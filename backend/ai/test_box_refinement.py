import math
import unittest
import numpy as np
from box_refinement import BoxRefinement


def centered(width, height=.4, cx=.5, cy=.5):
    return dict(x=cx-width/2, y=cy-height/2, width=width, height=height)


class BoxRefinementTests(unittest.TestCase):
    def test_scale_noise_is_reduced_without_freezing_real_zoom(self):
        refinement = BoxRefinement('person', 0.)
        box = centered(.3)
        widths = [box['width']]
        raw_steps = []
        for i in range(120):
            step = .008 if i % 2 else -.008
            measured = centered(box['width']*math.exp(step), box['height']*math.exp(step))
            box = refinement.motion(box, measured, 1/30)
            widths.append(box['width'])
            raw_steps.append(step)
        steps = np.diff(np.log(widths))
        self.assertLess(np.std(steps), np.std(raw_steps)*.3)
        self.assertLess(max(abs(np.array(widths)/.3-1)), .015)

        # A real approach must still grow the box, then a retreat shrink it.
        start = box['width']
        for _ in range(30):
            box = refinement.motion(box, centered(box['width']*1.007, box['height']*1.007), 1/30)
        self.assertGreater(box['width']/start, 1.19)
        for _ in range(30):
            box = refinement.motion(box, centered(box['width']/1.007, box['height']/1.007), 1/30)
        self.assertLess(abs(box['width']/start-1), .035)

    def test_detector_corrections_settle_fast_without_overshoot(self):
        for kind in ('person', 'face', 'object'):
            with self.subTest(kind=kind):
                refinement = BoxRefinement(kind, 0.)
                box = centered(.3)
                target = centered(.2, .3, .54, .48)
                for _ in range(15):
                    box = refinement.update(box, target, 1/30)
                    # First-order convergence must never overshoot target center.
                    self.assertLessEqual(box['x'] + box['width']/2, .54 + 1e-9)
                    self.assertGreaterEqual(box['y'] + box['height']/2, .48 - 1e-9)
                self.assertLess(abs(box['width']/target['width']-1), .05)
                self.assertLess(abs(box['x']+box['width']/2-.54), .004)

    def test_correction_preserves_measured_translation_starts_stops_and_reversals(self):
        refinement = BoxRefinement('person', 0.)
        box = centered(.2)
        for dx in [0.]*5+[.01]*10+[0.]*5+[-.01]*10:
            measured = dict(box, x=box['x']+dx)
            carried = refinement.motion(box, measured, 1/30)
            shown = refinement.update(carried, carried, 1/30)
            self.assertAlmostEqual(shown['x']+shown['width']/2,
                                   box['x']+box['width']/2+dx, places=12)
            box = shown

    def test_large_real_displacement_snaps_without_lag(self):
        refinement = BoxRefinement('person', 0.)
        box = centered(.2, .4, .3, .5)
        target = centered(.2, .4, .55, .5)
        shown = refinement.update(box, target, 1/30)
        self.assertAlmostEqual(shown['x'] + shown['width']/2, .55, places=6)


if __name__ == '__main__':
    unittest.main()
