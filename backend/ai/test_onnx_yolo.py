import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace
import numpy as np
from onnx_yolo import ONNXRuntimeYOLO


class RuntimeDecoderTests(unittest.TestCase):
    def test_cpu_session_uses_same_letterbox_coordinates_classes_and_confidence(self):
        row = np.zeros((1,84,1),np.float32)
        row[0,:4,0] = [320,320,128,128]
        row[0,4+67,0] = .9
        session = Mock()
        session.get_inputs.return_value = [SimpleNamespace(name='images')]
        session.run.return_value = [row]
        with patch('onnx_yolo.ort.InferenceSession',return_value=session) as factory:
            model = ONNXRuntimeYOLO('unused.onnx')
        self.assertEqual(factory.call_args.kwargs['providers'],['CPUExecutionProvider'])
        result = model.predict(np.zeros((720,1280,3),np.uint8),classes=[67])[0]
        np.testing.assert_allclose(result.boxes.data.numpy()[0],[512,232,768,488,.9,67],atol=.01)
        blob = session.run.call_args.args[1]['images']
        self.assertEqual(blob.shape,(1,3,640,640))
        self.assertIsNone(model.net.blob)

    def test_pose_session_preserves_wrist_coordinates_and_keypoint_confidence(self):
        row = np.zeros((1,56,1),np.float32)
        row[0,:5,0] = [320,320,128,128,.9]
        row[0,5:,0] = np.tile([320,320,.95],17)
        session = Mock()
        session.get_inputs.return_value = [SimpleNamespace(name='images')]
        session.run.return_value = [row]
        with patch('onnx_yolo.ort.InferenceSession',return_value=session):
            model = ONNXRuntimeYOLO('unused.onnx',pose=True)
        result = model.predict(np.zeros((720,1280,3),np.uint8))[0]
        np.testing.assert_allclose(result.keypoints.data.numpy()[0,9],[640,360,.95],atol=.01)


if __name__=='__main__':
    unittest.main()
