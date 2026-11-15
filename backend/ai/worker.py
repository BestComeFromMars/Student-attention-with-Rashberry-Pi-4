"""A child of the Node backend. No HTTP listener, service registration, or camera access."""
import argparse
import base64
import json
import os
import sys
import time
import psutil
import gc
from pathlib import Path

protocol = sys.stdout
sys.stdout = sys.stderr  # library messages never corrupt the JSON protocol
import cv2
import numpy as np
from geometry import FaceGeometry
from face_validation import face_is_publishable, landmark_confirmation, face_tracking_state
from perception_process import PerceptionProcess as Perception
from visual_tracking import FaceVisualTracker
from object_tracking import ObjectVisualTracker
from person_tracking import PersonTracking,merge_rest_bodies
from memory_budget import MemoryBudget,select_people


def send(message):
    protocol.write(json.dumps(message, separators=(",", ":"), allow_nan=False) + "\n")
    protocol.flush()


def main():
    from camera_cpu import camera_cpu
    camera_cpu()
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    cv2.setNumThreads(max(1,min(4,int(os.environ.get('AI_OPENCV_THREADS','1')))))
    if os.environ.get('AI_EXPORT_SERIAL_NATIVE')=='1':
        import multiprocessing
        import native_runtime
        native_runtime.EXPORT_NATIVE_LOCK=multiprocessing.get_context('spawn').RLock()
    analysis = Perception(args.models)
    FaceVisualTracker.warmup(args.models/'object_tracking_vittrack_2023sep.onnx')
    gc.collect()
    process=psutil.Process()
    def memory_mb(item):
        info=item.memory_info()
        return getattr(info,'private',info.rss)/1024**2
    print('AI process memory MB: '+str(round(memory_mb(process)))+
          '; child MB: '+str(round(sum(memory_mb(child) for child in process.children(recursive=True)))),flush=True)
    sessions = {};memory_at=0;private_mb=0
    memory_budget=MemoryBudget()
    send({"type":"ready","capabilities":{
        "people":"YOLO11s","objects":"YOLO11s + bounded crop" if analysis.device=='cpu' else 'YOLO11m + bounded crop',"tracking":"ByteTrack",
        "faces":"YuNet + SCRFD-10G + MediaPipe Face Landmarker","hands":"MediaPipe Hand Landmarker",
        "pose":"YOLO11n-pose","behaviors":11,"maxFaces":min(memory_budget.limit,analysis.person_limit),"memory":memory_budget.status(limit=min(memory_budget.limit,analysis.person_limit)),"attentionScoring":False,
        "postureObservation":"immediate camera reference; sustained turn, turn with smile, upper-body slump; pretrained pose + corroborated appearance",
        "deskRest":"Pinned community YOLOv8n posture cue + independent YOLO11s person/shape agreement; not sleep diagnosis",
        "headTurning":"3 sustained orientation changes / 10s; person history; face pose or visible head keypoints",
        "personTracking":"ByteTrack + native person rectangles; optional face evidence",
        "actions":analysis.actions_model,"actionClasses":analysis.actions_classes,"actionModelStatus":analysis.actions_status,
        "actionAccuracyVerified":False,
        "objectFocus":"v4-independent-vittrack",
        "objectTracking":"OpenCV VitTrack / ONNX Runtime; independent object IDs and current-frame rectangles",
        "yoloRuntime":"onnxruntime-cpu" if analysis.device=='cpu' else 'pytorch',
        "faceTracking":"Current-frame YuNet + bounded SCRFD-500M recovery of verified faces; VitTrack fallback; SCRFD-10G verification",
        "cavt":analysis.engagement.status,"cavtPrecision":None,
        "device":analysis.device}})
    try:
        for line in sys.stdin:
            message = None
            try:
                message = json.loads(line)
                session = str(message.get("session","default"))
                if message.get("type") == "release":
                    closed = sessions.pop(session,None)
                    if closed:
                        closed["geometry"].close()
                        closed['objects'].close()
                        closed['persons'].close()
                    analysis.release(session)
                    continue
                started = time.perf_counter()
                limit=min(memory_budget.update(sum(state.get('processed',0) for state in sessions.values())),analysis.person_limit)
                jpeg = base64.b64decode(message["image"], validate=True)
                encoded = np.frombuffer(jpeg,np.uint8)
                frame = cv2.imdecode(encoded,cv2.IMREAD_COLOR)
                if frame is None or frame.shape[0]*frame.shape[1] > 12_000_000:
                    raise ValueError("Invalid or oversized JPEG")
                offline_at=message.get('at') if os.environ.get('AI_EXPORT_VIDEO_TIMELINE')=='1' else None
                at = int(offline_at) if isinstance(offline_at,(int,float)) else int(time.time()*1000)
                if session not in sessions:
                    sessions[session] = dict(geometry=FaceGeometry(
                        args.models/"scrfd_10g.onnx"),objects=ObjectVisualTracker(),persons=PersonTracking(),seen=at,confirmations={},accepted={},acceptedEvidence={})
                state = sessions[session]
                state['geometry'].max_faces=limit
                state['persons'].set_limit(limit)
                frame_ids=state.setdefault('frameIds',{})
                if isinstance(message.get('frameId'),int):frame_ids[at]=message['frameId']
                state['frameIds']=frame_ids={k:v for k,v in frame_ids.items() if at-k<=6000}
                state["seen"] = at
                # Start person/pose inference before potentially slow face geometry.
                # This phase does not clear or replace face measurements.
                analysis.submit(session,frame,[],at,body_only=True)
                observations = analysis.snapshot(session)
                body_snapshot=analysis.body_snapshot(session)
                body_snapshot['bodies']=select_people(body_snapshot['bodies'],limit,(body['id'] for body in state['persons'].tracks))
                dense=state['geometry']._dense_scene(body_snapshot['bodies'])
                if dense:
                    # Dense faces are measured directly on this image, without
                    # body anchoring. Let the parallel person model finish while
                    # that detector runs, then take its NEWEST atomic snapshot.
                    # Reading only before the slow face pass added an entire
                    # inference of avoidable age to every body/template job.
                    faces=state['geometry'].update(frame,at,body_snapshot['bodies'],observations)
                    body_snapshot=analysis.body_snapshot(session)
                body_started=time.perf_counter()
                bodies=state['persons'].update(frame,at,body_snapshot['bodies'],body_snapshot['bodyAt'])
                body_tracking_ms=round((time.perf_counter()-body_started)*1000,2)
                if not dense:
                    faces=state['geometry'].update(frame,at,bodies,observations)
                    completed=analysis.body_snapshot(session,wait_ms=750 if not body_snapshot['bodyAt'] else 0)
                    if completed['bodyAt']>body_snapshot['bodyAt']:
                        # Person inference often finishes during the first face
                        # scan. Publish both boxes in this response, without
                        # waiting for another upload or tracking pixels twice.
                        body_started=time.perf_counter()
                        bodies=state['persons'].refresh(at,completed['bodies'],completed['bodyAt'])
                        body_tracking_ms+=round((time.perf_counter()-body_started)*1000,2)
                        body_snapshot=completed
                tracked_objects=state['objects'].update(frame,at,analysis.object_hints(session))
                if analysis.submit(session,frame,faces,at):
                    state['objects'].remember_source(frame,at)
                observations = analysis.snapshot(session)
                # Refresh only evidence metadata after geometry; its rectangles
                # already belong to the current image and must not move again.
                body_metadata={body['id']:body for body in analysis.body_hints(session)}
                for body in bodies:
                    latest=body_metadata.get(body['id'])
                    if latest is not None:
                        body['observation']=latest.get('observation',{})
                        body['actions']=latest.get('actions',[])
                bodies=select_people(merge_rest_bodies(bodies,analysis.rest_bodies(session),at),limit,(body['id'] for body in state['persons'].tracks))
                for body in bodies:
                    rest=body.get('observation',{}).get('deskRest')
                    if rest is not None:
                        body['observation']={**body['observation'],'deskRest':{**rest,'imageAt':at}}
                alive = {face['id'] for face in faces}
                state['accepted'] = {key:value for key,value in state['accepted'].items() if key in alive}
                state['acceptedEvidence'] = {key:value for key,value in state['acceptedEvidence'].items() if key in alive}
                state['confirmations'] = {key:value for key,value in state['confirmations'].items() if key in alive}
                people = []
                for face in faces:
                    observation = observations.get(face["id"],dict(valid=False,eyeAspectRatio=0,yawOffset=0,observedAt=at,quality=face.get('quality')))
                    measured = landmark_confirmation(face,faces,observation,at)
                    if measured is not None:
                        state['confirmations'][face['id']] = measured
                    confirmed = face_is_publishable(face,faces,observation,at,state['confirmations'].get(face['id']))
                    if confirmed:
                        evidence_at = max(face.get('detectedAt',0),measured['at'] if measured else 0)
                        if evidence_at>state['acceptedEvidence'].get(face['id'],-1):
                            state['acceptedEvidence'][face['id']] = evidence_at
                            # A cold first detector call can itself take >1s.
                            # Start the display grace when its result exists;
                            # duplicate cached evidence cannot renew this time.
                            state['accepted'][face['id']] = at if offline_at is not None else int(time.time()*1000)
                    mode = face_tracking_state(face,confirmed,state['accepted'].get(face['id']),at)
                    if mode is None:
                        continue
                    if not confirmed:
                        # Retaining a known ROI cannot create new eye/mouth or
                        # object alerts from cached measurements.
                        observation = dict(valid=False,facePresent=False,eyeAspectRatio=0,yawOffset=0,observedAt=at)
                    # Use the native model rectangle; the browser paints it on
                    # the matching analyzed image, without another size filter.
                    x,y,w,h = face['box']
                    x,y = max(0.,x),max(0.,y)
                    w,h = min(w,1-x),min(h,1-y)
                    if w <= 0 or h <= 0:
                        continue
                    people.append(dict(
                        box=dict(x=x,y=y,width=w,height=h),boxKind="face",confidence=face["score"],
                        geometryId=face["id"],personId=observation.get("personId") or face.get('personId'),
                        trackingState=mode,
                        geometryTimes=dict(face=max(face.get('visualAt') or 0,face.get('fastFaceAt') or 0,face.get('detectedAt') or 0)),
                        observation=observation,analysisAt=observation.get("observedAt")))
                face_people=people
                people=state['persons'].assemble(bodies,face_people,at)
                detected=max(len(people),body_snapshot.get('candidateCount',0),state['geometry'].candidate_count)
                preferred=state.get('selectedPeople',set())
                if len(people)>limit:
                    people=sorted(people,key=lambda person:(str(person.get('personId',person.get('geometryId'))) not in preferred,-person.get('confidence',0)))[:limit]
                state['selectedPeople']={str(person.get('personId',person.get('geometryId'))) for person in people}
                state['processed']=len(people)
                memory=memory_budget.status(detected,len(people),limit)
                for person in people:
                    times=person.pop('geometryTimes',{})
                    person['geometryFrameIds']={kind:frame_ids[t] for kind,t in times.items() if t in frame_ids}
                if time.monotonic()-memory_at>2:
                    private_mb=round(memory_mb(process)+sum(memory_mb(child) for child in process.children(recursive=True)),1);memory_at=time.monotonic()
                send({"id":message["id"],"people":people,"objects":tracked_objects,"frameAt":at,"memory":memory,
                      "metrics":{"geometryMs":round((time.perf_counter()-started)*1000,2),
                                 "bodyTrackingMs":body_tracking_ms,"bodyTrackingError":state['persons'].error,
                                 "bodyHintCount":len(body_snapshot['bodies']),"bodyHintAgeMs":at-body_snapshot['bodyAt'] if body_snapshot['bodyAt'] else None,
                                 "bodyTemplateBusy":state['persons'].job is not None,
                                 "privateMemoryMB":private_mb,
                                 "memory":memory,
                                 "faceCount":sum(person['trackingState'] in ('face','visual') for person in face_people),
                                 "trackedFaceCount":len(face_people),
                                 "inferredFaceCount":sum(person['trackingState'] in ('body','coasting','predicted') for person in face_people),
                                 "analysisError":analysis.error,
                                 "objectTrackingError":state['objects'].error,
                                 "trackedObjectCount":len(tracked_objects),
                                 "candidateFaceCount":len(faces),
                                 "hiddenFaceCount":len(faces)-len(face_people),"personCount":len(bodies),
                                 "meshFaceCount":sum(landmark_confirmation(face,faces,observations.get(face['id'],{}),at) is not None for face in faces),
                                 **({'faceTrackingDetails':[dict(id=f['id'],box=f['box'],verifiedAge=at-(f.get('verifiedAt') or 0),
                                     detectedAge=at-f['detectedAt'],fastAge=at-(f.get('fastFaceAt') or 0),fastScore=f.get('fastFaceScore'),
                                     fastModel=f.get('fastFaceModel'),lost=f.get('visualLostAt'),missed=f.get('missedScans')) for f in faces]}
                                    if os.environ.get('AI_DEBUG_FACE_TRACKING')=='1' else {}),
                                 "geometryError":state['geometry'].scan_error,
                                 "rescanMs":state['geometry'].scan_ms,
                                 "cavt":analysis.engagement.status,**state['geometry'].timings,**analysis.timings}})
                for key in list(sessions):
                    if at-sessions[key]["seen"]>120000:
                        sessions[key]["geometry"].close()
                        sessions[key]['objects'].close()
                        sessions[key]['persons'].close()
                        del sessions[key]
                        analysis.release(key)
            except Exception as error:
                if isinstance(error,MemoryError) or any(term in str(error).lower() for term in ('bad allocation','insufficient memory','failed to allocate','not enough memory')):
                    memory_budget.reduce()
                    memory=memory_budget.status(max(1,locals().get('detected',0)),0)
                    memory['limited']=True
                    send(dict(id=message.get('id') if isinstance(message,dict) else None,people=[],objects=[],memory=memory,metrics=dict(memory=memory)))
                    gc.collect()
                    continue
                if not isinstance(error,(ValueError,KeyError)):
                    import traceback
                    traceback.print_exc()
                send({"id":message.get("id") if isinstance(message,dict) else None,"error":str(error)})
    finally:
        for state in sessions.values():
            state["geometry"].close()
            state['objects'].close()
            state['persons'].close()
        analysis.close()


if __name__ == "__main__":
    main()
