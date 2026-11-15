"""Run the pinned YOLO ONNX graphs with the existing letterbox/COCO decoder."""
import onnxruntime as ort
from native_runtime import export_serialized
from opencv_yolo import OpenCVYOLO


class _SessionNet:
    def __init__(self, path):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 1
        options.inter_op_num_threads = 1
        options.enable_cpu_mem_arena = False
        options.enable_mem_pattern = False
        options.add_session_config_entry('session.intra_op.allow_spinning', '0')
        options.add_session_config_entry('session.inter_op.allow_spinning', '0')
        self.session = ort.InferenceSession(str(path), sess_options=options, providers=['CPUExecutionProvider'])
        self.name = self.session.get_inputs()[0].name
        self.blob = None

    def setInput(self, blob):
        self.blob = blob

    @export_serialized
    def forward(self):
        try:
            return self.session.run(None, {self.name: self.blob})[0]
        finally:
            self.blob = None


class ONNXRuntimeYOLO(OpenCVYOLO):
    def __init__(self, path, pose=False):
        # Inherit the tested coordinate, class, NMS and wrist decoding exactly.
        self.net = _SessionNet(path)
        self.pose = pose
