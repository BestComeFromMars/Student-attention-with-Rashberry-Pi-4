import unittest
import threading
from unittest.mock import patch
from pathlib import Path
import cv2
import numpy as np
from geometry import FaceGeometry, project_anchors, iou

cv2.setNumThreads(1)


class FakeDetector:
    def __init__(self, boxes):
        self.rows = []
        for x, y, w, h, score in boxes:
            anchors = [[x+.3*w, y+.35*h], [x+.7*w, y+.35*h], [x+.5*w, y+.55*h],
                       [x+.35*w, y+.75*h], [x+.65*w, y+.75*h]]
            self.rows.append([x, y, w, h, *np.asarray(anchors).flatten(), score])

    def setInputSize(self, size):
        pass

    def detect(self, image):
        rows=np.asarray(self.rows,np.float32)
        if len(rows) and hasattr(self,'source_size'):
            # Geometry pads only the bottom/right. The test's 1024px source is
            # reduced to 640px before padding, so both axes use the same scale.
            rows[:,:14]*=image.shape[1]/self.source_size[0]
        return None,rows


class GeometryDetectionTests(unittest.TestCase):
    def test_dense_scene_measures_current_image_without_replaying_or_retaining_missing_faces(self):
        from unittest.mock import Mock
        with patch('scrfd.VerifiedFaceDetector',return_value=FakeDetector([])):
            geometry=FaceGeometry('unused')
        image=np.zeros((480,640,3),np.uint8)
        def detections(shift):
            return [dict(box=[.04+i*.10+shift,.3,.06,.12],score=.95,
                anchors=[[0,0]]*5,detectorVerified=True,detectorModel='SCRFD-10G',evidenceMode='scrfd') for i in range(9)]
        try:
            geometry._merge(detections(0),1000)
            identities=[t['id'] for t in geometry.tracks]
            geometry._detect=Mock(return_value=detections(.01))
            geometry.visual.update=Mock(side_effect=AssertionError('dense frames must not run per-face replay'))
            geometry.visual.seed=Mock(side_effect=AssertionError('dense frames must not initialize per-face trackers'))
            result=geometry.update(image,5000)
            self.assertEqual([t['id'] for t in result],identities)
            self.assertTrue(all(t['detectedAt']==5000 for t in result))
            self.assertAlmostEqual(result[0]['box'][0],.05)
            geometry._detect.return_value=[]
            self.assertEqual(geometry.update(image,5100),[],'an actual empty scan must hide the faces immediately')
        finally:geometry.close()

    def test_refreshes_native_appearance_without_moving_a_current_fast_detection_back_to_the_scan_image(self):
        from types import SimpleNamespace
        with patch('scrfd.VerifiedFaceDetector',return_value=FakeDetector([])):
            geometry=FaceGeometry('unused')
        source=[.2,.2,.2,.3];current=[.4,.2,.2,.3]
        native=SimpleNamespace(box=(128,96,128,144))
        replacement=dict(tracker=native,seen=1070,seededAt=1070)
        track=dict(id=1,box=list(source),score=.95,seen=1000,anchors=[[0,0]]*5,detectorVerified=True)
        geometry.tracks=[track];geometry.last_scan=1000
        geometry.visual.items[1]=dict(tracker=SimpleNamespace(box=(128,96,128,144)),seen=1000,seededAt=1000)
        geometry.visual.shape=(480,640)
        def fast(frame,tracks,now,**kwargs):
            tracks[0].update(box=list(current),relativeAnchors=[[.5,.5]]*5,fastFaceAt=now,fastFaceScore=.95,fastFaceModel='YuNet',visualAt=now)
            return {1}
        geometry.fast=SimpleNamespace(update=fast)
        image=np.zeros((480,640,3),np.uint8)
        detection=dict(box=list(source),score=.95,anchors=[[0,0]]*5,detectorVerified=True,
            _prepared=dict(item=replacement,box=list(source),at=1070,visualAt=1070,visualLostAt=None,trackingScore=.9))
        geometry.completed=([detection],1070,{1:list(source)},image)
        try:
            result=geometry.update(image,1100)[0]
            self.assertEqual(result['box'],current)
            self.assertIs(geometry.visual.items[1],replacement)
            self.assertEqual(native.box,(256,96,128,144))
            self.assertEqual(geometry.visual.items[1]['seededAt'],1070)
        finally:geometry.close()

    def test_matching_landmark_proof_enables_recovery_and_cached_proof_cannot_renew_its_time(self):
        with patch('scrfd.VerifiedFaceDetector',return_value=FakeDetector([[200,150,160,240,.95]])):
            geometry=FaceGeometry('unused')
        image=np.zeros((480,640,3),np.uint8)
        try:
            first=geometry.update(image,1000)[0]
            observation=dict(facePresent=True,observedAt=1020,faceBox=list(first['box']))
            geometry.update(image,1050,owners={first['id']:observation})
            self.assertEqual(geometry.tracks[0]['verifiedAt'],1020)
            geometry.update(image,1100,owners={first['id']:observation})
            self.assertEqual(geometry.tracks[0]['verifiedAt'],1020,'cached landmarks are not fresh proof')
        finally:geometry.close()

    def test_slow_completed_scan_cannot_replace_a_newer_current_frame_detection(self):
        geometry=FaceGeometry.__new__(FaceGeometry)
        geometry.tracks=[dict(id=1,box=[.3,.2,.2,.3],score=.95,seen=1500,verifiedAt=1500)]
        geometry.next_id=2
        geometry._merge([dict(box=[.1,.2,.2,.3],score=.9)],1600,reference={1:[.1,.2,.2,.3]},observed_at=1200)
        self.assertEqual(len(geometry.tracks),1)
        self.assertEqual(geometry.tracks[0]['seen'],1500)
        self.assertEqual(geometry.tracks[0]['box'],[.3,.2,.2,.3])

    def test_prepared_templates_apply_without_replaying_old_images_in_the_response(self):
        from types import SimpleNamespace
        geometry=FaceGeometry.__new__(FaceGeometry)
        geometry.history=[]
        image=cv2.imread(str(Path(__file__).resolve().parents[1]/'test-fixtures/faces/two-frontal-profile.jpg'))
        image=cv2.resize(image,(640,360))
        detection=dict(box=[.17,.34,.15,.4],score=.99,anchors=[[0,0]]*5)
        geometry.history=[(1100,image),(1200,image)]
        geometry._prepare_templates([detection],image,1000)
        prepared=detection['_prepared']
        self.assertEqual(prepared['at'],1200)
        self.assertEqual(prepared['visualAt'],1200)
        self.assertGreater(prepared['trackingScore'],.3)
        self.assertEqual(prepared['item']['seen'],1000,'replay is not new detector evidence')

    def test_search_is_urgent_for_empty_or_detector_rejected_tracks_even_when_visual_tracker_is_confident(self):
        geometry=FaceGeometry.__new__(FaceGeometry)
        geometry.tracks=[]
        self.assertEqual(geometry._scan_interval(2000),100)
        tracked=dict(id=1,visualAt=2000,seen=1900)
        geometry.tracks=[tracked]
        self.assertEqual(geometry._scan_interval(2000),250)
        tracked['missedScans']=1
        self.assertEqual(geometry._scan_interval(2000),100)
        tracked.pop('missedScans');tracked['visualLostAt']=2000
        self.assertEqual(geometry._scan_interval(2000),100)
        geometry.tracks=[dict(id=i,visualAt=2000,seen=1900) for i in range(10)]
        self.assertEqual(geometry._scan_interval(2000),500)

    def test_agreeing_rescan_refreshes_evidence_without_reloading_a_live_native_template(self):
        from types import SimpleNamespace
        geometry=FaceGeometry.__new__(FaceGeometry)
        source=[.2,.2,.2,.3];live=[.25,.2,.2,.3]
        geometry.tracks=[dict(id=1,box=list(live),score=.95,seen=1000,visualAt=1400)]
        item=dict(seen=1000,seededAt=1000)
        geometry.visual=SimpleNamespace(items={1:item});geometry.next_id=2
        geometry._merge([dict(box=list(source),score=.95,detectorVerified=True)],1400,reference={1:source},observed_at=1300)
        self.assertEqual(geometry.tracks[0]['box'],live,'an agreeing rescan must not pull the current model box back to its old source frame')
        self.assertEqual(item['seen'],1300)
        self.assertEqual(item['seededAt'],1000,'refreshing detector evidence must not pretend that the template was reloaded')
        geometry.tracks[0].update(box=list(live),missedScans=1,missedAt=1450,visualAt=1600)
        geometry._merge([dict(box=list(source),score=.95,detectorVerified=True)],1600,reference={1:source},observed_at=1500)
        self.assertEqual(geometry.tracks[0]['box'],source,'a previously rejected track must be reseeded when reacquired')
        self.assertEqual(item['seen'],1300)

    def test_async_detection_does_not_inherit_previous_tracker_scale_drift(self):
        geometry=FaceGeometry.__new__(FaceGeometry)
        source=[.2,.2,.2,.3]
        geometry.tracks=[dict(id=1,box=[.3,.3,.1,.15],score=.95,seen=1000)]
        geometry.next_id=2
        geometry._merge([dict(box=list(source),score=.95)],1500,reference={1:source},observed_at=1400)
        self.assertEqual(len(geometry.tracks),1)
        self.assertEqual(geometry.tracks[0]['id'],1)
        self.assertEqual(geometry.tracks[0]['box'],source,'fresh model geometry must not be multiplied by old tracker drift')
        self.assertEqual(geometry.tracks[0]['seen'],1400)

    def test_reacquired_face_retires_old_carried_roi_on_the_same_body_only(self):
        geometry=FaceGeometry.__new__(FaceGeometry)
        old=dict(id=1,box=[.4,.2,.2,.3],personId=7,seen=1000,missedScans=1)
        fresh=dict(id=2,box=[.41,.2,.2,.3],personId=7,seen=1500,detectorVerified=True)
        neighbor=dict(old,id=3,box=[.1,.2,.2,.3],personId=8)
        geometry.tracks=[old,fresh,neighbor]
        geometry._drop_body_duplicates()
        self.assertEqual([track['id'] for track in geometry.tracks],[2,3])

    def test_negative_rescan_marks_only_tracks_that_existed_in_its_source_frame(self):
        with patch('scrfd.VerifiedFaceDetector',return_value=FakeDetector([])):
            geometry=FaceGeometry('unused')
        try:
            first=dict(box=[.1,.2,.2,.3],score=.95,anchors=[[0,0]]*5)
            geometry._merge([dict(first)],1000)
            geometry._merge([dict(first,box=[.6,.2,.2,.3])],1400,reference={1:first['box']})
            self.assertEqual(geometry.tracks[0]['missedScans'],1)
            self.assertNotIn('missedAt',geometry.tracks[1])
            geometry._merge([],1500,reference={1:first['box']},observed_at=1400)
            self.assertEqual(geometry.tracks[0]['missedScans'],1,'same snapshot cannot count twice')
            geometry._merge([dict(first)],1700)
            self.assertEqual(geometry.tracks[0]['missedScans'],0)
            self.assertNotIn('missedAt',geometry.tracks[0])
        finally:
            geometry.close()

    def test_background_rescans_rotate_source_tiles_at_bounded_inference_size(self):
        engine = FaceGeometry.__new__(FaceGeometry)
        engine.max_faces = 40
        calls = []
        class Detector:
            def setInputSize(self,size):
                pass
            def detect(self,image):
                calls.append((image.shape[:2],tuple(image[0,0,:2])))
                return None,None
        engine.detector = Detector()
        engine.detector_lock=threading.Lock()
        image = np.zeros((1080,1920,3),np.uint8)
        image[:,:,0] = np.arange(1920,dtype=np.uint16)[None,:]//8
        image[:,:,1] = np.arange(1080,dtype=np.uint16)[:,None]//8
        origins = []
        for _ in range(6):
            calls.clear()
            engine._detect(image,tiled=True,tile_limit=1)
            self.assertEqual(len(calls),2,'each pass must contain the full frame and only one tile')
            self.assertEqual(calls[0][0],(384,640))
            self.assertEqual(calls[1][0],(640,640),'source tile is sampled at bounded detector cost')
            origins.append(calls[1][1])
        self.assertEqual(len(set(origins)),6,'all overlapping source tiles must be visited')
        calls.clear()
        engine._detect(image,tiled=True,tile_limit=1)
        self.assertEqual(calls[1][1],origins[0],'the tile cursor wraps')

    def test_single_detector_hits_increase_on_rescan_not_on_video_frames(self):
        detection = dict(box=[.2,.2,.2,.3],score=.85,anchors=[[0,0]]*5,
                         detectorVerified=True,evidenceMode='scrfd')
        with patch('scrfd.VerifiedFaceDetector',return_value=FakeDetector([])):
            geometry = FaceGeometry('unused')
        geometry._detect = lambda frame,tiled=False: [dict(detection)]
        try:
            frame = np.zeros((720,1280,3),np.uint8)
            first = geometry.update(frame,1000)
            self.assertEqual(first[0]['detectionHits'],1)
            for at in [1033,1066,1100]:
                current = geometry.update(frame,at)
                self.assertEqual(current[0]['detectionHits'],1)
            geometry._merge([dict(detection)],1450)
            self.assertEqual(geometry.tracks[0]['detectionHits'],2)
            self.assertEqual(geometry.tracks[0]['evidenceMode'],'scrfd')
            geometry._merge([dict(detection,evidenceMode='dual')],1900)
            self.assertEqual(geometry.tracks[0]['detectionHits'],1)
            geometry._merge([dict(detection,detectorVerified=False)],2100)
            geometry._merge([dict(detection)],2300)
            self.assertEqual(geometry.tracks[0]['detectionHits'],1,'a weak rescan cannot count toward two strong rescans')
            geometry._merge([dict(detection)],3000,observed_at=2400)
            self.assertEqual(geometry.tracks[0]['seen'],2400,'an async result must retain its image timestamp')
            self.assertEqual(geometry.tracks[0]['detectionHits'],2)
        finally:
            geometry.close()

    def test_native_model_rectangles_are_not_resized_again_by_geometry(self):
        with patch('scrfd.VerifiedFaceDetector',return_value=FakeDetector([])):
            geometry = FaceGeometry('unused')
        class Tracker:
            def init(self,frame,rect): self.rect=rect
            def update(self,frame): return True,self.rect
            def getTrackingScore(self):return .9
        geometry._detect = lambda frame,tiled=False: [dict(box=[.4,.35,.2,.3],score=.95,anchors=[[0,0]]*5)]
        try:
            with patch('cv2.TrackerVit_create',side_effect=lambda params:Tracker()):
                image=np.zeros((720,1280,3),np.uint8)
                first=geometry.update(image,1000)[0]
                for step in range(1,9):
                    current=geometry.update(image,1000+step*34)[0]
                    np.testing.assert_allclose(current['box'],first['box'],atol=.002)
                    self.assertEqual(current['id'],first['id'])
        finally:
            geometry.close()

    def test_pretrained_tracker_keeps_forty_ids_on_known_translation(self):
        # Public portrait fixture, repeated for load; no model/identity accuracy
        # claim. The affine warp supplies independent motion ground truth.
        portrait = cv2.imread(str(Path(__file__).resolve().parents[1]/'test-fixtures/portrait.jpg'))
        crop = portrait[70:350,300:510]
        for size in (64, 96):
            boxes = [[20+i%8*235, 20+i//8*205, size, size*1.25] for i in range(40)]
            image = np.full((1080, 1920, 3), 235, np.uint8)
            for x,y,w,h in boxes:
                image[y:y+int(h),x:x+w] = cv2.resize(crop,(w,int(h)))
            detections = [dict(box=[x/1920,y/1080,w/1920,h/1080], score=.95,
                              anchors=[[x+w*.3,y+h*.35],[x+w*.7,y+h*.35],[x+w*.5,y+h*.55],
                                       [x+w*.35,y+h*.75],[x+w*.65,y+h*.75]]) for x,y,w,h in boxes]
            with patch('scrfd.VerifiedFaceDetector', return_value=FakeDetector([])):
                geometry = FaceGeometry('unused-model-path')
            # Exercise the native tracker's 40-template capacity independently
            # of the production dense-scene detector scheduling regression above.
            geometry._dense_scene=lambda bodies:False
            geometry._detect = lambda frame, tiled=False: detections
            try:
                geometry.update(image, 1000)
                for step in range(1, 9):
                    moved = cv2.warpAffine(image, np.float32([[1,0,step*2],[0,1,step]]), (1920,1080))
                    faces = geometry.update(moved, 1000+step*34)
                self.assertEqual(len(faces), 40)
                for face, (x,y,w,h) in zip(faces, boxes):
                    expected=[(x+16)/1920,(y+8)/1080,w/1920,h/1080]
                    self.assertGreater(iou(face['box'],expected),.6,'must follow the independently warped face')
                self.assertEqual([face['id'] for face in faces],list(range(1,41)))
            finally:
                geometry.close()

    def detect(self, boxes):
        engine = FaceGeometry.__new__(FaceGeometry)
        engine.max_faces = 40
        engine.detector = FakeDetector(boxes)
        engine.detector_lock=threading.Lock()
        engine.detector.source_size=(1024,720)
        return engine._detect(np.zeros((720, 1024, 3), np.uint8))

    def test_suppresses_a_face_part_inside_a_large_face_even_when_iou_is_small(self):
        faces = self.detect([[300, 210, 240, 310, .95], [460, 350, 40, 60, .90]])
        self.assertEqual(len(faces), 1)
        self.assertAlmostEqual(faces[0]['box'][2], 240/1024)

    def test_keeps_separate_small_and_similar_size_faces(self):
        faces = self.detect([[300, 210, 240, 310, .95], [560, 210, 220, 300, .94],
                             [850, 350, 32, 40, .91]])
        self.assertEqual(len(faces), 3)

    def test_strong_face_part_cannot_suppress_its_larger_parent(self):
        faces = self.detect([[300, 210, 240, 310, .92], [460, 350, 40, 60, .99]])
        self.assertEqual(len(faces), 1)
        self.assertAlmostEqual(faces[0]['box'][2], 240/1024)

    def test_landmark_anchors_follow_the_box_after_motion_and_scale_changes(self):
        face = self.detect([[300, 210, 240, 310, .95]])[0]
        original = np.asarray(face['anchors'])
        face['box'] = [350/1024, 230/720, 288/1024, 341/720]
        expected = (original-np.array([300, 210]))*np.array([1.2, 1.1])+np.array([350, 230])
        np.testing.assert_allclose(project_anchors(face, 1024, 720), expected, atol=.001)


if __name__ == '__main__':
    unittest.main()
