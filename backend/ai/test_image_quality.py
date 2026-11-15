import unittest
from pathlib import Path
import cv2
import numpy as np
from image_quality import face_quality, enhance_low_light
from face_validation import face_is_publishable, landmark_confirmation


class ImageQualityTests(unittest.TestCase):
    def setUp(self):
        self.frame = cv2.imread(str(Path(__file__).resolve().parents[1]/'test-fixtures/portrait.jpg'))
        self.box = [.37,.07,.24,.27]

    def test_quality_reports_underexposure_and_blur_without_deciding_detection(self):
        self.assertTrue(face_quality(self.frame,self.box)['usable'])
        dark = (self.frame*.1).astype(np.uint8)
        self.assertEqual(face_quality(dark,self.box)['reason'],'too_dark')
        blur = cv2.GaussianBlur(self.frame,(0,0),20)
        self.assertFalse(face_quality(blur,self.box)['usable'])

    def test_noise_in_a_dark_frame_does_not_look_like_reliable_detail(self):
        noise = np.random.default_rng(2).integers(0,30,self.frame.shape,dtype=np.uint8)
        quality = face_quality(noise,self.box)
        self.assertFalse(quality['usable'])
        self.assertEqual(quality['reason'],'too_dark')

    def test_quality_warning_does_not_veto_matching_detector_and_mesh_evidence(self):
        face = dict(id=1,box=self.box,score=.99,detectorVerified=True,evidenceMode='dual',detectedAt=950,
                    quality=dict(usable=False,reason='blurred'))
        mesh = dict(facePresent=True,valid=True,faceBox=self.box,observedAt=990)
        self.assertTrue(face_is_publishable(face,[face],mesh,1000))
        self.assertEqual(landmark_confirmation(face,[face],mesh,1000)['at'],990)
        # A photometric retry does not relax landmark matching or freshness.
        face['detectorVerified'] = False
        mesh['faceBox'] = [.75,.75,.1,.1]
        self.assertFalse(face_is_publishable(face,[face],mesh,1000))

    def test_enhancement_preserves_coordinates_and_skips_normal_or_empty_images(self):
        bright = np.random.default_rng(3).integers(100,220,self.frame.shape,dtype=np.uint8)
        self.assertIsNone(enhance_low_light(bright))
        self.assertIsNone(enhance_low_light(np.zeros_like(self.frame)))
        dark = (self.frame*.1).astype(np.uint8)
        enhanced = enhance_low_light(dark)
        self.assertEqual(enhanced.shape,dark.shape)
        self.assertEqual(enhanced.dtype,np.uint8)
        self.assertGreater(float(enhanced.mean()),float(dark.mean())*3)
        self.assertTrue(np.array_equal(dark,(self.frame*.1).astype(np.uint8)))
