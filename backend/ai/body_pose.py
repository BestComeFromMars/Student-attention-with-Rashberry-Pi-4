"""Small timestamped pose records, matched uniquely to existing person identities."""
import math
import numpy as np
from geometry import iou


def pack_pose(box, points, confidence, width, height, at):
    points=np.asarray(points,dtype=float)
    if points.shape!=(17,3) or not np.isfinite(points).all() or not math.isfinite(float(confidence)):
        return None
    normalized=[]
    for x,y,score in points:
        visible=0<=x<=width and 0<=y<=height
        normalized.append(dict(x=float(np.clip(x/width,0,1)),y=float(np.clip(y/height,0,1)),
            confidence=float(np.clip(score,0,1)) if visible else 0.))
    x1,y1,x2,y2=map(float,box)
    return dict(box=dict(x=x1/width,y=y1/height,width=(x2-x1)/width,height=(y2-y1)/height),
        keypoints=normalized,confidence=float(np.clip(confidence,0,1)),aspectRatio=width/height,
        observedAt=at,source='YOLO11n-pose')


def match_poses(bodies,poses,now):
    pairs=[]
    for index,pose in enumerate(poses):
        if not 0<=now-pose['observedAt']<=2000:continue
        box=[pose['box'][key] for key in ('x','y','width','height')]
        for body in bodies:
            score=iou(body['box'],box)
            if score>.3:pairs.append((score,body['id'],index))
    used_people=set();used_poses=set();result={}
    for score,identity,index in sorted(pairs,reverse=True):
        if identity in used_people or index in used_poses:continue
        if any(other>=score-.05 and ((person!=identity and pose==index) or
            (person==identity and pose!=index)) for other,person,pose in pairs):continue
        used_people.add(identity);used_poses.add(index);result[identity]=poses[index]
    return result
