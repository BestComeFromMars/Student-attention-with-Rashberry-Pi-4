"""YOLO11 + ByteTrack + MediaPipe measurements, independently of fast bbox updates."""
import os
import threading
import time
import gc
from collections import deque
from pathlib import Path
from types import SimpleNamespace
import cv2
import mediapipe as mp
import numpy as np
import torch
from ultralytics import YOLO
from ultralytics.trackers.byte_tracker import BYTETracker
from head_orientation import keypoint_heading
from body_pose import pack_pose,match_poses
from desk_rest import DeskRestDetector,corroborate_people,attach_rest,rest_person_candidates,activate_confirmed_rest_people,latest_rest_evidence,refresh_rest
from rest_body_tracking import RestBodyTracking
from geometry import iou
from face_validation import landmarks_match_box
from image_quality import face_quality, enhance_low_light
from mouth_geometry import measure_mouth
from profile_landmarks import ProfileLandmarker
from association import associate_objects
from native_runtime import serialized,export_serialized
from onnx_yolo import ONNXRuntimeYOLO
from action_recognition import ActionRecognizer
from object_scene import SceneObjects
from scb_recognition import SCBRecognizer
from memory_budget import MemoryBudget,select_people

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
        # multiprocessing uses spawn on Windows: OpenCV's parent thread limit
        # is not inherited. Its default per-operation pool oversubscribed all
        # face/YOLO/pose/hand threads in dense scenes and delayed snapshots.
        cv2.setNumThreads(max(1,min(4,int(os.environ.get('AI_OPENCV_THREADS','1')))))
        self.device = os.environ.get("AI_DEVICE", "cpu")
        if self.device == "auto":
            self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        torch.set_num_threads(max(1, min(4, int(os.environ.get("AI_THREADS", "1")))))
        torch.set_num_interop_threads(1)
        # Keep optimized convolutions; disabling them greatly increases CPU workspace RAM.
        if os.name=="nt" and self.device=="cpu":
            torch.backends.mkldnn.enabled = os.environ.get("AI_USE_MKLDNN","1")=="1"
        # Keep the legacy status field for clients, without loading a scoring model.
        self.engagement=SimpleNamespace(model=None,status='disabled_observation_only')
        self.desk_rest=DeskRestDetector(self.models)
        if self.device=='cpu':
            self.people=ONNXRuntimeYOLO(self.models/'yolo11s.onnx')
            # Its own session: mutable input buffers must not be shared with
            # the concurrent person detector. The CPU host uses the small graph
            # so full frame + one crop can finish before evidence expires.
            self.objects=ONNXRuntimeYOLO(self.models/'yolo11s.onnx')
            self.pose=ONNXRuntimeYOLO(self.models/'yolo11n-pose.onnx',pose=True)
        else:
            self.people = YOLO(str(self.models/"yolo11s.pt"))
            self.objects = YOLO(str(self.models/"yolo11m.pt"))
            self.pose = YOLO(str(self.models/"yolo11n-pose.pt"))
        self.scene_detector=SceneObjects(self.objects,self.device)
        # Fuse and warm before MediaPipe creates its native inference delegates.
        blank = np.zeros((320, 320, 3), np.uint8)
        print("AI: warming YOLO models",flush=True)
        for model in (self.people, self.objects, self.pose):
            model.predict(blank, imgsz=640, device=self.device, verbose=False)
        vision = mp.tasks.vision
        options = mp.tasks.BaseOptions
        self.face = vision.FaceLandmarker.create_from_options(vision.FaceLandmarkerOptions(
            base_options=options(model_asset_path=str(self.models/"face_landmarker.task")),
            running_mode=vision.RunningMode.IMAGE, num_faces=1,
            min_face_detection_confidence=.3, min_face_presence_confidence=.45,
            output_face_blendshapes=True, output_facial_transformation_matrixes=True))
        self.profile = ProfileLandmarker(self.models/'face_landmarker.task')
        self.hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=options(model_asset_path=str(self.models/"hand_landmarker.task")),
            running_mode=vision.RunningMode.IMAGE, num_hands=2,
            min_hand_detection_confidence=.35, min_hand_presence_confidence=.35))
        self.actions=SCBRecognizer(self.models.parent/'classroom-actions') if os.environ.get('AI_CLASSROOM_ACTIONS')=='1' else ActionRecognizer(self.models.parent/'actions')
        self.memory_budget=MemoryBudget()
        self.person_limit=self.memory_budget.limit
        self.sessions = {}
        self.latest = {}
        self.scene_latest = {}
        self.body_latest = {}
        self.pose_latest = {}
        self.rest_latest = {}
        self.scene_results = {}
        self.scene_boxes = {}
        self.scene_objects = {}
        self.results = {}
        self.lock = threading.Lock()
        self.stop = threading.Event()
        self.face_error = None
        self.scene_error = None
        self.timings={'opencvThreads':cv2.getNumThreads()}
        self.thread = threading.Thread(target=self._loop, name="behavior-analysis", daemon=False)
        self.scene_thread = threading.Thread(target=self._scene_loop,name="objects-and-body",daemon=False)
        self.body_thread=threading.Thread(target=self._body_loop,name='person-detection',daemon=False)
        self.pose_thread=threading.Thread(target=self._pose_loop,name='person-pose',daemon=False)
        self.rest_thread=threading.Thread(target=self._rest_loop,name='desk-rest',daemon=False)
        self.thread.start()
        self.scene_thread.start()
        self.body_thread.start()
        self.pose_thread.start()
        self.rest_thread.start()
        print("AI: all pipelines ready",flush=True)

    def submit(self, session, frame, faces, at, body_only=False):
        state = self._state(session)
        self.person_limit=self.memory_budget.update(sum(len(s.get('bodies',[])) for s in self.sessions.values()))
        faces=select_people(faces,self.person_limit,state.get('faceCache',{}))
        state['lastAt']=at
        if not body_only:self.actions.observe(session,frame,state['bodies'],at)
        with self.lock:
            if not body_only:
                self.latest[session] = (frame, faces, at,state)  # replace, never append old camera frames
                self.scene_latest[session] = (frame,faces,at,state)
            self.body_latest[session]=(frame,at,state)
            self.pose_latest[session]=(frame,at,state)
            self.rest_latest[session]=(frame,at,state)

    def snapshot(self, session):
        with self.lock:
            output = {key:dict(value) for key,value in self.results.get(session, {}).items()}
            for key,value in self.scene_results.get(session,{}).items():
                output.setdefault(key,dict(valid=False,eyeAspectRatio=0,yawOffset=0)).update(value)
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
            rest_current=refresh_rest(bodies,rest_observations,rest_candidates,rest_at,state.get('lastAt',body_at))
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
            self.scene_latest.pop(session,None)
            self.body_latest.pop(session,None)
            self.pose_latest.pop(session,None)
            self.rest_latest.pop(session,None)
            self.scene_results.pop(session,None)
            self.scene_boxes.pop(session,None)
            self.scene_objects.pop(session,None)
            self.results.pop(session, None)
            self.sessions.pop(session, None)
            self.actions.release(session)

    def _state(self, session):
        with self.lock:
            if session not in self.sessions:
                from ultralytics.trackers.basetrack import BaseTrack
                count = BaseTrack._count
                args = SimpleNamespace(track_high_thresh=.2, track_low_thresh=.1, new_track_thresh=.2,
                                       track_buffer=30, match_thresh=.8, fuse_score=True)
                tracker = BYTETracker(args,frame_rate=5)
                BaseTrack._count = max(count,BaseTrack._count)
                self.sessions[session] = dict(tracker=tracker,peopleAt=0,
                    objectsAt=0,bodies=[],objects=[],wrists=[],poses=[],cursor=0,faceCache={},bodyObservations={},lastAt=0,poseAt=0,bodyHistory=deque(maxlen=20))
            return self.sessions[session]

    def _people(self,state,frame,at):
        height,width = frame.shape[:2]
        if at-state["peopleAt"] >= 300:
            result = self.people.predict(frame, imgsz=int(os.environ.get("AI_SCENE_IMGSZ","640")),
                                         classes=[0],conf=.03,device=self.device,verbose=False)[0]
            rows=result.boxes.data.cpu().numpy()
            recent=[p for p in state.get('restReferences',[]) if 0<=at-p['personObservedAt']<=2000]
            # The auxiliary posture model used to block every person scan.
            # Consume its bounded, timestamped latest result without waiting.
            with self.lock:
                rest_at,evidence=latest_rest_evidence(state.get('restHistory',()),at)
            candidates=rest_person_candidates(rows,evidence,width,height,at,rest_at,state.get('restPersonCandidates',[]))
            rows,rest=corroborate_people(rows,evidence,width,height,at,recent,state.get('restPersonCandidates',[]),rest_at)
            for candidate in candidates:
                candidate['confirmed']=candidate.get('confirmed',False) or any(iou(candidate['box'],cue['candidateBox'])>=.5 for cue in rest.values())
            state['restPersonCandidates']=candidates
            self.timings.update(restPersonCandidates=len(candidates),restPeopleMatched=len(rest),
                restEvidenceAgeMs=at-rest_at if rest_at else None)
            # A weak candidate may continue a recently verified posture, but
            # cannot start a person or renew the independent-person timestamp.
            renewed=[p for p in rest.values() if p['candidateConfidence']>=.1]
            state['restReferences']=[p for p in recent if not any(iou(p['box'],q['box'])>=.5 for q in renewed)]+renewed
            from ultralytics.engine.results import Boxes
            # Frontend switches 720p/1080p without changing the camera/session.
            # Keep Kalman state in the first frame's coordinate plane; a resize
            # is not a person moving or a reason to replace their identity.
            tracking_width,tracking_height=state.setdefault('trackingSize',(width,height))
            scale=np.asarray([tracking_width/width,tracking_height/height,tracking_width/width,tracking_height/height],dtype=np.float32)
            tracking_rows=rows.copy();tracking_rows[:,:4]*=scale
            tracked=state['tracker'].update(Boxes(torch.from_numpy(tracking_rows),(tracking_height,tracking_width)).numpy(),None).copy()
            if len(tracked):tracked[:,:4]/=scale
            tracked=activate_confirmed_rest_people(state['tracker'],tracked,rest,width,height,scale)
            bodies = [{"id":int(row[4]), "at":at,"confidence":float(row[5]), "box":[float(row[0]/width),float(row[1]/height),
                float((row[2]-row[0])/width),float((row[3]-row[1])/height)]} for row in tracked]
            state['bodyCandidateCount']=len(bodies)
            bodies=select_people(bodies,self.person_limit,(body['id'] for body in state.get('bodies',[])))
            with self.lock:
                observed=attach_rest(tracked,rows,rest,at,width,height)
                for cue in observed.values():cue['observedAt']=rest_at
                retained={identity:cue for identity,cue in state.get('restObservations',{}).items()
                          if 0<=at-cue.get('personObservedAt',cue['observedAt'])<=2000}
                state['restObservations']={**retained,**observed}
                folded=state.setdefault('restBodyTracking',RestBodyTracking())
                folded.seed(bodies,observed,at)
                if state.get('restAt',0)>=at:folded.update(state.get('restCandidates',[]),state['restAt'])
                state['bodies']=bodies;state['bodyHistory'].append((at,[dict(body) for body in bodies]));state['peopleAt']=at

    def _rest_loop(self):
        while not self.stop.wait(.02):
            with self.lock:pending=list(self.rest_latest.items());self.rest_latest.clear()
            for session,(frame,at,state) in pending:
                try:
                    # Match person detection's cadence. Skipping its second
                    # image discarded the independent posture confirmation
                    # needed to start an already folded, face-hidden person.
                    if at-state.get('restAt',0)<300:continue
                    started=time.perf_counter();evidence=self.desk_rest.predict(frame)
                    with self.lock:
                        if self.sessions.get(session) is not state:continue
                        state.setdefault('restHistory',deque(maxlen=8)).append((at,evidence))
                        state.update(restAt=at,restCandidates=evidence)
                        if state.get('restBodyTracking'):state['restBodyTracking'].update(evidence,at)
                        self.timings.update(restLatencyMs=int(time.time()*1000)-at,
                            restInferenceMs=round((time.perf_counter()-started)*1000,2),restCandidates=len(evidence),restError=None)
                except Exception as error:self.timings['restError']=str(error)

    def _body_loop(self):
        while not self.stop.wait(.015):
            with self.lock:pending=list(self.body_latest.items());self.body_latest.clear()
            for session,(frame,at,state) in pending:
                try:
                    # ONNX people detection has its own bounded cadence. It
                    # must not wait behind transformer/pose/object work.
                    started=time.perf_counter()
                    self._people(state,frame,at)
                    self.timings.update(bodyLatencyMs=int(time.time()*1000)-state['peopleAt'],
                        bodyInferenceMs=round((time.perf_counter()-started)*1000,2),bodyDetections=len(state['bodies']))
                    self.timings['bodyError']=None
                except Exception as error:self.timings['bodyError']=str(error)

    @export_serialized
    def _pose(self, frame, at):
        height,width=frame.shape[:2]
        pose=self.pose.predict(frame,imgsz=640,conf=.25,device=self.device,verbose=False)[0]
        result=dict(wrists=[],poses=[],headings=[],poseRegions=[],poseAt=at)
        if pose.keypoints is not None:
            for box,points,confidence in zip(pose.boxes.xyxy.cpu().numpy(),pose.keypoints.data.cpu().numpy(),pose.boxes.conf.cpu().numpy()):
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
        while not self.stop.wait(.015):
            with self.lock:pending=list(self.pose_latest.items());self.pose_latest.clear()
            for session,(frame,at,state) in pending:
                try:
                    if at-state.get('poseAt',0)<400:continue
                    result=self._pose(frame,at)
                    with self.lock:
                        if self.sessions.get(session) is not state:continue
                        self._publish_pose(state,result,at)
                        self.timings.update(poseLatencyMs=int(time.time()*1000)-at,poseError=None,
                            poseDetections=len(result['poseRegions']),poseMatches=len(state['poseObservations']),
                            poseBodyCandidates=state['poseBodyCandidates'],poseBestIoU=state['poseBestIoU'])
                except Exception as error:self.timings['poseError']=str(error)

    @serialized
    def _scene(self, state, frame, at):
        height,width=frame.shape[:2]
        if at-state["objectsAt"] >= 700:
            cursor=state.get('objectTile',0)
            detected=self.scene_detector.predict(frame,cursor) if hasattr(self,'scene_detector') else self.objects.predict(
                frame,imgsz=640,classes=[63,67,73],conf=.2,device=self.device,verbose=False)[0].boxes.data.cpu().numpy()
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
        result = self.hands.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb))
        return [(float((left+p.x*(right-left))/width),float((top+p.y*(bottom-top))/height))
                for hand in result.hand_landmarks for i,p in enumerate(hand) if i in [0,5,8,9,12,16,20]]

    def _ownership(self, frame, state, faces,at=None):
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
            if near_objects and budget>0:
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
        factor = 256/max(crop.shape[:2])
        scaled = cv2.resize(crop,(max(1,round(crop.shape[1]*factor)),max(1,round(crop.shape[0]*factor))))
        rgb = np.ascontiguousarray(cv2.cvtColor(scaled,cv2.COLOR_BGR2RGB))
        result = self.face.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb))
        if not result.face_landmarks:
            enhanced = enhance_low_light(scaled)
            if enhanced is not None:
                rgb = np.ascontiguousarray(cv2.cvtColor(enhanced,cv2.COLOR_BGR2RGB))
                result = self.face.detect(mp.Image(image_format=mp.ImageFormat.SRGB,data=rgb))
        profile_only = False
        if not result.face_landmarks:
            result = self.profile.detect(frame,face,state) if getattr(self,'profile',None) is not None else None
            if result is None:
                return missing
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
        refined = [(mn[0]/width-box[0])/max(box[2],1e-6),(mn[1]/height-box[1])/max(box[3],1e-6),
                   (mx[0]-mn[0])/width/max(box[2],1e-6),(mx[1]-mn[1])/height/max(box[3],1e-6)]
        mouth_valid = bool(face["facePixels"] >= int(os.environ.get("MIN_BEHAVIOR_FACE_PX","40")))
        valid = mouth_valid and not profile_only
        # Coarse orientation needs less detail than eyelids/articulation. Do not
        # withhold a measured head pose solely because mouth detail is missing.
        head_pose_valid=bool(face['facePixels']>=32 and quality.get('usable') is not False and
            yaw is not None and np.isfinite(yaw) and abs(yaw)<=90 and
            (pitch is None or np.isfinite(pitch) and abs(pitch)<=75))
        # Upscaling a tiny face does not restore eyelid detail. Keep its box,
        # heading and mouth measurements, but do not turn noisy EAR into an
        # eye-closure warning. The original-image pixels decide availability.
        eye_valid=bool(valid and face['facePixels']>=64 and quality.get('usable') is not False and
            min(distance(points[33],points[133]),distance(points[362],points[263]))>=8 and
            (yaw is None or abs(yaw)<=45) and (pitch is None or abs(pitch)<=35))
        return dict(valid=valid,facePresent=not profile_only,faceBox=list(box),mouthValid=mouth_valid,
            eyeValid=eye_valid,
            headPoseValid=head_pose_valid,
            mouthSource='profile_roi' if profile_only else 'face_landmarker',eyeAspectRatio=float(ear),yawOffset=abs(yaw or 0)/90,
            leftEyeAspectRatio=left_ear,rightEyeAspectRatio=right_ear,
            pitchDeg=pitch,yawDeg=yaw,**mouth,jawOpen=blend.get("jawOpen"),
            eyeBlinkLeft=blend.get("eyeBlinkLeft"),eyeBlinkRight=blend.get("eyeBlinkRight"),
            mouthSmileLeft=blend.get('mouthSmileLeft'),mouthSmileRight=blend.get('mouthSmileRight'),
            observedAt=at,facePixels=float(face["facePixels"]),refinement=None if profile_only else [float(x) for x in refined],
            quality=quality)

    def _loop(self):
        while not self.stop.wait(.01):
            with self.lock:
                pending = list(self.latest.items())
                self.latest.clear()
            for session,(frame,faces,at,state) in pending:
                try:
                    count = len(faces)
                    selected = [faces[(state["cursor"]+i)%count] for i in range(min(12,count))] if count else []
                    state["cursor"] = (state["cursor"]+len(selected))%max(1,count)
                    alive = {face["id"] for face in faces}
                    state['profileRois'] = {key:value for key,value in state.get('profileRois',{}).items() if key in alive}
                    cache = {key:value for key,value in state["faceCache"].items() if key in alive}
                    for face in selected:
                        with self.lock:
                            active=self.sessions.get(session) is state
                        if not active:
                            break
                        measurement = self._face(frame,face,at,session,state)
                        if measurement:
                            cache[face["id"]] = measurement
                    state["faceCache"] = cache
                    output = {}
                    for face in faces:
                        observation = dict(cache.get(face["id"],dict(valid=False,eyeAspectRatio=0,yawOffset=0,observedAt=at)))
                        output[face["id"]] = observation
                    with self.lock:
                        if self.sessions.get(session) is state:
                            self.results[session] = output
                            self.timings['faceLatencyMs']=int(time.time()*1000)-at
                    self.face_error = None
                except Exception as error:
                    import traceback
                    traceback.print_exc()
                    self.face_error = str(error)

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
                            self.timings['sceneLatencyMs']=int(time.time()*1000)-at
                    self.scene_error = None
                except Exception as error:
                    import traceback
                    traceback.print_exc()
                    self.scene_error = str(error)

    def close(self):
        self.stop.set()
        self.thread.join(timeout=10)
        self.scene_thread.join(timeout=10)
        self.body_thread.join(timeout=10)
        self.pose_thread.join(timeout=10)
        self.rest_thread.join(timeout=10)
        self.actions.close()
        self.face.close()
        self.profile.close()
        self.hands.close()
