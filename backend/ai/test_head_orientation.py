import unittest
import numpy as np
from head_orientation import keypoint_heading


class HeadOrientationTests(unittest.TestCase):
    def points(self, nose=100):
        points=np.zeros((17,3),np.float32)
        points[:5]=[[nose,80,.9],[90,70,.9],[110,70,.9],[80,80,.9],[120,80,.9]]
        return points

    def test_orientation_is_signed_and_front_is_neutral(self):
        self.assertEqual(keypoint_heading(self.points()),0)
        self.assertLess(keypoint_heading(self.points(85)),-.22)
        self.assertGreater(keypoint_heading(self.points(115)),.22)

    def test_visible_eyes_can_supply_orientation_when_ears_are_hidden(self):
        points=self.points(110);points[3:5,2]=0
        self.assertGreater(keypoint_heading(points),.22)

    def test_missing_nose_or_both_anchor_pairs_are_unavailable(self):
        points=self.points();points[0,2]=0
        self.assertIsNone(keypoint_heading(points))
        points=self.points();points[1:5,2]=0
        self.assertIsNone(keypoint_heading(points))

    def test_translation_does_not_become_head_rotation(self):
        points=self.points();points[:,:2]+=[100,70]
        self.assertEqual(keypoint_heading(points),0)

    def test_invalid_tiny_and_nonfinite_keypoints_do_not_manufacture_heading(self):
        for points in ([],np.zeros((17,3)),np.full((17,3),float('nan'))):
            self.assertIsNone(keypoint_heading(points))
        points=self.points();points[:,:2]*=.01
        self.assertIsNone(keypoint_heading(points))


if __name__=='__main__':unittest.main()
