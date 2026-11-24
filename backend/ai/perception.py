"""YOLO11 + ByteTrack + MediaPipe measurements, independently of fast bbox updates."""
import os
import threading
import time
import gc
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
import cv2
import mediapipe as mp
import numpy as np
from lite_bytetrack import BaseTrack, BYTETracker
from light_results import NumpyBoxes
from head_orientation import keypoint_heading
from body_pose import pack_pose,match_poses
from desk_rest import DeskRestDetector,corroborate_people,attach_rest,rest_person_candidates,activate_confirmed_rest_people,latest_rest_evidence,refresh_rest,match_rest_to_bodies
from rest_body_tracking import RestBodyTracking
from geometry import iou
from face_validation import landmarks_match_box
from image_quality import face_quality, enhance_low_light
from mouth_geometry import measure_mouth
from profile_landmarks import ProfileLandmarker, profile_yaw, profile_pitch
from association import associate_objects
from native_runtime import serialized,export_serialized
from onnx_yolo import ONNXRuntimeYOLO
from action_recognition import ActionRecognizer
from object_scene import SceneObjects
from memory_budget import MemoryBudget,select_people
from runtime_profile import resolve_profile, default_features, merge_features

FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109]
LEFT_EYE, RIGHT_EYE = [33,160,158,133,153,144], [362,385,387,263,373,380]


def distance(a, b):
    return float(np.linalg.norm(np.asarray(a) - np.asarray(b)))


def eye_ratio(points, indices):
    a,b,c,d,e,f = [points[index] for index in indices]
    return (distance(b,f) + distance(c,e)) / max(1e-6, 2*distance(a,d))


def pixel_rect(box, width, height, padding=0):
    x,y,w,h = box
    left, top = max(0, int((x-padding*w)*width)), max(0, int((y-padding*h)*height))
    right, bottom = min(width, int((x+(1+padding)*w)*width)), min(height, int((y+(1+padding)*h)*height))
    return left,top,right,bottom


def contains(box, point, margin=.05):
    x,y,w,h = box
    return x-margin*w <= point[0] <= x+(1+margin)*w and y-margin*h <= point[1] <= y+(1+margin)*h


class Perception:
    def __init__(self, models):
        self.models = Path(models)
        self.profile_cfg = resolve_profile()
        # multiprocessing uses spawn on Windows: OpenCV's parent thread limit
        # is not inherited. Its default per-operation pool oversubscribed all
        # face/YOLO/pose/hand threads in dense scenes and delayed snapshots.
        cv2.setNumThreads(max(1,min(4,int(os.environ.get('AI_OPENCV_THREADS','1')))))
        self.device = os.environ.get("AI_DEVICE", "cpu")
        if self.device == "auto":
            import torch
            self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        if self.device != "cpu":
            import torch
            torch.set_num_threads(max(1, min(4, int(os.environ.get("AI_THREADS", "1")))))
            torch.set_num_interop_threads(1)
        # Keep the legacy status field for clients, without loading a scoring model.
        self.engagement=SimpleNamespace(model=None,status='disabled_observation_only')
        self.model_lock = threading.Lock()
        self.session_features = {}
        self.active_features = default_features()
        self.desk_rest = None
        self.pose = None
        self.face = None
        self.profile = None
        self.hands = None
        self.objects = None
        self.scene_detector = None
        self.person_model_name = self.profile_cfg['personModel']
        # Warm only active Tier-2 behavior models (Pose, DeskRest, FaceLandmarker).
        # Tier-1 person detection lives in worker.py; objects YOLO loads lazily when enabled.
        blank = np.zeros((320, 320, 3), np.uint8)
        print(f"AI: warming behavior models (profile={self.profile_cfg['name']})", flush=True)
        if self.active_features['pose'] or not self.profile_cfg.get('lazyOptionalModels', True):
            self._ensure_pose().predict(blank, imgsz=640, device=self.device, verbose=False)
        if self.active_features['deskRest'] or not self.profile_cfg.get('lazyOptionalModels', True):
            self._ensure_desk_rest()
        if self.active_features['faceMesh'] or not self.profile_cfg.get('lazyOptionalModels', True):
            self._ensure_face()
        if self.active_features['hands'] and not self.profile_cfg.get('lazyOptionalModels', True):
            self._ensure_hands()
        if os.environ.get('AI_CLASSROOM_ACTIONS') == '1':
            from scb_recognition import SCBRecognizer
            self.actions = SCBRecognizer(self.models.parent / 'classroom-actions')
        else:
            self.actions = ActionRecognizer(self.models.parent / 'actions')
        self.memory_budget = MemoryBudget()
        self.person_limit = self.memory_budget.limit
        self.sessions = {}
        self.latest = {}
        self.scene_latest = {}
        self.pose_latest = {}
        self.rest_latest = {}
        self.scene_results = {}
        self.scene_boxes = {}
        self.scene_objects = {}
        self.results = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.face_event = threading.Event()
        self.pose_event = threading.Event()
        self.rest_event = threading.Event()
        self.version = 0
        self.face_local = threading.local()
        self._face_models = []
        self.face_workers = max(1, min(6, int(os.environ.get('AI_FACE_WORKERS', str(self.profile_cfg.get('faceWorkers', 2))))))
        self.face_pool = ThreadPoolExecutor(max_workers=self.face_workers, thread_name_prefix='face-person')
        self.face_error = None
        self.scene_error = None
        self.timings = {'opencvThreads': cv2.getNumThreads(), 'profile': self.profile_cfg['name'],
                        'personModel': self.person_model_name, 'faceWorkers': self.face_workers}
        self.thread = threading.Thread(target=self._loop, name="behavior-analysis", daemon=False)
        self.scene_thread = threading.Thread(target=self._scene_loop, name="objects-analysis", daemon=False)
        self.pose_thread = threading.Thread(target=self._pose_loop, name='person-pose', daemon=False)
        self.rest_thread = threading.Thread(target=self._rest_loop, name='desk-rest', daemon=False)
        self.thread.start()
        self.scene_thread.start()
        self.pose_thread.start()
        self.rest_thread.start()
        print("AI: all pipelines ready", flush=True)

    def _ensure_objects(self):
        with self.model_lock:
            if self.objects is None:
                if self.device == 'cpu':
                    name = self.profile_cfg.get('objectModel', 'yolo11n.onnx')
                    path = self.models / name
                    if not path.is_file():
                        path = self.models / 'yolo11n.onnx'
                    self.objects = ONNXRuntimeYOLO(path)
                else:
                    from ultralytics import YOLO
                    self.objects = YOLO(str(self.models / 'yolo11m.pt'))
                self.scene_detector = SceneObjects(self.objects, self.device, tile_crop=self.profile_cfg.get('sceneTileCrop', True))
            return self.scene_detector

    def _ensure_desk_rest(self):
        with self.model_lock:
            if self.desk_rest is None:
                self.desk_rest = DeskRestDetector(self.models)
            return self.desk_rest

    def _ensure_pose(self):
        with self.model_lock:
            if self.pose is None:
                if self.device == 'cpu':
                    self.pose = ONNXRuntimeYOLO(self.models / 'yolo11n-pose.onnx', pose=True)
                else:
                    from ultralytics import YOLO
                    self.pose = YOLO(str(self.models / 'yolo11n-pose.pt'))
            return self.pose

    def _create_face_landmarker(self):
        vision = mp.tasks.vision
        options = mp.tasks.BaseOptions
        return vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=options(model_asset_path=str(self.models/"face_landmarker.task")),
            running_mode=vision.RunningMode.IMAGE, num_faces=1,
            min_face_detection_confidence=.3, min_face_presence_confidence=.45,
            output_face_blendshapes=True, output_facial_transformation_matrixes=True))

    def _ensure_face(self):
        with self.model_lock:
            if self.face is None:
                self.face = self._create_face_landmarker()
                if hasattr(self, '_face_models'):
                    self._face_models.append(self.face)
            return self.face

    def _worker_face(self):
        local = getattr(self, 'face_local', None)
        if local is None:
            return self._ensure_face() if getattr(self, 'face', None) is None else self.face
        model = getattr(local, 'face', None)
        if model is None:
            with self.model_lock:
                if self.face is not None and not getattr(self, '_primary_face_claimed', False):
                    model = self.face
                    self._primary_face_claimed = True
                else:
                    model = self._create_face_landmarker()
                    self._face_models.append(model)
            local.face = model
        return model

    def _ensure_profile(self):
        with self.model_lock:
            if self.profile is None:
                self.profile = ProfileLandmarker(self.models / 'face_landmarker.task')
            return self.profile

    def _ensure_hands(self):
        with self.model_lock:
            if self.hands is None:
                vision = mp.tasks.vision
                options = mp.tasks.BaseOptions
                self.hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
                    base_options=options(model_asset_path=str(self.models/"hand_landmarker.task")),
                    running_mode=vision.RunningMode.IMAGE, num_hands=2,
                    min_hand_detection_confidence=.35, min_hand_presence_confidence=.35))
            return self.hands

    def _feature_enabled(self, session, key):
        features = getattr(self, 'session_features', None)
        if not features:
            return True
        config = features.get(session)
        return True if config is None else bool(config.get(key, True))

    def configure(self, session, features):
        with self.lock:
            self.session_features[session] = dict(features)
            self.active_features = merge_features(list(self.session_features.values()))
            state = self.sessions.get(session)
            if state is not None:
                if not features.get('objects', True):
                    self.scene_latest.pop(session, None)
                    self.scene_results.pop(session, None)
                    self.scene_objects.pop(session, None)
                    state['objects'] = []
                    state.pop('objectsAt', None)
                    for obs in state.get('bodyObservations', {}).values():
                        obs.pop('phoneHeld', None)
                        obs.pop('laptopInteraction', None)
                        obs.pop('bookInteraction', None)
                        obs.pop('objectRegions', None)
                if not features.get('deskRest', True):
                    self.rest_latest.pop(session, None)
                    state.pop('restObservations', None)
                    state.pop('restHistory', None)
                    state.pop('restCandidates', None)
                    state.pop('restPersonCandidates', None)
                if not features.get('pose', True):
                    self.pose_latest.pop(session, None)
                    state.pop('poseObservations', None)
                    state.pop('poseHistory', None)
                    state['poses'] = []
                    state['wrists'] = []
                    state['headings'] = []
                    state['poseRegions'] = []
        if getattr(self, 'profile_cfg', {}).get('lazyOptionalModels', True):
            self._release_unused_models()

    def _release_unused_models(self):
        released = False
        with self.model_lock:
            if not self.active_features.get('hands', True) and self.hands is not None:
                try: self.hands.close()
                except Exception: pass
                self.hands = None; released = True
            if not self.active_features.get('profileMesh', True) and self.profile is not None:
                try: self.profile.close()
                except Exception: pass
                self.profile = None; released = True
            if not self.active_features.get('deskRest', True) and self.desk_rest is not None:
                self.desk_rest = None; released = True
            if not self.active_features.get('objects', False) and getattr(self, 'objects', None) is not None:
                self.objects = None; self.scene_detector = None; released = True
        if released:
            gc.collect()

    def submit(self, session, frame, faces, at, bodies=None):
        state = self._state(session)
        self.person_limit = self.memory_budget.update(sum(len(s.get('bodies', [])) for s in self.sessions.values()))
        faces = select_people(faces, self.person_limit, state.get('faceCache', {}))
        state['lastAt'] = at
        if bodies is not None:
            with self.lock:
                state['bodies'] = [dict(b) for b in bodies]
                state['bodyCandidateCount'] = len(bodies)
                state['peopleAt'] = at
                state['bodyHistory'].append((at, [dict(b) for b in bodies]))
                rest_at, evidence = latest_rest_evidence(state.get('restHistory', ()), at)
                rest_obs = match_rest_to_bodies(state['bodies'], state.get('restObservations', {}), evidence, rest_at, at)
                state['restObservations'] = {k: v for k, v in rest_obs.items() if v.get('active')}
                folded = state.setdefault('restBodyTracking', RestBodyTracking())
                if self._feature_enabled(session, 'deskRest'):
                    folded.seed(state['bodies'], state['restObservations'], at)
                else:
                    folded.tracks.clear()
        self.actions.observe(session, frame, state['bodies'], at)
        need_face = self._feature_enabled(session, 'faceMesh') or self._feature_enabled(session, 'faceHeading')
        need_objects = self._feature_enabled(session, 'objects')
        need_pose = self._feature_enabled(session, 'pose')
        need_rest = self._feature_enabled(session, 'deskRest')
        with self.lock:
            if need_face:
                self.latest[session] = (frame, faces, at, state)
                alive = {face['id'] for face in faces}
                person_latest = state.setdefault('personLatest', {})
                person_last_at = state.setdefault('personLastAt', {})
                for dead in list(person_latest):
                    if dead not in alive:
                        person_latest.pop(dead, None)
                for dead in list(person_last_at):
                    if dead not in alive:
                        person_last_at.pop(dead, None)
                if 'profileRois' in state:
                    state['profileRois'] = {k: v for k, v in state['profileRois'].items() if k in alive}
                if 'faceCache' in state:
                    state['faceCache'] = {k: v for k, v in state['faceCache'].items() if k in alive}
                if hasattr(self, 'results') and session in self.results:
                    self.results[session] = {k: v for k, v in self.results[session].items() if k in alive}
                state['denseFaceBatch'] = len(faces) > 6
                state['latestFacesAt'] = at
                state['latestFaceIds'] = alive
                for face in faces:
                    person_latest[face['id']] = (frame, face, at)
                if not faces:
                    if hasattr(self, 'results'):
                        self.results[session] = {}
                    state['faceAt'] = at
                    self.version = getattr(self, 'version', 0) + 1
            if need_objects:
                self.scene_latest[session] = (frame, faces, at, state)
            if need_pose:
                self.pose_latest[session] = (frame, at, state)
            if need_rest:
                self.rest_latest[session] = (frame, at, state)
        if need_face and hasattr(self, 'face_event'):
            self.face_event.set()
        if need_pose and hasattr(self, 'pose_event'):
            self.pose_event.set()
        if need_rest and hasattr(self, 'rest_event'):
            self.rest_event.set()

    def snapshot(self, session, *, with_timestamp=False):
        with self.lock:
            output = {key:dict(value) for key,value in self.results.get(session, {}).items()}
            for key,value in self.scene_results.get(session,{}).items():
                output.setdefault(key,dict(valid=False,eyeAspectRatio=0,yawOffset=0)).update(value)
            if with_timestamp:
                return dict(observations=output, faceAt=self.sessions.get(session, {}).get('faceAt', 0))
            return output

    @property
    def error(self):
        return self.face_error or self.scene_error or self.timings.get('bodyError') or self.timings.get('poseError') or self.timings.get('restError')

    def body_hints(self,session,with_timestamp=False):
        with self.lock:
            state=self.sessions.get(session,{})
            bodies=[dict(b) for b in state.get('bodies',[])];observations=state.get('bodyObservations',{})
            pose_observations=state.get('poseObservations',{})
            body_at=state.get('peopleAt',0)
            rest_observations={identity:dict(cue) for identity,cue in state.get('restObservations',{}).items()}
            rest_at,rest_candidates=latest_rest_evidence(state.get('restHistory',()),state.get('lastAt',body_at))
            rest_current=match_rest_to_bodies(bodies,rest_observations,rest_candidates,rest_at,state.get('lastAt',body_at))
        output=[]
        for body in bodies:
            observation=dict(observations.get(body['id'],{}))
            for key in ('bodyPose','headYaw','headObservedAt','headSource'):observation.pop(key,None)
            observation.update(pose_observations.get(body['id'],{}))
            observation['deskRest']=rest_current.get(body['id'],
                dict(active=False,confidence=0,personConfidence=0,observedAt=rest_at or body_at))
            actions=self.actions.snapshot(session,body['id'],state.get('lastAt',0))
            for action in actions:
                if action['type']=='slumped_on_desk' and action['state']=='pending' and observation.get('deskSlumpPose') is not True:
                    action.update(state='unavailable',reason='requires_body_posture_evidence')
            output.append({**body,'observation':observation,'actions':actions})
        return dict(bodies=output,bodyAt=body_at,candidateCount=state.get('bodyCandidateCount',len(output))) if with_timestamp else output

    def object_hints(self,session):
        with self.lock:
            return self.scene_objects.get(session,{})

    def body_snapshot(self,session):
        return self.body_hints(session,with_timestamp=True)

    def rest_bodies(self,session):
        with self.lock:
            state=self.sessions.get(session,{})
            tracker=state.get('restBodyTracking')
            return tracker.snapshot(state.get('lastAt',0)) if tracker else []

    def release(self, session):
        with self.lock:
            self.latest.pop(session, None)
            self.scene_latest.pop(session, None)
            self.pose_latest.pop(session, None)
            self.rest_latest.pop(session, None)
            self.scene_results.pop(session, None)
            self.scene_boxes.pop(session, None)
            self.scene_objects.pop(session, None)
            self.results.pop(session, None)
            self.sessions.pop(session, None)
            if hasattr(self, 'session_features'):
                self.session_features.pop(session, None)
                self.active_features = merge_features(list(self.session_features.values()))
            self.actions.release(session)

    def _state(self, session):
        with self.lock:
            if session not in self.sessions:
                self.sessions[session] = dict(
                    _sessionId=session, peopleAt=0, objectsAt=0, bodies=[], objects=[],
                    wrists=[], poses=[], cursor=0, faceCache={}, bodyObservations={},
                    lastAt=0, poseAt=0, bodyHistory=deque(maxlen=20),
                )
            return self.sessions[session]

    def _rest_loop(self):
        interval = getattr(self, 'profile_cfg', {}).get('restIntervalMs', 500)
        rest_event = getattr(self, 'rest_event', None)
        while not self.stop.is_set():
            if rest_event is not None:
                rest_event.wait(.02)
                rest_event.clear()
            else:
                if self.stop.wait(.02):
                    break
            if self.stop.is_set():
                break
            with self.lock:
                pending = []
                for session, item in list(self.rest_latest.items()):
                    _, at, state = item
                    if at - state.get('restAt', 0) >= interval:
                        pending.append((session, item))
                        self.rest_latest.pop(session, None)
            for session, (frame, at, state) in pending:
                try:
                    if not self._feature_enabled(session, 'deskRest'):
                        continue
                    started = time.perf_counter()
                    evidence = self._ensure_desk_rest().predict(frame)
                    with self.lock:
                        if self.sessions.get(session) is not state:
                            continue
                        state.setdefault('restHistory', deque(maxlen=8)).append((at, evidence))
                        state.update(restAt=at, restCandidates=evidence)
                        rest_obs = match_rest_to_bodies(state.get('bodies', []), state.get('restObservations', {}), evidence, at, at)
                        state['restObservations'] = {k: v for k, v in rest_obs.items() if v.get('active')}
                        if state.get('restBodyTracking'):
                            state['restBodyTracking'].update(evidence, at)
                        self.version = getattr(self, 'version', 0) + 1
                        self.timings.update(
                            restLatencyMs=int(time.time() * 1000) - at,
                            restInferenceMs=round((time.perf_counter() - started) * 1000, 2),
                            restCandidates=len(evidence),
                            restError=None,
                        )
                except Exception as error:
                    self.timings['restError'] = str(error)

    @export_serialized
    def _pose(self, frame, at):
        height,width=frame.shape[:2]
        pose_model = self._ensure_pose() if getattr(self, 'pose', None) is None else self.pose
        pose=pose_model.predict(frame,imgsz=640,conf=.25,device=self.device,verbose=False)[0]
        result=dict(wrists=[],poses=[],headings=[],poseRegions=[],poseAt=at)
        if pose.keypoints is not None:
            raw_xyxy = pose.boxes.xyxy
            raw_kpts = pose.keypoints.data
            raw_conf = pose.boxes.conf
            xyxy_np = raw_xyxy.cpu().numpy() if hasattr(raw_xyxy, 'cpu') else np.asarray(raw_xyxy)
            kpts_np = raw_kpts.cpu().numpy() if hasattr(raw_kpts, 'cpu') else np.asarray(raw_kpts)
            conf_np = raw_conf.cpu().numpy() if hasattr(raw_conf, 'cpu') else np.asarray(raw_conf)
            for box,points,confidence in zip(xyxy_np,kpts_np,conf_np):
                rectangle=[float(box[0]/width),float(box[1]/height),float((box[2]-box[0])/width),float((box[3]-box[1])/height)]
                packed=pack_pose(box,points,confidence,width,height,at)
                if packed is not None:
                    result['poseRegions'].append(packed)
                    result['headings'].append((rectangle,keypoint_heading(points)))
                normalized=[(float(p[0]/width),float(p[1]/height)) for p in points[[9,10]] if p[2]>.3]
                result['wrists'].append((rectangle,normalized))
                shoulders=[p for p in points[[5,6]] if p[2]>.35];hips=[p for p in points[[11,12]] if p[2]>.35]
                slump=None
                if len(shoulders)==2 and len(hips)==2:
                    shoulder=np.mean(shoulders,axis=0);hip=np.mean(hips,axis=0);nose=points[0]
                    slump=bool(nose[2]>=.35 and abs(shoulder[0]-hip[0])>abs(shoulder[1]-hip[1]) and nose[1]>=shoulder[1]-.05*height)
                result['poses'].append((rectangle,slump))
        return result

    def _publish_pose(self,state,result,at):
        past=[(stamp,boxes) for stamp,boxes in list(state.get('bodyHistory',[])) if 0<=at-stamp<=2000]
        bodies=max(past,key=lambda item:item[0])[1] if past else []
        yaws={id(pose):yaw for pose,(_,yaw) in zip(result['poseRegions'],result['headings'])}
        matched=match_poses(bodies,result['poseRegions'],at)
        state['poseBodyCandidates']=len(bodies)
        state['poseBestIoU']=max((iou(body['box'],[pose['box'][k] for k in ('x','y','width','height')])
            for body in bodies for pose in result['poseRegions']),default=0.)
        # A faster pose job can finish before person detection for its frame.
        # Keep only still-fresh, already-owned evidence while that metadata is
        # missing. Its original timestamp is never renewed by this fallback.
        previous={identity:value for identity,value in state.get('poseObservations',{}).items()
            if 0<=at-value['bodyPose']['observedAt']<=2000} if not bodies and result['poseRegions'] else {}
        state.update(result)
        state.setdefault('poseHistory',deque(maxlen=16)).append((at,result))
        state['poseObservations']={**previous,**{identity:dict(bodyPose=pose,headYaw=yaws[id(pose)],
            headObservedAt=at,headSource='body_keypoints') for identity,pose in matched.items()}}

    def _pose_loop(self):
        interval = getattr(self, 'profile_cfg', {}).get('poseIntervalMs', 400)
        pose_event = getattr(self, 'pose_event', None)
        while not self.stop.is_set():
            if pose_event is not None:
                pose_event.wait(.015)
                pose_event.clear()
            else:
                if self.stop.wait(.015):
                    break
            if self.stop.is_set():
                break
            with self.lock:
                pending = []
                for session, item in list(self.pose_latest.items()):
                    _, at, state = item
                    if at - state.get('poseAt', 0) >= interval:
                        pending.append((session, item))
                        self.pose_latest.pop(session, None)
            for session,(frame,at,state) in pending:
                try:
                    if not self._feature_enabled(session, 'pose'): continue
                    result=self._pose(frame,at)
                    with self.lock:
                        if self.sessions.get(session) is not state:continue
                        self._publish_pose(state,result,at)
                        self.version = getattr(self, 'version', 0) + 1
                        self.timings.update(poseLatencyMs=int(time.time()*1000)-at,poseError=None,
                            poseDetections=len(result['poseRegions']),poseMatches=len(state['poseObservations']),
                            poseBodyCandidates=state['poseBodyCandidates'],poseBestIoU=state['poseBestIoU'])
                except Exception as error:self.timings['poseError']=str(error)

    @serialized
    def _scene(self, state, frame, at):
        height,width=frame.shape[:2]
        interval = getattr(self, 'profile_cfg', {}).get('sceneIntervalMs', 700)
        if at-state["objectsAt"] >= interval:
            cursor=state.get('objectTile',0)
            detector = self.scene_detector if getattr(self, 'scene_detector', None) is not None else self._ensure_objects()
            detected=detector.predict(frame,cursor)
            state['objectTile']=(cursor+1)%4
            state["objects"] = [{"class":int(row[5]), "detectionId":index, "confidence":float(row[4]), "box":[float(row[0]/width),float(row[1]/height),
                float((row[2]-row[0])/width),float((row[3]-row[1])/height)]} for index,row in enumerate(detected)]
            state["objectsAt"] = at
            self.timings.update(sceneObjectsAt=at,sceneObjectCount=len(state['objects']),
                scenePhoneCount=sum(obj['class']==67 for obj in state['objects']),
                sceneBookCount=sum(obj['class']==73 for obj in state['objects']),
                sceneLaptopCount=sum(obj['class']==63 for obj in state['objects']))

    @export_serialized
    def _hands_for(self, frame, body):
        height,width = frame.shape[:2]
        left,top,right,bottom = pixel_rect(body, width, height, .05)
        crop = frame[top:bottom,left:right]
        if not crop.size:
            return []
        scale = min(1.,512/max(crop.shape[:2]))
        if scale<1:
            crop = cv2.resize(crop,None,fx=scale,fy=scale)
        rgb = np.ascontiguousarray(cv2.cvtColor(crop,cv2.COLOR_BGR2RGB))
        hands_model = self._ensure_hands() if getattr(self, 'hands', None) is None else self.hands
        result = hands_model.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        return [(float((left+p.x*(right-left))/width),float((top+p.y*(bottom-top))/height))
                for hand in result.hand_landmarks for i,p in enumerate(hand) if i in [0,5,8,9,12,16,20]]

    def _ownership(self, frame, state, faces,at=None):
        hands_enabled = self._feature_enabled(state.get('_sessionId'), 'hands') if '_sessionId' in state else True
        bodies = state["bodies"]
        pose_state=state
        if at is not None:
            past=[(stamp,boxes) for stamp,boxes in list(state.get('bodyHistory',[])) if 0<=at-stamp<=2000]
            bodies=max(past,key=lambda item:item[0])[1] if past else []
            poses=[(stamp,result) for stamp,result in list(state.get('poseHistory',[])) if 0<=at-stamp<=2000]
            pose_state=max(poses,key=lambda item:item[0])[1] if poses else {}
        hand_points = {}
        budget = 4
        offset = state.get("handCursor",0)%max(1,len(bodies))
        for body in bodies[offset:]+bodies[:offset]:
            near_objects = [obj for obj in state["objects"] if contains(body["box"],
                (obj["box"][0]+obj["box"][2]/2,obj["box"][1]+obj["box"][3]/2), .2)]
            points = []
            for pose_box, wrists in pose_state.get('wrists',[]):
                if iou(body["box"], pose_box) > .3:
                    points.extend(wrists)
            if hands_enabled and near_objects and budget>0:
                points.extend(self._hands_for(frame,body["box"]))
                budget -= 1
            hand_points[body["id"]] = points
        state["handCursor"] = offset+4
        owned, regions = associate_objects(bodies,state["objects"],hand_points)
        state['bodyObservations']={b['id']:dict(phoneHeld=owned[b['id']][67],laptopInteraction=owned[b['id']][63],
            bookInteraction=owned[b['id']][73],objectRegions=[dict(r,observedAt=state['objectsAt']) for r in regions[b['id']]],
            objectsAt=state['objectsAt']) for b in bodies} if 'objectsAt' in state else {}
        for body in bodies:
            if body['id'] not in state['bodyObservations']:continue
            matched=[(iou(body['box'],box),slump) for box,slump in pose_state.get('poses',[]) if iou(body['box'],box)>.3]
            state['bodyObservations'][body['id']]['deskSlumpPose']=max(matched,key=lambda p:p[0])[1] if matched else None
        for identity,pose in match_poses(bodies,pose_state.get('poseRegions',[]),at if at is not None else state.get('poseAt',0)).items():
            if identity in state['bodyObservations']:state['bodyObservations'][identity]['bodyPose']=pose
        # Link pose evidence one-to-one; overlapping people must not share a head direction.
        pairs=sorted(((iou(body['box'],box),body['id'],index,yaw)
            for body in bodies for index,(box,yaw) in enumerate(pose_state.get('headings',[]))
            if iou(body['box'],box)>.3),key=lambda item:item[0],reverse=True)
        used_bodies=set();used_heads=set()
        for overlap,identity,index,yaw in pairs:
            if identity in used_bodies or index in used_heads:continue
            if any(score>=overlap-.05 and ((other_id!=identity and other_index==index) or
                (other_id==identity and other_index!=index)) for score,other_id,other_index,_ in pairs):continue
            used_bodies.add(identity);used_heads.add(index)
            state['bodyObservations'][identity].update(headYaw=yaw,headObservedAt=pose_state.get('poseAt',0),headSource='body_keypoints')
        associations = {}
        for face in faces:
            x,y,w,h = face["box"]
            center = (x+w/2,y+h/2)
            candidates = [body for body in bodies if contains(body["box"],center,.05)]
            if not candidates:
                associations[face["id"]] = (None,None,[])
                continue
            body = min(candidates,key=lambda b:b["box"][2]*b["box"][3])
            reliable = body["box"][2]*frame.shape[1] >= 80
            values = owned[body["id"]] if reliable else None
            associations[face["id"]] = (body["id"], values, regions[body["id"]] if reliable else [])
        # Overlapping faces must not both inherit one body's phone/book.
        for key,(person_id,values,linked) in list(associations.items()):
            if person_id is not None and sum(value[0] == person_id for value in associations.values()) > 1:
                associations[key] = (person_id,None,[])
        self.timings.update(sceneBodyCount=len(bodies),sceneHandPointCount=sum(map(len,hand_points.values())),
            sceneLinkedObjectCount=sum(len(value[2]) for value in associations.values()),
            sceneInteractingObjectCount=sum(region.get('interaction',False)
                for value in associations.values() for region in value[2]))
        return associations

    @export_serialized
    def _face(self, frame, face, at, session, state):
        height,width = frame.shape[:2]
        box = face["box"]
        quality = face_quality(frame,box)
        missing = dict(valid=False,facePresent=False,eyeAspectRatio=0,yawOffset=0,
                       observedAt=at,facePixels=face["facePixels"],quality=quality)
        left,top,right,bottom = pixel_rect(box,width,height,.25)
        crop = frame[top:bottom,left:right]
        if not crop.size:
            return missing
        if face["facePixels"] < 24:
            return self._face_heading_only(frame, face, at)
        factor = 256/max(crop.shape[:2])
        scaled = cv2.resize(crop,(max(1,round(crop.shape[1]*factor)),max(1,round(crop.shape[0]*factor))))
        rgb = np.ascontiguousarray(cv2.cvtColor(scaled,cv2.COLOR_BGR2RGB))
        face_model = self._worker_face()
        result = face_model.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb))
        if not result.face_landmarks:
            skip_bright = getattr(self, 'profile_cfg', {}).get('skipLowLightRetryWhenNormal', False)
            if not skip_bright or quality.get('brightness', 100) < 55:
                enhanced = enhance_low_light(scaled)
                if enhanced is not None:
                    rgb = np.ascontiguousarray(cv2.cvtColor(enhanced,cv2.COLOR_BGR2RGB))
                    result = face_model.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb))
        profile_only = False
        if not result.face_landmarks:
            if face["facePixels"] >= 48 and not getattr(self, '_dense_face_batch', False) and self._feature_enabled(session, 'profileMesh'):
                prof = self.profile if getattr(self, 'profile', None) is not None else (self._ensure_profile() if hasattr(self, 'model_lock') else None)
                result = prof.detect(frame,face,state) if prof is not None else None
            else:
                result = None
            if result is None:
                fallback = self._face_heading_only(frame, face, at)
                return fallback if fallback.get('headPoseValid') else missing
            profile_only = True
        coordinate_width,coordinate_height = (width,height) if profile_only else (right-left,bottom-top)
        origin_x,origin_y = (0,0) if profile_only else (left,top)
        points = np.array([[p.x*coordinate_width+origin_x,p.y*coordinate_height+origin_y] for p in result.face_landmarks[0]],np.float32)
        oval = points[FACE_OVAL]
        mn,mx = oval.min(axis=0),oval.max(axis=0)
        measured = [float(mn[0]/width),float(mn[1]/height),float((mx[0]-mn[0])/width),float((mx[1]-mn[1])/height)]
        if not landmarks_match_box(box,measured):
            return missing
        left_ear,right_ear = (None,None) if profile_only else (eye_ratio(points,LEFT_EYE),eye_ratio(points,RIGHT_EYE))
        ear = 0 if profile_only else (left_ear+right_ear)/2
        mouth = measure_mouth(result.face_landmarks[0],coordinate_width,coordinate_height)
        blend = {item.category_name:float(item.score) for item in result.face_blendshapes[0]} if result.face_blendshapes else {}
        pitch,yaw = None,result.yaw if profile_only else None
        if result.facial_transformation_matrixes:
            matrix = np.asarray(result.facial_transformation_matrixes[0],np.float64)[:3,:3]
            # Remove model scale before decomposing rotation in the camera frame.
            matrix = matrix / np.maximum(np.linalg.norm(matrix,axis=0,keepdims=True),1e-6)
            angles = cv2.RQDecomp3x3(matrix)[0]
            pitch,yaw = float(-angles[0]),float(angles[1])
            # Supplement 3D matrix decomposition with rigid upper-face geometry
            # (outer eye corners 33..263, nose tip 1, cheek contours 234..454),
            # which is invariant to mouth opening and more responsive to real
            # downward head bows and sideways head turns under webcam perspective.
            eye_span = max(6.0, distance(points[33], points[263]))
            eye_mid_y = float((points[33][1] + points[133][1] + points[362][1] + points[263][1]) * 0.25)
            nose_drop = float((points[1][1] - eye_mid_y) / eye_span)
            geom_pitch = float(np.clip((nose_drop - 0.36) * 95.0, -45.0, 60.0))
            if pitch >= 3.0 and geom_pitch > pitch:
                pitch = float(min(60.0, 0.45 * pitch + 0.55 * geom_pitch))
            cheek_span = float(points[454][0] - points[234][0])
            if cheek_span >= 6.0 and abs(yaw) >= 18.0:
                cheek_mid_x = float((points[234][0] + points[454][0]) * 0.5)
                cheek_offset = float((points[1][0] - cheek_mid_x) / (cheek_span * 0.5))
                geom_yaw = float(np.clip(cheek_offset * 52.0, -75.0, 75.0))
                if yaw * geom_yaw >= 0 and abs(geom_yaw) > abs(yaw):
                    yaw = float(0.45 * yaw + 0.55 * geom_yaw)
        refined = [(mn[0]/width-box[0])/max(box[2],1e-6),(mn[1]/height-box[1])/max(box[3],1e-6),
                   (mx[0]-mn[0])/width/max(box[2],1e-6),(mx[1]-mn[1])/height/max(box[3],1e-6)]
        mouth_valid = bool(face["facePixels"] >= int(os.environ.get("MIN_BEHAVIOR_FACE_PX","28")))
        valid = mouth_valid and not profile_only
        # Coarse orientation needs less detail than eyelids/articulation. Do not
        # withhold a measured head pose solely because mouth detail is missing.
        head_pose_valid=bool(face['facePixels']>=20 and quality.get('usable') is not False and
            yaw is not None and np.isfinite(yaw) and abs(yaw)<=90 and
            (pitch is None or np.isfinite(pitch) and abs(pitch)<=75))
        # Upscaling a tiny face does not restore eyelid detail. Keep its box,
        # heading and mouth measurements, but do not turn noisy EAR into an
        # eye-closure warning. The original-image pixels decide availability.
        eye_valid=bool(valid and face['facePixels']>=38 and quality.get('usable') is not False and
            min(distance(points[33],points[133]),distance(points[362],points[263]))>=5.5 and
            (yaw is None or abs(yaw)<=45) and (pitch is None or abs(pitch)<=35))
        jaw_open = blend.get("jawOpen")
        if jaw_open is not None:
            lip_motion = (
                0.55 * (blend.get("mouthFunnel", 0.0) + blend.get("mouthPucker", 0.0))
                + 0.45 * 0.5 * (blend.get("mouthLowerDownLeft", 0.0) + blend.get("mouthLowerDownRight", 0.0))
                + 0.35 * 0.5 * (blend.get("mouthUpperUpLeft", 0.0) + blend.get("mouthUpperUpRight", 0.0))
                + 0.25 * 0.5 * (blend.get("mouthStretchLeft", 0.0) + blend.get("mouthStretchRight", 0.0))
            )
            jaw_open = float(min(1.0, max(jaw_open, jaw_open + lip_motion)))
        return dict(valid=valid,facePresent=not profile_only,faceBox=list(box),mouthValid=mouth_valid,
            eyeValid=eye_valid,
            headPoseValid=head_pose_valid,
            mouthSource='profile_roi' if profile_only else 'face_landmarker',eyeAspectRatio=float(ear),yawOffset=abs(yaw or 0)/90,
            leftEyeAspectRatio=left_ear,rightEyeAspectRatio=right_ear,
            pitchDeg=pitch,yawDeg=yaw,**mouth,jawOpen=jaw_open,
            eyeBlinkLeft=blend.get("eyeBlinkLeft"),eyeBlinkRight=blend.get("eyeBlinkRight"),
            mouthSmileLeft=blend.get('mouthSmileLeft'),mouthSmileRight=blend.get('mouthSmileRight'),
            observedAt=at,facePixels=float(face["facePixels"]),refinement=None if profile_only else [float(x) for x in refined],
            quality=quality)

    def _face_heading_only(self, frame, face, at):
        quality = face_quality(frame, face['box'])
        anchors_at = face.get('anchorsAt')
        fresh_anchors = anchors_at is None or 0 <= at - anchors_at <= 350
        yaw = profile_yaw(face, minimum=0) if fresh_anchors else None
        pitch = profile_pitch(face) if fresh_anchors else None
        head_pose_valid = bool(fresh_anchors and face['facePixels'] >= 20 and quality.get('usable') is not False and yaw is not None)
        return dict(valid=False, facePresent=head_pose_valid, faceBox=list(face['box']), mouthValid=False, eyeValid=False,
            headPoseValid=head_pose_valid, mouthSource='profile_roi', eyeAspectRatio=0, yawOffset=abs(yaw or 0)/90,
            yawDeg=yaw, pitchDeg=pitch,
            observedAt=at, facePixels=float(face['facePixels']), quality=quality)

    def _process_person(self, session, state, face_id):
        try:
            with self.lock:
                if self.sessions.get(session) is not state or self.stop.is_set():
                    return
                job = state.get('personLatest', {}).pop(face_id, None)
                dense = bool(state.get('denseFaceBatch', False))
            if job is None:
                return
            frame, face, at = job
            use_mesh = self._feature_enabled(session, 'faceMesh')
            use_heading = self._feature_enabled(session, 'faceHeading')
            if not use_mesh and not use_heading:
                return
            self._dense_face_batch = dense
            if use_mesh and face.get('facePixels', 0) >= 24:
                measurement = self._face(frame, face, at, session, state)
            elif use_heading:
                measurement = self._face_heading_only(frame, face, at)
            else:
                measurement = None
            with self.lock:
                if self.sessions.get(session) is not state:
                    return
                cache = state.setdefault('faceCache', {})
                if measurement:
                    existing = cache.get(face_id)
                    if not (
                        not measurement.get('valid') and not measurement.get('headPoseValid')
                        and existing and (existing.get('valid') or existing.get('headPoseValid'))
                        and 0 <= at - existing.get('observedAt', 0) <= 350
                    ):
                        cache[face_id] = measurement
                published = cache.get(face_id)
                if published is not None:
                    self.results.setdefault(session, {})[face_id] = dict(published)
                person_last_at = state.setdefault('personLastAt', {})
                person_last_at[face_id] = max(person_last_at.get(face_id, 0), at)
                active_ids = state.get('latestFaceIds') or set()
                if active_ids and all(person_last_at.get(fid, 0) >= at for fid in active_ids):
                    state['faceAt'] = max(state.get('faceAt', 0), at)
                elif not active_ids:
                    state['faceAt'] = max(state.get('faceAt', 0), at)
                self.version = getattr(self, 'version', 0) + 1
                self.timings['faceLatencyMs'] = int(time.time() * 1000) - at
            self.face_error = None
        except Exception as error:
            import traceback
            traceback.print_exc()
            self.face_error = str(error)
        finally:
            retrigger = False
            with self.lock:
                state.get('personBusy', set()).discard(face_id)
                if self.sessions.get(session) is state and face_id in state.get('personLatest', {}):
                    retrigger = True
            if retrigger and hasattr(self, 'face_event'):
                self.face_event.set()

    def _loop(self):
        face_event = getattr(self, 'face_event', None)
        while not self.stop.is_set():
            if face_event is not None:
                face_event.wait(.015)
                face_event.clear()
            else:
                if self.stop.wait(.01):
                    break
            if self.stop.is_set():
                break
            candidates = []
            with self.lock:
                for session, state in list(self.sessions.items()):
                    person_latest = state.get('personLatest')
                    if not person_latest:
                        continue
                    person_busy = state.setdefault('personBusy', set())
                    person_last_at = state.setdefault('personLastAt', {})
                    for face_id in list(person_latest):
                        if face_id not in person_busy:
                            candidates.append((person_last_at.get(face_id, 0), session, state, face_id))
                candidates.sort(key=lambda item: item[0])
                to_submit = []
                for _, session, state, face_id in candidates:
                    if self.sessions.get(session) is not state:
                        continue
                    person_busy = state.setdefault('personBusy', set())
                    if face_id in person_busy or face_id not in state.get('personLatest', {}):
                        continue
                    person_busy.add(face_id)
                    to_submit.append((session, state, face_id))
            pool = getattr(self, 'face_pool', None)
            for session, state, face_id in to_submit:
                if pool is not None:
                    try:
                        pool.submit(self._process_person, session, state, face_id)
                    except RuntimeError:
                        with self.lock:
                            state.get('personBusy', set()).discard(face_id)
                else:
                    self._process_person(session, state, face_id)

    def _publish_object_geometry(self,session,state):
        # Hand/interaction analysis must not withhold ready object rectangles.
        objects=[]
        for obj in state['objects']:
            x,y,w,h=obj['box'];left,top=max(0.,x),max(0.,y)
            right,bottom=min(1.,x+w),min(1.,y+h)
            if right<=left or bottom<=top:continue
            objects.append(dict(kind={63:'laptop',67:'phone',73:'book'}[obj['class']],detectionId=obj['detectionId'],
                box=dict(x=left,y=top,width=right-left,height=bottom-top),confidence=obj['confidence'],
                observedAt=state['objectsAt'],interaction=False))
        with self.lock:
            if self.sessions.get(session) is state:
                self.scene_objects[session]=dict(at=state['objectsAt'],objects=objects)

    def _scene_loop(self):
        while not self.stop.wait(.02):
            with self.lock:
                pending = list(self.scene_latest.items())
                self.scene_latest.clear()
            for session,(frame,faces,at,state) in pending:
                try:
                    if not self._feature_enabled(session, 'objects'):
                        continue
                    before = state["objectsAt"]
                    self._scene(state,frame,at)
                    if state["objectsAt"] == before:
                        continue
                    self._publish_object_geometry(session,state)
                    owners = self._ownership(frame,state,faces,at)
                    # Every YOLO object is a tracking target, even without a
                    # face/body/hand owner. Ownership is optional metadata.
                    detected_objects=[]
                    for obj in state['objects']:
                        x,y,w,h=obj['box']; left,top=max(0.,x),max(0.,y)
                        right,bottom=min(1.,x+w),min(1.,y+h)
                        if right<=left or bottom<=top:continue
                        linked=[(face_id,region) for face_id,(_,_,regions) in owners.items() for region in regions
                                if region.get('detectionId')==obj['detectionId']]
                        item=dict(kind={63:'laptop',67:'phone',73:'book'}[obj['class']],detectionId=obj['detectionId'],
                            box=dict(x=left,y=top,width=right-left,height=bottom-top),confidence=obj['confidence'],
                            observedAt=state['objectsAt'],interaction=False)
                        body_owners=[identity for identity,observation in state.get('bodyObservations',{}).items()
                            if any(region.get('detectionId')==obj['detectionId'] for region in observation.get('objectRegions',[]))]
                        if len(body_owners)==1:
                            item['ownerPersonId']=body_owners[0]
                            region=next(region for region in state['bodyObservations'][body_owners[0]]['objectRegions'] if region.get('detectionId')==obj['detectionId'])
                            item['interaction']=region['interaction']
                        if len(linked)==1:
                            item.update(ownerGeometryId=linked[0][0],interaction=linked[0][1]['interaction'])
                        detected_objects.append(item)
                    output = {}
                    for face in faces:
                        person_id,objects,regions = owners.get(face["id"],(None,None,[]))
                        output[face["id"]] = dict(
                            phoneHeld=None if objects is None else objects[67],
                            laptopInteraction=None if objects is None else objects[63],
                            bookInteraction=None if objects is None else objects[73],
                            objectRegions=[dict(region,observedAt=state["objectsAt"]) for region in regions],
                            objectsAt=state["objectsAt"],personId=person_id)
                    with self.lock:
                        if self.sessions.get(session) is state:
                            self.scene_results[session] = output
                            self.scene_boxes[session] = list(state["bodies"])
                            self.scene_objects[session] = dict(at=state['objectsAt'],objects=detected_objects)
                            self.version = getattr(self, 'version', 0) + 1
                            self.timings['sceneLatencyMs']=int(time.time()*1000)-at
                    self.scene_error = None
                except Exception as error:
                    import traceback
                    traceback.print_exc()
                    self.scene_error = str(error)

    def close(self):
        self.stop.set()
        for event in (getattr(self, 'face_event', None), getattr(self, 'pose_event', None), getattr(self, 'rest_event', None)):
            if event is not None:
                event.set()
        self.thread.join(timeout=10)
        if getattr(self, 'face_pool', None) is not None:
            self.face_pool.shutdown(wait=True, cancel_futures=True)
        self.scene_thread.join(timeout=10)
        self.pose_thread.join(timeout=10)
        self.rest_thread.join(timeout=10)
        self.actions.close()
        closed_models = set()
        for model in list(getattr(self, '_face_models', [])):
            if id(model) not in closed_models:
                closed_models.add(id(model))
                try: model.close()
                except Exception: pass
        if self.face is not None and id(self.face) not in closed_models:
            try: self.face.close()
            except Exception: pass
        if self.profile is not None: self.profile.close()
        if self.hands is not None: self.hands.close()
