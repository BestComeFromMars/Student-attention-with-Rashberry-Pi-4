"""After unattended playback: replay ONLY pixel tracking at native source FPS.

Semantic decisions are the actual completed live API responses, never new AI
inference or ground-truth annotations. Each exported frame gets geometry measured
on that exact original frame. This does not claim to be a live screencast.
"""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np
from pixel_tracking import PixelTracking


def prepare(work):
    cv2.setNumThreads(1)
    recording=json.loads((work/'recording.json').read_text(encoding='utf8'))
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
    completed=[q for q in recording['requests'] if q.get('status')==200 and q.get('end',float('inf'))<=recording['endedAt']]
    cap=cv2.VideoCapture(recording['sourcePath']);now=0.;tracker=PixelTracking(clock=lambda:now)
    current=-1;frames=[]
    for index in range(len(thumbs)):
        ok,image=cap.read()
        if not ok:raise RuntimeError('Original frame missing')
        h,w=image.shape[:2];scale=min(1,640/max(h,w))
        now=index/fps
        tracker.update(cv2.resize(image,(round(w*scale),round(h*scale))),index)
        while current+1<len(completed) and completed[current+1]['completedSourceSeconds']<=now+1e-9:
            current+=1;q=completed[current];seeds=[]
            for person in q['data']['tracks']:
                if person['status']!='visible':continue
                for kind,key in [('person','personBox'),('face','faceBox')]:
                    source_id=person.get('geometryFrameIds',{}).get(kind)
                    if source_id not in matches or not person.get(key):continue
                    if kind=='face' and person.get('faceVisibility')=='unavailable':continue
                    seeds.append(dict(key=kind+':'+person['id'],box=person[key],frameId=matches[source_id]))
            # Objects are measured on the same immutable AI upload as their request.
            source_id=q.get('frameId')
            if q['data'].get('objects') and source_id is None:
                raise ValueError('Exact object image identity is required; timestamps cannot substitute for frame IDs')
            for obj in q['data'].get('objects',[]):
                if source_id in matches:seeds.append(dict(key='object:'+obj['id'],box=obj['box'],frameId=matches[source_id]))
            tracker.seed(seeds)
        boxes=[dict(key=v['key'],box=v['box']) for v in tracker.boxes.values()]
        frames.append(dict(frame=index,sourceSeconds=now,requestIndex=completed[current]['index'] if current>=0 else None,
            geometry=dict(frameId=index,boxes=boxes,processingMs=0)))
    cap.release()
    result=dict(frames=frames,pixelMatching=dict(matched=len(matches),meanError=float(np.mean(errors)),
        p95Error=float(np.percentile(errors,95))),sourceFrameByCameraFrame=matches,
        usesFutureAI=False,replaysPixelTrackingOnly=True,livePresentationIsMeasuredSeparately=True)
    (work/'pixel-export.json').write_text(json.dumps(result),encoding='utf8')
    print(json.dumps(dict(pixelFrames=len(frames),matchedInputs=len(matches),pixelMatching=result['pixelMatching'])),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--work',type=Path,required=True);args=p.parse_args();prepare(args.work)
