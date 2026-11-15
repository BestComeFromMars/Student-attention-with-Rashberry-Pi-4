import unittest
import numpy as np
from opencv_yolo import OpenCVYOLO


class FakeNet:
    def __init__(self,rows):
        self.output=np.asarray(rows,np.float32).T[None]
    def setInput(self,blob):
        self.blob=blob
    def forward(self):
        return self.output


class DecoderTests(unittest.TestCase):
    def predictor(self,rows,pose=False):
        engine=OpenCVYOLO.__new__(OpenCVYOLO)
        engine.net=FakeNet(rows)
        engine.pose=pose
        return engine

    def row(self,cls,score=.9):
        row=np.zeros(84,np.float32)
        row[:4]=[320,320,128,128]
        row[4+cls]=score
        return row

    def test_filters_classes_and_removes_letterbox_padding(self):
        engine=self.predictor([self.row(0),self.row(67)])
        boxes=engine.predict(np.zeros((720,1280,3),np.uint8),classes=[0])[0].boxes.data.numpy()
        self.assertEqual(boxes.shape,(1,6))
        np.testing.assert_allclose(boxes[0,:4],[512,232,768,488],atol=.01)

    def test_suppresses_duplicates_per_class(self):
        engine=self.predictor([self.row(67,.9),self.row(67,.8),self.row(63,.85)])
        boxes=engine.predict(np.zeros((640,640,3),np.uint8),classes=[63,67])[0].boxes
        self.assertEqual(len(boxes),2)
        self.assertEqual(set(boxes.cls.numpy()),{63,67})

    def test_pose_wrist_coordinates_use_the_same_letterbox_transform(self):
        row=np.zeros(56,np.float32)
        row[:5]=[320,320,128,128,.9]
        row[5:]=np.tile([320,320,.95],17)
        result=self.predictor([row],pose=True).predict(np.zeros((720,1280,3),np.uint8))[0]
        np.testing.assert_allclose(result.keypoints.data.numpy()[0,9],[640,360,.95],atol=.01)


if __name__=='__main__':
    unittest.main()
