import unittest
from pathlib import Path
from unittest.mock import patch
import cv2
import numpy as np
from visual_tracking import FaceVisualTracker, follow_body
from geometry import iou

cv2.setNumThreads(1)


class FaceScaleTests(unittest.TestCase):
    def test_native_size_and_position_are_forwarded_on_the_same_update(self):
        image=np.zeros((480,640,3),np.uint8)
        tracker=FaceVisualTracker()
        face=dict(id=1,seen=1000,box=[.2,.2,.2,.3])
        class Native:
            def update(self,frame):return True,(256,96,192,216)
            def getTrackingScore(self):return .9
        tracker.shape=image.shape[:2]
        tracker.items[1]=dict(tracker=Native(),seen=1000)
        tracker.update(image,[face],1100)
        np.testing.assert_allclose(face['box'],[.4,.2,.3,.45])
        self.assertEqual(face['visualAt'],1100)
        self.assertEqual(face['seen'],1000)

    def test_rejected_model_update_does_not_move_the_box_or_refresh_face_evidence(self):
        image=np.zeros((480,640,3),np.uint8)
        tracker=FaceVisualTracker()
        face=dict(id=1,seen=1000,box=[.25,.2,.2,.3])
        class Rejected:
            def update(self,frame):return False,(0,0,1,1)
            def getTrackingScore(self):return .1
        tracker.items[1]=dict(tracker=Rejected(),seen=1000)
        tracker.shape=image.shape[:2]
        with patch('cv2.TrackerVit_create') as create:
            tracker.update(image,[face],1100)
            create.assert_not_called()
        self.assertEqual(face['box'],[.25,.2,.2,.3])
        self.assertEqual(face['visualLostAt'],1100)
        self.assertEqual(face['seen'],1000)
        self.assertNotIn('visualAt',face)

    def test_real_image_zoom_changes_box_on_each_frame_without_a_detector_rescan(self):
        portrait = cv2.imread(str(Path(__file__).resolve().parents[1]/'test-fixtures/portrait.jpg'))
        patch = cv2.resize(portrait[70:350,300:510],(150,200))
        image = np.full((480,640,3),220,np.uint8)
        image[140:340,245:395] = patch
        tracker = FaceVisualTracker()
        face = dict(id=1,seen=1000,box=[245/640,140/480,150/640,200/480])
        tracker.update(image,[face],1000)
        tracker.seed(image,[face])
        scales = [1.06**step for step in range(1,8)] + [1.06**step for step in range(6,-7,-1)]
        for index,scale in enumerate(scales):
            matrix = cv2.getRotationMatrix2D((320,240),0,scale)
            moved = cv2.warpAffine(image,matrix,(640,480),borderValue=(220,220,220))
            tracker.update(moved,[face],1100+index*80)
            tracker.seed(moved,[face])
            expected=[(320-75*scale)/640,(240-100*scale)/480,150*scale/640,200*scale/480]
            self.assertGreater(iou(face['box'],expected),.6,'pretrained tracker must overlap the independently warped target')
            self.assertGreater(face['trackingScore'],.3)
            self.assertEqual(face['seen'],1000,'image motion is not new detector evidence')

    def test_turning_in_plane_does_not_inflate_width_on_each_update(self):
        portrait = cv2.imread(str(Path(__file__).resolve().parents[1]/'test-fixtures/portrait.jpg'))
        image = cv2.resize(portrait,(640,640))
        tracker = FaceVisualTracker()
        face = dict(id=1,seen=1000,box=[.3,.2,.3,.4])
        tracker.update(image,[face],1000)
        tracker.seed(image,[face])
        for index,angle in enumerate(range(2,22,2)):
            moved = cv2.warpAffine(image,cv2.getRotationMatrix2D((288,256),angle,1),(640,640))
            tracker.update(moved,[face],1100+index*80)
            tracker.seed(moved,[face])
        self.assertGreater(iou(face['box'],[.3,.2,.3,.4]),.6)
        self.assertLess(face['box'][2]*face['box'][3],.3*.4*1.5,'rotation must not compound box expansion')


class BodyContinuityTests(unittest.TestCase):
    def test_current_fast_face_detector_overrides_an_older_negative_scan_and_delayed_body_rectangle(self):
        track=dict(id=1,box=[.2,.1,.1,.15],seen=1000)
        owner={1:dict(personId=7)}
        follow_body(track,[dict(id=7,at=1000,box=[.1,0,.4,.9])],owner,1000)
        track.update(box=[.6,.1,.1,.15],missedScans=1,missedAt=1400,fastFaceAt=1500)
        follow_body(track,[dict(id=7,at=1400,box=[.1,0,.4,.9])],owner,1500)
        self.assertEqual(track['box'],[.6,.1,.1,.15])

    def test_negative_scan_forces_body_motion_even_when_visual_tracker_is_locked_to_background(self):
        track=dict(id=1,box=[.2,.1,.1,.15],seen=1000)
        owner={1:dict(personId=7)}
        follow_body(track,[dict(id=7,at=1000,box=[.1,0,.4,.9])],owner,1000)
        track.update(missedScans=1,missedAt=1400,visualAt=1500)
        follow_body(track,[dict(id=7,at=1500,box=[.4,0,.4,.9])],owner,1500)
        self.assertAlmostEqual(track['box'][0],.5)

    def test_new_face_can_use_one_fresh_body_before_scene_ownership_finishes(self):
        track=dict(id=2,box=[.5,.1,.1,.15],seen=1500)
        bodies=[dict(id=7,at=1500,box=[.4,0,.4,.9])]
        self.assertTrue(follow_body(track,bodies,{},1500))
        self.assertEqual(track['personId'],7)
        ambiguous=dict(id=3,box=[.5,.1,.1,.15],seen=1500)
        self.assertFalse(follow_body(ambiguous,bodies+[dict(bodies[0],id=8)],{},1500))

    def test_body_carries_only_its_calibrated_face_box_through_long_occlusion(self):
        track = dict(id=1,box=[.2,.1,.1,.15],seen=1000)
        owner = {1:dict(personId=7)}
        self.assertTrue(follow_body(track,[dict(id=7,at=1000,box=[.1,0,.4,.9])],owner,1000))
        for at in range(2000,12000,1000):
            self.assertTrue(follow_body(track,[dict(id=7,at=at,box=[.4,0,.4,.9])],owner,at))
            self.assertAlmostEqual(track['box'][0],.5)
            self.assertAlmostEqual(track['box'][2],.1)
            self.assertAlmostEqual(track['box'][3],.15)
            self.assertEqual(track['id'],1)
            self.assertEqual(track['seen'],1000,'body is not a fresh face detection')
        self.assertFalse(follow_body(track,[dict(id=7,at=11000,box=[.4,0,.4,.9])],owner,14000))

    def test_different_body_and_uncalibrated_body_cannot_move_a_face(self):
        track = dict(id=1,box=[.2,.1,.1,.15],seen=1000)
        self.assertFalse(follow_body(track,[dict(id=8,at=1000,box=[.1,0,.4,.9])],{1:dict(personId=7)},1000))
        self.assertNotIn('bodyAnchor',track)
        self.assertFalse(follow_body(track,[dict(id=7,at=4000,box=[.1,0,.4,.9])],{1:dict(personId=7)},4000))

    def test_live_visual_tracking_is_not_pulled_back_by_delayed_body_worker(self):
        track = dict(id=1,box=[.2,.1,.1,.15],seen=1000)
        owner={1:dict(personId=7)}
        follow_body(track,[dict(id=7,at=1000,box=[.1,0,.4,.9])],owner,1000)
        track.update(box=[.6,.1,.1,.15],visualAt=2000)
        follow_body(track,[dict(id=7,at=1700,box=[.2,0,.4,.9])],owner,2000)
        self.assertEqual(track['box'],[.6,.1,.1,.15])
