import unittest
from export_video_io import evaluate, metrics


class VideoEvaluationTests(unittest.TestCase):
    def test_unknown_and_missing_instances_are_not_counted_as_correct_predictions(self):
        ground=[dict(x1=0,y1=0,x2=100,y2=100,status='Focused'),
                dict(x1=100,y1=0,x2=200,y2=100,status='Distracted'),
                dict(x1=200,y1=0,x2=300,y2=100,status='Focused')]
        tracks=[dict(status='visible',attention='focused',box=dict(x=.05,y=.1,width=.1,height=.1)),
                dict(status='visible',attention='uncertain',box=dict(x=.4,y=.1,width=.1,height=.1))]
        result=metrics(evaluate(ground,tracks,300,100))
        self.assertEqual(result['gt'],3)
        self.assertEqual(result['matched'],2)
        self.assertEqual(result['unknown'],1)
        self.assertEqual(result['missed'],1)
        self.assertEqual(result['matchedStatusAccuracyPct'],100)
        self.assertAlmostEqual(result['endToEndCorrectPct'],33.333,places=3)

    def test_one_prediction_cannot_cover_two_labelled_students(self):
        ground=[dict(x1=0,y1=0,x2=100,y2=100,status='Focused')]*2
        tracks=[dict(status='visible',attention='focused',box=dict(x=.2,y=.2,width=.2,height=.2))]
        result=evaluate(ground,tracks,100,100)
        self.assertEqual(result['matched'],1)
        self.assertEqual(result['missed'],1)
        self.assertEqual(result['correct'],1)

    def test_lost_or_predicted_faces_do_not_match_ground_truth_as_visible(self):
        ground=[dict(x1=0,y1=0,x2=100,y2=100,status='Focused')]
        for status,mode in [('lost','body'),('visible','predicted')]:
            result=evaluate(ground,[dict(status=status,trackingState=mode,attention='focused',box=dict(x=.2,y=.2,width=.2,height=.2))],100,100)
            self.assertEqual(result['matched'],0)
            self.assertEqual(result['missed'],1)


if __name__=='__main__':unittest.main()
