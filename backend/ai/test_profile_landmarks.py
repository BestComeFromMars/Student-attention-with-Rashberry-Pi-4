import unittest
from types import SimpleNamespace
import numpy as np
from profile_landmarks import matched_profile, profile_yaw


class ProfileGeometryTests(unittest.TestCase):
    def setUp(self):
        self.face = dict(box=[.2, .1, .3, .6], score=.95,
            anchors=[[280, 250], [400, 250], [250, 400], [260, 550], [300, 550]])
        # A spatially matching mesh; only nose/lips are trusted by this path.
        self.points = [SimpleNamespace(x=.35, y=.4) for _ in range(478)]
        self.points[10] = SimpleNamespace(x=.2, y=.1)
        self.points[152] = SimpleNamespace(x=.5, y=.7)
        self.points[1] = SimpleNamespace(x=.25, y=.4)
        self.points[13] = SimpleNamespace(x=.28, y=.54)
        self.points[14] = SimpleNamespace(x=.28, y=.56)

    def test_accepts_lips_and_nose_matching_independent_yunet_anchors(self):
        self.assertTrue(matched_profile(self.face, self.points, 1000, 1000))

    def test_rejects_a_high_presence_mesh_fitted_to_the_cheek_instead_of_lips(self):
        self.points[13] = SimpleNamespace(x=.28, y=.29)
        self.points[14] = SimpleNamespace(x=.28, y=.31)
        self.assertFalse(matched_profile(self.face, self.points, 1000, 1000))

    def test_rejects_nose_disagreement_even_if_mesh_box_and_mouth_match(self):
        self.points[1] = SimpleNamespace(x=.48, y=.2)
        self.assertFalse(matched_profile(self.face, self.points, 1000, 1000))

    def test_profile_direction_is_signed_and_frontal_faces_are_not_forced_sideways(self):
        self.assertLess(profile_yaw(self.face), 0)
        self.face['anchors'][2][0] = 390
        self.assertGreater(profile_yaw(self.face), 0)
        self.face['anchors'][2][0] = 340
        self.assertIsNone(profile_yaw(self.face))

    def test_holds_a_known_profile_across_small_anchor_jitter(self):
        self.face['anchors'][2][0] = 340-120*28/90
        self.assertIsNone(profile_yaw(self.face))
        self.assertLess(profile_yaw(self.face, 25), 0)

    def test_rejects_missing_nonfinite_or_collapsed_anchors(self):
        for anchors in [[], [[0, 0]]*5, [[float('nan'), 0]]*5]:
            self.face['anchors'] = anchors
            self.assertIsNone(profile_yaw(self.face))


if __name__ == '__main__':
    unittest.main()
