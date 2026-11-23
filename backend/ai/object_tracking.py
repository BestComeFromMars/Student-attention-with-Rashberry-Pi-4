"""Independent YOLO object identities and pretrained VitTrack rectangles.

Slow detections seed on their actual source image, then replay real sampled
images off the response thread. Live updates use the current uploaded frame.
Face tracking and hand/behavior confirmation never gate an object rectangle.
"""
import threading
from collections import deque
import cv2
from visual_tracking import FaceVisualTracker


def overlap(a, b):
    x=max(a[0],b[0]); y=max(a[1],b[1])
    area=max(0,min(a[0]+a[2],b[0]+b[2])-x)*max(0,min(a[1]+a[3],b[1]+b[3])-y)
    return area/max(1e-9,a[2]*a[3]+b[2]*b[3]-area)


def same_target(a, b, same_kind):
    if overlap(a,b)>.85:return True
    if not same_kind:return False
    intersection=max(0,min(a[0]+a[2],b[0]+b[2])-max(a[0],b[0]))*max(0,min(a[1]+a[3],b[1]+b[3])-max(a[1],b[1]))
    small=min(a[2]*a[3],b[2]*b[3]); large=max(a[2]*a[3],b[2]*b[3])
    return small>0 and intersection/small>.9 and small/max(large,1e-9)>.2


class ObjectVisualTracker:
    MAX_AGE_MS=5000
    # Dense YOLO scans can take several seconds. A successful measurement on
    # every current image may bridge two slow scans, with a hard expiry. Empty
    # detector results and failed native measurements still remove immediately.
    MAX_LIVE_SUPPORT_MS=8000

    def __init__(self, model_path=None, history_limit=64, track_edge=640, max_objects=20):
        self.model_path=model_path
        self.visual=FaceVisualTracker(model_path)
        self.tracks=[]
        self.history=deque(maxlen=max(4,int(history_limit)))
        self.track_edge=max(240,int(track_edge))
        self.max_objects=max(1,int(max_objects))
        self.enabled=True
        self.next_id=1
        self.shape=None
        self.last_scan=-1
        self.applied_scan=-1
        self.generation=0
        self.lock=threading.Lock()
        self.event=threading.Event()
        self.stopped=threading.Event()
        self.pending=None
        self.completed=None
        self.error=None
        self.thread=threading.Thread(target=self._prepare_loop,name='object-templates',daemon=False)
        self.thread.start()

    def set_enabled(self, enabled):
        enabled = bool(enabled)
        if enabled == self.enabled:
            return
        self.enabled = enabled
        if not enabled:
            self.tracks = []
            self.visual.items.clear()
            self.history.clear()
            with self.lock:
                self.generation += 1
                self.pending = None
                self.completed = None

    def image(self, frame):
        scale=min(1., getattr(self, 'track_edge', 640)/max(frame.shape[:2]))
        return cv2.resize(frame,None,fx=scale,fy=scale) if scale<1 else frame

    def remember_source(self, frame, at):
        if not self.enabled:
            return
        image=self.image(frame)
        reference={track['id']:dict(kind=track['kind'],box=list(track['box'])) for track in self.tracks}
        self.history.append((at,image.copy(),reference))
        while self.history and at-self.history[0][0]>self.MAX_AGE_MS:
            self.history.popleft()

    def _prepare_loop(self):
        while not self.stopped.is_set():
            self.event.wait(.1); self.event.clear()
            with self.lock:
                job,self.pending=self.pending,None
            if job is None:
                continue
            snapshot,source,history,generation=job
            native=FaceVisualTracker(self.model_path)
            try:
                # A bounded number of native trackers; all object types retain
                # their own IDs/templates, separate from every face template.
                ordered=[]
                for obj in sorted(snapshot['objects'],key=lambda item:-item.get('confidence',0)):
                    box=obj.get('box',{})
                    if not all(key in box for key in ('x','y','width','height')):continue
                    candidate=[box['x'],box['y'],box['width'],box['height']]
                    # Competing labels on effectively the same detector ROI
                    # are one target, not two identical object rectangles.
                    if any(same_target(candidate,[other['box'][key] for key in ('x','y','width','height')],obj['kind']==other['kind']) for other in ordered):continue
                    ordered.append(obj)
                    if len(ordered)>=getattr(self,'max_objects',20):break
                tracks=[]
                for index,obj in enumerate(ordered):
                    box=obj.get('box',{})
                    if obj.get('kind') not in ('phone','book','laptop') or not all(key in box for key in ('x','y','width','height')):
                        continue
                    tracks.append(dict(obj,id=index+1,seen=snapshot['at'],_sourceBox=[box['x'],box['y'],box['width'],box['height']],
                        box=[box['x'],box['y'],box['width'],box['height']]))
                native.seed(source,tracks)
                tracks=[track for track in tracks if track['id'] in native.items]
                latest=snapshot['at']
                recent=list(self.history) or history
                for at,image,_ in recent[-2:]:
                    if self.stopped.is_set() or generation!=self.generation:break
                    if at>latest and image.shape==source.shape:
                        native.update(image,tracks,at)
                        latest=at
                prepared=dict(tracks=tracks,items=dict(native.items),at=latest,scan=snapshot['at'],reference=history[0][2])
                with self.lock:
                    if generation==self.generation and not self.stopped.is_set():
                        self.completed=prepared
                self.error=None
            except Exception as error:
                self.error=str(error)
            finally:
                native.close()

    def _apply(self, prepared, image, at):
        if prepared['scan']<=self.applied_scan:return
        self.applied_scan=prepared['scan']
        old={track['id']:track for track in self.tracks}
        used=set(); tracks=[]; items={}
        for detected in prepared['tracks']:
            # Match on the detector's source snapshot, never a face rectangle.
            matches=[(overlap(detected['_sourceBox'],value['box']),identity) for identity,value in prepared['reference'].items()
                     if identity in old and identity not in used and
                     (value['kind']==detected['kind'] or overlap(detected['_sourceBox'],value['box'])>.85)]
            # For the first delayed scans, the source can precede initial object
            # publication. Use only a strong same-class overlap in that case.
            if not matches:
                matches=[(overlap(detected['box'],value['box']),identity) for identity,value in old.items()
                         if identity not in used and
                         (value['kind']==detected['kind'] or overlap(detected['box'],value['box'])>.85)]
            score,identity=max(matches,default=(0,None))
            if score<.3:
                identity=self.next_id; self.next_id+=1
            used.add(identity)
            item=prepared['items'].get(detected['id'])
            if item is None:
                continue
            tracked=dict(detected,id=identity)
            previous=old.get(identity)
            if previous and previous['kind']!=detected['kind']:
                hits=previous.get('candidateHits',0)+1 if previous.get('candidateKind')==detected['kind'] else 1
                if hits<3:
                    tracked.update(kind=previous['kind'],confidence=previous['confidence'],interaction=False,
                        observedAt=previous['observedAt'],
                        candidateKind=detected['kind'],candidateHits=hits)
            tracks.append(tracked)
            items[identity]=item
        # A partial detector miss may bridge one scan using current pixels.
        # Detector timestamps stay unchanged; an empty scan still clears all.
        for identity,track in old.items():
            if (identity not in used and identity in self.visual.items and
                    0<=at-track['seen']<=self.MAX_LIVE_SUPPORT_MS and track.get('missedScans',0)<1 and
                    not any(same_target(track['box'],other['box'],track['kind']==other['kind']) for other in tracks)):
                tracks.append(dict(track,missedScans=track.get('missedScans',0)+1))
                items[identity]=self.visual.items[identity]
        self.tracks=tracks
        self.visual.items=items
        self.visual.shape=image.shape[:2]
        # The next update measures the current frame directly. Replaying a
        # growing tail here could delay all boxes behind the next detector scan.

    def update(self, frame, at, snapshot=None):
        if not self.enabled:
            return []
        image=self.image(frame)
        if self.shape!=image.shape:
            self.shape=image.shape
            self.tracks=[]; self.visual.items.clear(); self.history.clear()
            with self.lock:
                self.generation+=1; self.pending=None; self.completed=None
            self.last_scan=-1
            self.applied_scan=-1
        # Install a finished batch before accepting a newer scan. Positive
        # detector results cannot repeatedly cancel valid template handovers.
        with self.lock:
            completed,self.completed=self.completed,None
        if completed is not None:
            self._apply(completed,image,at)
        if snapshot and snapshot.get('at',-1)>self.last_scan:
            scan_at=snapshot['at']
            self.last_scan=scan_at
            if not snapshot.get('objects'):
                self.tracks=[]; self.visual.items.clear()
                with self.lock:
                    self.generation+=1;self.pending=None;self.completed=None
            elif 0<=at-scan_at<=self.MAX_AGE_MS:
                history=list(self.history)
                source=next((entry for entry in history if entry[0]==scan_at),None)
                if source is not None:
                    relevant=[entry for entry in history if entry[0]>=scan_at]
                    with self.lock:
                        self.pending=(snapshot,source[1],relevant,self.generation)
                    self.event.set()
        if snapshot:
            metadata={obj.get('detectionId'):obj for obj in snapshot.get('objects',[]) if obj.get('detectionId') is not None}
            for track in self.tracks:
                obj=metadata.get(track.get('detectionId'))
                if obj is not None and track['seen']==snapshot['at'] and obj['kind']==track['kind']:
                    for key in ('interaction','ownerPersonId','ownerGeometryId'):
                        if key in obj:track[key]=obj[key]
        self.tracks=[track for track in self.tracks if 0<=at-track['seen']<=self.MAX_LIVE_SUPPORT_MS]
        self.visual.update(image,self.tracks,at)
        failed={track['id'] for track in self.tracks if track.get('visualLostAt')==at}
        self.tracks=[track for track in self.tracks if track['id'] not in failed]
        for identity in failed:self.visual.items.pop(identity,None)
        output=[]
        for track in self.tracks:
            if track.get('visualAt')!=at or track.get('visualLostAt')==at:
                continue
            x,y,w,h=track['box']
            output.append(dict(id='O'+str(track['id']),kind=track['kind'],
                box=dict(x=x,y=y,width=w,height=h),confidence=track['confidence'],
                observedAt=track['observedAt'],trackedAt=at,trackingState='visual',
                interaction=track.get('interaction',False),
                **({'ownerPersonId':track['ownerPersonId']} if track.get('ownerPersonId') is not None else {}),
                **({'ownerGeometryId':track['ownerGeometryId']} if track.get('ownerGeometryId') is not None else {})))
        return output

    def close(self):
        self.stopped.set(); self.event.set(); self.thread.join(timeout=10)
        self.visual.close(); self.history.clear(); self.tracks=[]
