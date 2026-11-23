import unittest
from types import SimpleNamespace
import numpy as np
from runtime_profile import resolve_profile, default_features, merge_features
from light_results import NumpyBoxes
from lite_bytetrack import BYTETracker
from object_tracking import ObjectVisualTracker
from perception import Perception


class RuntimeProfileAndGatingTests(unittest.TestCase):
    def test_resolves_8gb_lite_and_16gb_balanced_profiles(self):
        lite = resolve_profile('auto', total_mb=8192)
        balanced = resolve_profile('auto', total_mb=16384)
        self.assertEqual(lite['name'], 'lite')
        self.assertEqual(lite['personModel'], 'yolo11n.onnx')
        self.assertEqual(lite['faceModel'], 'scrfd_2.5g.onnx')
        self.assertFalse(lite['sceneTileCrop'])
        self.assertEqual(balanced['name'], 'balanced')
        self.assertEqual(balanced['personModel'], 'yolo11n.onnx')
        self.assertEqual(balanced['faceModel'], 'scrfd_2.5g.onnx')

    def test_merge_features_unions_active_sessions(self):
        base = default_features()
        self.assertFalse(base['objects'])
        self.assertFalse(base['hands'])
        merged = merge_features([base, dict(base, objects=True, hands=True)])
        self.assertTrue(merged['objects'])
        self.assertTrue(merged['hands'])

    def test_numpy_boxes_and_bytetrack_work_without_torch(self):
        args = SimpleNamespace(track_high_thresh=.2, track_low_thresh=.1, new_track_thresh=.2,
                               track_buffer=30, match_thresh=.8, fuse_score=True)
        tracker = BYTETracker(args, frame_rate=5)
        rows = np.array([[100, 100, 220, 360, .9, 0]], dtype=np.float32)
        tracked = tracker.update(NumpyBoxes(rows, (480, 640)), None)
        self.assertEqual(len(tracked), 1)
        self.assertEqual(int(tracked[0, 4]), 1)

    def test_object_tracker_clears_state_when_disabled(self):
        tracker = ObjectVisualTracker(history_limit=8, track_edge=480, max_objects=5)
        try:
            frame = np.zeros((240, 320, 3), np.uint8)
            tracker.remember_source(frame, 1000)
            self.assertEqual(len(tracker.history), 1)
            tracker.set_enabled(False)
            self.assertEqual(len(tracker.history), 0)
            self.assertEqual(tracker.update(frame, 1100, {'at': 1000, 'objects': []}), [])
        finally:
            tracker.close()

    def test_perception_configure_gates_pipelines_and_clears_disabled_state(self):
        import threading
        engine = Perception.__new__(Perception)
        engine.lock = threading.Lock()
        engine.model_lock = threading.Lock()
        engine.profile_cfg = resolve_profile('lite', total_mb=8192)
        engine.session_features = {}
        engine.active_features = default_features()
        engine.hands = None
        engine.profile = None
        engine.desk_rest = None
        engine.scene_latest = {'s1': ('frame', [], 100, {})}
        engine.scene_results = {'s1': {1: {}}}
        engine.scene_objects = {'s1': {'at': 100, 'objects': [{}]}}
        engine.rest_latest = {'s1': ('frame', 100, {})}
        engine.pose_latest = {'s1': ('frame', 100, {})}
        engine.sessions = {'s1': {'objects': [{}], 'objectsAt': 100, 'bodyObservations': {1: {'phoneHeld': True}},
                                  'restObservations': {1: {}}, 'poseObservations': {1: {}},
                                  'poses': [1], 'wrists': [1], 'headings': [1], 'poseRegions': [1]}}
        engine.configure('s1', {'objects': False, 'hands': False, 'faceMesh': False, 'profileMesh': False,
                                'pose': False, 'deskRest': False, 'faceHeading': True})
        self.assertNotIn('s1', engine.scene_latest)
        self.assertNotIn('s1', engine.scene_objects)
        self.assertEqual(engine.sessions['s1']['objects'], [])
        self.assertNotIn('phoneHeld', engine.sessions['s1']['bodyObservations'][1])
        self.assertNotIn('restObservations', engine.sessions['s1'])
        self.assertNotIn('poseObservations', engine.sessions['s1'])


if __name__ == '__main__':
    unittest.main()
