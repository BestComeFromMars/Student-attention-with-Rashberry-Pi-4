"""A child of the Node backend. Tier-1 fast geometry (YOLO11n + ByteTrack + SCRFD-2.5G)
runs directly on the current frame in parallel; Tier-2 behavior AI (PerceptionProcess)
runs asynchronously and only updates behavior colors/labels on existing bboxes.
"""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
import gc
import json
import os
from pathlib import Path
import sys
import time
import psutil

protocol = sys.stdout
sys.stdout = sys.stderr  # library messages never corrupt the JSON protocol
import cv2
import numpy as np
from face_validation import face_is_publishable, landmark_confirmation, face_tracking_state
from geometry import FaceGeometry
from memory_budget import MemoryBudget, select_people
from object_tracking import ObjectVisualTracker
from perception_process import PerceptionProcess as Perception
from person_tracking import PersonDetector, PersonTracking, merge_rest_bodies
from runtime_profile import resolve_profile, default_features
from visual_tracking import FaceVisualTracker


def send(message):
    protocol.write(json.dumps(message, separators=(",", ":"), allow_nan=False) + "\n")
    protocol.flush()


def main():
    from camera_cpu import camera_cpu
    camera_cpu()
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    cv2.setNumThreads(max(1, min(4, int(os.environ.get('AI_OPENCV_THREADS', '1')))))
    if os.environ.get('AI_EXPORT_SERIAL_NATIVE') == '1':
        import multiprocessing
        import native_runtime
        native_runtime.EXPORT_NATIVE_LOCK = multiprocessing.get_context('spawn').RLock()

    profile_cfg = resolve_profile()
    face_model_name = profile_cfg['faceModel']
    if not (args.models / face_model_name).is_file():
        face_model_name = 'scrfd_10g.onnx'
    person_detector = PersonDetector(args.models, profile_cfg['personModel'])
    analysis = Perception(args.models)
    offline_faces = os.environ.get('AI_EXPORT_WAIT_FOR_FACES') == '1'
    FaceVisualTracker.warmup(args.models / 'object_tracking_vittrack_2023sep.onnx')
    gc.collect()

    process = psutil.Process()

    def memory_mb(item):
        info = item.memory_info()
        return getattr(info, 'private', info.rss) / 1024 ** 2

    print(
        'AI process memory MB: ' + str(round(memory_mb(process)))
        + '; child MB: ' + str(round(sum(memory_mb(child) for child in process.children(recursive=True)))),
        flush=True,
    )

    sessions = {}
    session_features = {}
    memory_at = 0.0
    private_mb = 0.0
    memory_budget = MemoryBudget()
    tier1_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix='tier1-geom')

    send({
        "type": "ready",
        "capabilities": {
            "people": person_detector.model_name,
            "objects": "Lazy YOLO11n + optional crop (only when enabled)",
            "tracking": "ByteTrack (pure IoU)",
            "faces": f"YuNet + {face_model_name} + MediaPipe Face Landmarker",
            "hands": "MediaPipe Hand Landmarker (on-demand)",
            "pose": "YOLO11n-pose",
            "behaviors": 11,
            "maxFaces": memory_budget.limit,
            "memory": memory_budget.status(limit=memory_budget.limit),
            "attentionScoring": False,
            "profile": profile_cfg['name'],
            "maxDetectEdge": profile_cfg['maxDetectEdge'],
            "maxTrackEdge": profile_cfg['maxTrackEdge'],
            "postureObservation": "immediate camera reference; sustained turn, turn with smile, upper-body slump; pretrained pose + corroborated appearance",
            "deskRest": "Pinned community YOLOv8n posture cue + independent YOLO11 person/shape agreement; not sleep diagnosis",
            "headTurning": "3 sustained orientation changes / 10s; person history; face pose or visible head keypoints",
            "personTracking": "Direct Tier-1 YOLO11 + pure-IoU ByteTrack on current frame; decoupled behavior labels",
            "actions": analysis.actions_model,
            "actionClasses": analysis.actions_classes,
            "actionModelStatus": analysis.actions_status,
            "actionAccuracyVerified": False,
            "objectFocus": "v4-independent-vittrack",
            "objectTracking": "OpenCV VitTrack / ONNX Runtime; independent object IDs and current-frame rectangles",
            "yoloRuntime": "onnxruntime-cpu" if person_detector.device == 'cpu' else 'pytorch',
            "faceTracking": f"Current-frame YuNet + {face_model_name} in parallel with Tier-1 person detector",
            "cavt": analysis.engagement.status,
            "cavtPrecision": None,
            "device": person_detector.device,
        },
    })

    try:
        for line in sys.stdin:
            message = None
            try:
                message = json.loads(line)
                session = str(message.get("session", "default"))
                if message.get("type") == "configure":
                    features = dict(default_features(), **(message.get("features") or {}))
                    session_features[session] = features
                    analysis.configure(session, features)
                    if session in sessions:
                        sessions[session]['objects'].set_enabled(bool(features.get('objects', False)))
                    continue
                if message.get("type") == "release":
                    closed = sessions.pop(session, None)
                    session_features.pop(session, None)
                    if closed:
                        closed["geometry"].close()
                        closed['objects'].close()
                        closed['persons'].close()
                    analysis.release(session)
                    continue

                started = time.perf_counter()
                limit = min(
                    memory_budget.update(sum(s.get('processed', 0) for s in sessions.values())),
                    analysis.person_limit,
                )
                jpeg = base64.b64decode(message["image"], validate=True)
                encoded = np.frombuffer(jpeg, np.uint8)
                frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
                if frame is None or frame.shape[0] * frame.shape[1] > 12_000_000:
                    raise ValueError("Invalid or oversized JPEG")
                offline_at = message.get('at') if os.environ.get('AI_EXPORT_VIDEO_TIMELINE') == '1' else None
                at = int(offline_at) if isinstance(offline_at, (int, float)) else int(time.time() * 1000)

                if session not in sessions:
                    features = session_features.get(session, default_features())
                    obj_tracker = ObjectVisualTracker(
                        history_limit=profile_cfg['objectHistory'],
                        track_edge=profile_cfg['objectTrackEdge'],
                        max_objects=profile_cfg['maxObjects'],
                    )
                    obj_tracker.set_enabled(bool(features.get('objects', False)))
                    sessions[session] = dict(
                        geometry=FaceGeometry(
                            args.models / face_model_name,
                            face_max_edge=profile_cfg['faceMaxEdge'],
                            history_limit=profile_cfg['faceHistory'],
                            skip_low_light_normal=profile_cfg['skipLowLightRetryWhenNormal'],
                        ),
                        objects=obj_tracker,
                        persons=PersonTracking(max_people=limit),
                        seen=at,
                        confirmations={},
                        accepted={},
                        acceptedEvidence={},
                    )
                    analysis.configure(session, features)

                state = sessions[session]
                state['geometry'].max_faces = limit
                state['persons'].set_limit(limit)
                frame_ids = state.setdefault('frameIds', {})
                if isinstance(message.get('frameId'), int):
                    frame_ids[at] = message['frameId']
                state['frameIds'] = frame_ids = {k: v for k, v in frame_ids.items() if at - k <= 6000}
                state["seen"] = at

                # Read latest non-blocking Tier-2 behavior labels (never blocks Tier-1 geometry).
                observations = analysis.snapshot(session)

                # TIER 1: Run Person Detection (YOLO11n + ByteTrack) and Face Detection
                # (SCRFD-2.5G + YuNet) IN PARALLEL on the EXACT CURRENT FRAME (0 ms lag).
                body_started = time.perf_counter()
                body_future = tier1_pool.submit(state['persons'].detect, person_detector, frame, at)
                faces = state['geometry'].update(frame, at, state['persons'].tracks, observations)
                bodies = body_future.result()
                body_tracking_ms = round((time.perf_counter() - body_started) * 1000, 2)

                tracked_objects = (
                    state['objects'].update(frame, at, analysis.object_hints(session))
                    if state['objects'].enabled
                    else []
                )

                # TIER 2: Dispatch one async behavior snapshot (frame + current bodies + faces).
                # Tier 2 only enriches colors/labels/alerts; it never moves or delays bboxes.
                wait_for_faces = offline_faces and offline_at is not None and bool(faces)
                if analysis.submit(session, frame, faces, at, bodies=bodies, wait=wait_for_faces) and state['objects'].enabled:
                    state['objects'].remember_source(frame, at)
                if wait_for_faces:
                    observations = analysis.wait_for_faces(session, at)

                # Attach latest Tier-2 posture/desk-rest/action metadata to Tier-1 bodies.
                body_metadata = {b['id']: b for b in analysis.body_hints(session)}
                for body in bodies:
                    latest = body_metadata.get(body['id'])
                    if latest is not None:
                        body['observation'] = latest.get('observation', {})
                        body['actions'] = latest.get('actions', [])
                bodies = select_people(
                    merge_rest_bodies(bodies, analysis.rest_bodies(session), at),
                    limit,
                    (b['id'] for b in state['persons'].tracks),
                )
                for body in bodies:
                    rest = body.get('observation', {}).get('deskRest')
                    if rest is not None:
                        body['observation'] = {**body['observation'], 'deskRest': {**rest, 'imageAt': at}}

                alive = {face['id'] for face in faces}
                state['accepted'] = {k: v for k, v in state['accepted'].items() if k in alive}
                state['acceptedEvidence'] = {k: v for k, v in state['acceptedEvidence'].items() if k in alive}
                state['confirmations'] = {k: v for k, v in state['confirmations'].items() if k in alive}

                face_people = []
                for face in faces:
                    observation = observations.get(
                        face["id"],
                        dict(valid=False, eyeAspectRatio=0, yawOffset=0, observedAt=at, quality=face.get('quality')),
                    )
                    measured = landmark_confirmation(face, faces, observation, at)
                    if measured is not None:
                        state['confirmations'][face['id']] = measured
                    confirmed = face_is_publishable(face, faces, observation, at, state['confirmations'].get(face['id']))
                    if confirmed:
                        evidence_at = max(face.get('detectedAt', 0), measured['at'] if measured else 0)
                        if evidence_at > state['acceptedEvidence'].get(face['id'], -1):
                            state['acceptedEvidence'][face['id']] = evidence_at
                            state['accepted'][face['id']] = at if offline_at is not None else int(time.time() * 1000)
                    mode = face_tracking_state(face, confirmed, state['accepted'].get(face['id']), at)
                    if mode is None:
                        continue
                    if not confirmed:
                        observation = dict(valid=False, facePresent=False, eyeAspectRatio=0, yawOffset=0, observedAt=at)
                    x, y, w, h = face['box']
                    x, y = max(0., x), max(0., y)
                    w, h = min(w, 1 - x), min(h, 1 - y)
                    if w <= 0 or h <= 0:
                        continue
                    face_people.append(dict(
                        box=dict(x=x, y=y, width=w, height=h),
                        boxKind="face",
                        confidence=face["score"],
                        geometryId=face["id"],
                        personId=observation.get("personId") or face.get('personId'),
                        trackingState=mode,
                        geometryTimes=dict(face=max(face.get('visualAt') or 0, face.get('fastFaceAt') or 0, face.get('detectedAt') or 0)),
                        observation=observation,
                        analysisAt=observation.get("observedAt"),
                    ))

                people = state['persons'].assemble(bodies, face_people, at)
                detected = max(len(people), state['persons'].candidate_count, state['geometry'].candidate_count)
                preferred = state.get('selectedPeople', set())
                if len(people) > limit:
                    people = sorted(
                        people,
                        key=lambda p: (str(p.get('personId', p.get('geometryId'))) not in preferred, -p.get('confidence', 0)),
                    )[:limit]
                state['selectedPeople'] = {str(p.get('personId', p.get('geometryId'))) for p in people}
                state['processed'] = len(people)
                memory = memory_budget.status(detected, len(people), limit)

                for person in people:
                    times = person.pop('geometryTimes', {})
                    person['geometryFrameIds'] = {kind: frame_ids[t] for kind, t in times.items() if t in frame_ids}

                if time.monotonic() - memory_at > 2:
                    private_mb = round(
                        memory_mb(process) + sum(memory_mb(child) for child in process.children(recursive=True)),
                        1,
                    )
                    memory_at = time.monotonic()

                send({
                    "id": message["id"],
                    "people": people,
                    "objects": tracked_objects,
                    "frameAt": at,
                    "memory": memory,
                    "metrics": {
                        "geometryMs": round((time.perf_counter() - started) * 1000, 2),
                        "bodyTrackingMs": body_tracking_ms,
                        "bodyTrackingError": state['persons'].error,
                        "bodyHintCount": len(bodies),
                        "bodyHintAgeMs": 0,
                        "bodyTemplateBusy": False,
                        "privateMemoryMB": private_mb,
                        "memory": memory,
                        "faceCount": sum(p['trackingState'] in ('face', 'visual') for p in face_people),
                        "trackedFaceCount": len(face_people),
                        "inferredFaceCount": sum(p['trackingState'] in ('body', 'coasting', 'predicted') for p in face_people),
                        "analysisError": analysis.error,
                        "objectTrackingError": state['objects'].error,
                        "trackedObjectCount": len(tracked_objects),
                        "candidateFaceCount": len(faces),
                        "hiddenFaceCount": len(faces) - len(face_people),
                        "personCount": len(bodies),
                        "meshFaceCount": sum(
                            landmark_confirmation(face, faces, observations.get(face['id'], {}), at) is not None
                            for face in faces
                        ),
                        "geometryError": state['geometry'].scan_error,
                        "rescanMs": state['geometry'].scan_ms,
                        "cavt": analysis.engagement.status,
                        **state['geometry'].timings,
                        **analysis.timings,
                    },
                })

                for key in list(sessions):
                    if at - sessions[key]["seen"] > 120000:
                        sessions[key]["geometry"].close()
                        sessions[key]['objects'].close()
                        sessions[key]['persons'].close()
                        del sessions[key]
                        analysis.release(key)
            except Exception as error:
                if isinstance(error, MemoryError) or any(
                    term in str(error).lower()
                    for term in ('bad allocation', 'insufficient memory', 'failed to allocate', 'not enough memory')
                ):
                    memory_budget.reduce()
                    memory = memory_budget.status(max(1, locals().get('detected', 0)), 0)
                    memory['limited'] = True
                    send(dict(
                        id=message.get('id') if isinstance(message, dict) else None,
                        people=[],
                        objects=[],
                        memory=memory,
                        metrics=dict(memory=memory),
                    ))
                else:
                    send({"id": message.get("id") if isinstance(message, dict) else None, "error": str(error)})
    finally:
        tier1_pool.shutdown(wait=True, cancel_futures=True)
        for state in sessions.values():
            state["geometry"].close()
            state['objects'].close()
            state['persons'].close()
        analysis.close()


if __name__ == "__main__":
    main()
