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

    def test_detector_corrections_settle_for_every_layer(self):
        for kind in ('person', 'face', 'object'):
            with self.subTest(kind=kind):
                refinement = BoxRefinement(kind, 0.)
                box = centered(.3)
                target = centered(.2, .3, .54, .48)
                for _ in range(45):
                    old = box
                    box = refinement.update(box, target, 1/30)
                    self.assertLess(abs(math.log(box['width']/old['width'])), .045)
                self.assertLess(abs(box['width']/target['width']-1), .04)
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

    def test_detector_retarget_keeps_correction_velocity_continuous(self):
        jumps = []
        # A genuine velocity discontinuity remains when the integration step
        # shrinks. A continuous, accelerating correction converges instead.
        for dt in (.002, .001, .0005):
            refinement = BoxRefinement('person', 0.)
            box, target = centered(.3), centered(.22)
            widths = [box['width']]
            handoff = round(.05/dt)
            for i in range(handoff+3):
                if i == handoff:
                    newer = centered(.35)
                    refinement.observe(target, newer, .05)
                    target = newer
                box = refinement.update(box, target, dt)
                widths.append(box['width'])
            velocity = np.diff(np.log(widths))/dt
            jumps.append(max(abs(np.diff(velocity[handoff-1:handoff+2]))))
        self.assertLess(jumps[1], jumps[0]*.65)
        self.assertLess(jumps[2], jumps[1]*.65)


if __name__ == '__main__':
    unittest.main()
