import unittest

from evaluate_realtime_replay import associate, boxes_for, evaluate


class RealtimeCoverageTests(unittest.TestCase):
    def test_one_face_cannot_match_two_overlapping_reference_people(self):
        regions = [(0, 0, 70, 70), (20, 20, 90, 90)]
        self.assertEqual(associate(regions, [dict(x=.3, y=.3, width=.2, height=.2)], 'faces', 100, 100), 1)

    def test_body_without_a_face_is_not_counted_as_a_detected_face(self):
        body = dict(x=.1, y=.1, width=.5, height=.8)
        data = dict(tracks=[dict(status='visible', box=body, personBox=body, boxKind='person', faceVisibility='unavailable')])
        self.assertEqual(boxes_for(data, False), dict(people=[body], faces=[]))

    def test_display_coverage_uses_the_actual_display_rectangle(self):
        raw, shown = dict(x=.1, y=.1, width=.2, height=.2), dict(x=.15, y=.15, width=.2, height=.2)
        data = dict(tracks=[dict(status='visible', box=raw, faceBox=raw, displayBoxes=dict(face=shown))])
        self.assertEqual(boxes_for(data, False)['faces'], [raw])
        self.assertEqual(boxes_for(data, True)['faces'], [shown])

    def test_startup_and_empty_ai_results_remain_in_the_coverage_denominator(self):
        regions = {1: [(0, 0, 100, 100)], 2: [(0, 0, 100, 100)]}
        data = dict(tracks=[dict(status='visible', boxKind='face', box=dict(x=.2, y=.2, width=.2, height=.2))])
        totals = evaluate([(1, {}), (2, data)], regions, dict(width=100, height=100), True)['totals']['faces']
        self.assertEqual(totals['spatialAssociationCoveragePct'], 50)
        self.assertEqual(totals['referenceRegions'], 2)


if __name__ == '__main__':
    unittest.main()
