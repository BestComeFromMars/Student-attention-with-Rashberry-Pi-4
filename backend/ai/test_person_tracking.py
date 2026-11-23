import unittest
import numpy as np
from person_tracking import PersonTracking, attach_faces, merge_rest_bodies


class FakeDetector:
    def __init__(self, rows):
        self.rows = rows

    def predict_rows(self, _frame):
        return np.asarray(self.rows, dtype=np.float32).reshape(-1, 6)


class PersonAssociationTests(unittest.TestCase):
    def setUp(self):
        self.persons = PersonTracking()

    def tearDown(self):
        self.persons.close()

    def test_border_body_is_clipped_and_fully_offscreen_body_is_not_published(self):
        edge = dict(id=1, seen=1000, box=[-.0003348, .8, .13838, .3])
        outside = dict(id=2, seen=1000, box=[1.02, .2, .1, .4])
        result = self.persons.assemble([edge, outside], [], 1000)
        self.assertEqual([person['personId'] for person in result], [1])
        box = result[0]['box']
        self.assertEqual(box, result[0]['personBox'])
        self.assertEqual(box['x'], 0)
        self.assertAlmostEqual(box['width'], .1380452)
        self.assertAlmostEqual(box['y'] + box['height'], 1)

    def test_unpaired_face_cannot_inherit_another_bodys_cached_identity_and_behavior(self):
        body = dict(id=7, seen=1000, box=[.1, .1, .2, .5])
        face = dict(
            boxKind='face', box=dict(x=.7, y=.2, width=.1, height=.1), geometryId=9, trackingState='face', personId=7,
            observation=dict(
                valid=True, facePresent=True, observedAt=1000, eyeAspectRatio=.3, yawDeg=35,
                personId=7, phoneHeld=True, headYaw=.4, bodyPose={'old': True}, deskRest={'active': True},
            ),
        )
        output = self.persons.assemble([body], [face], 1000)
        orphan = next(p for p in output if p.get('geometryId') == 9)
        self.assertNotIn('personId', orphan)
        self.assertTrue(orphan['observation']['valid'])
        self.assertEqual(orphan['observation']['yawDeg'], 35)
        for key in ['personId', 'phoneHeld', 'headYaw', 'bodyPose', 'deskRest']:
            self.assertNotIn(key, orphan['observation'])

    def test_a_torso_fragment_cannot_claim_a_neighboring_face_outside_its_bounds(self):
        bodies = [dict(id=1, seen=1000, box=[.45, .48, .06, .12]), dict(id=2, seen=1000, box=[.48, .44, .07, .18])]
        face = dict(boxKind='face', box=dict(x=.516, y=.47, width=.025, height=.045), geometryId=9, trackingState='face', personId=1)
        links, _ = attach_faces(bodies, [face])
        self.assertEqual(links, {1: 0})

    def test_overlapping_body_duplicates_do_not_publish_two_students_for_one_face(self):
        bodies = [dict(id=1, seen=1000, box=[.2, .2, .3, .5]), dict(id=2, seen=1000, box=[.21, .2, .28, .4])]
        face = dict(boxKind='face', box=dict(x=.3, y=.21, width=.08, height=.1), geometryId=9, trackingState='face')
        output = self.persons.assemble(bodies, [face], 1000)
        self.assertEqual(len(output), 1)
        self.assertEqual(output[0]['geometryId'], 9)

    def test_two_distinct_heads_and_corroborated_face_hidden_people_survive_overlap(self):
        bodies = [dict(id=1, seen=1000, box=[.2, .2, .3, .5]), dict(id=2, seen=1000, box=[.21, .2, .28, .4])]
        faces = [
            dict(boxKind='face', box=dict(x=x, y=.21, width=.06, height=.08), geometryId=i, personId=i + 1, trackingState='face')
            for i, x in enumerate([.24, .38])
        ]
        self.assertEqual(len(self.persons.assemble(bodies, faces, 1000)), 2)
        bodies[1]['observation'] = dict(deskRest=dict(active=True, confidence=.6))
        self.assertEqual(len(self.persons.assemble(bodies, faces[:1], 1100)), 2)

    def test_overlapping_unfaced_bodies_and_duplicate_orphan_faces_are_suppressed(self):
        bodies = [
            dict(id=1, seen=1000, box=[.2, .2, .22, .45], confidence=.85),
            dict(id=2, seen=1000, box=[.21, .21, .21, .44], confidence=.65),
        ]
        output = self.persons.assemble(bodies, [], 1000)
        self.assertEqual([p['personId'] for p in output], [1])
        face_main = dict(boxKind='face', box=dict(x=.26, y=.22, width=.08, height=.1), geometryId=10, trackingState='face')
        face_dup = dict(boxKind='face', box=dict(x=.265, y=.225, width=.078, height=.098), geometryId=11, trackingState='face')
        output2 = self.persons.assemble(bodies, [face_main, face_dup], 1000)
        self.assertEqual(len(output2), 1)
        self.assertEqual(output2[0]['personId'], 1)
        self.assertEqual(output2[0]['geometryId'], 10)

    def test_direct_tier1_detect_tracks_distant_back_row_and_occluded_face_student(self):
        frame = np.zeros((360, 640, 3), np.uint8)
        # Back-row student with modest YOLO score (0.24) must keep stable ID across frames.
        det = FakeDetector([[40, 40, 100, 140, 0.24, 0], [300, 120, 460, 340, 0.88, 0]])
        b1 = self.persons.detect(det, frame, 1000)
        b2 = self.persons.detect(det, frame, 1120)
        self.assertEqual(len(b1), 2)
        self.assertEqual([b['id'] for b in b1], [b['id'] for b in b2])
        # Occluded face: student remains visible with personBox and faceVisibility='unavailable'.
        assembled = self.persons.assemble(b2, [], 1120)
        self.assertEqual(len(assembled), 2)
        for person in assembled:
            self.assertIn('personBox', person)
            self.assertEqual(person['faceVisibility'], 'unavailable')
            self.assertNotIn('faceBox', person)

    def test_merge_rest_bodies_preserves_slumped_student(self):
        bodies = [dict(id=1, seen=1000, box=[.1, .1, .2, .4])]
        rest = [dict(id=2, at=1000, seen=1000, box=[.5, .5, .2, .3], observation=dict(deskRest=dict(active=True)))]
        merged = merge_rest_bodies(bodies, rest, 1100)
        self.assertEqual({b['id'] for b in merged}, {1, 2})


if __name__ == '__main__':
    unittest.main()
