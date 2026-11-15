import unittest
from encode_decision_video import frame_decisions


class DecisionTimingTests(unittest.TestCase):
    def test_native_frames_keep_the_last_completed_decision_without_anticipating_a_future_result(self):
        decisions=[dict(sourceSeconds=.35),dict(sourceSeconds=1.15),dict(sourceSeconds=1.8)]
        actual=list(frame_decisions(decisions,10,20))
        self.assertEqual(actual,[-1]*4+[0]*8+[1]*6+[2]*2)

    def test_no_decision_keeps_every_video_frame_and_empty_decisions_still_replace_the_previous_boxes(self):
        self.assertEqual(list(frame_decisions([],29.97,533)),[-1]*533)
        decisions=[dict(sourceSeconds=0,tracks=[1]),dict(sourceSeconds=1,tracks=[])]
        self.assertEqual(list(frame_decisions(decisions,2,5)),[0,0,1,1,1])
