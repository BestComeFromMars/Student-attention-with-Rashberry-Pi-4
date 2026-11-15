"""Pretrained OpenCV VitTrack; body association is session geometry only.

Tracker implementation and model come from OpenCV Zoo. No custom optical-flow,
scale estimator, or random network is used between detector observations.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import cv2
from onnx_vittrack import ONNXVitTrack, runtime


class FaceVisualTracker:
    def __init__(self, model_path=None):
        self.model_path=Path(model_path) if model_path else Path(__file__).resolve().parents[1]/'models/classroom/object_tracking_vittrack_2023sep.onnx'
        self.items={}
        self.shape=None
        self.pool=None

    @staticmethod
    def warmup(model_path):
        runtime(str(model_path))

    def update(self,frame,tracks,now,only_ids=None):
        height,width=frame.shape[:2]
        if self.shape!=(height,width):
            self.items.clear()
            self.shape=(height,width)
        alive={track['id'] for track in tracks}
        self.items={key:value for key,value in self.items.items() if key in alive}
        jobs=[(track,self.items[track['id']]) for track in tracks if track['id'] in self.items and
              (only_ids is None or track['id'] in only_ids)]
        def run(job):
            track,item=job
            ok,rect=item['tracker'].update(frame)
            track['trackingScore']=float(item['tracker'].getTrackingScore())
            if ok:
                x,y,w,h=rect
                left,top=max(0,x),max(0,y)
                right,bottom=min(width,x+w),min(height,y+h)
                if right>left and bottom>top:
                    track['box']=[left/width,top/height,(right-left)/width,(bottom-top)/height]
                    track['visualAt']=now
                    track.pop('visualLostAt',None)
                    return
            track['visualLostAt']=now
        if len(jobs)>1:
            if self.pool is None:self.pool=ThreadPoolExecutor(max_workers=4,thread_name_prefix='vittrack')
            list(self.pool.map(run,jobs))
        else:
            for job in jobs:run(job)

    def seed(self,frame,tracks):
        height,width=frame.shape[:2]
        if self.shape!=(height,width):
            self.items.clear()
            self.shape=(height,width)
        for track in tracks:
            previous=self.items.get(track['id'])
            if previous and previous['seen']==track['seen']:continue
            x,y,w,h=track['box']
            left,top=max(0,round(x*width)),max(0,round(y*height))
            right,bottom=min(width,round((x+w)*width)),min(height,round((y+h)*height))
            if right-left<8 or bottom-top<8:continue
            # The graph is already loaded once, not read/optimized per face or
            # rescan. Reinitialization replaces only this track's template.
            tracker=previous['tracker'] if previous else ONNXVitTrack(self.model_path)
            tracker.init(frame,(left,top,right-left,bottom-top))
            self.items[track['id']]=dict(tracker=tracker,seen=track['seen'],seededAt=track['seen'])

    def close(self):
        if self.pool is not None:self.pool.shutdown(wait=True,cancel_futures=True)
        self.items.clear()


def follow_body(track, bodies, owners, now):
    """Move a previously observed face ROI with its own fresh ByteTrack body.

    The stored face/body offset is calibrated only on a recent face detection.
    Never draw the body rectangle itself as a face, or use stale body snapshots.
    """
    owner = owners.get(track['id'], {})
    person_id = owner.get('personId', track.get('personId'))
    if person_id is None and not track.get('missedScans',0) and 0<=now-track['seen']<=500:
        x,y,w,h = track['box']
        candidates = [body for body in bodies if 0<=now-body.get('at',-100000)<=1800 and
                      body['box'][0]<=x+w/2<=body['box'][0]+body['box'][2] and
                      body['box'][1]<=y+h/2<=body['box'][1]+.65*body['box'][3]]
        # Associate a new face before the slow object worker publishes its
        # ownership map, but never guess between overlapping body tracks.
        if len(candidates)==1:
            person_id = candidates[0]['id']
    body = next((body for body in bodies if body['id'] == person_id and
                 0 <= now-body.get('at', -100000) <= 1800), None)
    if body is None:
        return False
    bx, by, bw, bh = body['box']
    if bw <= 0 or bh <= 0:
        return False
    # A measurement may be delayed; learn only while both boxes are nearby
    # and the face was independently detected in this recent interval.
    x, y, w, h = track['box']
    if not track.get('missedScans',0) and now-track['seen'] <= 500 and bx <= x+w/2 <= bx+bw and by <= y+h/2 <= by+bh:
        track['personId'] = person_id
        track['bodyAnchor'] = [(x+w/2-bx)/bw, (y+h/2-by)/bh, w/bw, h/bh]
    anchor = track.get('bodyAnchor')
    if anchor is None or track.get('personId') != person_id:
        return False
    track['bodyAt'] = body['at']
    # Live visual tracking is more precise than the slower body worker.
    if (0<=now-track.get('fastFaceAt',-100000)<=100 or
            not track.get('missedScans',0) and (now-track.get('visualAt', -100000) <= 100 or now-track['seen'] <= 500)):
        return True
    cx, cy, rw, rh = anchor
    w, h = min(1., rw*bw), min(1., rh*bh)
    track['box'] = [max(0., min(1-w, bx+cx*bw-w/2)),
                    max(0., min(1-h, by+cy*bh-h/2)), w, h]
    return True
