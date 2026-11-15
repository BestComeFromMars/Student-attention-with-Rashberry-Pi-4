"""Build two real-video inputs after all media and annotation checks pass."""
from collections import defaultdict
import csv,hashlib,json,os
from pathlib import Path
os.environ.setdefault('OPENCV_VIDEOIO_MSMF_ENABLE_HW_TRANSFORMS','0')
import cv2
from demo_sources import WARMUP_SECONDS,source_frame

ROOT=Path(__file__).resolve().parents[2];WORK=ROOT/'.qa/action-demo'
LABELS=json.loads(Path(__file__).with_name('action_labels.json').read_text(encoding='utf-8'))
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    selection=json.loads((WORK/'sav-selection.json').read_text(encoding='utf-8'))
    missing=[row['path'] for row in selection['selectedClips'] if not Path(row['path']).is_file()]
    missing_warmup=[row['clip'] for row in selection['selectedClips'] if not row.get('causalWarmupAvailable')]
    supplement=WORK/'supplement-manifest.json'
    if missing or missing_warmup or not supplement.is_file():
        report=dict(complete=False,passed=False,accuracyVerified=False,missingSAVClips=len(missing),
            missingSAVWarmup=len(missing_warmup),
            missingSupplementAnnotations=not supplement.is_file(),reason='Original real videos and independently verified labels are required; no placeholder export.')
        (WORK/'assessment.json').write_text(json.dumps(report,indent=2));print(json.dumps(report));raise SystemExit(2)
    if sha(WORK/'sav_val.csv')!=selection['labelsSha256']:raise RuntimeError('Frozen SAV annotations changed')
    sav=defaultdict(lambda:defaultdict(dict))
    with (WORK/'sav_val.csv').open(newline='',encoding='utf-8-sig') as stream:
        for row in csv.reader(stream):
            key=(row[0],float(row[1]),row[7]);box=list(map(float,row[2:6]));action=LABELS[int(row[6])-1]['type']
            sav[row[0]][float(row[1])].setdefault(row[7],dict(id=row[7],box=dict(x=box[0],y=box[1],width=box[2]-box[0],height=box[3]-box[1]),labels=[]))['labels'].append(action)
    supplemental=json.loads(supplement.read_text(encoding='utf-8'))
    if supplemental.get('annotationSource') not in ('human_verified','published_ground_truth'):raise RuntimeError('Supplement labels cannot be model-generated')
    demos=[dict(name='sav_demo',dataset='SAV',segments=[dict(path=row['path'],sha256=row['sha256'],
        startSeconds=row['sourceStartSeconds'],endSeconds=row['sourceEndSeconds'],preRollSeconds=row['preRollSeconds'],
        annotations=[dict(timeSeconds=at+row['annotationOriginSeconds'],people=list(people.values())) for at,people in sav[row['clip']].items()]) for row in selection['selectedClips']]),
        dict(name='behavior_demo',dataset='supplement',segments=supplemental['segments'])]
    # Validate all sources before creating any source video.
    for demo in demos:
        for segment in demo['segments']:
            path=Path(segment['path'])
            if not path.is_file() or sha(path)!=segment['sha256']:raise RuntimeError('Missing or changed source: '+str(path))
            if not segment.get('annotations'):raise RuntimeError('Missing independently verified annotations')
            if segment.get('preRollSeconds',0)<WARMUP_SECONDS:raise RuntimeError('Need at least 3 seconds of real preceding source frames')
            if not segment['startSeconds']+segment['preRollSeconds']<segment['endSeconds']:raise RuntimeError('No scored interval after warmup')
            for annotation in segment['annotations']:
                if not segment['startSeconds']+segment['preRollSeconds']<=annotation['timeSeconds']<segment['endSeconds']:
                    raise RuntimeError('Annotations must be in the scored interval, after source warmup')
    cv2.setNumThreads(1);width,height,fps=1920,1080,30;manifest=dict(videos=[],selectionFrozenBeforeInference=True)
    for demo in demos:
        target=WORK/(demo['name']+'.mp4');writer=cv2.VideoWriter(str(target),cv2.CAP_MSMF,cv2.VideoWriter_fourcc(*'H264'),fps,(width,height))
        if not writer.isOpened():raise RuntimeError('Cannot open demo encoder')
        frame=0;boundaries=[];ground={}
        try:
            for segment in demo['segments']:
                cap=cv2.VideoCapture(segment['path'],cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
                sw,sh,sfps=[cap.get(prop) for prop in (cv2.CAP_PROP_FRAME_WIDTH,cv2.CAP_PROP_FRAME_HEIGHT,cv2.CAP_PROP_FPS)]
                if not cap.isOpened() or min(sw,sh,sfps)<=0:raise RuntimeError('Invalid source')
                scale=min(width/sw,height/sh);rw,rh=round(sw*scale),round(sh*scale);left,top=(width-rw)//2,(height-rh)//2
                start,end=segment['startSeconds'],segment['endSeconds'];count=round((end-start)*fps);first=frame+1
                first_source=source_frame(start,0,fps,sfps)
                cap.set(cv2.CAP_PROP_POS_FRAMES,first_source);current=None;decoded_index=first_source-1
                import numpy as np
                for tick in range(count):
                    wanted=source_frame(start,tick,fps,sfps)
                    while decoded_index<wanted:
                        ok,current=cap.read();decoded_index+=1
                        if not ok:raise RuntimeError('Source ends before annotated segment')
                    canvas=np.zeros((height,width,3),np.uint8);canvas[top:top+rh,left:left+rw]=cv2.resize(current,(rw,rh))
                    writer.write(canvas);frame+=1
                cap.release()
                boundaries.append(dict(startFrame=first,endFrame=frame,scoreStartFrame=first+round(segment['preRollSeconds']*fps),
                    source=segment['path'],sourceStartSeconds=start,sourceSha256=segment['sha256'],scenarios=segment.get('scenarios',[])))
                for annotation in segment['annotations']:
                    index=first+round((annotation['timeSeconds']-start)*fps)
                    if not first<=index<=frame:continue
                    people=[]
                    for person in annotation['people']:
                        b=person['box'];people.append({**person,'box':dict(x=(left+b['x']*sw*scale)/width,y=(top+b['y']*sh*scale)/height,
                            width=b['width']*sw*scale/width,height=b['height']*sh*scale/height)})
                    ground[str(index)]=people
        finally:writer.release()
        manifest['videos'].append(dict(name=demo['name'],path=str(target),dataset=demo['dataset'],segments=boundaries,groundTruth=ground,frames=frame,fps=fps))
    (WORK/'demo-manifest.json').write_text(json.dumps(manifest,indent=2,ensure_ascii=False),encoding='utf-8')

if __name__=='__main__':main()
