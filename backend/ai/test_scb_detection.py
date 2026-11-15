import unittest
import cv2
import numpy as np
from scb_detection import prepare_image,decode
from scb_recognition import attach_actions
from evaluate_scb import match_counts

class SCBDetectionTests(unittest.TestCase):
    def test_letterbox_and_class_scores_keep_reading_and_writing_independent(self):
        tensor,transform=prepare_image(np.zeros((100,200,3),np.uint8))
        self.assertEqual(tensor.shape,(1,3,640,640))
        rows=np.array([[[320,320,320,160,.8,.1,.75,.625]]],np.float32)
        result=decode(rows,transform)
        self.assertEqual({r['type'] for r in result},{'read','take_notes'})
        np.testing.assert_allclose(result[0]['box'],[.25,.25,.5,.5],atol=1e-6)
    def test_objectness_multiplies_class_score_instead_of_treating_it_as_yolo11_output(self):
        _,transform=prepare_image(np.zeros((640,640,3),np.uint8))
        rows=np.array([[[320,320,100,100,.1,.9,.9,.9]]],np.float32)
        self.assertEqual(decode(rows,transform),[])
    def test_one_detection_cannot_be_attached_to_two_overlapping_students(self):
        bodies=[dict(id=1,box=[.1,.1,.4,.7]),dict(id=2,box=[.11,.1,.4,.7])]
        result=attach_actions(bodies,[dict(type='read',box=[.1,.1,.4,.7],confidence=.9)],1000)
        self.assertEqual(result[1][1]['state'],'unavailable');self.assertEqual(result[2][1]['state'],'unavailable')
    def test_face_visibility_is_not_required_for_body_action_but_id_ownership_is(self):
        bodies=[dict(id=7,box=[.1,.1,.4,.7])]
        result=attach_actions(bodies,[dict(type='read',box=[.1,.1,.4,.7],confidence=.9)],1000)
        self.assertEqual(result[7][1]['state'],'pending');self.assertEqual(result[7][1]['source'],'SCB-YOLOv7')
        self.assertEqual(result[7][2]['state'],'clear');self.assertEqual(result[7][1]['observedAt'],1000)
    def test_duplicate_or_missing_boxes_cannot_raise_validation_score(self):
        box=[.1,.1,.4,.7]
        result=match_counts([(1,box),(1,[.6,.1,.3,.6])],[dict(classId=1,box=box),dict(classId=1,box=box)],1)
        self.assertEqual((result['tp'],result['fp'],result['fn']),(1,1,1))

if __name__=='__main__':unittest.main()
