"""Current-image geometry, independent of semantic inference.

Late detections are projected through measured optical flow, never applied to
the current image as old coordinates. History contains pixels' feature IDs,
not predicted velocity. A missing history/failed measurement cannot birth a box.
"""
import base64
import json
import math
import sys
import time
from collections import deque
import cv2
import numpy as np
from camera_cpu import camera_cpu
from box_refinement import BoxRefinement

cv2.setNumThreads(1)


def transform(box, before, after, shape, affine=True, body=False):
    h, w = shape
    x, y, bw, bh = [box[k] for k in ('x', 'y', 'width', 'height')]
    # Prefer the interior, excluding desks/background around a person's edges.
    p = before
    if body:
        # A moving wrist should not set the whole person's motion/scale. Prefer
        # the torso, falling back when a small/occluded torso has few features.
        mask = ((p[:, 0] >= (x + .22*bw)*w) & (p[:, 0] <= (x + .78*bw)*w) &
                (p[:, 1] >= (y + .12*bh)*h) & (p[:, 1] <= (y + .68*bh)*h))
    if not body or np.count_nonzero(mask)<8:
        mask = ((p[:, 0] >= (x + .12*bw)*w) & (p[:, 0] <= (x + .88*bw)*w) &
                (p[:, 1] >= (y + .08*bh)*h) & (p[:, 1] <= (y + .8*bh)*h))
    if np.count_nonzero(mask) < 4:
        mask = ((p[:, 0] >= x*w) & (p[:, 0] <= (x+bw)*w) &
                (p[:, 1] >= y*h) & (p[:, 1] <= (y+bh)*h))
    if np.count_nonzero(mask) < 3:
        return None
    a, b = p[mask], after[mask]
    delta = b-a
    middle=len(delta)//2
    median = np.partition(delta,middle,axis=0)[middle]
    good = np.linalg.norm(delta-median, axis=1) < max(2., .12*min(bw*w, bh*h))
    if np.count_nonzero(good) < 3:
        return None
    a, b = a[good], b[good]
    scale = 1.
    if not affine and len(a)>=6:
        # One native reduction gives the same translation and least-squares
        # scale. Dozens of bodies/faces need not each allocate/reduce several
        # NumPy intermediates on every camera frame.
        cov,means=cv2.calcCovarMatrix(np.concatenate((a,b),axis=1),None,
            cv2.COVAR_ROWS|cv2.COVAR_NORMAL)
        ax,ay,bx,by=means[0]
        dx,dy=bx-ax,by-ay
        xx,yy=float(cov[0,0]),float(cov[1,1])
        xy_x,xy_y=float(cov[0,2]),float(cov[1,3])
        denominator=xx+yy
        if denominator>20:
            measured=(xy_x+xy_y)/denominator
            scale=max(.997,min(1.003,measured))
            if body:
                # Approaching/receding people change both axes coherently.
                # Asymmetric limb motion is a later shape correction, not zoom.
                scale=1.
                if abs(measured-1.)>=.0015 and len(a)>=8 and min(xx,yy)>20:
                    residual2=max(0.,(float(cov[2,2]+cov[3,3])-measured**2*denominator)/len(a))
                    if (abs(xy_x/xx-xy_y/yy)<.025 and
                            residual2<max(.6,.015*min(bw*w,bh*h))**2):
                        scale=max(.99,min(1.01,measured))
                        dx+=((x+bw/2)*w-ax)*(scale-1.)
                        dy+=((y+bh/2)*h-ay)*(scale-1.)
    else:
        dx,dy=cv2.mean((b-a).reshape(-1,1,2))[:2]
    if affine and len(a) >= 6:
        matrix, inliers = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC,
            ransacReprojThreshold=2., maxIters=100, confidence=.95)
        if matrix is not None and inliers.sum() >= .65*len(a):
            measured = float(np.hypot(matrix[0, 0], matrix[0, 1]))
            if .75 < measured < 1.33:
                scale = measured
                center = np.array([(x+bw/2)*w, (y+bh/2)*h])
                moved = matrix[:, :2]@center+matrix[:, 2]-center
                dx, dy = moved
    nw, nh = min(1., bw*scale), min(1., bh*scale)
    nx = float(max(0,min(1-nw,x+bw/2+dx/w-nw/2)))
    ny = float(max(0,min(1-nh,y+bh/2+dy/h-nh/2)))
    return dict(x=nx, y=ny, width=nw, height=nh)


def carry_target(target, before, after):
    """Carry a detector's shape target by the SAME measured current motion."""
    sx,sy=after['width']/before['width'],after['height']/before['height']
    width,height=min(1.,target['width']*sx),min(1.,target['height']*sy)
    cx=after['x']+after['width']/2+(target['x']+target['width']/2-before['x']-before['width']/2)*sx
    cy=after['y']+after['height']/2+(target['y']+target['height']/2-before['y']-before['height']/2)*sy
    return dict(x=max(0.,min(1-width,cx-width/2)),y=max(0.,min(1-height,cy-height/2)),width=width,height=height)


def follow_body_support(box, target, dt):
    """Conservative feature-search ROI, independent of the displayed rectangle.

    Keep the established feature support behavior: feeding a damped display box
    back into point selection can remove features from a small/occluded person.
    This ROI is never rendered; BoxRefinement owns the visible correction.
    """
    dims=[]
    for dim in ('width','height'):
        delta=math.log(target[dim]/box[dim])
        if abs(delta)<=.02:
            dims.append(box[dim]);continue
        tau=.22 if delta>0 else .34
        rate=.75 if delta>0 else .6
        step=max(-rate*dt,min(rate*dt,delta*(1-math.exp(-dt/tau))))
        dims.append(min(1.,box[dim]*math.exp(step)))
    centers=[]
    for axis,dim in (('x','width'),('y','height')):
        center=box[axis]+box[dim]/2
        delta=target[axis]+target[dim]/2-center
        if abs(delta)>box[dim]*.015:
            limit=max(box[dim],target[dim])*.75*dt
            center+=max(-limit,min(limit,delta*(1-math.exp(-dt/.24))))
        centers.append(center)
    width,height=dims
    return dict(x=max(0.,min(1-width,centers[0]-width/2)),
                y=max(0.,min(1-height,centers[1]-height/2)),width=width,height=height)


class PixelTracking:
    def __init__(self,clock=None):
        self.clock=clock or (lambda:time.monotonic())
        self.gray = None
        self.points = np.empty((0, 2), np.float32)
        self.ids = np.empty(0, np.int64)
        self.sequence = 0
        self.frame_id = -1
        self.history = deque(maxlen=180)
        self.boxes = {}
        self.updated_at = None
        self.captured_at = None

    def project(self, box, frame_id, body=False):
        if frame_id == self.frame_id:
            return dict(box)
        old = next((v for v in reversed(self.history) if v[0] == frame_id), None)
        if old is None or self.gray is None:
            return None
        _, src_ids, src_points, _ = old
        _, a, b = np.intersect1d(src_ids, self.ids, return_indices=True)
        return transform(box, src_points[a], self.points[b], self.gray.shape,body=body)

    def seed(self, seeds):
        projected=[self.project(seed['box'],seed['frameId'],body=seed['key'].startswith('person:')) for seed in seeds]
        # A small face may have no global scene features. Recover its own real
        # pixels from the exact source image, in one batched LK pass per image.
        missing={seed['frameId'] for seed,box in zip(seeds,projected) if box is None}
        for source_id in missing:
            old=next((v for v in reversed(self.history) if v[0]==source_id),None)
            if old is None:continue
            h,w=self.gray.shape;points=[];regions=[]
            for index,seed in enumerate(seeds):
                if projected[index] is not None or seed['frameId']!=source_id:continue
                b=seed['box'];x,y=int(b['x']*w),int(b['y']*h)
                right,bottom=min(w,int((b['x']+b['width'])*w)),min(h,int((b['y']+b['height'])*h))
                if right-x<3 or bottom-y<3:continue
                features=cv2.goodFeaturesToTrack(old[3][y:bottom,x:right],maxCorners=20,qualityLevel=.005,minDistance=2,blockSize=3)
                if features is None:continue
                features=features.reshape(-1,2)+np.array([x,y],np.float32)
                regions.append((index,len(points),len(features)));points.extend(features)
            if not points:continue
            src=np.array(points,np.float32)
            dst,valid,_=cv2.calcOpticalFlowPyrLK(old[3],self.gray,src,None,winSize=(15,15),maxLevel=3)
            back,back_valid,_=cv2.calcOpticalFlowPyrLK(self.gray,old[3],dst,None,winSize=(15,15),maxLevel=3)
            good=(valid.ravel()==1)&(back_valid.ravel()==1)&(np.linalg.norm(back-src,axis=1)<1.5)
            for index,start,length in regions:
                selected=np.arange(start,start+length);selected=selected[good[selected]]
                projected[index]=transform(seeds[index]['box'],src[selected],dst[selected],self.gray.shape,
                    body=seeds[index]['key'].startswith('person:'))
            extra=dst[good];ids=np.arange(self.sequence,self.sequence+len(extra),dtype=np.int64);self.sequence+=len(extra)
            self.points=np.concatenate([self.points,extra]);self.ids=np.concatenate([self.ids,ids])
        for seed,box in zip(seeds,projected):
            if box is None:
                continue
            key = seed['key']
            prior = self.boxes.get(key)
            if prior and prior['frameId'] >= seed['frameId']:
                continue
            if prior:
                # All three layers consume late detector corrections without
                # resetting their current rectangle or correction velocity.
                prior['refinement'].observe(prior['target'],box,self.clock())
                prior.update(target=dict(box),frameId=seed['frameId'],confirmedAt=self.clock(),failed=0)
                if key.startswith('person:'):
                    prior['support_target']=dict(box)
                else:
                    support=dict(box)
                    for dim in ('width','height'):
                        support[dim]=.75*prior['support'][dim]+.25*box[dim]
                    for axis,dim in (('x','width'),('y','height')):
                        support[axis]=max(0.,min(1-support[dim],box[axis]+box[dim]/2-support[dim]/2))
                    prior['support']=support
                continue
            self.boxes[key] = dict(key=key, box=box, frameId=seed['frameId'],
                target=dict(box),confirmedAt=self.clock(), failed=0,
                support=dict(box),support_target=dict(box),
                refinement=BoxRefinement(key.split(':',1)[0],self.clock()))
        # Spend feature budget on actual targets, especially small faces, rather
        # than on stationary high-contrast desks across the entire classroom.
        if self.gray is not None:
            h,w=self.gray.shape
            for seed in seeds:
                track=self.boxes.get(seed['key'])
                if track is None:continue
                b=track['support'];x,y=int(b['x']*w),int(b['y']*h)
                right,bottom=min(w,int((b['x']+b['width'])*w)),min(h,int((b['y']+b['height'])*h))
                if right-x<3 or bottom-y<3:continue
                inside=(self.points[:,0]>=x)&(self.points[:,0]<right)&(self.points[:,1]>=y)&(self.points[:,1]<bottom)
                if inside.sum()>=8:continue
                extra=cv2.goodFeaturesToTrack(self.gray[y:bottom,x:right],maxCorners=8,
                    qualityLevel=.01,minDistance=2,blockSize=3)
                if extra is None:continue
                extra=extra.reshape(-1,2)+np.array([x,y],np.float32)
                if len(self.points):
                    distances=((extra[:,None]-self.points[None,:])**2).sum(axis=2)
                    extra=extra[distances.min(axis=1)>4]
                ids=np.arange(self.sequence,self.sequence+len(extra),dtype=np.int64);self.sequence+=len(extra)
                self.points=np.concatenate([self.points,extra]);self.ids=np.concatenate([self.ids,ids])
            if len(self.points)>1200:
                self.points,self.ids=self.points[-1000:],self.ids[-1000:]
            # Source-frame snapshots include any new target features as well.
            if self.history:self.history[-1]=(self.frame_id,self.ids.copy(),self.points.copy(),self.gray)

    def update(self, frame, frame_id, captured_at=None):
        if frame_id <= self.frame_id:
            raise ValueError('Frame IDs must increase')
        if captured_at is not None and (not math.isfinite(captured_at) or captured_at < 0 or
                self.captured_at is not None and captured_at < self.captured_at):
            raise ValueError('Capture timestamps must be finite and nondecreasing')
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        if self.gray is not None and self.gray.shape != gray.shape:
            self.__init__(self.clock)
        now=self.clock()
        # Transport/CPU scheduling can bunch frames. Shape must use the camera's
        # capture intervals; server monotonic time still controls evidence expiry.
        elapsed=(captured_at-self.captured_at if captured_at is not None and self.captured_at is not None
                 else 0. if self.updated_at is None else now-self.updated_at)
        dt=max(0.,min(.0667,elapsed))
        self.captured_at=captured_at
        self.updated_at=now
        if self.gray is not None and len(self.points):
            previous = self.points
            nxt, valid, _ = cv2.calcOpticalFlowPyrLK(self.gray, gray, previous, None,
                winSize=(9, 9), maxLevel=2,
                criteria=(cv2.TERM_CRITERIA_COUNT|cv2.TERM_CRITERIA_EPS, 8, .03))
            back, backwards, _ = cv2.calcOpticalFlowPyrLK(gray, self.gray, nxt, None,
                winSize=(9, 9), maxLevel=2,
                criteria=(cv2.TERM_CRITERIA_COUNT|cv2.TERM_CRITERIA_EPS, 8, .03))
            good = (valid.ravel() == 1) & (backwards.ravel() == 1) & (np.linalg.norm(back-previous, axis=1) < 1.5)
            good &= (nxt[:, 0] >= 0) & (nxt[:, 0] < gray.shape[1]) & (nxt[:, 1] >= 0) & (nxt[:, 1] < gray.shape[0])
            before,after=previous[good],nxt[good]
            for key, track in list(self.boxes.items()):
                body=key.startswith('person:')
                measured = transform(track['support'], before, after, gray.shape, affine=False,body=body)
                if measured is None:
                    track['failed'] += 1
                else:
                    moved=carry_target(track['box'],track['support'],measured)
                    moved=track['refinement'].motion(track['box'],moved,dt)
                    track['target']=carry_target(track['target'],track['box'],moved)
                    track['refinement'].carry(track['box'],moved)
                    moved=track['refinement'].update(moved,track['target'],dt)
                    track['box'] = moved
                    if body:
                        track['support_target']=carry_target(track['support_target'],track['support'],measured)
                        measured=follow_body_support(measured,track['support_target'],dt)
                    track['support']=measured
                    track['failed'] = 0
                # No indefinite frozen boxes, and AI evidence cannot live forever.
                if track['failed'] > 3 or now-track['confirmedAt'] > 3.:
                    del self.boxes[key]
            self.points, self.ids = nxt[good], self.ids[good]
        self.gray = gray
        self.frame_id = frame_id
        if len(self.points) < 300:
            mask = np.full(gray.shape, 255, np.uint8)
            for x, y in self.points:
                cv2.circle(mask, (int(x), int(y)), 4, 0, -1)
            extra = cv2.goodFeaturesToTrack(gray, maxCorners=450-len(self.points),
                qualityLevel=.008, minDistance=5, mask=mask, blockSize=3)
            if extra is not None:
                extra = extra.reshape(-1, 2)
                ids = np.arange(self.sequence, self.sequence+len(extra), dtype=np.int64)
                self.sequence += len(extra)
                self.points = np.concatenate([self.points, extra])
                self.ids = np.concatenate([self.ids, ids])
        self.history.append((frame_id, self.ids.copy(), self.points.copy(),gray))
        return [dict(key=v['key'], box=v['box']) for v in self.boxes.values()]


def main():
    camera_cpu(geometry=True)
    sessions = {}
    print(json.dumps(dict(type='ready')), flush=True)
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            session = request['session']
            if request['type'] == 'release':
                sessions.pop(session, None)
                continue
            state = sessions.setdefault(session, PixelTracking())
            if request['type'] == 'seed':
                state.seed(request['seeds'])
                continue
            if request['frameId']<=state.frame_id:
                # Parallel HTTP requests can reach the server out of order.
                # A late pixel packet is discarded, never rewinds any tracker.
                print(json.dumps(dict(id=request['id'],frameId=request['frameId'],boxes=[],
                    processingMs=0,discarded=True)),flush=True)
                continue
            started = time.perf_counter()
            jpeg = np.frombuffer(base64.b64decode(request['image'], validate=True), np.uint8)
            frame = cv2.imdecode(jpeg, cv2.IMREAD_COLOR)
            if frame is None or max(frame.shape[:2]) > 960:
                raise ValueError('Invalid tracking image')
            captured_at=request.get('capturedAt')
            boxes = state.update(frame, request['frameId'],None if captured_at is None else captured_at/1000)
            print(json.dumps(dict(id=request['id'], frameId=request['frameId'], boxes=boxes,
                processingMs=(time.perf_counter()-started)*1000)), flush=True)
        except Exception as error:
            print(json.dumps(dict(id=request.get('id'), error=str(error))), flush=True)


if __name__ == '__main__':
    main()
