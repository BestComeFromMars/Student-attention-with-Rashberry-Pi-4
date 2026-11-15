import unittest
from pathlib import Path
import cv2
import numpy as np
from onnx_vittrack import ONNXVitTrack
from geometry import iou


class VitTrackRuntimeTests(unittest.TestCase):
    def test_runtime_preserves_pretrained_opencv_boxes_and_confidence_on_independent_warps(self):
        root=Path(__file__).resolve().parents[1]
        path=root/'models/classroom/object_tracking_vittrack_2023sep.onnx'
        image=cv2.imread(str(root/'test-fixtures/faces/two-frontal-profile.jpg'))
        cv2.setNumThreads(1)
        for box in [(213,251,193,263),(835,226,175,305)]:
            for dx,scale in [(0,1),(25,1.12),(-25,.88)]:
                matrix=cv2.getRotationMatrix2D((box[0]+box[2]/2,box[1]+box[3]/2),0,scale)
                matrix[0,2]+=dx
                moved=cv2.warpAffine(image,matrix,(1280,720),borderValue=(220,220,220))
                params=cv2.TrackerVit_Params();params.net=str(path);params.tracking_score_threshold=.3
                native=cv2.TrackerVit_create(params)
                fast=ONNXVitTrack(path)
                native.init(image,box);fast.init(image,box)
                native_ok,native_box=native.update(moved)
                fast_ok,fast_box=fast.update(moved)
                self.assertEqual(native_ok,fast_ok)
                self.assertGreater(iou(native_box,fast_box),.95)
                self.assertAlmostEqual(native.getTrackingScore(),fast.getTrackingScore(),delta=.01)

    def test_tracks_and_reinitializations_share_graph_but_not_templates_or_rectangles(self):
        root=Path(__file__).resolve().parents[1]
        path=root/'models/classroom/object_tracking_vittrack_2023sep.onnx'
        image=cv2.imread(str(root/'test-fixtures/faces/two-frontal-profile.jpg'))
        first,second=ONNXVitTrack(path),ONNXVitTrack(path)
        self.assertIs(first.session,second.session)
        first.init(image,(213,251,193,263));second.init(image,(835,226,175,305))
        template=second.template.copy();box=second.box
        first.init(image,(200,240,180,260));first.update(image)
        self.assertIs(first.session,second.session)
        np.testing.assert_array_equal(second.template,template)
        self.assertEqual(second.box,box)
