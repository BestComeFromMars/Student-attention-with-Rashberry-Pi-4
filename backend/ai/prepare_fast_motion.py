"""Offline public speaking clips + controlled abrupt motion, never a camera."""
from pathlib import Path
import json,sys
import cv2
import numpy as np

root=Path(__file__).resolve().parents[1]
out=root.parent/'.qa/fast-motion'
out.mkdir(parents=True,exist_ok=True)
cv2.setNumThreads(1)
sys.path.insert(0,str(root/'ai'))
from scrfd import SCRFD
reference_detector=SCRFD(root/'models/classroom/scrfd_10g.onnx')

def warped_box(box,matrix):
    x,y,w,h=box
    corners=np.float32([[x,y],[x+w,y],[x,y+h],[x+w,y+h]])
    moved=cv2.transform(corners[None],matrix)[0]
    left,top=moved.min(axis=0);right,bottom=moved.max(axis=0)
    return dict(x=float(left/1280),y=float(top/720),width=float((right-left)/1280),height=float((bottom-top)/720))
cases=[]
for name in ['s22_p_sgbe5s.mov','s22_p_sgbe5s2.mov']:
    capture=cv2.VideoCapture(str(root/'test-fixtures/tracking'/name));frames=[]
    while True:
        ok,frame=capture.read()
        if not ok:break
        frames.append(frame)
    capture.release()
    sampled=[frames[i] for i in np.linspace(0,len(frames)-1,28).astype(int)]
    for mode in ['speaking','abrupt-motion']:
        files=[];expected=[];reference=None
        for index,image in enumerate(sampled):
            h,w=image.shape[:2];scale=min(1.,480/max(h,w))
            image=cv2.resize(image,None,fx=scale,fy=scale);h,w=image.shape[:2]
            canvas=np.full((720,1280,3),220,np.uint8)
            x,y=(1280-w)//2,(720-h)//2
            canvas[y:y+h,x:x+w]=image
            if reference is None:
                small=cv2.resize(canvas,(640,360))
                small=cv2.copyMakeBorder(small,0,24,0,0,cv2.BORDER_CONSTANT)
                _,rows=reference_detector.detect(small)
                if rows is None:raise RuntimeError('No reference face in public speaking clip')
                reference=max(rows,key=lambda row:row[-1])[:4]*2
            matrix=np.float32([[1,0,0],[0,1,0]])
            if mode=='abrupt-motion':
                angle=[0,0,0,0,-28,28,-35,35,0,-25,25,0][index%12]
                dx=[0,0,0,0,-130,130,-100,100,0,-80,80,0][index%12]
                matrix=cv2.getRotationMatrix2D((640,360),angle,1)
                matrix[0,2]+=dx
                canvas=cv2.warpAffine(canvas,matrix,(1280,720),borderValue=(220,220,220))
            filename=Path(name).stem+'-'+mode+'-'+str(index)+'.jpg'
            cv2.imwrite(str(out/filename),canvas,[cv2.IMWRITE_JPEG_QUALITY,90]);files.append(filename)
            expected.append([warped_box(reference,matrix)])
        cases.append(dict(name=Path(name).stem+'-'+mode,files=files,expectedFaces=1,expectedBoxes=expected))
image=cv2.imread(str(root/'test-fixtures/faces/two-frontal-profile.jpg'))
files=[];expected=[]
for index in range(28):
    dx=[0,0,0,0,-90,90,-60,60,0][index%9]
    matrix=np.float32([[1,0,dx],[0,1,0]])
    frame=cv2.warpAffine(image,matrix,(1280,720),borderValue=(220,220,220))
    filename='two-abrupt-'+str(index)+'.jpg';cv2.imwrite(str(out/filename),frame);files.append(filename)
    expected.append([warped_box(box,matrix) for box in [(213,251,193,263),(835,226,175,305)]])
cases.append(dict(name='two-people-abrupt',files=files,expectedFaces=2,expectedBoxes=expected))
blank=np.full((720,1280,3),220,np.uint8);cv2.imwrite(str(out/'blank.jpg'),blank)
(out/'cases.json').write_text(json.dumps(cases,indent=2),encoding='utf8')
print(json.dumps(dict(cases=len(cases),frames=sum(len(case['files']) for case in cases))))
