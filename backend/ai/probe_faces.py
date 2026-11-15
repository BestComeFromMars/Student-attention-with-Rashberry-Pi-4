"""Diagnose one JPEG from stdin. Pixels stay in RAM; no camera or file output."""
import sys
protocol = sys.stdout
sys.stdout = sys.stderr
import base64
import json
from pathlib import Path
from types import SimpleNamespace
import cv2
import mediapipe as mp
import numpy as np
from geometry import FaceGeometry
from scrfd import SCRFD
from perception import Perception
from profile_landmarks import ProfileLandmarker
from face_validation import face_is_publishable


def main():
    frame = cv2.imdecode(np.frombuffer(sys.stdin.buffer.read(4*1024*1024+1),np.uint8),cv2.IMREAD_COLOR)
    if frame is None:
        raise ValueError('Invalid JPEG')
    cv2.setNumThreads(2)
    models = Path(__file__).resolve().parents[1]/'models/classroom'
    height,width = frame.shape[:2]
    scale = min(1.,1280/max(width,height))
    image = cv2.resize(frame,None,fx=scale,fy=scale) if scale<1 else frame
    image = cv2.copyMakeBorder(image,0,(-image.shape[0])%32,0,(-image.shape[1])%32,cv2.BORDER_CONSTANT)
    yunet = cv2.FaceDetectorYN.create(str(models/'face_detection_yunet_2023mar.onnx'),'',(image.shape[1],image.shape[0]),.65,.3,5000)
    _,yu = yunet.detect(image)
    _,sc = SCRFD(models/'scrfd_2.5g.onnx').detect(image)
    geometry = FaceGeometry(models/'scrfd_2.5g.onnx')
    engine = Perception.__new__(Perception)
    engine.engagement = SimpleNamespace(model=None)
    engine.profile = None
    engine.face = None
    try:
        engine.face = mp.tasks.vision.FaceLandmarker.create_from_options(mp.tasks.vision.FaceLandmarkerOptions(
            base_options=mp.tasks.BaseOptions(model_asset_path=str(models/'face_landmarker.task')),
            running_mode=mp.tasks.vision.RunningMode.IMAGE,num_faces=1,
            min_face_detection_confidence=.35,min_face_presence_confidence=.5,
            output_face_blendshapes=True,output_facial_transformation_matrixes=True))
        engine.profile = ProfileLandmarker(models/'face_landmarker.task')
        faces = geometry._detect(frame,True)
        measured = []
        for identity,face in enumerate(faces):
            face.update(id=identity,facePixels=face['box'][2]*width,detectedAt=1000)
            observation = engine._face(frame,face,1000,'probe',{})
            measured.append(dict(box=face['box'],score=face['score'],facePixels=face['facePixels'],
                mesh=observation.get('facePresent',False),profile=observation.get('mouthSource')=='profile_roi',
                visible=face_is_publishable(face,faces,observation,1000),
                detectorVerified=face.get('detectorVerified',False)))
        def rows(items):
            return [] if items is None else [dict(box=(item[:4]/scale).tolist(),score=float(item[-1])) for item in items]
        result=dict(dimensions=[width,height],yunet=rows(yu),scrfd=rows(sc),candidates=len(faces),faces=measured,
                    visible=sum(face['visible'] for face in measured))
        if '--preview' in sys.argv:
            preview=cv2.resize(frame,(480,round(height*480/width)))
            result['preview']=base64.b64encode(cv2.imencode('.jpg',preview,[cv2.IMWRITE_JPEG_QUALITY,55])[1]).decode()
        protocol.write(json.dumps(result)+'\n');protocol.flush()
    finally:
        geometry.close()
        if engine.face is not None: engine.face.close()
        if engine.profile is not None: engine.profile.close()


if __name__=='__main__':
    main()
