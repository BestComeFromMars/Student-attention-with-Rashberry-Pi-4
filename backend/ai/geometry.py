"""Fused YuNet/SCRFD candidates anchor pretrained OpenCV VitTrack trackers."""
import threading
import time
import cv2
import numpy as np
from face_validation import contained_face_part,landmark_confirmation
from image_quality import face_quality, enhance_low_light
from visual_tracking import FaceVisualTracker, follow_body
from fast_face_tracking import FastFaceTracking


def iou(a,b):
    left,top = max(a[0],b[0]),max(a[1],b[1])
    right,bottom = min(a[0]+a[2],b[0]+b[2]),min(a[1]+a[3],b[1]+b[3])
    area = max(0,right-left)*max(0,bottom-top)
    return area/max(1e-8,a[2]*a[3]+b[2]*b[3]-area)


def project_anchors(track,width,height):
    relative = track.get('relativeAnchors')
    if relative is None:
        return track['anchors']
    x,y,w,h = track['box']
    return [[float((x+px*w)*width),float((y+py*h)*height)] for px,py in relative]


class FaceGeometry:
    def __init__(self,model_path,max_faces=40):
        from scrfd import VerifiedFaceDetector
        self.detector = VerifiedFaceDetector(model_path)
        self.fast = FastFaceTracking(model_path,self.detector.scrfd) if hasattr(self.detector,'yunet') else None
        self.max_faces = max_faces
        self.candidate_count = 0
        self.tracks = []
        self.visual = FaceVisualTracker()
        self.last_scan = 0
        self.last_tile = 0
        self.last_detail_scan = 0
        self.tile_cursor = 0
        self.next_id = 1
        self.lock = threading.Lock()
        self.detector_lock = threading.Lock()
        self.event = threading.Event()
        self.stop = threading.Event()
        self.request = None
        self.completed = None
        self.scan_error = None
        self.scan_ms=0
        self.timings={}
        self.history=[]
        self.thread = threading.Thread(target=self._scan_loop,name="face-rescan",daemon=False)
        self.thread.start()

    def _detect(self,frame,tiled=False,tile_limit=None,max_edge=640):
        with self.detector_lock:
            return self._detect_locked(frame,tiled,tile_limit,max_edge)

    def _detect_locked(self,frame,tiled=False,tile_limit=None,max_edge=640):
        height,width = frame.shape[:2]
        found = []
        def run(image,ox,oy,scale):
            ih,iw = image.shape[:2]
            padded = cv2.copyMakeBorder(image,0,(-ih)%32,0,(-iw)%32,cv2.BORDER_CONSTANT,value=(0,0,0))
            self.detector.setInputSize((padded.shape[1],padded.shape[0]))
            _,detections = self.detector.detect(padded)
            evidence = getattr(self.detector,'evidence',[])
            for index,face in enumerate([] if detections is None else detections):
                if face[0]+face[2]/2>=iw or face[1]+face[3]/2>=ih:
                    continue
                x,y,w,h = face[:4]/scale
                if w<10 or h<10:
                    continue
                points = face[4:14].reshape(5,2)/scale+np.array([ox,oy])
                found.append(dict(box=[float((x+ox)/width),float((y+oy)/height),float(w/width),float(h/height)],
                                  score=float(face[-1]),anchors=points.tolist(),
                                  relativeAnchors=((points-np.array([x+ox,y+oy]))/np.array([w,h])).tolist(),
                                  **(evidence[index] if index<len(evidence) else {})))
        # Do not throw away the faint profile detail before the exposure retry.
        # Ordinary frames use the detector's VGA scale; very dark but textured
        # input keeps up to 1280 source pixels. This changes sampling, not model
        # confidence or the conditions for declaring a face.
        sample=cv2.cvtColor(cv2.resize(frame,(64,64),interpolation=cv2.INTER_AREA),cv2.COLOR_BGR2GRAY)
        edge=1280 if sample.mean()<45 and np.percentile(sample,95)-np.percentile(sample,10)>3 else max_edge
        scale = min(1.,edge/max(width,height))
        run(cv2.resize(frame,None,fx=scale,fy=scale) if scale<1 else frame,0,0,scale)
        if tiled and max(width,height)>1280:
            size,step = 960,720
            xs = sorted(set(list(range(0,max(1,width-size+1),step))+[max(0,width-size)]))
            ys = sorted(set(list(range(0,max(1,height-size+1),step))+[max(0,height-size)]))
            tiles = [(x,y) for y in ys for x in xs]
            if tile_limit is not None:
                cursor = getattr(self,'tile_cursor',0)%len(tiles)
                count = min(tile_limit,len(tiles))
                tiles = [tiles[(cursor+i)%len(tiles)] for i in range(count)]
                self.tile_cursor = (cursor+count)%(len(xs)*len(ys))
            for x,y in tiles:
                crop=frame[y:min(y+size,height),x:min(x+size,width)]
                tile_scale=min(1.,640/max(crop.shape[:2]))
                run(cv2.resize(crop,None,fx=tile_scale,fy=tile_scale) if tile_scale<1 else crop,x,y,tile_scale)
        kept = []
        for face in sorted(found,key=lambda item:item["score"],reverse=True):
            if any(other is not face and other["score"] >= .85 and
                   contained_face_part(face["box"],other["box"]) for other in found):
                continue
            if all(iou(face["box"],other["box"])<.3 for other in kept):
                kept.append(face)
        self.candidate_count = len(kept)
        kept = kept[:self.max_faces]
        for face in kept:
            face['quality'] = face_quality(frame,face['box'])
        return kept

    def _scan_loop(self):
        while not self.stop.is_set():
            self.event.wait(.2)
            self.event.clear()
            with self.lock:
                job,self.request = self.request,None
            if job is None or self.stop.is_set():
                continue
            frame,at,tiled,reference,tracking_frame = job
            try:
                started=time.perf_counter()
                # Always refresh the full image. For a few large faces, search
                # extra small-face tiles less often; dense/unknown scenes keep
                # visiting a tile each pass. Decide here, not when enqueuing,
                # because queued jobs may be replaced by a newer image.
                few_large=0<len(reference)<=8 and all(box[2]*frame.shape[1]>=80 for box in reference.values())
                scan_tiles=tiled and at-self.last_tile>=1250
                if scan_tiles:self.last_tile=at
                close_faces=0<len(reference)<=4 and all(box[2]*frame.shape[1]>=160 for box in reference.values())
                detail=not close_faces or at-self.last_detail_scan>=1000
                if detail:self.last_detail_scan=at
                edge=(480 if detail else 320) if few_large else 640
                detections = self._detect(frame,scan_tiles,tile_limit=1,max_edge=edge)
                self.scan_ms=round((time.perf_counter()-started)*1000,2)
                # Reinitialize and catch up replacement templates here, off the
                # response path. Otherwise each detector correction can replay
                # many native updates while the browser waits on one frame.
                if detections:
                    required=[]
                    live={track['id']:track for track in self.tracks}
                    latest=self.history[-1][0] if self.history else at
                    for detection in detections:
                        matches=[(iou(box,detection['box']),identity) for identity,box in reference.items()]
                        overlap,identity=max(matches) if matches else (0,None)
                        template=self.visual.items.get(identity)
                        current=live.get(identity,{})
                        if not (overlap>=.8 and detection.get('detectorVerified') is True and template and
                                not current.get('visualLostAt') and not current.get('missedScans',0) and
                                0<=latest-template.get('seededAt',template['seen'])<1500):
                            required.append(detection)
                    if required:self._prepare_templates(required,tracking_frame,at)
                with self.lock:
                    self.completed = (detections,at,reference,tracking_frame)
                self.scan_error = None
            except Exception as error:
                self.scan_error = str(error)

    def _prepare_templates(self,detections,source,at):
        native=FaceVisualTracker()
        tracks=[dict(d,id=index+1,seen=at) for index,d in enumerate(detections)]
        try:
            native.seed(source,tracks)
            latest=at
            # Bounded catch-up for a dense classroom: reinitialization must
            # never replay the whole history once for each of forty faces.
            history=list(self.history)
            for stamp,image in (history if len(tracks)<=4 else history[-1:]):
                if stamp>at and image.shape==source.shape:
                    native.update(image,tracks,stamp)
                    latest=stamp
            for detection,track in zip(detections,tracks):
                if track['id'] in native.items:
                    detection['_prepared']=dict(box=list(track['box']),at=latest,
                        visualAt=track.get('visualAt'),visualLostAt=track.get('visualLostAt'),
                        trackingScore=track.get('trackingScore'),item=native.items[track['id']])
        finally:
            native.close()

    def _merge(self,detections,now,reference=None,observed_at=None):
        detected_at = now if observed_at is None else observed_at
        # Match against the detector's source snapshot. The native tracker will
        # carry that new template to the current image; never multiply a fresh
        # detector box by the accumulated scale drift of the previous tracker.
        if reference:
            current = {track["id"]:track for track in self.tracks}
            for detection in detections:
                matches = [(iou(box,detection["box"]),identity,box) for identity,box in reference.items()]
                if not matches:
                    continue
                overlap,identity,old = max(matches)
                if overlap<.15 or identity not in current:
                    continue
                detection["knownId"] = identity
        candidates = []
        for ti,track in enumerate(self.tracks):
            for di,detection in enumerate(detections):
                a,b = track["box"],detection["box"]
                overlap = iou(a,b)
                distance = np.hypot(a[0]+a[2]/2-b[0]-b[2]/2,a[1]+a[3]/2-b[1]-b[3]/2)
                if detection.get("knownId")==track["id"]:
                    candidates.append((-1.,ti,di))
                elif overlap>.15 or distance<min(.08,max(a[2],b[2])):
                    candidates.append((1-overlap+distance,ti,di))
        used_tracks,used_detections = set(),set()
        for _,ti,di in sorted(candidates):
            if ti in used_tracks or di in used_detections:
                continue
            previous = self.tracks[ti]
            detection = detections[di]
            if detected_at<previous['seen']:
                used_tracks.add(ti);used_detections.add(di)
                continue
            consecutive = (0<=detected_at-previous['seen']<2500 and
                           previous.get('evidenceMode')==detection.get('evidenceMode') and
                           previous.get('detectorVerified') is True and detection.get('detectorVerified') is True)
            hits = previous.get('detectionHits',1)+1 if consecutive else 1
            native=getattr(self,'visual',None)
            template=native.items.get(previous['id']) if native is not None else None
            source_box=reference.get(previous['id']) if reference else None
            # A matching detector confirmation need not reload the same native
            # model/template and replay its image history. Keep the LIVE model
            # rectangle when it still agrees with the detector on the source
            # snapshot; disagreement/loss/old templates are reseeded normally.
            reuse=(template is not None and source_box is not None and detection.get('detectorVerified') is True and
                   not previous.get('missedScans',0) and not previous.get('visualLostAt') and
                   0<=now-previous.get('visualAt',-100000)<=100 and
                   0<=now-template.get('seededAt',template['seen'])<1500 and
                   iou(source_box,detection['box'])>=.8)
            live_box=list(previous['box']) if reuse else list(detection['box'])
            self.tracks[ti].update(detection,box=live_box,seen=detected_at,detectionHits=hits)
            if detection.get('detectorVerified') is True:self.tracks[ti]['verifiedAt']=detected_at
            if reuse:template['seen']=detected_at
            self.tracks[ti]['missedScans'] = 0
            self.tracks[ti].pop('missedAt',None)
            used_tracks.add(ti)
            used_detections.add(di)
        for ti,track in enumerate(self.tracks):
            # A successful rescan that no longer finds this face is stronger
            # evidence than a visual tracker locking onto background texture.
            # Do not apply an old job to a track created after its snapshot.
            if (ti not in used_tracks and (reference is None or track['id'] in reference) and
                    detected_at>track['seen'] and detected_at>track.get('missedAt',-1)):
                track['missedScans'] = track.get('missedScans',0)+1
                track['missedAt'] = detected_at
        for di,detection in enumerate(detections):
            if di not in used_detections:
                self.tracks.append(dict(detection,id=self.next_id,seen=detected_at,detectionHits=1,
                    verifiedAt=detected_at if detection.get('detectorVerified') is True else -10000))
                self.next_id += 1

    def _scan_interval(self,now):
        # A native tracker can confidently follow the occluder/background.
        # Negative detector evidence must therefore trigger a search even if
        # visualAt keeps updating. Empty scenes must not wait the steady timer.
        if not self.tracks or any(t.get('missedScans',0) or t.get('visualLostAt') or
                now-t.get('visualAt',-100000)>150 for t in self.tracks):
            return 100
        return 250 if len(self.tracks)<=4 else 500

    def _dense_scene(self,bodies):
        return len(self.tracks)>8 or len(bodies)>8

    def update(self,frame,now_ms,bodies=(),owners=None):
        started=time.perf_counter()
        self.tracks=self.tracks[:self.max_faces]
        alive={track['id'] for track in self.tracks}
        self.visual.items={key:value for key,value in self.visual.items.items() if key in alive}
        height,width = frame.shape[:2]
        # Per-face native tracking scales with the number of students, while
        # one full-image detector pass does not. In a crowded scene, delayed
        # background scans used to arrive after ALL face evidence had expired.
        # Measure the actual submitted image instead; never stretch evidence
        # deadlines or paint a previous frame's faces to hide that failure.
        if self._dense_scene(bodies):
            with self.lock:
                self.request=None;self.completed=None
            detections=self._detect(frame)
            self._merge(detections,now_ms)
            self.last_scan=now_ms
            for track in self.tracks:
                if track['seen']==now_ms:
                    track['visualAt']=now_ms;track.pop('visualLostAt',None)
            self.tracks=[t for t in self.tracks if now_ms-t['seen']<=2000][:self.max_faces]
            self.visual.items.clear()
            self.timings=dict(prepareMs=0,visualMs=0,refreshMs=round((time.perf_counter()-started)*1000,2),
                              faceScheduling='current_frame_dense')
            return [dict(id=t['id'],box=list(t['box']),score=t['score'],anchors=t['anchors'],
                detectedAt=t['seen'],facePixels=float(t['box'][2]*width),
                detectorVerified=t.get('detectorVerified',False),evidenceMode=t.get('evidenceMode'),
                verifiedAt=t.get('verifiedAt'),detectorModel=t.get('detectorModel'),
                detectionHits=t.get('detectionHits',1),scrfdScore=t.get('scrfdScore',0.),
                quality=t.get('quality'),visualAt=t.get('visualAt'),missedScans=t.get('missedScans',0),
                missedAt=t.get('missedAt')) for t in self.tracks if t['seen']==now_ms]
        # Newly entering small/second faces must not invalidate all pending
        # snapshots and native templates by switching 640 <-> 960.
        scale = min(1.,960/max(width,height))
        tracking_frame = cv2.resize(frame,None,fx=scale,fy=scale) if scale<1 else frame
        brighter=enhance_low_light(tracking_frame)
        if brighter is not None:tracking_frame=brighter
        # A tracker expects consecutive images. Detector jobs may finish several
        # frames late; replay those real intervening images through VitTrack
        # instead of asking it to jump across a fast head turn in one update.
        self.history=[(at,image) for at,image in self.history if
                      now_ms-at<=1500 and image.shape==tracking_frame.shape][-11:]
        self.history.append((now_ms,tracking_frame))
        prepared_at=time.perf_counter()
        self._drop_body_duplicates(now_ms)
        # A face confirmed by matching MediaPipe/profile landmarks is also a
        # known face. Previously only a high SCRFD score enabled fast recovery,
        # so a valid mesh-confirmed profile could never use the recovery path.
        proof_faces=[dict(t,detectedAt=t['seen'],facePixels=t['box'][2]*width) for t in self.tracks]
        for track,face in zip(self.tracks,proof_faces):
            proof=landmark_confirmation(face,proof_faces,(owners or {}).get(track['id'],{}),now_ms)
            if proof is not None:track['verifiedAt']=max(track.get('verifiedAt',-10000),proof['at'])
        fast_ids=self.fast.update(frame,self.tracks,now_ms) if self.fast is not None else set()
        self.visual.update(tracking_frame,self.tracks,now_ms,only_ids={t['id'] for t in self.tracks}-fast_ids)
        if self.fast is not None and any(t['id'] not in fast_ids and (t.get('visualLostAt') or t.get('missedScans',0)) for t in self.tracks):
            fast_ids|=self.fast.update(frame,self.tracks,now_ms,rotate=True)
        fast_boxes={t['id']:{key:t[key] for key in ('box','anchors','relativeAnchors','fastFaceAt','fastFaceScore','fastFaceModel','visualAt')}
                    for t in self.tracks if t['id'] in fast_ids}
        # A detector on the current image recenters the native search window.
        # Keep its independent appearance template ready for a profile/blurred
        # frame where the fast frontal detector cannot confirm the face.
        th,tw=tracking_frame.shape[:2]
        for track in self.tracks:
            item=self.visual.items.get(track['id'])
            if track['id'] in fast_ids and item and hasattr(item['tracker'],'box'):
                x,y,bw,bh=track['box'];item['tracker'].box=(round(x*tw),round(y*th),round(bw*tw),round(bh*th))
        tracked=time.perf_counter()
        for track in self.tracks:
            follow_body(track,bodies,owners or {},now_ms)
        with self.lock:
            completed,self.completed = self.completed,None
        if completed and now_ms-completed[1]<5000 and completed[3].shape==tracking_frame.shape:
            previous={track['id']:track['seen'] for track in self.tracks}
            self._merge(completed[0],now_ms,completed[2],observed_at=completed[1])
            for track in self.tracks:
                if track['id'] in fast_boxes:
                    track.update(fast_boxes[track['id']]);track.pop('visualLostAt',None)
                    item=self.visual.items.get(track['id'])
                    if item:item['seen']=track['seen']
            refreshed={track['id'] for track in self.tracks if previous.get(track['id'])!=track['seen'] and
                       track['id'] not in fast_ids and
                       self.visual.items.get(track['id'],{}).get('seen')!=track['seen']}
            replay_from={identity:completed[1] for identity in refreshed}
            for track in self.tracks:
                prepared_template=track.pop('_prepared',None)
                if prepared_template and track['id'] in fast_ids:
                    # Refresh appearance off-thread even while current-frame
                    # detections supply position. Otherwise fast tracking keeps
                    # the fallback template from the very first frame forever.
                    item=prepared_template['item'];self.visual.items[track['id']]=item
                    item['seen']=track['seen']
                    if hasattr(item['tracker'],'box'):
                        x,y,bw,bh=track['box'];item['tracker'].box=(round(x*tw),round(y*th),round(bw*tw),round(bh*th))
                if prepared_template and track['id'] in refreshed:
                    self.visual.items[track['id']]=prepared_template['item']
                    track['box']=prepared_template['box']
                    for key in ('visualAt','visualLostAt','trackingScore'):
                        if prepared_template[key] is None:track.pop(key,None)
                        else:track[key]=prepared_template[key]
                    replay_from[track['id']]=prepared_template['at']
            self.visual.seed(completed[3],self.tracks)
            for at,image in self.history:
                remaining={identity for identity in refreshed if at>replay_from[identity]}
                if remaining:self.visual.update(image,self.tracks,at,only_ids=remaining)
        if self.last_scan==0:
            self._merge(self._detect(frame),now_ms)
            self.last_scan = now_ms
        elif now_ms-self.last_scan >= self._scan_interval(now_ms):
            tiled = max(width,height)>1280
            reference = {track["id"]:list(track["box"]) for track in self.tracks}
            with self.lock:
                self.request = (frame,now_ms,tiled,reference,tracking_frame)
            self.event.set()
            self.last_scan = now_ms
        # New detector candidates need their body link in this same response,
        # not several seconds later when the object worker completes again.
        for track in self.tracks:
            follow_body(track,bodies,owners or {},now_ms)
        self._drop_body_duplicates(now_ms)
        self.tracks = [track for track in self.tracks if now_ms-track['seen']<=2000 or
            (now_ms-track.get('visualAt',-100000)<250 and now_ms-track['seen']<5000) or
            now_ms-track.get('bodyAt',-100000)<=1800][:self.max_faces]
        self.visual.seed(tracking_frame,self.tracks)
        finished=time.perf_counter()
        self.timings=dict(prepareMs=round((prepared_at-started)*1000,2),
                          visualMs=round((tracked-prepared_at)*1000,2),
                          refreshMs=round((finished-tracked)*1000,2))
        return [dict(id=t["id"],box=list(t["box"]),score=t["score"],anchors=project_anchors(t,width,height),
                     detectedAt=t['seen'],facePixels=float(t["box"][2]*width),
                     detectorVerified=t.get('detectorVerified',False),evidenceMode=t.get('evidenceMode'),
                     verifiedAt=t.get('verifiedAt'),
                     detectorModel=t.get('detectorModel'),
                     detectionHits=t.get('detectionHits',1),scrfdScore=t.get('scrfdScore',0.),
                     quality=t.get('quality'),visualAt=t.get('visualAt'),bodyAt=t.get('bodyAt'),
                     personId=t.get('personId'),trackingScore=t.get('trackingScore'),fastFaceAt=t.get('fastFaceAt'),fastFaceScore=t.get('fastFaceScore'),fastFaceModel=t.get('fastFaceModel'),visualLostAt=t.get('visualLostAt'),missedScans=t.get('missedScans',0),missedAt=t.get('missedAt')) for t in self.tracks]

    def _drop_body_duplicates(self,now=None):
        fresh=[track for track in self.tracks if not track.get('missedScans',0) and
               track.get('detectorVerified') is True and track.get('personId') is not None]
        self.tracks=[track for track in self.tracks if not track.get('missedScans',0) or not any(
            other is not track and other.get('personId')==track.get('personId') and
            other['seen']>track['seen'] and iou(other['box'],track['box'])>.4 for other in fresh)]
        if now is not None:
            current=[track for track in self.tracks if track.get('fastFaceAt')==now]
            self.tracks=[track for track in self.tracks if not any(other is not track and
                other['seen']>track['seen'] and iou(other['box'],track['box'])>=.6 for other in current)]
        # Two native templates can converge on the same face after an abrupt
        # movement. Keep the established ID once; do not count both ROIs as
        # separate people or make fast recovery ambiguous on the next frame.
        kept=[]
        for track in sorted(self.tracks,key=lambda t:t['id']):
            if all(iou(track['box'],other['box'])<.65 for other in kept):kept.append(track)
        self.tracks=kept

    def close(self):
        self.stop.set()
        self.event.set()
        self.thread.join(timeout=2)
        self.visual.close()
        self.history.clear()
