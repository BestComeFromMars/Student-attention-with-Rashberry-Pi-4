import unittest
from unittest.mock import Mock
from pathlib import Path
import cv2
import numpy as np
from fast_face_tracking import FastFaceTracking,associate,overlap


class FastFaceTrackingTests(unittest.TestCase):
    def test_one_lightweight_model_call_searches_all_three_rolls_of_an_existing_face(self):
        tracker=FastFaceTracking.__new__(FastFaceTracking)
        tracker.detect=Mock(return_value=[]);tracker.strong=object()
        tracker.quick=Mock();tracker.quick.detect.return_value=(None,None)
        known=dict(id=1,box=[.4,.3,.1,.2],seen=1000,detectorVerified=True)
        tracker.update(np.zeros((720,1280,3),np.uint8),[known],1100,rotate=True)
        tracker.quick.detect.assert_called_once()
        packed=tracker.quick.detect.call_args.args[0]
        self.assertEqual(packed.shape[1]%3,0)
        self.assertGreaterEqual(packed.shape[1],3*packed.shape[0])

    def test_small_background_face_does_not_disable_current_frame_tracking_of_a_large_face(self):
        tracker=FastFaceTracking.__new__(FastFaceTracking)
        tracker.detect=Mock(return_value=[dict(box=[.21,.2,.2,.3],anchors=[[0,0]]*5,
            relativeAnchors=[[.5,.5]]*5,score=.95)])
        large=dict(id=1,box=[.2,.2,.2,.3],seen=1000,detectorVerified=True)
        small=dict(id=2,box=[.7,.2,.02,.03],seen=1000,detectorVerified=True)
        found=tracker.update(np.zeros((720,1280,3),np.uint8),[large,small],1100)
        self.assertEqual(found,{1})
        self.assertEqual(large['fastFaceAt'],1100)
        self.assertNotIn('fastFaceAt',small)

    def test_unknown_or_expired_face_cannot_borrow_fast_presence(self):
        face=dict(id=1,box=[.2,.2,.1,.2],seen=1000,detectorVerified=False)
        rows=[dict(box=list(face['box']))]
        self.assertEqual(associate([face],rows,1100),{})
        face['detectorVerified']=True
        self.assertEqual(associate([face],rows,2601),{})
        self.assertEqual(associate([face],rows,1100),{0:0})

    def test_overlapping_owners_and_one_detection_are_ambiguous(self):
        face=dict(id=1,box=[.2,.2,.1,.2],seen=1000,detectorVerified=True)
        other=dict(face,id=2,box=[.205,.2,.1,.2])
        self.assertEqual(associate([face,other],[dict(box=[.2,.2,.1,.2])],1100),{})

    def test_real_yunet_moves_a_frontal_face_without_changing_other_ids_or_evidence_time(self):
        root=Path(__file__).resolve().parents[1]
        tracker=FastFaceTracking(root/'models/classroom/scrfd_10g.onnx')
        image=cv2.imread(str(root/'test-fixtures/faces/two-frontal-profile.jpg'))
        faces=[dict(id=1,box=[213/1280,251/720,193/1280,263/720],seen=1000,detectorVerified=True),
               dict(id=2,box=[835/1280,226/720,175/1280,305/720],seen=1000,detectorVerified=True)]
        moved=cv2.warpAffine(image,np.float32([[1,0,100],[0,1,0]]),(1280,720),borderValue=(220,220,220))
        found=tracker.update(moved,faces,1100)
        self.assertIn(1,found)
        for face,original_x in zip(faces[:1],[213]):
            self.assertLess(abs((face['box'][0]+face['box'][2]/2)*1280-(original_x+100+90)),65)
            self.assertEqual(face['seen'],1000)
            self.assertEqual(face['fastFaceAt'],1100)

    def test_rotated_yunet_coordinates_are_mapped_back_to_the_source_image(self):
        root=Path(__file__).resolve().parents[1]
        tracker=FastFaceTracking(root/'models/classroom/scrfd_10g.onnx')
        image=cv2.imread(str(root/'test-fixtures/faces/two-frontal-profile.jpg'))
        rows=tracker.detect(image,[dict(box=[.16,.34,.16,.37])],angle=30)
        self.assertTrue(rows)
        for row in rows:
            x,y,w,h=row['box']
            self.assertGreater(w,0);self.assertGreater(h,0)
            self.assertLessEqual(x+w,1.0001);self.assertLessEqual(y+h,1.0001)
            self.assertEqual(len(row['anchors']),5)


if __name__=='__main__':unittest.main()
