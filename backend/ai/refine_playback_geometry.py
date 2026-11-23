"""Refine recorded boxes using the source pixels on both sides of each sample."""
from bisect import bisect_left
from collections import defaultdict
import math

import cv2

from person_tracking import clip_to_frame
from pixel_tracking import PixelTracking


FIELDS=('x','y','width','height')
MAX_BRIDGE_SECONDS=1.2


def track_key(kind,track):
    owner=track.get('personId')
    if owner is None:
        owner=track.get('geometryId',track['id'])
    return f"{kind}:{track['id']}#{owner}"


def collect_anchors(decisions,fps):
    sampled_frames={round(row['sourceSeconds']*fps) for row in decisions}
    anchors=defaultdict(dict)
    allowed=[]
    for row in decisions:
        index=round(row['sourceSeconds']*fps)
        keys={}
        for track in row['data']['tracks']:
            if track.get('trackingState')=='predicted':
                continue
            for kind,field in (('person','personBox'),('face','faceBox')):
                key=track_key(kind,track)
                keys[key]=kind+':'+track['id']
                source=track.get('geometryFrameIds',{}).get(kind)
                if (track['status']!='visible' or source not in sampled_frames or source>index or
                        not track.get(field) or kind=='face' and track.get('faceVisibility')=='unavailable'):
                    continue
                clipped=clip_to_frame([track[field][f] for f in FIELDS])
                if clipped is not None:
                    anchors[key].setdefault(source,dict(zip(FIELDS,clipped)))
        for obj in row['data'].get('objects',[]):
            key='object:'+obj['id']
            keys[key]=key
            anchors[key][index]=obj['box']
        allowed.append(keys)
    return anchors,allowed


def video_frames(source,length,reverse=False):
    cap=cv2.VideoCapture(source,cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    if not cap.isOpened():
        raise RuntimeError('Cannot open the original video')
    try:
        if not reverse:
            for index in range(length):
                ok,frame=cap.read()
                if not ok:
                    raise RuntimeError(f'Missing source frame {index}')
                yield index,tracking_size(frame)
            return
        for end in range(length,0,-48):
            start=max(0,end-48)
            if not cap.set(cv2.CAP_PROP_POS_FRAMES,start):
                raise RuntimeError(f'Cannot seek to source frame {start}')
            window=[]
            for index in range(start,end):
                ok,frame=cap.read()
                if not ok:
                    raise RuntimeError(f'Missing source frame {index}')
                window.append((index,tracking_size(frame)))
            yield from reversed(window)
    finally:
        cap.release()


def tracking_size(frame):
    height,width=frame.shape[:2]
    scale=min(1,864/max(height,width))
    return cv2.resize(frame,(round(width*scale),round(height*scale)),interpolation=cv2.INTER_AREA)


def flow(source,length,fps,anchors,reverse=False):
    seeds=defaultdict(list)
    for key,by_frame in anchors.items():
        for frame,box in by_frame.items():
            seeds[frame].append((key,box))
    step=0
    tracker=PixelTracking(clock=lambda:step/fps)
    for step,(frame,image) in enumerate(video_frames(source,length,reverse)):
        tracker.update(image,step)
        current=[]
        for key,box in seeds.get(frame,[]):
            # Each measured rectangle is an endpoint. The two tracked paths
            # are blended between endpoints instead of changing the target in place.
            tracker.boxes.pop(key,None)
            current.append(dict(key=key,box=box,frameId=step))
        tracker.seed(current)
        yield frame,{key:item['box'] for key,item in tracker.boxes.items() if item['failed']==0}


def representation(box):
    return (box['x']+box['width']/2,box['y']+box['height']/2,math.log(box['width']),math.log(box['height']))


def box_of(values):
    x,y,w,h=values
    w,h=math.exp(w),math.exp(h)
    return dict(x=max(0,min(1-w,x-w/2)),y=max(0,min(1-h,y-h/2)),width=w,height=h)


def bounded_motion(reference,measured):
    if measured is None:
        return reference
    limits=(.2*math.exp(reference[2]),.2*math.exp(reference[3]),.15,.15)
    return tuple(value+max(-limit,min(limit,target-value))
                 for value,target,limit in zip(reference,representation(measured),limits))


def between(frame,stamps,anchors,forward,backward,fps):
    after=bisect_left(stamps,frame)
    if after<len(stamps) and stamps[after]==frame:
        return representation(anchors[frame])
    left=stamps[after-1] if after else None
    right=stamps[after] if after<len(stamps) else None
    if left is not None and right is not None and forward and right-left<=MAX_BRIDGE_SECONDS*fps:
        a,b=representation(anchors[left]),representation(anchors[right])
        t=(frame-left)/(right-left)
        base=tuple(x+(y-x)*t for x,y in zip(a,b))
        moved_from_left=bounded_motion(base,forward)
        moved_from_right=bounded_motion(base,backward)
        return tuple(x+(y-x)*t for x,y in zip(moved_from_left,moved_from_right))
    if left is not None and frame-left<=.5*fps and forward:
        return representation(forward)
    return None


def fuse(causal,candidate):
    if causal is None:
        return candidate
    reference=representation(causal)
    adjusted=bounded_motion(reference,box_of(candidate)) if candidate is not None else reference
    return tuple(a+.7*(b-a) for a,b in zip(reference,adjusted))


def smooth_frames(frames):
    for frame,values in enumerate(frames):
        result={}
        for key,value in values.items():
            samples=[(5,value)]
            for offset in (1,2,3,4):
                before,after=frame-offset,frame+offset
                if before<0 or after>=len(frames) or key not in frames[before] or key not in frames[after]:
                    break
                samples.extend(((5-offset,frames[before][key]),(5-offset,frames[after][key])))
            total=sum(weight for weight,_ in samples)
            coordinates=[sum(weight*sample[axis] for weight,sample in samples)/total for axis in range(4)]
            result[key]=box_of(coordinates)
        yield result


def refine(source,length,fps,decisions,baseline):
    anchors,allowed=collect_anchors(decisions,fps)
    stamps={key:sorted(entries) for key,entries in anchors.items()}
    forward=dict(flow(source,length,fps,anchors))
    indices=[round(row['completedSourceSeconds']*fps) for row in decisions]
    by_frame=[{} for _ in range(length)]
    current=len(indices)-1
    for frame,backward in flow(source,length,fps,anchors,reverse=True):
        while current>=0 and indices[current]>frame:
            current-=1
        if current<0:
            continue
        causal={entry['key']:entry['box'] for entry in baseline[frame]['geometry']['boxes']}
        for key,public_key in allowed[current].items():
            value=None
            if key in anchors:
                value=between(frame,stamps[key],anchors[key],forward[frame].get(key),backward.get(key),fps)
            value=fuse(causal.get(public_key),value)
            if value is not None:
                by_frame[frame][key]=value
    current=-1
    for frame,values in enumerate(smooth_frames(by_frame)):
        while current+1<len(indices) and indices[current+1]<=frame:
            current+=1
        boxes=[dict(key=allowed[current][key],box=box) for key,box in values.items()]
        yield frame,current,boxes
