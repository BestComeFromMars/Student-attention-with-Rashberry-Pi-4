"""ByteTrack person IDs with current native body rectangles; optional faces."""
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import math
import cv2
from visual_tracking import FaceVisualTracker
from geometry import iou
from memory_budget import select_people

def box_dict(box):return dict(zip(('x','y','width','height'),map(float,box)))

def merge_rest_bodies(bodies,rest_bodies,at):
    """A specialist can continue an already verified, face-hidden person.

    Rectangles and times are actual completed detections. Never create a face
    or replace another person's metadata from a merely overlapping rectangle.
    """
    output=list(bodies)
    for rest in rest_bodies:
        if not 0<=at-rest['at']<=1500:continue
        matches=[(iou(body['box'],rest['box']),i,body) for i,body in enumerate(output)
                 if body['id']==rest['id'] or iou(body['box'],rest['box'])>=.7]
        matches.sort(key=lambda item:(item[2]['id']==rest['id'],item[0]),reverse=True)
        old={}
        if matches and (matches[0][2]['id']==rest['id'] or len(matches)==1 or matches[0][0]-matches[1][0]>=.05):
            _,index,old=matches[0];output.pop(index)
        observation={**old.get('observation',{}),**rest.get('observation',{})}
        output.append({**old,**rest,'observation':observation,'geometryAt':rest['at']})
    return output

def attach_faces(bodies,faces,preferred=None):
    pairs=[]
    for bi,body in enumerate(bodies):
        bx,by,bw,bh=body['box']
        for fi,face in enumerate(faces):
            rest=body.get('observation',{}).get('deskRest',{})
            if (rest.get('active') or rest.get('trackedBodyAt') is not None) and face.get('personId')!=body['id'] and (
                    not preferred or preferred.get(face.get('geometryId'))!=body['id']):continue
            box=face.get('faceBox') or (face['box'] if face.get('boxKind')=='face' else None)
            if not box:continue
            x,y,w,h=[box[k] for k in ('x','y','width','height')];cx,cy=x+w/2,y+h/2
            coverage=max(0,min(x+w,bx+1.05*bw)-max(x,bx-.05*bw))*max(0,min(y+h,by+bh)-max(y,by-.08*bh))
            if coverage<.8*w*h:continue
            if bx-.05*bw<=cx<=bx+1.05*bw and by-.08*bh<=cy<=by+.75*bh and w<=1.2*bw:
                score=((cx-bx-bw/2)/max(bw,.01))**2+((cy-by-.17*bh)/max(bh,.01))**2
                if face.get('personId')==body['id']:score-=.2
                if preferred and preferred.get(face.get('geometryId'))==body['id']:score-=.5
                pairs.append((score,bi,fi))
    result={};used=set()
    for _,bi,fi in sorted(pairs):
        if bi not in result and fi not in used:result[bi]=fi;used.add(fi)
    return result,used

def duplicate_unfaced_body(index,bodies,faces,links):
    """Reject two overlapping detector rectangles for one verified head.

    Different visible heads or an independently corroborated folded person
    must remain separate, even when their classroom rectangles overlap.
    """
    body=bodies[index];rest=body.get('observation',{}).get('deskRest',{})
    if rest.get('active') or rest.get('trackedBodyAt') is not None:return False
    bx,by,bw,bh=body['box']
    for owner,fi in links.items():
        if owner==index:continue
        other=bodies[owner];ox,oy,ow,oh=other['box']
        other_rest=other.get('observation',{}).get('deskRest',{})
        if other_rest.get('active') or other_rest.get('trackedBodyAt') is not None:continue
        intersection=max(0,min(bx+bw,ox+ow)-max(bx,ox))*max(0,min(by+bh,oy+oh)-max(by,oy))
        if intersection<.65*min(bw*bh,ow*oh) or intersection<.4*max(bw*bh,ow*oh):continue
        face=faces[fi];box=face.get('faceBox') or face['box'];cx=box['x']+box['width']/2;cy=box['y']+box['height']/2
        if not (bx<=cx<=bx+bw and by<=cy<=by+.55*bh and oy<=cy<=oy+.55*oh):continue
        nearby=[i for i,f in enumerate(faces) if bx<=(f.get('faceBox') or f['box'])['x']+(f.get('faceBox') or f['box'])['width']/2<=bx+bw and
            by<=(f.get('faceBox') or f['box'])['y']+(f.get('faceBox') or f['box'])['height']/2<=by+.75*bh]
        # A composite rectangle can cover two already-owned neighboring heads.
        # Keep ambiguity whenever any such head has no independent owner.
        if any(i not in links.values() for i in nearby):continue
        pose=body.get('observation',{}).get('bodyPose')
        if pose and pose.get('keypoints'):
            nose=pose['keypoints'][0]
            if nose['confidence']>=.35 and math.hypot((nose['x']-cx)/box['width'],(nose['y']-cy)/box['height'])>1.5:continue
        return True
    return False

class PersonTracking:
    def __init__(self,async_prepare=True):
        self.visual=FaceVisualTracker();self.tracks=[];self.history=deque(maxlen=128);self.last_scan=-1
        self.async_prepare=async_prepare;self.pool=None;self.job=None;self.pending=None
        self.generation=0;self.applied_scan=-1;self.allowed=None;self.error=None
        self.face_owners={}
        self.max_people=40

    def set_limit(self,limit):
        if limit<self.max_people:
            self.generation+=1;self.pending=None
            self.tracks=self.tracks[:limit]
            alive={track['id'] for track in self.tracks}
            self.visual.items={key:value for key,value in self.visual.items.items() if key in alive}
            if self.allowed is not None:self.allowed.intersection_update(alive)
        self.max_people=limit

    def _prepare(self,source,hints,scan,history,generation):
        native=FaceVisualTracker();tracks=[{**hint,'box':list(hint['box']),'seen':scan} for hint in hints]
        latest=scan
        try:
            native.seed(source,tracks)
            # Never chase an expanding camera history for every body. With a
            # classroom, that job could never catch the producer and every
            # completed batch was discarded. Jump the actual native tracker to
            # the newest sampled image; a rejected update remains unavailable.
            recent=list(self.history) or history
            if recent and generation==self.generation:
                stamp,image=recent[-1]
                if stamp>latest and image.shape==source.shape:
                    native.update(image,tracks,stamp);latest=stamp
            return dict(tracks=tracks,items=dict(native.items),at=latest,scan=scan,generation=generation,shape=source.shape[:2])
        finally:native.close()

    def _prepared(self,image,at):
        if self.job is not None and self.job.done():
            try:
                result=self.job.result()
                if (result['generation']==self.generation and result['scan']>self.applied_scan and
                        result.get('shape',image.shape[:2])==image.shape[:2] and 0<=at-result['scan']<=5000 and
                        0<=at-result['at']<=3000):
                    existing={track['id']:track for track in self.tracks}
                    for track in result['tracks']:
                        if self.allowed is not None and track['id'] not in self.allowed:continue
                        old=existing.get(track['id'])
                        if old and old['seen']>result['scan']:continue
                        existing[track['id']]=track
                        if track['id'] in result['items']:self.visual.items[track['id']]=result['items'][track['id']]
                    self.tracks=list(existing.values());self.visual.shape=image.shape[:2]
                    self.applied_scan=result['scan']
                self.error=None
            except Exception as error:self.error=str(error)
            self.job=None
        if self.job is None and self.pending is not None:
            source,hints,scan,history,generation=self.pending;self.pending=None
            if self.pool is None:self.pool=ThreadPoolExecutor(max_workers=1,thread_name_prefix='body-templates')
            self.job=self.pool.submit(self._prepare,source,hints,scan,history,generation)
    def update(self,frame,at,hints,scan_at=None):
        scale=min(1.,480/max(frame.shape[:2]));image=cv2.resize(frame,None,fx=scale,fy=scale) if scale<1 else frame
        self.history.append((at,image))
        while self.history and at-self.history[0][0]>3500:self.history.popleft()
        if self.async_prepare:self._prepared(image,at)
        # Install the finished batch BEFORE the one live update, so handover
        # cannot publish old rectangles or discard it merely for being behind.
        self.visual.update(image,self.tracks,at)
        return self.refresh(at,hints,scan_at)

    def refresh(self,at,hints,scan_at=None):
        """Merge detections completed during face inference into this result.

        The current image is already tracked. Do not advance native tracking
        twice or wait for a background model/template to complete.
        """
        hints=select_people(hints,self.max_people,(track['id'] for track in self.tracks))
        image=next((image for stamp,image in reversed(self.history) if stamp==at),None)
        if image is None:return []
        scan=max((body['at'] for body in hints),default=-1) if scan_at is None else scan_at
        if scan>self.last_scan and 0<=at-scan<=3500:
            if not hints:
                self.tracks=[];self.visual.items.clear();self.last_scan=scan
                self.generation+=1;self.pending=None;self.allowed=set()
            source=next((im for stamp,im in self.history if stamp==scan),None)
            if hints and source is not None:
                previous={t['id']:t for t in self.tracks};current=[]
                self.allowed={hint['id'] for hint in hints}
                refreshed=set()
                for hint in hints:
                    box=list(hint['box'])
                    if len(box)!=4 or not all(math.isfinite(v) for v in box) or min(box[2:])<=0:continue
                    old=previous.get(hint['id'],{});item=self.visual.items.get(hint['id'])
                    reuse=bool(item and old and not old.get('visualLostAt') and 0<=at-old.get('visualAt',-10000)<=100 and
                        0<=at-item.get('seededAt',item['seen'])<1500 and iou(old['box'],box)>=.8)
                    if reuse:item['seen']=scan
                    else:refreshed.add(hint['id'])
                    current.append({**old,**hint,'box':list(old['box']) if reuse else box,'seen':scan})
                    current[-1].pop('missedScans',None)
                # A partial scan can miss a still-visible person. Bridge one
                # scan only with a successful current native measurement.
                for identity,track in previous.items():
                    if (identity not in self.allowed and track.get('visualAt')==at and not track.get('visualLostAt') and
                            0<=at-track['seen']<=3000 and track.get('missedScans',0)<1 and
                            not any(iou(track['box'],body['box'])>=.6 for body in current)):
                        current.append(dict(track,missedScans=track.get('missedScans',0)+1))
                        self.allowed.add(identity)
                current=select_people(current,self.max_people,previous)
                self.allowed={track['id'] for track in current}
                if self.async_prepare:
                    pending=[hint for hint in current if hint['id'] in refreshed]
                    # A fresh positive YOLO rectangle is already evidence. Do
                    # not hide it merely because a replacement pixel template
                    # is preparing or the old native tracker rejected a frame.
                    # Its source timestamp stays unchanged and expires quickly.
                    self.tracks=[]
                    for track in current:
                        old=previous.get(track['id'])
                        if track['id'] not in refreshed:self.tracks.append(track)
                        elif old and old.get('visualAt')==at and not old.get('visualLostAt'):
                            self.tracks.append(old)
                        elif 0<=at-scan<=1800:
                            detected=dict(track,boxFromDetectionAt=scan)
                            detected.pop('visualLostAt',None);detected.pop('visualAt',None)
                            self.tracks.append(detected)
                    self.pending=(source,pending,scan,list(self.history),self.generation) if pending else None
                    self.last_scan=scan
                    if self.job is None:self._prepared(image,at)
                else:
                    self.visual.seed(source,current)
                    for stamp,im in self.history:
                        if refreshed and scan<stamp<=at:self.visual.update(im,current,stamp,only_ids=refreshed)
                    self.tracks=current;self.last_scan=scan
        # Update metadata independently from the pixel tracker without renewing
        # body detection time from repeated asynchronous snapshots.
        metadata={b['id']:b for b in hints}
        output=[]
        for track in self.tracks:
            if track['id'] in metadata:
                for key in ('observation','actions'):track[key]=metadata[track['id']].get(key,{} if key=='observation' else [])
            # A current, successful native measurement may continue a detected
            # body while another slow YOLO pass is in flight. Keep the original
            # detection timestamp for behavior freshness; this is not stale-box
            # retention. A failed tracker or an empty/new scan still removes it.
            fresh=0<=at-track['seen']<=3000
            live=0<=at-track.get('visualAt',-10000)<=100 and 0<=at-track['seen']<=5000
            if not (fresh or live):continue
            detector_box=track.get('boxFromDetectionAt')==track['seen'] and 0<=at-track['seen']<=1800
            if track.get('boxFromDetectionAt') is not None and track.get('visualAt')!=at and not detector_box:continue
            if track.get('visualLostAt') and track.get('visualLostAt',0)>=track.get('visualAt',0) and not detector_box:continue
            output.append(dict(track))
        self.tracks=[t for t in self.tracks if 0<=at-t['seen']<=5000]
        return output
    def assemble(self,bodies,faces,at):
        owners={k:v for k,v in getattr(self,'face_owners',{}).items() if 0<=at-v[1]<=3000}
        links,used=attach_faces(bodies,faces,{k:v[0] for k,v in owners.items()});output=[]
        for bi,fi in links.items():
            if faces[fi].get('geometryId') is not None:owners[faces[fi]['geometryId']]=(bodies[bi]['id'],at)
        self.face_owners=owners
        for bi,body in enumerate(bodies):
            if bi not in links and duplicate_unfaced_body(bi,bodies,faces,links):continue
            face=faces[links[bi]] if bi in links else None
            visible=bool(face and face.get('trackingState') in ('face','visual'))
            observation=dict(face.get('observation',{})) if visible else dict(valid=False,facePresent=False,eyeAspectRatio=0,yawOffset=0,observedAt=at)
            observation.update(body.get('observation',{}));observation['personId']=body['id']
            item=dict(box=box_dict(body['box']),personBox=box_dict(body['box']),boxKind='person',personId=body['id'],
                personObservedAt=body['seen'],faceVisibility='visible' if visible else 'unavailable',trackingState='face' if visible else 'visual',
                observation=observation,analysisAt=observation.get('observedAt',at),actions=body.get('actions',[]),confidence=body.get('confidence',.5))
            item['geometryTimes']=dict(person=body.get('geometryAt') or (at if body.get('visualAt')==at else
                body.get('boxFromDetectionAt') or body.get('at') or body['seen']))
            if visible:
                item.update(faceBox=face['box'],geometryId=face.get('geometryId'))
                item['geometryTimes'].update(face.get('geometryTimes',{}))
            output.append(item)
        for fi,face in enumerate(faces):
            if fi not in used and face.get('trackingState') in ('face','visual'):
                # Scene/hand observations can finish after their body moved or
                # disappeared. An unmatched current face cannot keep that old
                # person's identity, phone/book flags, pose or folded-body cue.
                orphan={**face,'faceBox':face['box'],'faceVisibility':'visible'}
                orphan.pop('personId',None)
                body_fields={'personId','phoneHeld','laptopInteraction','bookInteraction','objectRegions','objectsAt',
                    'bodyPose','headYaw','headObservedAt','headSource','deskRest','deskSlumpPose'}
                if 'observation' in orphan:orphan['observation']={k:v for k,v in orphan['observation'].items() if k not in body_fields}
                output.append(orphan)
        return output
    def close(self):
        self.generation+=1;self.pending=None
        if self.pool is not None:self.pool.shutdown(wait=True,cancel_futures=True)
        self.visual.close();self.history.clear();self.tracks=[]
