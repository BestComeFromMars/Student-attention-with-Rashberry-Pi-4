"""Development comparison on public images; no user camera and no accuracy claim."""
import json,time
from pathlib import Path
import cv2
import numpy as np
from scrfd import SCRFD
from geometry import iou

root=Path(__file__).resolve().parents[1]
models=root/'models/classroom'
cv2.setNumThreads(1)
report={'detectors':[],'trackers':[]}
videos=list((root/'test-fixtures/tracking').glob('*.mov'))
for model in ['scrfd_2.5g.onnx','scrfd_10g.onnx']:
    detector=SCRFD(models/model)
    for video in videos:
        capture=cv2.VideoCapture(str(video));count=0;found=0;times=[];scores=[]
        while count<18:
            ok,frame=capture.read()
            if not ok:break
            count+=1
            ratio=min(1,640/max(frame.shape[:2]));frame=cv2.resize(frame,None,fx=ratio,fy=ratio)
            frame=cv2.copyMakeBorder(frame,0,(-frame.shape[0])%32,0,(-frame.shape[1])%32,cv2.BORDER_CONSTANT)
            start=time.perf_counter();_,rows=detector.detect(frame);times.append((time.perf_counter()-start)*1000)
            found+=int(rows is not None and len(rows)>0)
            scores.append(0 if rows is None or not len(rows) else float(rows[:,-1].max()))
        capture.release()
        report['detectors'].append(dict(model=model,video=video.name,frames=count,found=found,meanMs=float(np.mean(times)),scores=scores))

image=cv2.imread(str(root/'test-fixtures/faces/two-frontal-profile.jpg'))
boxes=[(213,251,193,263),(835,226,175,305)]
for name in ['nano','vit']:
    if name=='nano' and not all((models/file).is_file() for file in ['nanotrack_backbone_sim.onnx','nanotrack_head_sim.onnx']):
        continue  # Optional development comparison, not a production dependency.
    for box in boxes:
        if name=='nano':
            params=cv2.TrackerNano_Params();params.backbone=str(models/'nanotrack_backbone_sim.onnx');params.neckhead=str(models/'nanotrack_head_sim.onnx')
            tracker=cv2.TrackerNano_create(params)
        else:
            params=cv2.TrackerVit_Params();params.net=str(models/'object_tracking_vittrack_2023sep.onnx');tracker=cv2.TrackerVit_create(params)
        tracker.init(image,box);rows=[]
        for step in range(36):
            dx=round(np.sin(step*.32)*150);scale=1+np.sin(step*.2)*.2
            matrix=cv2.getRotationMatrix2D((box[0]+box[2]/2,box[1]+box[3]/2),0,scale);matrix[0,2]+=dx
            frame=cv2.warpAffine(image,matrix,(1280,720),borderValue=(220,220,220))
            expected=[box[0]+box[2]*(1-scale)/2+dx,box[1]+box[3]*(1-scale)/2,box[2]*scale,box[3]*scale]
            started=time.perf_counter();ok,rect=tracker.update(frame);elapsed=(time.perf_counter()-started)*1000
            rows.append(dict(iou=iou(rect,expected),score=float(tracker.getTrackingScore()),ms=elapsed,
                centerError=float(np.hypot(rect[0]+rect[2]/2-expected[0]-expected[2]/2,rect[1]+rect[3]/2-expected[1]-expected[3]/2))))
        report['trackers'].append(dict(name=name,box=box,meanIou=float(np.mean([r['iou'] for r in rows])),
            meanErrorPx=float(np.mean([r['centerError'] for r in rows])),meanMs=float(np.mean([r['ms'] for r in rows])),rows=rows))
out=root.parent/'.qa/pretrained-comparison.json';out.write_text(json.dumps(report,indent=2))
print(json.dumps({key:[{k:v for k,v in row.items() if k not in ('scores','rows')} for row in value] for key,value in report.items()},indent=2))
