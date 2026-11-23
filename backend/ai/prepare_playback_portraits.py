"""Crop clean portraits from original frames for the people in the warning history."""
import argparse
import base64
import json
import math
from pathlib import Path

import cv2
import numpy as np


CONTEXT_SIGNALS={'phone','laptop','upper_body_slumped','torso_turned'}


def identity(track):
    owner=track.get('personId')
    if owner is None:
        owner=track.get('geometryId',track['id'])
    return track['id'],owner


def portrait(frame,box,kind='face'):
    height,width=frame.shape[:2]
    if kind=='person':
        x=max(0,math.floor(box['x']*width))
        y=max(0,math.floor(box['y']*height))
        right=min(width,math.ceil((box['x']+box['width'])*width))
        bottom=min(height,math.ceil((box['y']+box['height'])*height))
        crop=frame[y:bottom,x:right]
        scale=160/max(crop.shape[:2])
        w,h=[max(1,round(scale*dimension)) for dimension in (crop.shape[1],crop.shape[0])]
        cropped=np.full((160,160,3),248,dtype=np.uint8)
        left,top=(160-w)//2,(160-h)//2
        cropped[top:top+h,left:left+w]=cv2.resize(crop,(w,h),interpolation=cv2.INTER_AREA if scale<1 else cv2.INTER_CUBIC)
    else:
        dimensions=[box['width']*width,box['height']*height]
        side=round(min(width,height,max(dimensions)*1.2))
        x=round(max(0,min(width-side,(box['x']+box['width']/2)*width-side/2)))
        y=round(max(0,min(height-side,(box['y']+box['height']/2)*height-side/2)))
        cropped=cv2.resize(frame[y:y+side,x:x+side],(160,160),interpolation=cv2.INTER_AREA if side>160 else cv2.INTER_CUBIC)
    ok,jpeg=cv2.imencode('.jpg',cropped,[cv2.IMWRITE_JPEG_QUALITY,86])
    if not ok:
        raise RuntimeError('Could not encode portrait')
    return 'data:image/jpeg;base64,'+base64.b64encode(jpeg).decode('ascii')


def prepare(work):
    recording=json.loads((work/'recording.json').read_text(encoding='utf8'))
    source=json.loads((work/'source-info.json').read_text(encoding='utf8'))
    fps=source['fps']
    frames={round(row['sourceSeconds']*fps):row['sourceSeconds'] for row in recording['requests']}
    pixel_path=work/'pixel-export.json'
    pixel_data=json.loads(pixel_path.read_text(encoding='utf8')) if pixel_path.exists() else {}
    geometry={row['frame']:{entry['key']:entry['box'] for entry in row['geometry']['boxes']}
              for row in pixel_data.get('frames',[]) if row['frame'] in frames}
    events=[]
    last_event={}
    candidates={}
    for row in recording['requests']:
        at=row['sourceSeconds']
        for track in row['data']['tracks']:
            if track['status']!='visible':
                continue
            key=identity(track)
            alerts={alert['type'] for alert in track.get('alerts',[]) if not alert['held']}
            action=track.get('actionAlert')
            signature=(frozenset(alerts),action['type'] if action else None)
            if track.get('attention')=='needs_attention' and (alerts or action):
                if last_event.get(key)!=signature:
                    index=round(at*fps)
                    body=geometry.get(index,{}).get('person:'+track['id'])
                    body_frame=track.get('geometryFrameIds',{}).get('person')
                    if body:
                        body_frame=index
                    elif body_frame in frames and frames[body_frame]<=at:
                        body=track.get('personBox')
                    events.append((key,at,bool(alerts&CONTEXT_SIGNALS or action),body_frame,body))
                last_event[key]=signature
            elif not any(alert['held'] for alert in track.get('alerts',[])):
                last_event.pop(key,None)
            box=track.get('faceBox')
            frame_id=track.get('geometryFrameIds',{}).get('face')
            observation=track.get('observation') or {}
            face_size=0 if not box else min(box['width']*source['width'],box['height']*source['height'])
            if (track.get('faceVisibility')!='visible' or track.get('trackingState') not in ('face','visual') or
                    frame_id not in frames or frames[frame_id]>at or face_size<16 or
                    (observation.get('quality') or {}).get('usable') is False):
                continue
            yaw=abs(observation.get('yawDeg') or 0)
            pitch=abs(observation.get('pitchDeg') or 0)
            score=face_size/(1+(yaw+pitch)/70)
            candidates.setdefault(key,[]).append((at,score,frame_id,box))

    selected={}
    for key,alert_at,wants_body,body_frame,body in events:
        faces=candidates.get(key,[])
        prior=[face for face in faces if face[0]<=alert_at]
        if body and (wants_body or not prior):
            selected.setdefault(body_frame,[]).append((key,body,alert_at,alert_at,'person',wants_body))
        if (wants_body and body) or not faces:
            continue
        available_at,_,frame_id,box=max(prior,key=lambda face:(face[1],face[0])) if prior else faces[0]
        selected.setdefault(frame_id,[]).append((key,box,max(alert_at,available_at),alert_at,'face',True))

    cap=cv2.VideoCapture(recording['sourcePath'],cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    if not cap.isOpened():
        raise RuntimeError('Could not open the original video')
    result=[]
    try:
        current=-1
        for frame_id in sorted(selected):
            while current<frame_id:
                if not cap.grab():
                    raise RuntimeError('Could not reach a recorded portrait frame')
                current+=1
            ok,frame=cap.retrieve()
            if not ok:
                raise RuntimeError('Could not decode a recorded portrait frame')
            for (track_id,owner),box,at,warning_at,kind,preferred in selected[frame_id]:
                result.append(dict(trackId=track_id,owner=owner,at=at,captured=frames[frame_id],
                    warningAt=warning_at,kind=kind,preferred=preferred,photo=portrait(frame,box,kind)))
    finally:
        cap.release()
    (work/'portraits.json').write_text(json.dumps(result),encoding='utf8')
    print(f'Original-frame evidence: {len(result)} photos for {len(events)} warning changes',flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--work',type=Path,required=True)
    prepare(parser.parse_args().work)
