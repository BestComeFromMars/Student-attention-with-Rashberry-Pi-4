import unittest
from face_validation import face_is_publishable, landmarks_match_box, needs_confirmation, landmark_confirmation, face_tracking_state


def face(identity, box, score=.95):
    return dict(id=identity, box=box, score=score)


class FaceValidationTests(unittest.TestCase):
    def test_small_detector_can_continue_only_a_recently_verified_face_and_cannot_renew_its_verification(self):
        known=dict(id=1,box=[.1,.2,.2,.3],score=.95,detectorVerified=True,
                   detectedAt=1000,verifiedAt=1000,missedAt=1100,missedScans=1,
                   fastFaceAt=1190,fastFaceScore=.60,fastFaceModel='SCRFD-500M')
        self.assertTrue(face_is_publishable(known,[known],{},1200))
        self.assertEqual(known['verifiedAt'],1000)
        self.assertFalse(face_is_publishable(dict(known,fastFaceScore=.599),[known],{},1200))
        self.assertFalse(face_is_publishable(dict(known,verifiedAt=-1000),[known],{},1200))

    def test_current_fast_detection_recovers_verified_face_without_reusing_stale_behavior(self):
        known=dict(id=1,box=[.1,.2,.2,.3],score=.95,detectorVerified=True,
                   evidenceMode='dual',detectedAt=1000,missedAt=1100,missedScans=1,fastFaceAt=1190,fastFaceScore=.94)
        missing=dict(valid=False,facePresent=False,observedAt=1050)
        self.assertTrue(face_is_publishable(known,[known],missing,1200))
        self.assertIs(missing['valid'],False)
        for change in [dict(fastFaceAt=1090),dict(fastFaceAt=900),dict(detectorVerified=False),dict(detectedAt=-500)]:
            bad=dict(known,**change)
            self.assertFalse(face_is_publishable(bad,[bad],missing,1200))

    def test_one_native_miss_keeps_only_the_old_rectangle_for_at_most_250ms(self):
        track=dict(visualAt=1000,visualLostAt=1050,missedScans=0)
        for now in (1050,1150,1250):
            self.assertEqual(face_tracking_state(track,False,1000,now),'coasting')
        self.assertEqual(face_tracking_state(track,False,1000,1251),'predicted')
        self.assertEqual(track['visualAt'],1000,'held frames cannot renew the last native update')
        self.assertIsNone(face_tracking_state(track,False,None,1100),'a new candidate cannot inherit a held box')
        self.assertEqual(face_tracking_state(dict(track,missedScans=1,missedAt=1090),False,1000,1100),'predicted')

    def test_background_optical_flow_cannot_keep_a_face_visible_after_a_negative_rescan(self):
        stale=dict(visualAt=1500,missedAt=1450,missedScans=1)
        self.assertEqual(face_tracking_state(stale,False,1000,1500),'predicted')
        self.assertEqual(face_tracking_state(dict(stale,bodyAt=1400),False,1000,1500),'body')
        self.assertIsNone(face_tracking_state(stale,False,None,1500))
        self.assertEqual(face_tracking_state(dict(visualAt=1500),False,1000,1500),'visual')
        self.assertEqual(face_tracking_state(dict(visualAt=3200),False,1000,3200),'predicted')

    def test_negative_rescan_overrides_old_positive_detector_and_cached_mesh(self):
        known=dict(id=1,box=[.1,.2,.2,.3],score=.95,detectorVerified=True,
                   evidenceMode='dual',detectedAt=1000,missedAt=1450,missedScans=1)
        cached=dict(valid=True,facePresent=True,observedAt=1100,faceBox=list(known['box']))
        self.assertFalse(face_is_publishable(known,[known],cached,1500))
        fresh=dict(cached,observedAt=1480)
        self.assertTrue(face_is_publishable(known,[known],fresh,1500))

    def setUp(self):
        # Proportions from the reported frame: a 238x312 face and a 42x60 ear.
        self.head = face(1, [.302, .292, .235, .429])
        self.ear = face(2, [.549, .475, .041, .083], .92)
        self.faces = [self.head, self.ear]

    def test_ear_beside_a_larger_face_waits_for_landmark_confirmation(self):
        self.assertTrue(needs_confirmation(self.ear, self.faces))
        self.assertFalse(face_is_publishable(self.ear, self.faces, {}, 1000))
        self.assertFalse(face_is_publishable(self.ear, self.faces,
            dict(facePresent=False, observedAt=900), 1000))
        self.assertFalse(face_is_publishable(self.head, self.faces, {}, 1000))

    def test_confirmation_is_for_the_face_not_its_behavior_pixel_threshold(self):
        observation = dict(facePresent=True, valid=False, facePixels=32, observedAt=900, faceBox=self.ear['box'])
        self.assertTrue(face_is_publishable(self.ear, self.faces, observation, 1000))
        # A behavioral measurement without a matching mesh does not verify a face.
        self.assertFalse(face_is_publishable(self.ear, self.faces,
            dict(valid=True, observedAt=900), 1000))

    def test_stale_or_future_confirmation_cannot_reveal_a_suspect_box(self):
        for at in [-1001, 1001]:
            self.assertFalse(face_is_publishable(self.ear, self.faces,
                dict(facePresent=True, observedAt=at, faceBox=self.ear['box']), 1000))

    def test_confident_small_classroom_faces_and_adjacent_students_remain_visible(self):
        small = face(3, [.72, .48, .02, .04], .91)
        adjacent = face(4, [.55, .3, .21, .42], .94)
        for candidate in [small, adjacent]:
            self.assertFalse(needs_confirmation(candidate, self.faces + [candidate]))
            self.assertFalse(face_is_publishable(candidate, self.faces + [candidate], {}, 1000))
            self.assertTrue(face_is_publishable(candidate, self.faces + [candidate],
                dict(facePresent=True, observedAt=950, faceBox=candidate['box']), 1000))

    def test_low_confidence_is_verified_even_without_a_larger_face(self):
        candidate = face(1, [.3, .3, .2, .3], .70)
        self.assertFalse(face_is_publishable(candidate, [candidate], {}, 1000))
        self.assertTrue(face_is_publishable(candidate, [candidate],
            dict(facePresent=True, observedAt=1000, faceBox=candidate['box']), 1000))

    def test_high_confidence_object_still_requires_a_matching_mesh(self):
        obj = face(9, [.6, .2, .2, .3], .999)
        self.assertFalse(face_is_publishable(obj, [obj], {}, 1000))
        self.assertFalse(face_is_publishable(obj, [obj],
            dict(facePresent=True, observedAt=950, faceBox=[.1, .2, .2, .3]), 1000))

    def test_known_face_can_keep_its_box_briefly_without_inventing_behavior(self):
        self.head['detectedAt'] = 950
        missing = dict(facePresent=False,valid=False,observedAt=980,faceBox=self.head['box'])
        confirmation = dict(at=800,box=self.head['box'])
        self.assertTrue(face_is_publishable(self.head,self.faces,missing,1000,confirmation))
        self.assertIs(missing['valid'],False)
        self.assertIs(missing['facePresent'],False)
        self.assertFalse(face_is_publishable(self.head,self.faces,missing,1000))

    def test_retained_confirmation_expires_and_requires_current_detection_and_matching_position(self):
        self.head['detectedAt'] = 950
        for confirmation in [dict(at=-201,box=self.head['box']),dict(at=1001,box=self.head['box']),
                             dict(at=900,box=[.8,.2,.1,.2])]:
            self.assertFalse(face_is_publishable(self.head,self.faces,{},1000,confirmation))
        self.head['detectedAt'] = 200
        self.assertFalse(face_is_publishable(self.head,self.faces,{},1000,dict(at=950,box=self.head['box'])))

    def test_verified_profile_preserves_side_view_actions_but_cannot_confirm_an_ear(self):
        for candidate, expected in [(self.head, True), (self.ear, False)]:
            observation = dict(facePresent=False, mouthSource='profile_roi', observedAt=950, faceBox=candidate['box'])
            self.assertEqual(face_is_publishable(candidate, self.faces, observation, 1000), expected)

    def test_landmarks_must_belong_to_the_requested_box(self):
        self.assertTrue(landmarks_match_box([.3, .2, .2, .3], [.29, .18, .23, .34]))
        self.assertTrue(landmarks_match_box([.3, .2, .2, .3], [.33, .22, .12, .25]))
        for box in [[.51, .2, .2, .3], [.30, .20, .02, .03], [.1, .1, .8, .8],
                    [.3, .2, float('nan'), .3]]:
            self.assertFalse(landmarks_match_box([.3, .2, .2, .3], box))

    def test_independent_detector_consensus_can_display_a_face_without_behavior_landmarks(self):
        candidate = dict(face(1,[.3,.2,.2,.3],.79),detectorVerified=True,evidenceMode='dual',detectedAt=950)
        missing = dict(facePresent=False,valid=False,observedAt=980,faceBox=candidate['box'])
        self.assertTrue(face_is_publishable(candidate,[candidate],missing,1000))
        self.assertIs(missing['valid'],False)
        self.assertIsNone(landmark_confirmation(candidate,[candidate],missing,1000))
        for detected in [-201,1001]:
            candidate['detectedAt'] = detected
            self.assertFalse(face_is_publishable(candidate,[candidate],missing,1000))

    def test_single_detector_requires_two_actual_rescans_and_weak_evidence_waits_for_mesh(self):
        candidate = dict(face(1,[.3,.2,.2,.3],.82),detectorVerified=True,evidenceMode='scrfd',detectedAt=950,detectionHits=1)
        self.assertFalse(face_is_publishable(candidate,[candidate],{},1000))
        candidate['detectionHits'] = 2
        self.assertTrue(face_is_publishable(candidate,[candidate],{},1000))
        candidate.update(detectorVerified=False,evidenceMode='dual',detectionHits=100)
        self.assertFalse(face_is_publishable(candidate,[candidate],{},1000))

    def test_consensus_cannot_bypass_the_ear_check(self):
        self.ear.update(detectorVerified=True,evidenceMode='dual',detectedAt=950,detectionHits=10)
        self.assertFalse(face_is_publishable(self.ear,self.faces,{},1000))
        matching = dict(facePresent=True,observedAt=990,faceBox=self.ear['box'])
        self.assertTrue(face_is_publishable(self.ear,self.faces,matching,1000))

    def test_detector_evidence_does_not_refresh_mismatched_or_missing_landmarks(self):
        self.head.update(detectorVerified=True,evidenceMode='dual',detectedAt=950)
        for observation in [dict(facePresent=False,observedAt=990,faceBox=self.head['box']),
                            dict(facePresent=True,observedAt=990,faceBox=self.ear['box']),
                            dict(facePresent=True,observedAt=-1001,faceBox=self.head['box'])]:
            self.assertTrue(face_is_publishable(self.head,self.faces,observation,1000))
            self.assertIsNone(landmark_confirmation(self.head,self.faces,observation,1000))

    def test_mesh_without_strong_detector_support_needs_independent_body_evidence(self):
        candidate = dict(face(1,[.3,.2,.03,.08],.73),evidenceMode='yunet',detectedAt=950)
        mesh = dict(facePresent=True,observedAt=990,faceBox=candidate['box'])
        self.assertFalse(face_is_publishable(candidate,[candidate],mesh,1000))
        self.assertIsNone(landmark_confirmation(candidate,[candidate],mesh,1000))
        mesh.update(personId=7,objectsAt=900)
        self.assertTrue(face_is_publishable(candidate,[candidate],mesh,1000))
        for at in [-4001,1001]:
            mesh['objectsAt'] = at
            self.assertFalse(face_is_publishable(candidate,[candidate],mesh,1000))
        # A weak second detector result cannot verify a printed face either.
        candidate['evidenceMode'] = 'dual'
        self.assertFalse(face_is_publishable(candidate,[candidate],mesh,1000))
        candidate.update(evidenceMode='yunet',score=.97)
        self.assertFalse(face_is_publishable(candidate,[candidate],mesh,1000))
        candidate.update(evidenceMode='dual',detectorVerified=True)
        self.assertTrue(face_is_publishable(candidate,[candidate],mesh,1000))

    def test_large_clear_mesh_does_not_wait_for_slow_or_missing_body_analysis(self):
        candidate = dict(face(1,[.55,.2,.2,.3],.94),evidenceMode='yunet',facePixels=256,detectedAt=950)
        mesh = dict(facePresent=True,valid=True,observedAt=990,faceBox=candidate['box'])
        for body in [{},dict(personId=2,objectsAt=-6000)]:
            self.assertTrue(face_is_publishable(candidate,[candidate],dict(mesh,**body),1000))
        for change in [dict(facePixels=45),dict(score=.73)]:
            weak = dict(candidate,**change)
            self.assertFalse(face_is_publishable(weak,[weak],mesh,1000))
        for change in [dict(observedAt=-2000),dict(faceBox=[.1,.2,.2,.3]),dict(facePresent=False)]:
            self.assertFalse(face_is_publishable(candidate,[candidate],dict(mesh,**change),1000))


if __name__ == '__main__':
    unittest.main()
