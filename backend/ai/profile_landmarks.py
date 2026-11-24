"""Reuse the bundled landmark network on a verified YuNet region when face search fails."""
from types import SimpleNamespace
from zipfile import ZipFile
import cv2
import mediapipe as mp
import numpy as np
from mediapipe.framework import calculator_pb2
from mediapipe.framework.formats import rect_pb2
from mediapipe.tasks.cc.vision.face_landmarker.proto import face_landmarks_detector_graph_options_pb2 as graph_options
from mediapipe.python._framework_bindings import task_runner
from mediapipe.python import packet_creator, packet_getter
from face_validation import landmarks_match_box


def profile_yaw(face, minimum=30):
    anchors = np.asarray(face.get('anchors', []), np.float64)
    if anchors.shape != (5, 2) or not np.isfinite(anchors).all():
        return None
    eyes = anchors[1]-anchors[0]
    span2 = float(eyes@eyes)
    if span2 < 12:
        return None
    offset = float((anchors[2]-(anchors[0]+anchors[1])/2)@eyes/span2)
    # This is a signed orientation proxy from SCRFD/YuNet anchors, not a calibrated
    # head angle. It is used only when the full pose model is unavailable.
    yaw = float(np.clip(offset*90, -75, 75))
    return yaw if abs(yaw) >= minimum else None


def profile_pitch(face):
    anchors = np.asarray(face.get('anchors', []), np.float64)
    if anchors.shape != (5, 2) or not np.isfinite(anchors).all():
        return None
    eye_mid = (anchors[0] + anchors[1]) / 2.0
    mouth_mid = (anchors[3] + anchors[4]) / 2.0
    vertical = float(mouth_mid[1] - eye_mid[1])
    if vertical < 4.0:
        return None
    nose_ratio = float((anchors[2][1] - eye_mid[1]) / vertical)
    # Neutral upright face places nose around ~0.46 of eye-to-mouth vertical span;
    # bowing the head pushes the nose down toward the mouth (> 0.60).
    return float(np.clip((nose_ratio - 0.46) * 115.0, -45.0, 60.0))


def matched_profile(face, points, width, height):
    xy = np.asarray([[point.x*width, point.y*height] for point in points])
    if len(xy) < 468 or not np.isfinite(xy).all():
        return False
    mn, mx = xy.min(axis=0), xy.max(axis=0)
    measured = [mn[0]/width, mn[1]/height, (mx[0]-mn[0])/width, (mx[1]-mn[1])/height]
    if not landmarks_match_box(face['box'], measured):
        return False
    anchors = np.asarray(face['anchors'])
    mouth = (xy[13]+xy[14])/2
    # A high presence score can still fit a mesh to the cheek/eye in profile.
    # Both the actual nose and lips must agree with independently detected anchors.
    tolerance = face['box'][2]*width*.2
    return bool(np.linalg.norm(mouth-anchors[3:].mean(axis=0)) <= tolerance and
                np.linalg.norm(xy[1]-anchors[2]) <= tolerance)


class ProfileLandmarker:
    def __init__(self, model_path):
        with ZipFile(model_path) as bundle:
            weights = bundle.read('face_landmarks_detector.tflite')
        options = graph_options.FaceLandmarksDetectorGraphOptions(min_detection_confidence=.7)
        options.base_options.model_asset.file_content = weights
        config = calculator_pb2.CalculatorGraphConfig(input_stream=['image', 'roi'],
                                                       output_stream=['landmarks', 'score'])
        node = config.node.add(calculator='mediapipe.tasks.vision.face_landmarker.SingleFaceLandmarksDetectorGraph',
            input_stream=['IMAGE:image', 'NORM_RECT:roi'],
            output_stream=['NORM_LANDMARKS:landmarks', 'PRESENCE_SCORE:score'])
        node.options.Extensions[graph_options.FaceLandmarksDetectorGraphOptions.ext].CopyFrom(options)
        self.runner = task_runner.TaskRunner.create(config)

    def detect(self, frame, face, state):
        rois = state.setdefault('profileRois', {})
        yaw = profile_yaw(face, 25 if face['id'] in rois else 30)
        if yaw is None or face.get('score', 0) < .65 or face['facePixels'] < 22:
            return None
        height, width = frame.shape[:2]
        x, y, w, h = face['box']
        image = packet_creator.create_image(mp.Image(image_format=mp.ImageFormat.SRGB,
            data=np.ascontiguousarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))))
        choices = [(1.1, .3, .1), (1., .3, .15), (1.2, .3, .15)]
        previous = rois.get(face['id'])
        order = ([previous] if previous is not None else []) + [i for i in range(len(choices)) if i != previous]
        for index in order:
            scale, shift, down = choices[index]
            size = max(w*width, h*height)*scale
            roi = rect_pb2.NormalizedRect(x_center=x+(.5+np.sign(yaw)*shift)*w,
                y_center=y+(.5+down)*h, width=size/width, height=size/height, rotation=0)
            output = self.runner.process({'image': image, 'roi': packet_creator.create_proto(roi)})
            if output['landmarks'].is_empty():
                continue
            points = packet_getter.get_proto(output['landmarks']).landmark
            if matched_profile(face, points, width, height):
                rois[face['id']] = index
                return SimpleNamespace(face_landmarks=[points], face_blendshapes=[],
                    facial_transformation_matrixes=[], yaw=yaw, source='profile_roi')
        return None

    def close(self):
        self.runner.close()
