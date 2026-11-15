"""Bounded scene/crop detections for a latency-sensitive camera host.

All coordinates remain measurements of the supplied original image. Crops
improve model sampling, not source detail. No detector runs on the video clock.
"""
import numpy as np

TARGETS=[63,67,73]


def overlap(a,b):
    inter=max(0,min(a[2],b[2])-max(a[0],b[0]))*max(0,min(a[3],b[3])-max(a[1],b[1]))
    area=lambda v:max(0,v[2]-v[0])*max(0,v[3]-v[1])
    return inter/max(1e-9,area(a)+area(b)-inter)


class SceneObjects:
    def __init__(self,primary,device='cpu'):
        self.primary,self.device=primary,device
        self.rejected_laptops=0

    def detect(self,model,image):
        result=model.predict(image,imgsz=640,classes=TARGETS,conf=.2,device=self.device,verbose=False)[0]
        return result.boxes.data.cpu().numpy().astype(float).tolist()

    def predict(self,frame,cursor=0):
        h,w=frame.shape[:2];full=self.detect(self.primary,frame);rows=list(full)
        tile=None
        if min(h,w)>=240:
            # One overlapping tile per scene update; a complete pass takes four
            # updates, without making a frame wait for an unbounded crop queue.
            x=int(w*.4)*(cursor%2);y=int(h*.4)*((cursor//2)%2)
            tile=(x,y,min(w,x+int(w*.6)),min(h,y+int(h*.6)))
            a,b,c,d=tile
            for raw in self.detect(self.primary,frame[b:d,a:c]):
                raw=np.asarray(raw);raw[[0,2]]+=a;raw[[1,3]]+=b;row=raw.tolist()
                cut=(a>0 and row[0]<=a+2 or b>0 and row[1]<=b+2 or
                    c<w and row[2]>=c-2 or d<h and row[3]>=d-2)
                if not cut or any(int(old[5])==int(row[5]) and overlap(old,row)>=.3 for old in full):rows.append(row)
        # Flat paper/book regions often receive moderate laptop scores. Do not
        # promote those to a laptop class (or interaction); retain actual scores.
        # Other small objects keep their detector threshold. The bounded two
        # calls above must not become a chain of heavy synchronous verifiers.
        self.rejected_laptops+=sum(int(r[5])==63 and r[4]<.65 for r in rows)
        rows=[r for r in rows if int(r[5])!=63 or r[4]>=.65]
        kept=[]
        for row in sorted(rows,key=lambda r:r[4],reverse=True):
            if row[2]<=row[0] or row[3]<=row[1]:continue
            if any((int(row[5])==int(old[5]) or {int(row[5]),int(old[5])}=={63,73}) and overlap(row,old)>.55 for old in kept):continue
            kept.append(row)
        return np.asarray(kept,dtype=np.float32).reshape(-1,6)
