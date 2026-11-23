"""Track recorded detections on original video frames at native FPS."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from pixel_tracking import PixelTracking
from person_tracking import clip_to_frame


def add_seed(seeds, key, box, frame_id, *, owner=None, reacquire=False):
    fields=('x','y','width','height')
    clipped=clip_to_frame([box[field] for field in fields])
    if clipped is not None:
        seeds.append(dict(key=key,box=dict(zip(fields,clipped)),frameId=frame_id,owner=owner,reacquire=reacquire))


def appearances(path):
    if path is None:
        return {}
    decisions=json.loads(path.read_text(encoding='utf8'))['decisions']
    starts={}
    previous=set()
    for row in decisions:
        visible={item['kind']+':'+item['id'] for item in row['geometry']}
        if entering:=visible-previous:
            starts[row['frame']]=entering
        previous=visible
    return starts


def match_camera_frames(work, recording):
    cap=cv2.VideoCapture(recording['sourcePath']);fps=cap.get(cv2.CAP_PROP_FPS)
    thumbnails=[]
    while True:
        ok,image=cap.read()
        if not ok:break
        thumbnails.append(cv2.resize(image,(128,72),interpolation=cv2.INTER_AREA))
    cap.release();thumbs=np.array(thumbnails,dtype=np.int16)
    events={f['frameId']:f for f in recording['pixelFrames']}
    matches={};last=0;errors=[]
    for row in sorted(recording['pixels'],key=lambda row:row['frameId']):
        if row['start']>recording['endedAt']:continue
        event=events.get(row['frameId'])
        image=cv2.imread(str(work/'pixel_uploads'/f"{row['index']:06d}.jpg"))
        if image is None:continue
        thumb=cv2.resize(image,(128,72),interpolation=cv2.INTER_AREA).astype(np.int16)
        # The displayed camera stream can lag source.play by a few decode ticks.
        near=event['sourceSeconds'] if event else (row['start']-recording['startedAt'])/1000
        start=min(len(thumbs)-1,max(last,int((near-.45)*fps),0));end=min(len(thumbs),max(start+1,int((near+.05)*fps)+1))
        dif=np.abs(thumbs[start:end]-thumb).mean(axis=(1,2,3))
        chosen=start+int(dif.argmin());last=chosen
        matches[row['frameId']]=chosen;errors.append(float(dif.min()))
    # Frame 1 is the still image captured before the source begins playback.
    if recording['pixels']:matches.setdefault(recording['pixels'][0]['frameId'],0)
    stats=dict(matched=len(matches),meanError=float(np.mean(errors)) if errors else None,
        p95Error=float(np.percentile(errors,95)) if errors else None)
    return matches, stats


def prepare(work, source_frames=False, refine_offline=False, appearance_from=None, output=None):
    cv2.setNumThreads(1)
    recording=json.loads((work/'recording.json').read_text(encoding='utf8'))
    matches,stats=({},None) if source_frames else match_camera_frames(work,recording)
    completed=[q for q in recording['requests'] if q.get('status')==200 and q.get('end',float('inf'))<=recording['endedAt']]
    cap=cv2.VideoCapture(recording['sourcePath'],cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    if not cap.isOpened():
        raise RuntimeError('Cannot decode source video')
    fps=cap.get(cv2.CAP_PROP_FPS)
    length=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    if source_frames:
        for q in completed:
            position=q['sourceSeconds']*fps
            frame=round(position)
            if abs(position-frame)>1e-4 or not 0<=frame<length:
                raise ValueError('Offline decisions must reference an original video frame')
            q['frameId']=frame
            matches[frame]=frame
    now=0.;tracker=PixelTracking(clock=lambda:now)
    starts=appearances(appearance_from)
    current=-1;frames=[]
    for index in range(length):
        ok,image=cap.read()
        if not ok:raise RuntimeError('Original frame missing')
        h,w=image.shape[:2];scale=min(1,640/max(h,w))
        now=index/fps
        tracker.update(cv2.resize(image,(round(w*scale),round(h*scale))),index)
        reanchored=[]
        while current+1<len(completed) and completed[current+1]['completedSourceSeconds']<=now+1e-9:
            current+=1;q=completed[current];seeds=[]
            for person in q['data']['tracks']:
                if person['status']!='visible':continue
                for kind,key in [('person','personBox'),('face','faceBox')]:
                    source_id=person.get('geometryFrameIds',{}).get(kind)
                    if source_id not in matches or not person.get(key):continue
                    if kind=='face' and person.get('faceVisibility')=='unavailable':continue
                    label=kind+':'+person['id']
                    owner=person.get('personId')
                    add_seed(seeds,label,person[key],matches[source_id],owner=owner,
                        reacquire=source_frames and matches[source_id]==index and label in starts.get(index,()))
            # Objects are measured on the same immutable AI upload as their request.
            source_id=q.get('frameId')
            if q['data'].get('objects') and source_id is None:
                raise ValueError('Exact object image identity is required; timestamps cannot substitute for frame IDs')
            for obj in q['data'].get('objects',[]):
                if source_id in matches:
                    label='object:'+obj['id']
                    add_seed(seeds,label,obj['box'],matches[source_id],
                        reacquire=source_frames and matches[source_id]==index and label in starts.get(index,()))
            reanchored.extend(tracker.seed(seeds))
        boxes=[dict(key=v['key'],box=v['box']) for v in tracker.boxes.values()]
        frames.append(dict(frame=index,sourceSeconds=now,requestIndex=completed[current]['index'] if current>=0 else None,
            geometry=dict(frameId=index,boxes=boxes,processingMs=0),reanchored=reanchored))
    cap.release()
    if refine_offline:
        from refine_playback_geometry import refine
        frames=[dict(frame=index,sourceSeconds=index/fps,
            requestIndex=completed[current]['index'] if current>=0 else None,
            geometry=dict(frameId=index,boxes=boxes,processingMs=0))
            for index,current,boxes in refine(recording['sourcePath'],length,fps,completed,frames)]
    result=dict(frames=frames,pixelMatching=stats,sourceFrameByCameraFrame=matches,
        geometryRefinedWithLaterAnchors=refine_offline,usesFutureAI=False,replaysPixelTrackingOnly=True,
        livePresentationIsMeasuredSeparately=not source_frames)
    (output or work/'pixel-export.json').write_text(json.dumps(result),encoding='utf8')
    print(json.dumps(dict(pixelFrames=len(frames),matchedInputs=len(matches),pixelMatching=result['pixelMatching'])),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--work',type=Path,required=True)
    p.add_argument('--source-frames',action='store_true')
    p.add_argument('--refine-offline',action='store_true')
    p.add_argument('--appearance-from',type=Path)
    p.add_argument('--output',type=Path)
    args=p.parse_args()
    if args.refine_offline and not args.source_frames:
        p.error('--refine-offline requires --source-frames')
    if args.appearance_from and not args.source_frames:
        p.error('--appearance-from requires --source-frames')
    prepare(args.work,args.source_frames,args.refine_offline,args.appearance_from,args.output)
