import unittest
from unittest.mock import patch
from action_evaluation import score_frame,summarize

BOX=dict(x=.1,y=.1,width=.4,height=.7)
class ActionScoringTests(unittest.TestCase):
    def test_missing_and_uncertain_people_cannot_inflate_the_percentage(self):
        ground=[dict(box=BOX,labels=['read'])]
        for tracks in ([],[dict(status='visible',personBox=BOX,actions=[dict(type='read',state='unavailable',observedAt=1000)])]):
            result=summarize(score_frame(ground,tracks,1000,['read']))
            self.assertEqual(result['labels']['read']['fn'],1);self.assertEqual(result['macroF1Pct'],0);self.assertFalse(result['passed'])
    def test_one_person_can_have_multiple_actions_and_future_evidence_is_not_accepted(self):
        ground=[dict(box=BOX,labels=['sit','read'])]
        track=dict(status='visible',personBox=BOX,actions=[dict(type=c,state='confirmed',observedAt=1000) for c in ['sit','read']])
        self.assertTrue(summarize(score_frame(ground,[track],1000,['sit','read']))['passed'])
        self.assertFalse(summarize(score_frame(ground,[track],999,['sit','read']))['passed'])
    def test_a_face_rectangle_cannot_be_scored_as_a_complete_person_box(self):
        ground=[dict(box=BOX,labels=['read'])]
        face=dict(status='visible',box=dict(x=.15,y=.12,width=.1,height=.1),actions=[dict(type='read',state='confirmed',observedAt=1000)])
        self.assertEqual(score_frame(ground,[face],1000,['read'])['read']['tp'],0)
    def test_matching_does_not_sacrifice_a_valid_pair_to_two_invalid_pairs(self):
        ground=[dict(box=BOX,labels=['read']) for _ in range(2)]
        tracks=[dict(status='visible',personBox=BOX,actions=[dict(type='read',state='confirmed',observedAt=1000)]) for _ in range(2)]
        with patch('action_evaluation.overlap',side_effect=[.49,.51,0,.49]):
            row=score_frame(ground,tracks,1000,['read'])['read']
        self.assertEqual((row['tp'],row['fp'],row['fn']),(1,1,1))

if __name__=='__main__':unittest.main()
