"""Current-frame YuNet / SCRFD-500M recovery of SCRFD/mesh-verified faces.

This is an extra detector, not optical-flow prediction or new identity proof.
Small/dense classroom faces keep the detailed detector + native tracker path.
"""
from pathlib import Path
import time
import cv2
import numpy as np
from scrfd import plausible_points,SCRFD


def overlap(a,b):
    x,y=max(a[0],b[0]),max(a[1],b[1])
    area=max(0,min(a[0]+a[2],b[0]+b[2])-x)*max(0,min(a[1]+a[3],b[1]+b[3])-y)
    return area/max(1e-9,a[2]*a[3]+b[2]*b[3]-area)


def associate(tracks,detections,now):
    """One-to-one, bounded geometry; ambiguous/crossed heads need full rescans."""
    pairs=[]
    for ti,track in enumerate(tracks):
        verified=track.get('verifiedAt',track['seen'] if track.get('detectorVerified') else -10000)
        if not 0<=now-verified<=1600:continue
        a=track['box']
        for di,detection in enumerate(detections):
            b=detection['box']
            if not .4<=b[2]*b[3]/max(1e-9,a[2]*a[3])<=2.5:continue
            distance=np.hypot((a[0]+a[2]/2-b[0]-b[2]/2)/max(a[2],b[2]),
                              (a[1]+a[3]/2-b[1]-b[3]/2)/max(a[3],b[3]))
            # A frame may jump by more than one head width at low camera FPS.
            # Larger recovery is allowed only when there is one possible owner.
            limit=3.5 if len(tracks)==1 else 1.5
            absolute=np.hypot(a[0]+a[2]/2-b[0]-b[2]/2,a[1]+a[3]/2-b[1]-b[3]/2)
            if distance<=limit and absolute<=.35:pairs.append((float(distance+1-overlap(a,b)),ti,di))
    result={};used=set()
    for cost,ti,di in sorted(pairs):
        if ti in result or di in used:continue
        # Two plausible owners with nearly the same cost must not trade IDs.
        if any(other_ti!=ti and other_di==di and abs(other_cost-cost)<.2
               for other_cost,other_ti,other_di in pairs):continue
        result[ti]=di;used.add(di)
    return result


class FastFaceTracking:
    def __init__(self,model_path,strong=None):
        self.strong=strong
        quick_path=Path(model_path).with_name('scrfd_500m.onnx')
        self.quick=SCRFD(quick_path) if strong is not None and quick_path.is_file() else None
        self.model=cv2.FaceDetectorYN.create(str(Path(model_path).with_name('face_detection_yunet_2023mar.onnx')),
                                            '',(320,320),.85,.3,1000)

    def detect(self,frame,tracks,angle=0):
        h,w=frame.shape[:2]
        edge=320 if all(t['box'][2]*w>=120 for t in tracks) else 480
        scale=min(1.,edge/max(h,w));image=cv2.resize(frame,None,fx=scale,fy=scale) if scale<1 else frame
        ih,iw=image.shape[:2]
        matrix=cv2.getRotationMatrix2D((iw/2,ih/2),angle,1)
        if angle:
            cosine,sine=abs(matrix[0,0]),abs(matrix[0,1])
            rw,rh=int(np.ceil(iw*cosine+ih*sine)),int(np.ceil(ih*cosine+iw*sine))
            matrix[:,2]+=np.array([(rw-iw)/2,(rh-ih)/2])
            image=cv2.warpAffine(image,matrix,(rw,rh),borderValue=(110,110,110))
        inverse=cv2.invertAffineTransform(matrix)
        self.model.setInputSize((image.shape[1],image.shape[0]));_,rows=self.model.detect(image)
        detections=[]
        for row in [] if rows is None else rows:
            if row[-1]<.85 or not plausible_points(row):continue
            x,y,bw,bh=row[:4]
            points=np.array([[x,y],[x+bw,y],[x,y+bh],[x+bw,y+bh]],np.float32)
            points=cv2.transform(points[None],inverse)[0]/scale
            left,top=points.min(axis=0);right,bottom=points.max(axis=0)
            if right<=0 or bottom<=0 or left>=w or top>=h:continue
            x,y=max(0.,left),max(0.,top)
            bw,bh=min(w,right)-x,min(h,bottom)-y
            if bw<20 or bh<20:continue
            box=[max(0.,float(x/w)),max(0.,float(y/h)),min(1.,float(bw/w)),min(1.,float(bh/h))]
            anchors=cv2.transform(row[4:14].reshape(1,5,2),inverse)[0]/scale
            detections.append(dict(box=box,anchors=anchors.tolist(),score=float(row[-1]),
                relativeAnchors=((anchors-np.array([x,y]))/np.array([bw,bh])).tolist()))
        return detections

    def update(self,frame,tracks,now,rotate=False):
        if not 0<len(tracks)<=8:return set()
        # A small face in the background must not disable fast recovery of a
        # large face in front. Small faces continue on the detailed/native path.
        tracks=[t for t in tracks if t['box'][2]*frame.shape[1]>=80]
        if not tracks:return set()
        if not any(0<=now-t.get('verifiedAt',t['seen'] if t.get('detectorVerified') else -10000)<=1600 for t in tracks):return set()
        started=time.perf_counter()
        detections=self.detect(frame,tracks);matched=associate(tracks,detections,now);found=set()
        # Roll is not yaw. Retry the existing detector on rotated images only
        # when its upright pass missed an established face; map all geometry
        # back to the ORIGINAL current image before associating it.
        if rotate and len(matched)<len(tracks) and self.strong is not None:
            # A lightweight pretrained SCRFD searches only the known head's
            # enlarged region. Its lower tracking threshold cannot create a
            # new identity or renew verification from SCRFD-10G/landmarks.
            h,w=frame.shape[:2]
            detector=self.quick if self.quick is not None else self.strong
            threshold=.60 if self.quick is not None else .75
            for ti,track in enumerate(tracks):
                if time.perf_counter()-started>=.085:break
                if ti in matched or len(tracks)>4:continue
                x,y,bw,bh=track['box'];cx,cy=(x+bw/2)*w,(y+bh/2)*h
                side=max(240.,5*max(bw*w,bh*h))
                left,top=max(0,int(cx-side/2)),max(0,int(cy-side/2))
                right,bottom=min(w,int(cx+side/2)),min(h,int(cy+side/2))
                crop=frame[top:bottom,left:right]
                if not crop.size:continue
                scale=min(1.,320/max(crop.shape[:2]));image=cv2.resize(crop,None,fx=scale,fy=scale) if scale<1 else crop
                ih,iw=image.shape[:2]
                angles=(0,-30,30) if self.quick is not None else (0,)
                panels=[];inverses=[]
                for angle in angles:
                    matrix=cv2.getRotationMatrix2D((iw/2,ih/2),angle,1)
                    rotated=cv2.warpAffine(image,matrix,(iw,ih),borderValue=(110,110,110)) if angle else image
                    panels.append(cv2.copyMakeBorder(rotated,0,(-ih)%32,0,(-iw)%32,cv2.BORDER_CONSTANT))
                    inverses.append(cv2.invertAffineTransform(matrix))
                # One forward pass covers all rolls. A busy CPU must not use
                # up the budget before reaching the opposite turn direction.
                panel_width=panels[0].shape[1]
                _,rows=detector.detect(np.concatenate(panels,axis=1))
                for original in [] if rows is None else rows:
                    if original[-1]<threshold or not np.isfinite(original).all():continue
                    panel=int((original[0]+original[2]/2)//panel_width)
                    if not 0<=panel<len(inverses):continue
                    row=original.copy();row[0]-=panel*panel_width;row[4:14:2]-=panel*panel_width
                    rx,ry,rw,rh=row[:4]
                    if rx<0 or rx+rw>panel_width:continue
                    inverse=inverses[panel]
                    points=np.float32([[rx,ry],[rx+rw,ry],[rx,ry+rh],[rx+rw,ry+rh]])
                    points=cv2.transform(points[None],inverse)[0]/scale+np.array([left,top])
                    x,y=points.min(axis=0);right_box,bottom_box=points.max(axis=0)
                    bw,bh=right_box-x,bottom_box-y
                    if bw<20 or bh<20:continue
                    anchors=cv2.transform(row[4:14].reshape(1,5,2),inverse)[0]/scale+np.array([left,top])
                    detection=dict(box=[float(x/w),float(y/h),float(bw/w),float(bh/h)],
                        anchors=anchors.tolist(),score=float(row[-1]),strong=self.quick is None,
                        model='SCRFD-500M' if self.quick is not None else 'SCRFD-10G',
                        relativeAnchors=((anchors-np.array([x,y]))/np.array([bw,bh])).tolist())
                    if not associate(tracks,[detection],now):continue
                    if any(overlap(d['box'],detection['box'])>=.3 and d['score']>=detection['score'] and
                           associate(tracks,[d],now) for d in detections):continue
                    detections=[d for d in detections if overlap(d['box'],detection['box'])<.3]
                    detections.append(detection)
            matched=associate(tracks,detections,now)
        if rotate and len(matched)<len(tracks) and len(tracks)<=4:
            for angle in (-30,30):
                if time.perf_counter()-started>=.085:break
                for detection in self.detect(frame,tracks,angle):
                    if all(overlap(detection['box'],other['box'])<.3 for other in detections):detections.append(detection)
                matched=associate(tracks,detections,now)
                if len(matched)==len(tracks):break
        for ti,di in matched.items():
            track=tracks[ti];detection=detections[di]
            track.update(box=list(detection['box']),anchors=detection['anchors'],relativeAnchors=detection['relativeAnchors'],
                fastFaceAt=now,fastFaceScore=detection['score'],fastFaceModel=detection.get('model','YuNet'),visualAt=now)
            track.pop('visualLostAt',None);found.add(track['id'])
            if detection.get('strong'):
                track.update(seen=now,verifiedAt=now,score=detection['score'],scrfdScore=detection['score'],
                    detectorVerified=True,detectorModel='SCRFD-10G',evidenceMode='scrfd',missedScans=0,
                    detectionHits=track.get('detectionHits',0)+1)
                track.pop('missedAt',None)
        return found
