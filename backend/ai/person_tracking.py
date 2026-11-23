"""Fast Tier-1 person detection (YOLO11 ONNX + ByteTrack) and 1-person-1-bbox assembly.

Runs directly on the current camera frame (0 ms body-hint lag) with pure-IoU
ByteTrack (fuse_score=False) so distant/back-row students and face-occluded
students maintain stable IDs without VitTrack desk-lock drift.
"""
import math
import os
from pathlib import Path
from types import SimpleNamespace
import numpy as np
from geometry import iou
from light_results import NumpyBoxes
from lite_bytetrack import BaseTrack, BYTETracker
from memory_budget import select_people, DEFAULT_CEILING
from onnx_yolo import ONNXRuntimeYOLO


def box_dict(box):
    return dict(zip(('x', 'y', 'width', 'height'), map(float, box)))


def clip_to_frame(box):
    x, y, w, h = map(float, box)
    if not all(map(math.isfinite, (x, y, w, h))) or w <= 0 or h <= 0:
        return None
    right, bottom = x + w, y + h
    if x >= 0 and y >= 0 and right <= 1 and bottom <= 1:
        return box
    left, top = max(0., x), max(0., y)
    right, bottom = min(1., right), min(1., bottom)
    if right <= left or bottom <= top:
        return None
    return [left, top, right - left, bottom - top]


def merge_rest_bodies(bodies, rest_bodies, at):
    """Continue a confirmed slumped-on-desk person even when their face is hidden."""
    output = list(bodies)
    for rest in rest_bodies:
        if not 0 <= at - rest['at'] <= 1500:
            continue
        matches = [
            (iou(body['box'], rest['box']), i, body)
            for i, body in enumerate(output)
            if body['id'] == rest['id'] or iou(body['box'], rest['box']) >= .7
        ]
        matches.sort(key=lambda item: (item[2]['id'] == rest['id'], item[0]), reverse=True)
        old = {}
        if matches and (matches[0][2]['id'] == rest['id'] or len(matches) == 1 or matches[0][0] - matches[1][0] >= .05):
            _, index, old = matches[0]
            output.pop(index)
        observation = {**old.get('observation', {}), **rest.get('observation', {})}
        output.append({**old, **rest, 'observation': observation, 'geometryAt': rest['at']})
    return output


def attach_faces(bodies, faces, preferred=None):
    pairs = []
    for bi, body in enumerate(bodies):
        bx, by, bw, bh = body['box']
        for fi, face in enumerate(faces):
            rest = body.get('observation', {}).get('deskRest', {})
            if (rest.get('active') or rest.get('trackedBodyAt') is not None) and face.get('personId') != body['id'] and (
                    not preferred or preferred.get(face.get('geometryId')) != body['id']):
                continue
            box = face.get('faceBox') or (face['box'] if face.get('boxKind') == 'face' else None)
            if not box:
                continue
            x, y, w, h = [box[k] for k in ('x', 'y', 'width', 'height')]
            cx, cy = x + w / 2, y + h / 2
            coverage = (
                max(0., min(x + w, bx + 1.05 * bw) - max(x, bx - .05 * bw))
                * max(0., min(y + h, by + bh) - max(y, by - .08 * bh))
            )
            if coverage < .8 * w * h:
                continue
            if bx - .05 * bw <= cx <= bx + 1.05 * bw and by - .08 * bh <= cy <= by + .75 * bh and w <= 1.2 * bw:
                score = ((cx - bx - bw / 2) / max(bw, .01)) ** 2 + ((cy - by - .17 * bh) / max(bh, .01)) ** 2
                if face.get('personId') == body['id']:
                    score -= .2
                if preferred and preferred.get(face.get('geometryId')) == body['id']:
                    score -= .5
                pairs.append((score, bi, fi))
    result = {}
    used = set()
    for _, bi, fi in sorted(pairs):
        if bi not in result and fi not in used:
            result[bi] = fi
            used.add(fi)
    return result, used


def _box_intersection(a, b):
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    return max(0.0, min(ax + aw, bx + bw) - max(ax, bx)) * max(0.0, min(ay + ah, by + bh) - max(ay, by))


def _box_containment(a, b):
    inter = _box_intersection(a, b)
    smallest = min(a[2] * a[3], b[2] * b[3])
    return inter / smallest if smallest > 0 else 0.0


def _nose_point(body):
    pose = body.get('observation', {}).get('bodyPose')
    if pose and pose.get('keypoints'):
        nose = pose['keypoints'][0]
        if nose.get('confidence', 0) >= .35:
            return (float(nose['x']), float(nose['y']))
    return None


def duplicate_unfaced_body(index, bodies, faces, links):
    """Reject two overlapping detector rectangles for one verified head."""
    body = bodies[index]
    rest = body.get('observation', {}).get('deskRest', {})
    if rest.get('active') or rest.get('trackedBodyAt') is not None:
        return False
    bx, by, bw, bh = body['box']
    nearby = [
        i for i, f in enumerate(faces)
        if bx <= (f.get('faceBox') or f['box'])['x'] + (f.get('faceBox') or f['box'])['width'] / 2 <= bx + bw
        and by <= (f.get('faceBox') or f['box'])['y'] + (f.get('faceBox') or f['box'])['height'] / 2 <= by + .75 * bh
    ]
    has_unowned_face = any(i not in links.values() for i in nearby)
    nose = _nose_point(body)
    for owner, fi in links.items():
        if owner == index:
            continue
        other = bodies[owner]
        ox, oy, ow, oh = other['box']
        other_rest = other.get('observation', {}).get('deskRest', {})
        if other_rest.get('active') or other_rest.get('trackedBodyAt') is not None:
            continue
        ov = iou(body['box'], other['box'])
        contain = _box_containment(body['box'], other['box'])
        if ov < .55 and contain < .85:
            continue
        face = faces[fi]
        box = face.get('faceBox') or face['box']
        cx = box['x'] + box['width'] / 2
        cy = box['y'] + box['height'] / 2
        face_in_both = (bx <= cx <= bx + bw and by <= cy <= by + .65 * bh and oy <= cy <= oy + .65 * oh)
        if not face_in_both and ov < .55 and not (contain >= .85 and ov >= .30):
            continue
        if has_unowned_face:
            continue
        if nose is not None and math.hypot((nose[0] - cx) / max(box['width'], 1e-4), (nose[1] - cy) / max(box['height'], 1e-4)) > 1.5:
            continue
        return True
    return False


def suppress_duplicate_unfaced_bodies(bodies, faces, links):
    """Deduplicate overlapping unfaced person boxes (e.g. duplicate ByteTrack IDs on one student)."""
    suppressed = set()
    for bi in range(len(bodies)):
        if bi not in links and duplicate_unfaced_body(bi, bodies, faces, links):
            suppressed.add(bi)
    unfaced = [bi for bi in range(len(bodies)) if bi not in links and bi not in suppressed]

    def priority(bi):
        b = bodies[bi]
        rest = b.get('observation', {}).get('deskRest', {})
        has_rest = bool(rest.get('active') or rest.get('trackedBodyAt') is not None)
        has_pose = bool(b.get('observation', {}).get('bodyPose'))
        return (has_rest, has_pose, float(b.get('confidence', .5)), -float(b.get('seen', 0)), -int(b.get('id', 0)))

    unfaced.sort(key=priority, reverse=True)
    kept = []
    for bi in unfaced:
        body = bodies[bi]
        rest = body.get('observation', {}).get('deskRest', {})
        if rest.get('active') or rest.get('trackedBodyAt') is not None:
            kept.append(bi)
            continue
        nose_a = _nose_point(body)
        is_dup = False
        for ki in kept:
            other = bodies[ki]
            ov = iou(body['box'], other['box'])
            contain = _box_containment(body['box'], other['box'])
            if ov < .55 and not (contain >= .85 and ov >= .25):
                continue
            nose_b = _nose_point(other)
            if nose_a is not None and nose_b is not None and math.hypot(nose_a[0] - nose_b[0], nose_a[1] - nose_b[1]) > .07:
                continue
            is_dup = True
            break
        if is_dup:
            suppressed.add(bi)
        else:
            kept.append(bi)
    return suppressed


def _face_rect(face):
    b = face.get('faceBox') or face['box']
    return [float(b['x']), float(b['y']), float(b['width']), float(b['height'])]


def deduplicate_faces(faces):
    """Ensure two overlapping detections of the same face never split one person."""
    indexed = list(enumerate(faces))

    def priority(item):
        idx, f = item
        obs = f.get('observation', {})
        return (f.get('trackingState') == 'face', bool(obs.get('valid')), float(f.get('confidence', f.get('score', .5))), -idx)

    kept = []
    kept_rects = []
    for idx, f in sorted(indexed, key=priority, reverse=True):
        rect = _face_rect(f)
        if any(iou(rect, other) >= .35 or _box_containment(rect, other) >= .70 for other in kept_rects):
            continue
        kept.append((idx, f))
        kept_rects.append(rect)
    kept.sort(key=lambda item: item[0])
    return [f for _, f in kept]


def duplicate_orphan_face(face, kept_face_rects):
    rect = _face_rect(face)
    for other in kept_face_rects:
        if iou(rect, other) >= .30 or _box_containment(rect, other) >= .65:
            return True
    return False


class PersonDetector:
    """Shared lightweight YOLO11 ONNX person detector owned by Tier 1 (worker.py)."""

    def __init__(self, models_dir, model_name='yolo11n.onnx'):
        models_dir = Path(models_dir)
        path = models_dir / model_name
        if not path.is_file():
            path = models_dir / 'yolo11n.onnx'
            if not path.is_file():
                path = models_dir / 'yolo11s.onnx'
        self.model_name = path.name
        self.device = os.environ.get('AI_DEVICE', 'cpu')
        if self.device == 'cpu':
            self.model = ONNXRuntimeYOLO(path)
        else:
            from ultralytics import YOLO
            pt = path.with_suffix('.pt')
            self.model = YOLO(str(pt if pt.is_file() else models_dir / 'yolo11s.pt'))
            self.model_name = (pt if pt.is_file() else models_dir / 'yolo11s.pt').name
        self.imgsz = int(os.environ.get('AI_PERSON_IMGSZ', os.environ.get('AI_SCENE_IMGSZ', '640')))
        blank = np.zeros((320, 320, 3), np.uint8)
        self.model.predict(blank, imgsz=self.imgsz, classes=[0], conf=.1, device=self.device, verbose=False)

    def predict_rows(self, frame):
        result = self.model.predict(frame, imgsz=self.imgsz, classes=[0], conf=.03, device=self.device, verbose=False)[0]
        raw = result.boxes.data
        return raw.cpu().numpy() if hasattr(raw, 'cpu') else np.asarray(raw)


class PersonTracking:
    """Per-session pure-IoU ByteTrack person tracker + 1-person-1-bbox assembler."""

    def __init__(self, max_people=DEFAULT_CEILING):
        count = BaseTrack._count
        args = SimpleNamespace(
            track_high_thresh=.16,
            track_low_thresh=.10,
            new_track_thresh=.18,
            track_buffer=30,
            match_thresh=.85,
            fuse_score=False,
        )
        self.tracker = BYTETracker(args, frame_rate=8)
        BaseTrack._count = max(count, BaseTrack._count)
        self.tracking_size = None
        self.tracks = []
        self.face_owners = {}
        self.max_people = max_people
        self.candidate_count = 0
        self.error = None

    def set_limit(self, limit):
        self.max_people = max(1, int(limit))
        if len(self.tracks) > self.max_people:
            self.tracks = self.tracks[:self.max_people]

    def detect(self, detector, frame, at):
        """Run YOLO11 + ByteTrack directly on the current frame (0 ms staleness)."""
        height, width = frame.shape[:2]
        rows = detector.predict_rows(frame)
        if self.tracking_size is None:
            self.tracking_size = (width, height)
        tw, th = self.tracking_size
        scale = np.asarray([tw / width, th / height, tw / width, th / height], dtype=np.float32)
        tracking_rows = rows.copy() if len(rows) else np.empty((0, 6), dtype=np.float32)
        if len(tracking_rows):
            tracking_rows[:, :4] *= scale
        tracked = self.tracker.update(NumpyBoxes(tracking_rows, (th, tw)), None).copy()
        if len(tracked):
            tracked[:, :4] /= scale
        bodies = [
            {
                'id': int(row[4]),
                'at': at,
                'seen': at,
                'confidence': float(row[5]),
                'box': [
                    float(row[0] / width),
                    float(row[1] / height),
                    float((row[2] - row[0]) / width),
                    float((row[3] - row[1]) / height),
                ],
            }
            for row in tracked
        ]
        self.candidate_count = len(bodies)
        bodies = select_people(bodies, self.max_people, (t['id'] for t in self.tracks))
        self.tracks = bodies
        self.error = None
        return [dict(b) for b in bodies]

    def assemble(self, bodies, faces, at):
        """Attach faces 1:1 to people, deduplicate overlaps, and keep occluded-face people."""
        bodies = [{**body, 'box': box} for body in bodies if (box := clip_to_frame(body['box'])) is not None]
        faces = deduplicate_faces(faces)
        owners = {k: v for k, v in getattr(self, 'face_owners', {}).items() if 0 <= at - v[1] <= 3000}
        links, used = attach_faces(bodies, faces, {k: v[0] for k, v in owners.items()})
        output = []
        for bi, fi in links.items():
            if faces[fi].get('geometryId') is not None:
                owners[faces[fi]['geometryId']] = (bodies[bi]['id'], at)
        self.face_owners = owners
        suppressed = suppress_duplicate_unfaced_bodies(bodies, faces, links)
        kept_face_rects = []
        for bi, body in enumerate(bodies):
            if bi in suppressed:
                continue
            face = faces[links[bi]] if bi in links else None
            visible = bool(face and face.get('trackingState') in ('face', 'visual'))
            observation = (
                dict(face.get('observation', {}))
                if visible
                else dict(valid=False, facePresent=False, eyeAspectRatio=0, yawOffset=0, observedAt=at)
            )
            observation.update(body.get('observation', {}))
            observation['personId'] = body['id']
            item = dict(
                box=box_dict(body['box']),
                personBox=box_dict(body['box']),
                boxKind='person',
                personId=body['id'],
                personObservedAt=body.get('seen', at),
                faceVisibility='visible' if visible else 'unavailable',
                trackingState='face' if visible else 'visual',
                observation=observation,
                analysisAt=observation.get('observedAt', at),
                actions=body.get('actions', []),
                confidence=body.get('confidence', .5),
            )
            item['geometryTimes'] = dict(person=body.get('geometryAt') or body.get('at') or body.get('seen', at))
            if visible:
                item.update(faceBox=face['box'], geometryId=face.get('geometryId'))
                item['geometryTimes'].update(face.get('geometryTimes', {}))
                kept_face_rects.append(_face_rect(face))
            output.append(item)
        for fi, face in enumerate(faces):
            if fi not in used and face.get('trackingState') in ('face', 'visual'):
                if duplicate_orphan_face(face, kept_face_rects):
                    continue
                orphan = {**face, 'faceBox': face['box'], 'faceVisibility': 'visible'}
                orphan.pop('personId', None)
                body_fields = {
                    'personId', 'phoneHeld', 'laptopInteraction', 'bookInteraction', 'objectRegions', 'objectsAt',
                    'bodyPose', 'headYaw', 'headObservedAt', 'headSource', 'deskRest', 'deskSlumpPose',
                }
                if 'observation' in orphan:
                    orphan['observation'] = {k: v for k, v in orphan['observation'].items() if k not in body_fields}
                kept_face_rects.append(_face_rect(face))
                output.append(orphan)
        return output

    def close(self):
        self.tracks = []
        self.face_owners = {}
