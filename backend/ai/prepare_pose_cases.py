"""Public Sheffield front/profile video -> deterministic JPEG motion cases."""
from pathlib import Path
import json,hashlib
import cv2
import numpy as np

root=Path(__file__).resolve().parents[1]
out=root.parent/'.qa/pose-cases'
out.mkdir(parents=True,exist_ok=True)
cases=[]
for video in sorted((root/'test-fixtures/tracking').glob('*.mov')):
    capture=cv2.VideoCapture(str(video));frames=[]
    while True:
        ok,frame=capture.read()
        if not ok:break
        frames.append(frame)
    capture.release()
    sampled=[frames[index] for index in np.linspace(0,len(frames)-1,16).astype(int)]
    for mode in ['native','fast-tilt']:
        names=[]
        for step,frame in enumerate(sampled):
            if mode=='fast-tilt':
                # Actual side view comes from the video, not a perspective
                # imitation. Added 2D tilt and translation stress the tracker.
                h,w=frame.shape[:2]
                scale=min(1,400/max(h,w));frame=cv2.resize(frame,None,fx=scale,fy=scale)
                h,w=frame.shape[:2]
                matrix=cv2.getRotationMatrix2D((w/2,h/2),np.sin(step*.45)*25,1+np.sin(step*.35)*.12)
                frame=cv2.warpAffine(frame,matrix,(w,h),borderValue=(220,220,220))
                background=np.full((720,1280,3),220,np.uint8)
                left=round(440+np.sin(step*.42)*190);top=(720-h)//2
                background[top:top+h,left:left+w]=frame;frame=background
            name=video.stem+'-'+mode+'-'+str(step)+'.jpg'
            cv2.imwrite(str(out/name),frame,[cv2.IMWRITE_JPEG_QUALITY,90]);names.append(name)
        cases.append(dict(name=video.stem,mode=mode,files=names,sourceSha256=hashlib.sha256(video.read_bytes()).hexdigest()))
(out/'cases.json').write_text(json.dumps(cases,indent=2))
print(json.dumps(dict(cases=len(cases),frames=sum(len(case['files']) for case in cases))))
