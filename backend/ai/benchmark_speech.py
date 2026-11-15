"""Offline face measurements from a supplied video; never opens a camera or records audio."""
import argparse
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

# Ultralytics is imported by Perception, even though this benchmark loads only
# YuNet and the face landmarker, without YOLO or CavT weights.
ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault('YOLO_CONFIG_DIR', str(ROOT/'.tmp/ultralytics'))

import cv2
import mediapipe as mp
from geometry import FaceGeometry
from perception import Perception
from profile_landmarks import ProfileLandmarker


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--fps', type=float, default=15)
    args = parser.parse_args()
    if not 1 <= args.fps <= 30:
        parser.error('--fps must be between 1 and 30')
    video = cv2.VideoCapture(str(args.video))
    if not video.isOpened():
        raise ValueError('Cannot open supplied video')
    fps = video.get(cv2.CAP_PROP_FPS)
    if fps <= 0:
        video.release()
        raise ValueError('Video has no valid frame rate')
    cv2.setNumThreads(1)
    geometry = None
    engine = Perception.__new__(Perception)
    engine.engagement = SimpleNamespace(model=None)
    engine.face = None
    engine.profile = None
    state = {}
    samples, next_at, index = [], 0., 0
    started = time.perf_counter()
    try:
        engine.face = mp.tasks.vision.FaceLandmarker.create_from_options(mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(ROOT/'models/classroom/face_landmarker.task')),
            running_mode=mp.tasks.vision.RunningMode.IMAGE, num_faces=1,
            min_face_detection_confidence=.35, min_face_presence_confidence=.5,
            output_face_blendshapes=True, output_facial_transformation_matrixes=True))
        geometry = FaceGeometry(ROOT/'models/classroom/scrfd_2.5g.onnx')
        engine.profile = ProfileLandmarker(ROOT/'models/classroom/face_landmarker.task')
        while True:
            ok, frame = video.read()
            if not ok:
                break
            at = index*1000/fps
            index += 1
            if at + .01 < next_at:
                continue
            next_at += 1000/args.fps
            faces = geometry._detect(frame)
            observation = dict(valid=False, observedAt=round(at), eyeAspectRatio=0, yawOffset=0)
            if faces:
                face = max(faces, key=lambda item: item['box'][2]*item['box'][3])
                face.update(id=1, facePixels=face['box'][2]*frame.shape[1])
                observation = engine._face(frame, face, round(at), 'video', state)
            samples.append(observation)
            if len(samples) % 150 == 0:
                print(json.dumps(dict(samples=len(samples), videoMs=round(at))), flush=True)
    finally:
        video.release()
        if geometry is not None:
            geometry.close()
        if engine.face is not None:
            engine.face.close()
        if engine.profile is not None:
            engine.profile.close()
    result = dict(video=str(args.video), sampleFps=args.fps,
                  note='Single-face offline smoke test, not action-labeled accuracy evaluation; no audio used',
                  elapsedMs=round((time.perf_counter()-started)*1000), samples=samples)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, allow_nan=False), encoding='utf8')
    print(json.dumps(dict(output=str(args.output), samples=len(samples),
                          valid=sum(sample['valid'] for sample in samples),
                          mouthValid=sum(sample.get('mouthValid',sample['valid']) for sample in samples),
                          elapsedMs=result['elapsedMs'])), flush=True)


if __name__ == '__main__':
    main()
