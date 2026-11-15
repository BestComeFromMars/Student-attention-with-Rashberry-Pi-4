import tempfile
import unittest
from pathlib import Path
from demo_sources import sav_source,source_frame

class DemoSourceTests(unittest.TestCase):
    def test_a_trimmed_three_second_clip_cannot_claim_preceding_warmup(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,'20211212_04_510.mp4').touch()
            source=sav_source(directory,'20211212_04_510')
            self.assertFalse(source['causalWarmupAvailable'])
            self.assertEqual(source['preRollSeconds'],0)
    def test_original_uses_authors_cut_offset_and_real_earlier_frames(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory,'20211212_04.mp4').touch()
            source=sav_source(directory,'20211212_04_510')
            self.assertEqual(source['annotationOriginSeconds'],1019.5)
            self.assertEqual(source['sourceStartSeconds'],1016.5)
            self.assertEqual(source['sourceEndSeconds'],1022.5)
            self.assertTrue(source['causalWarmupAvailable'])
    def test_resampling_uses_the_latest_past_frame_instead_of_a_future_one(self):
        for tick in range(90):
            index=source_frame(0,tick,30,25)
            self.assertLessEqual(index/25,tick/30+1e-9)
            self.assertGreater((index+1)/25,tick/30)

if __name__=='__main__':unittest.main()
