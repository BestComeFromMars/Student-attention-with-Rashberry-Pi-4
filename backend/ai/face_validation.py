"""Separate evidence that a face exists from evidence for eye/mouth behavior."""
import math


def valid_box(box):
    return len(box) == 4 and all(math.isfinite(value) for value in box) and box[2] > 0 and box[3] > 0


def intersection(a, b):
    return max(0, min(a[0]+a[2], b[0]+b[2])-max(a[0], b[0])) * \
           max(0, min(a[1]+a[3], b[1]+b[3])-max(a[1], b[1]))


def contained_face_part(small, large):
    """IoU alone misses a small detection fully inside a much larger face."""
    return (small[2] <= .5*large[2] and small[3] <= .5*large[3] and
            intersection(small, large) >= .8*small[2]*small[3])


def needs_confirmation(face, faces):
    if face['score'] < .85:
        return True
    return suspected_face_part(face,faces)


def suspected_face_part(face, faces):
    x, y, w, h = face['box']
    cx, cy = x+w/2, y+h/2
    for other in faces:
        if other is face or other['score'] < .85:
            continue
        ox, oy, ow, oh = other['box']
        # A tiny box beside a head may be its ear. Keep it as a candidate so a
        # real, smaller student in the background can still be mesh-confirmed.
        if (w <= .4*ow and h <= .45*oh and
                ox-.3*ow <= cx <= ox+1.3*ow and oy+.1*oh <= cy <= oy+.9*oh):
            return True
    return False


def landmarks_match_box(box, measured):
    if not valid_box(box) or not valid_box(measured):
        return False
    x, y, w, h = box
    mx, my, mw, mh = measured
    overlap = intersection(box, measured)
    return (.45 <= mw/w <= 1.8 and .45 <= mh/h <= 1.8 and
            x-.1*w <= mx+mw/2 <= x+1.1*w and y-.1*h <= my+mh/2 <= y+1.1*h and
            overlap / max(1e-8, w*h+mw*mh-overlap) >= .25)


def landmark_confirmation(face, faces, observation, now):
    """Only matching measured landmarks may refresh the short mesh history."""
    # Small printed/cartoon faces can fit a mesh. Keep the body check for those
    # ambiguous candidates, but a large, confident detector + matching full mesh
    # is already independent evidence: cropped webcam heads may have no body,
    # and the scene worker can finish after its own freshness deadline.
    mode = face.get('evidenceMode')
    clear_mesh = (observation.get('facePresent') is True and face['score'] >= .85 and
                  face.get('facePixels',0) >= 80 and not suspected_face_part(face,faces))
    if mode in ('yunet','scrfd','dual') and face.get('detectorVerified') is not True and not clear_mesh:
        body_at = observation.get('objectsAt')
        if (observation.get('personId') is None or not isinstance(body_at,(int,float)) or
                not 0<=now-body_at<=5000):
            return None
    at = observation.get('observedAt')
    measured_box = observation.get('faceBox')
    if (isinstance(at, (int, float)) and 0 <= now-at <= 2000 and measured_box is not None and
            landmarks_match_box(face['box'], measured_box)):
        if observation.get('facePresent') is True:
            return dict(at=at, box=list(measured_box))
        if observation.get('mouthSource') == 'profile_roi' and not needs_confirmation(face, faces):
            return dict(at=at, box=list(measured_box))
    return None


def face_is_publishable(face, faces, observation, now, confirmation=None):
    missed = max(face.get('missedAt') or 0,face.get('visualLostAt') or 0) or None
    # Fresh image evidence can recover an ALREADY verified face in this frame,
    # even when a slower full rescan missed it. This does not renew SCRFD age
    # or enable eye/mouth measurements; stale/unknown/ambiguous faces still fail.
    fast=face.get('fastFaceAt');detected=face.get('detectedAt')
    verified=face.get('verifiedAt',detected if face.get('detectorVerified') else None)
    if (isinstance(verified,(int,float)) and 0<=now-verified<=1600 and isinstance(fast,(int,float)) and
            0<=now-fast<=150 and
            (missed is None or fast>missed) and
            face.get('fastFaceScore',0)>=(.60 if face.get('fastFaceModel')=='SCRFD-500M' else .85) and
            not suspected_face_part(face,faces)):
        return True
    if isinstance(missed,(int,float)) and missed>=face.get('detectedAt',0):
        # Cached mesh/detector scores cannot undo a later negative rescan.
        # Without current fast-detector evidence, only matching landmarks from
        # a newer frame can confirm it again.
        at = observation.get('observedAt')
        return (isinstance(at,(int,float)) and at>missed and
                landmark_confirmation(face,faces,observation,now) is not None)
    # A single confidence score cannot distinguish an ear or a face-like object.
    # Matching detector evidence can establish a face even if the independent
    # landmark/behavior model cannot measure its eyes/mouth. Keep behavior invalid.
    detected = face.get('detectedAt')
    if (face.get('detectorVerified') is True and isinstance(detected,(int,float)) and
            0<=now-detected<=1200 and not suspected_face_part(face,faces) and
            (face.get('evidenceMode')=='dual' or
             face.get('detectorModel')=='SCRFD-10G' or
             face.get('evidenceMode')=='scrfd' and face.get('detectionHits',0)>=2)):
        return True
    if landmark_confirmation(face,faces,observation,now) is not None:
        return True
    # A known face must not blink out on a single missed mesh in a crowded
    # round-robin pass. Keep only its BOX briefly, with current detector support;
    # the missing behavior observation stays invalid and cannot create a cue.
    if confirmation is None:
        return False
    verified = confirmation.get('at')
    detected = face.get('detectedAt')
    box = confirmation.get('box')
    return (isinstance(verified, (int, float)) and 0 <= now-verified <= 1200 and
            isinstance(detected, (int, float)) and 0 <= now-detected <= 750 and
            face['score'] >= .85 and box is not None and landmarks_match_box(face['box'], box))


def face_tracking_state(face, confirmed, accepted_at, now):
    """Image tracking is not proof of a face after a negative detector scan."""
    if confirmed:
        return 'face'
    if accepted_at is None:
        return None
    # One rejected native update is not yet a confirmed exit. Keep only the
    # previously measured rectangle briefly; a newer negative detector scan
    # still removes it immediately. Repeated misses cannot renew visualAt.
    if (not face.get('missedScans',0) and face.get('visualLostAt') and
            isinstance(face.get('visualAt'),(int,float)) and 0<=now-face['visualAt']<=250 and
            0<=now-accepted_at<=2000):
        return 'coasting'
    if isinstance(face.get('bodyAt'),(int,float)) and 0<=now-face['bodyAt']<=1800:
        return 'body'
    if (not face.get('missedScans',0) and not face.get('visualLostAt') and 0<=now-accepted_at<=2000 and
            isinstance(face.get('visualAt'),(int,float)) and 0<=now-face['visualAt']<250):
        return 'visual'
    return 'predicted'
