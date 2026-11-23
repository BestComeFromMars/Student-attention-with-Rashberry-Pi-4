"""Rasterize corrected offline boxes with bounded memory and no browser."""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


LABELS={'upper_body_slumped':'Gục người','eyes_closed':'Nhắm mắt','phone':'Điện thoại',
        'head_down':'Cúi đầu','yawn':'Ngáp','talking':'Nói chuyện','laptop':'Laptop',
        'head_turning':'Quay đầu','head_turned':'Quay ngang','torso_turned':'Quay thân',
        'turned_smiling':'Quay / cười'}
OBJECTS={'phone':'Điện thoại','book':'Sách/vở','laptop':'Laptop'}


def caption(track):
    alerts=sorted(track.get('alerts',[]),key=lambda alert:(alert['type']!='upper_body_slumped',alert['held']))
    action=track.get('actionAlert')
    warning=bool(alerts or action or track.get('attention')=='needs_attention')
    if alerts:
        short=LABELS.get(alerts[0]['type'],alerts[0]['label'])
    elif action:
        short='Gục người' if action['type']=='slumped_on_desk' else action['label']
    else:
        short='Chú ý' if warning else 'Sách/vở' if track.get('studyContext')=='book' else ''
    return track['id']+(f' · {short}' if short else ''),warning


def bgr(color):
    return tuple(int(color[offset:offset+2],16) for offset in (5,3,1))


def label_patch(text,color,warning,font):
    width=round(font.getlength(text))+14
    image=Image.new('RGB',(width,24),'#7f1d1d' if warning else '#0f172a')
    draw=ImageDraw.Draw(image)
    draw.rectangle((0,0,width-1,23),outline=color)
    draw.text((7,4),text,font=font,fill='#f8fafc')
    return np.asarray(image)[:,:,::-1]


def covered(box,visible):
    overlap_x=max(0,min(box['x']+box['width'],visible['x']+visible['width'])-max(box['x'],visible['x']))
    overlap_y=max(0,min(box['y']+box['height'],visible['y']+visible['height'])-max(box['y'],visible['y']))
    return overlap_x*overlap_y>=.75*box['width']*box['height']


def render(work):
    cv2.setNumThreads(1)
    def load(name):
        return json.loads((work/name).read_text(encoding='utf8'))
    source=load('source-info.json')
    width,height=source['width'],source['height']
    geometry=load('pixel-export.json')
    recording=load('recording.json')
    rows={row['index']:row['data'] for row in recording['requests']}
    fonts=('C:/Windows/Fonts/segoeuib.ttf','/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
    font=next((ImageFont.truetype(path,14) for path in fonts if Path(path).exists()),None)
    if font is None:
        font=ImageFont.load_default(size=14)
    cap=cv2.VideoCapture(recording['sourcePath'],cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    if not cap.isOpened():
        raise RuntimeError('Cannot open original video')
    raw=(work/'annotated.bgr').open('wb')
    decisions=[]
    patches={}
    lost_overlap={}
    suppressed=set()
    for frame in geometry['frames']:
        index=frame['frame']
        row=rows.get(frame['requestIndex'],{})
        tracks={track['id']:track for track in row.get('tracks',[]) if track.get('trackingState')!='predicted'}
        objects={obj['id']:obj for obj in row.get('objects',[])}
        boxes=frame['geometry']['boxes']
        bodies_by_id={box['key'].split(':',1)[1]:box['box'] for box in boxes if box['key'].startswith('person:')}
        visible_bodies=[box for identity,box in bodies_by_id.items()
                        if tracks.get(identity,{}).get('status')=='visible']
        suppressed.difference_update(identity for identity,track in tracks.items() if track['status']=='visible')
        next_overlap={}
        for identity,box in bodies_by_id.items():
            if identity in suppressed or tracks.get(identity,{}).get('status')!='lost':
                continue
            previous=lost_overlap.get(identity,0)
            # A lost track can continue briefly on pixels, but must release
            # its box once it settles on another currently measured person.
            count=previous+1 if any(covered(box,other) for other in visible_bodies) else 0
            if count>=3:
                suppressed.add(identity)
            next_overlap[identity]=count
        lost_overlap=next_overlap
        bodies=bodies_by_id.keys()
        ok,image=cap.read()
        if not ok or image.shape[:2]!=(height,width):
            raise RuntimeError(f'Cannot read source frame {index}')
        labels=[]
        shown=[]
        for entry in boxes:
            kind,identity=entry['key'].split(':',1)
            box=entry['box']
            left,top=round(box['x']*width),round(box['y']*height)
            right,bottom=round((box['x']+box['width'])*width),round((box['y']+box['height'])*height)
            if kind=='object':
                obj=objects.get(identity)
                if obj is None:
                    continue
                label=f"{identity} · {OBJECTS[obj['kind']]}"
                owner=tracks.get(obj.get('ownerId'),{})
                warning=obj.get('interaction') is not False and any(signal['type']==obj['kind'] and
                    signal['state']=='confirmed' for signal in owner.get('signals',[]))
                color='#ef4444' if warning else '#2dd4bf' if obj['kind']=='book' and obj.get('interaction') is not False else '#fbbf24'
            else:
                track=tracks.get(identity)
                if track is None or identity in suppressed:
                    continue
                label,warning=caption(track)
                color='#ef4444' if warning else '#38bdf8' if kind=='person' else '#22c55e'
            cv2.rectangle(image,(left,top),(right,bottom),bgr(color),2,cv2.LINE_AA)
            shown.append(dict(kind=kind,id=identity,box=box))
            if kind!='face' or identity not in bodies:
                key=(label,color,warning)
                if key not in patches:
                    patches[key]=label_patch(label,color,warning,font)
                patch=patches[key]
                text_width=patch.shape[1]
                x=max(0,min(right-text_width,width-text_width))
                y=max(0,min(top-24 if top>=24 else top,height-24))
                labels.append((warning,x,y,patch))
        for _,x,y,patch in sorted(labels,key=lambda item:item[0]):
            image[y:y+24,x:x+patch.shape[1]]=patch[:,:max(0,width-x)]
        raw.write(memoryview(image))
        if index in (0,source['frames']//2,source['frames']-1):
            suffix={0:'dau',source['frames']//2:'giua',source['frames']-1:'cuoi'}[index]
            cv2.imwrite(str(work/f"{Path(recording['sourcePath']).stem}_{suffix}_video.jpg"),image)
        decisions.append(dict(frame=index,sourceSeconds=frame['sourceSeconds'],requestIndex=frame['requestIndex'],
            geometry=shown))
        if index%100==0 or index+1==source['frames']:
            print(f'Source frame overlays: {index+1}/{source["frames"]}',flush=True)
    raw.close()
    cap.release()
    (work/'decision-overlays.json').write_text(json.dumps(dict(decisions=decisions,overlayStride=1,
        currentFramePixels=True,geometryRefinedWithLaterAnchors=geometry.get('geometryRefinedWithLaterAnchors',False),
        causalCompletedResultsOnly=True,captionsPinnedAtEverySourceFrame=True)),encoding='utf8')


if __name__=='__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--work',type=Path,required=True)
    render(parser.parse_args().work)
