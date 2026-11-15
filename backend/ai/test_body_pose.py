import unittest
import numpy as np
from body_pose import pack_pose,match_poses


class BodyPoseTests(unittest.TestCase):
    def pose(self,at=1000):
        return pack_pose([100,100,300,450],np.tile([200,200,.9],(17,1)),.8,500,500,at)

    def test_serializes_normalized_points_confidence_and_original_time(self):
        record=self.pose()
        self.assertEqual(len(record['keypoints']),17)
        self.assertEqual(record['keypoints'][0],dict(x=.4,y=.4,confidence=.9))
        self.assertEqual(record['observedAt'],1000)
        self.assertEqual(record['confidence'],.8)
        self.assertEqual(record['aspectRatio'],1)

    def test_invalid_and_outside_points_are_not_trusted(self):
        self.assertIsNone(pack_pose([0,0,10,10],np.full((17,3),float('nan')),.8,500,500,1000))
        points=np.tile([200,200,.9],(17,1));points[0,0]=-20
        self.assertEqual(pack_pose([0,0,300,450],points,.8,500,500,1000)['keypoints'][0]['confidence'],0)

    def test_ambiguity_stale_and_future_evidence_is_not_assigned(self):
        bodies=[dict(id=7,box=[.2,.2,.4,.7])]
        self.assertEqual(set(match_poses(bodies,[self.pose()],1100)),{7})
        self.assertEqual(match_poses(bodies,[self.pose(3000)],1000),{})
        self.assertEqual(match_poses(bodies,[self.pose()],4000),{})
        self.assertEqual(match_poses(bodies+[dict(id=8,box=[.2,.2,.4,.7])],[self.pose()],1100),{})
        self.assertEqual(match_poses(bodies,[self.pose(),self.pose()],1100),{})


if __name__=='__main__':unittest.main()
