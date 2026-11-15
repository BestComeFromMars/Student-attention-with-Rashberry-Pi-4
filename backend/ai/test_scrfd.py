import unittest
from unittest.mock import Mock, patch
import numpy as np
from scrfd import decode_level, supported_face, fuse_faces, VerifiedFaceDetector


def row(x=100,score=.9):
    return np.array([x,100,100,140,x+30,145,x+70,145,x+50,175,x+35,205,x+65,205,score],np.float32)


class SCRFDTests(unittest.TestCase):
    def test_production_consensus_keeps_scrfd_geometry_and_yunet_behavior_anchors(self):
        first=row();second=row(110,.8);second[2:4]*=1.15
        rows,evidence=fuse_faces([first],[second],prefer_scrfd=True)
        np.testing.assert_array_equal(rows[0,:4],second[:4])
        np.testing.assert_array_equal(rows[0,4:14],first[4:14])
        self.assertEqual(evidence[0]['evidenceMode'],'dual')
        np.testing.assert_array_equal(fuse_faces(None,[second],prefer_scrfd=True)[0][0,:4],rows[0,:4])

    def test_decodes_two_anchors_per_cell_and_stride_scaled_keypoints(self):
        scores = np.array([[.1], [.8], [.2], [.3]], np.float32)
        distances = np.ones((4, 4), np.float32)
        points = np.zeros((4, 10), np.float32)
        points[1] = np.arange(10)/10
        rows = decode_level(scores, distances, points, 8, 16, 8, .5)
        self.assertEqual(rows.shape, (1, 15))
        np.testing.assert_allclose(rows[0, :4], [-8, -8, 16, 16])
        np.testing.assert_allclose(rows[0, 4:14], np.arange(10)*.8, atol=1e-5)
        self.assertAlmostEqual(rows[0, -1], .8)

    def test_no_candidates_above_threshold(self):
        self.assertEqual(decode_level(np.zeros((2, 1)), np.zeros((2, 4)), np.zeros((2, 10)), 8, 8, 8, .5).shape, (0, 15))

    def test_evidence_for_neighbor_or_large_head_cannot_verify_an_ear(self):
        head = np.array([100, 100, 200, 300])
        self.assertTrue(supported_face(head, [np.array([110, 105, 190, 295])]))
        self.assertFalse(supported_face(head, [np.array([400, 100, 200, 300])]))
        self.assertFalse(supported_face(np.array([280, 220, 30, 40]), [head]))

    def test_scrfd_runs_and_keeps_faces_even_when_yunet_has_no_candidate(self):
        detector = VerifiedFaceDetector.__new__(VerifiedFaceDetector)
        detector.yunet = Mock();detector.scrfd = Mock()
        detector.yunet.detect.return_value = (None,None)
        detector.scrfd.detect.return_value = (None,np.array([row(score=.82)]))
        _,rows = detector.detect(np.zeros((320,320,3),np.uint8))
        detector.scrfd.detect.assert_called_once()
        self.assertEqual(len(rows),1)
        self.assertEqual(detector.evidence[0]['evidenceMode'],'scrfd')
        self.assertTrue(detector.evidence[0]['detectorVerified'])

    def test_mesh_can_still_confirm_a_face_seen_only_by_yunet(self):
        rows,evidence = fuse_faces([row()],None)
        self.assertEqual(len(rows),1)
        self.assertFalse(evidence[0]['detectorVerified'])
        self.assertEqual(evidence[0]['evidenceMode'],'yunet')

    def test_exposure_retry_merges_faces_without_duplicate_or_temporal_confirmation(self):
        detector = VerifiedFaceDetector.__new__(VerifiedFaceDetector)
        detector.yunet = Mock();detector.scrfd = Mock()
        detector.yunet.detect.side_effect = [(None,np.array([row()])),(None,np.array([row(102)]))]
        detector.scrfd.detect.side_effect = [(None,None),(None,np.array([row(103),row(350)]))]
        with patch('scrfd.enhance_low_light',return_value=np.ones((320,320,3),np.uint8)):
            _,rows = detector.detect(np.zeros((320,320,3),np.uint8))
        self.assertEqual(len(rows),2)
        self.assertEqual([item['evidenceMode'] for item in detector.evidence],['dual','scrfd'])
        self.assertTrue(all(item['enhanced'] for item in detector.evidence))
        self.assertTrue(all('detectionHits' not in item for item in detector.evidence))

    def test_exposure_retry_preserves_already_verified_raw_geometry(self):
        detector = VerifiedFaceDetector.__new__(VerifiedFaceDetector)
        detector.yunet = Mock();detector.scrfd = Mock()
        detector.yunet.detect.side_effect = [(None,np.array([row()])),(None,np.array([row(110)]))]
        detector.scrfd.detect.side_effect = [(None,np.array([row()])),(None,np.array([row(112)]))]
        with patch('scrfd.enhance_low_light',return_value=np.ones((320,320,3),np.uint8)):
            _,rows = detector.detect(np.zeros((320,320,3),np.uint8))
        np.testing.assert_array_equal(rows,np.array([row()]))
        self.assertNotIn('enhanced',detector.evidence[0])

    def test_one_verified_bright_face_does_not_skip_scrfd_recovery_of_a_dark_neighbor(self):
        detector = VerifiedFaceDetector.__new__(VerifiedFaceDetector)
        detector.yunet = Mock();detector.scrfd = Mock()
        detector.yunet.detect.side_effect = [(None,None),(None,np.array([row()]))]
        detector.scrfd.detect.side_effect = [(None,np.array([row(score=.7)])),(None,np.array([row(score=.7),row(350)]))]
        with patch('scrfd.enhance_low_light',return_value=np.ones((320,320,3),np.uint8)):
            _,rows = detector.detect(np.zeros((320,320,3),np.uint8))
        self.assertEqual(len(rows),2)
        self.assertTrue(detector.evidence[0]['detectorVerified'])
        self.assertEqual(detector.evidence[0]['evidenceMode'],'dual')
        self.assertEqual(detector.scrfd.detect.call_count,2)

    def test_consensus_keeps_yunet_anchors_and_does_not_duplicate_two_people(self):
        first = np.array([row(),row(350)])
        rows,evidence = fuse_faces(first,[row(354,.8),row(105,.7)])
        np.testing.assert_array_equal(rows,first)
        self.assertEqual(len(evidence),2)
        self.assertTrue(all(item['detectorVerified'] for item in evidence))

    def test_weak_or_malformed_independent_evidence_cannot_bypass_mesh(self):
        malformed = row(score=.9);malformed[4:14]=0
        for independent in [row(score=.54),malformed]:
            _,evidence = fuse_faces([row()], [independent])
            self.assertFalse(evidence[0]['detectorVerified'])
        _,evidence = fuse_faces([row(score=.68)], [row()])
        self.assertFalse(evidence[0]['detectorVerified'])

    def test_one_scrfd_face_cannot_verify_two_yunet_candidates(self):
        rows,evidence = fuse_faces([row(),row(102)],[row(101)])
        self.assertEqual(len(rows),2)
        self.assertEqual(sum(item['detectorVerified'] for item in evidence),1)


if __name__ == '__main__':
    unittest.main()
