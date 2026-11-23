"""Decode every frame, render actual predictions, and score supplied CDED labels.

Ground truth is used only here, after inference. It is never sent to the model.
The current UI exporter uses --prepare-only. Final overlays are rendered by the
actual frontend components, never by the legacy OpenCV drawing bridge here.
"""
import argparse
import base64
import csv
import json
import time
from pathlib import Path
from collections import Counter, defaultdict
import cv2
import numpy as np


def counts():
    return dict(gt=0,predictedFaces=0,matched=0,unmatchedPredictions=0,decided=0,correct=0,
                unknown=0,missed=0,tp=0,tn=0,fp=0,fn=0,annotatedFrames=0)


def evaluate(ground, tracks, width, height):
    """One-to-one face-center-in-head/shoulder-ROI association, NOT bbox AP.

    GT boxes cover head+shoulders while runtime boxes cover faces. An IoU=.5
    face/head+shoulder test would measure different box extents unfairly.
    """
    from scipy.optimize import linear_sum_assignment
    result=counts(); result['gt']=len(ground)
    visible=[track for track in tracks if track.get('status')=='visible' and track.get('trackingState') not in ('body','coasting','predicted')]
    result['predictedFaces']=len(visible)
    costs=np.full((len(ground),len(visible)),1e6,dtype=np.float64)
    for gi,gt in enumerate(ground):
        x1,y1,x2,y2=[float(gt[key]) for key in ('x1','y1','x2','y2')]
        x1,y1=max(0,x1),max(0,y1)
        x2,y2=min(width,x2),min(height,y2)
        for pi,pred in enumerate(visible):
            box=pred['box'];cx=(box['x']+box['width']/2)*width;cy=(box['y']+box['height']/2)*height
            if x1<=cx<=x2 and y1<=cy<=y2:
                costs[gi,pi]=((cx-(x1+x2)/2)/max(1,x2-x1))**2+((cy-(y1+y2)/2)/max(1,y2-y1))**2
    pairs=[]
    if costs.size:
        rows,cols=linear_sum_assignment(costs)
        pairs=[(int(gi),int(pi)) for gi,pi in zip(rows,cols) if costs[gi,pi]<1e5]
    result['matched']=len(pairs);result['missed']=len(ground)-len(pairs)
    result['unmatchedPredictions']=len(visible)-len(pairs)
    for gi,pi in pairs:
        predicted={'focused':'Focused','needs_attention':'Distracted'}.get(visible[pi].get('attention'))
        if predicted is None:
            result['unknown']+=1;continue
        result['decided']+=1
        gt=ground[gi]['status'];result['correct']+=int(predicted==gt)
        key='tp' if predicted=='Distracted' and gt=='Distracted' else 'tn' if predicted=='Focused' and gt=='Focused' else 'fp' if predicted=='Distracted' else 'fn'
        result[key]+=1
    return result


def metrics(total):
    pct=lambda numerator,denominator:round(100*numerator/denominator,3) if denominator else None
    p=total['tp']/(total['tp']+total['fp']) if total['tp']+total['fp'] else None
    r=total['tp']/(total['tp']+total['fn']) if total['tp']+total['fn'] else None
    return dict(total,matchedStatusAccuracyPct=pct(total['correct'],total['decided']),
        endToEndCorrectPct=pct(total['correct'],total['gt']),
        spatialAssociationCoveragePct=pct(total['matched'],total['gt']),
        decisionCoveragePct=pct(total['decided'],total['gt']),
        distractedPrecisionPct=round(p*100,3) if p is not None else None,
        distractedRecallOnDecidedMatchesPct=round(r*100,3) if r is not None else None,
        distractedF1OnDecidedMatchesPct=round(200*p*r/(p+r),3) if p is not None and r is not None and p+r else None)


COLORS={'focused':(50,180,40),'needs_attention':(55,55,235),'uncertain':(0,200,240)}
def rectangle(image,box,label,color):
    height,width=image.shape[:2]
    x,y,w,h=[box[key] for key in ('x','y','width','height')]
    left,top=max(0,round(x*width)),max(0,round(y*height))
    right,bottom=min(width-1,round((x+w)*width)),min(height-1,round((y+h)*height))
    if right<=left or bottom<=top:return
    cv2.rectangle(image,(left,top),(right,bottom),color,2)
    label=label[:100]; size=cv2.getTextSize(label,cv2.FONT_HERSHEY_SIMPLEX,.42,1)[0]
    tx=min(left,max(0,width-size[0]-6));ty=max(18,top-3)
    cv2.rectangle(image,(tx,ty-17),(min(width,tx+size[0]+6),ty+3),(22,24,34),-1)
    cv2.putText(image,label,(tx+3,ty-3),cv2.FONT_HERSHEY_SIMPLEX,.42,color,1,cv2.LINE_AA)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--video',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--labels',type=Path)
    parser.add_argument('--collect-only',action='store_true')
    parser.add_argument('--prepare-only',action='store_true')
    parser.add_argument('--sample-stride',type=int,default=1)
    args=parser.parse_args()
    if args.sample_stride < 1:
        parser.error('--sample-stride must be positive')
    cv2.setNumThreads(1)
    args.output.mkdir(parents=True,exist_ok=True)
    if args.prepare_only:
        # Decode before model startup. Keep only JPEG files on disk while the
        # dense-classroom models run; no decoder process shares their RAM.
        directory=args.output/(args.video.stem+'_input_frames')
        directory.mkdir(exist_ok=True)
        cap=cv2.VideoCapture(str(args.video),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
        if not cap.isOpened():raise RuntimeError('Cannot open '+str(args.video))
        info=dict(video=args.video.name,frames=int(cap.get(cv2.CAP_PROP_FRAME_COUNT)),
            fps=cap.get(cv2.CAP_PROP_FPS),width=int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),height=int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)))
        count=0
        try:
            while True:
                ok,image=cap.read()
                if not ok:break
                count+=1
                if (count - 1) % args.sample_stride:
                    continue
                if not cv2.imwrite(str(directory/f'{count:06}.jpg'),image,[cv2.IMWRITE_JPEG_QUALITY,84]):raise RuntimeError('Cannot write JPEG')
        finally:cap.release()
        if count!=info['frames']:raise RuntimeError('Incomplete preparation')
        (directory/'metadata.json').write_text(json.dumps(info),encoding='utf-8')
        print(f'{args.video.name}: prepared {(count - 1) // args.sample_stride + 1} of {count} input frames',flush=True)
        return
    ground=defaultdict(list); all_label_status=Counter()
    if args.labels and args.labels.exists():
        with args.labels.open(encoding='utf-8-sig',newline='') as stream:
            for row in csv.DictReader(stream):
                if row['video']==args.video.stem:
                    ground[int(row['frame_id'])].append(row);all_label_status[row['status']]+=1
    capture=cv2.VideoCapture(str(args.video),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    if not capture.isOpened():raise RuntimeError('Cannot open '+str(args.video))
    fps=capture.get(cv2.CAP_PROP_FPS);width=int(capture.get(cv2.CAP_PROP_FRAME_WIDTH));height=int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    expected=int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    if fps<=0:raise RuntimeError('Invalid video frame rate')
    video_path=args.output/(args.video.stem+'_annotated.mp4')
    writer=None if args.collect_only else cv2.VideoWriter(str(video_path),cv2.VideoWriter_fourcc(*'mp4v'),fps,(width,height))
    if writer is not None and not writer.isOpened():raise RuntimeError('Cannot initialize MP4V video output')
    print(json.dumps(dict(type='metadata',fps=fps,width=width,height=height,frames=expected,labels=len(ground),
        video=str(args.video),output=str(video_path))),flush=True)
    total=counts();frame=0;started=time.perf_counter();max_faces=max_objects=0;states=Counter();kinds=Counter();signals=Counter()
    json_path=args.output/(args.video.stem+'_predictions.jsonl')
    try:
        with json_path.open('w',encoding='utf-8') as predictions:
            while True:
                ok,image=capture.read()
                if not ok:break
                frame+=1
                ok,jpeg=cv2.imencode('.jpg',image,[cv2.IMWRITE_JPEG_QUALITY,84])
                if not ok:raise RuntimeError('JPEG encoding failed')
                print(json.dumps(dict(type='frame',frame=frame,timeMs=(frame-1)*1000/fps,image=base64.b64encode(jpeg).decode())),flush=True)
                line=input();data=json.loads(line)
                if data.get('error'):raise RuntimeError(data['error'])
                tracks=data['tracks'];objects=data['objects']
                if args.collect_only:
                    predictions.write(json.dumps(dict(frame=frame,timeMs=(frame-1)*1000/fps,tracks=tracks,objects=objects),separators=(',',':'),ensure_ascii=False)+'\n')
                    continue
                visible=[track for track in tracks if track.get('status')=='visible']
                max_faces=max(max_faces,len(visible));max_objects=max(max_objects,len(objects))
                for track in tracks:
                    if track.get('trackingState')=='predicted':continue
                    label=track['id']+' | '+track.get('attention','uncertain')
                    confirmed=[s['type'] for s in track.get('signals',[]) if s['state']=='confirmed']
                    if track.get('studyContext')=='book':label+=' | book context'
                    if confirmed:label+=' | '+','.join(confirmed)
                    rectangle(image,track['box'],label,COLORS.get(track.get('attention'),COLORS['uncertain']))
                    if track.get('status')=='visible':
                        states[track.get('attention','uncertain')]+=1;signals.update(confirmed)
                for obj in objects:
                    label=obj['kind']+' '+obj['id']+(' | HS '+obj['ownerId'] if obj.get('ownerId') else '')
                    rectangle(image,obj['box'],label,(255,200,40));kinds[obj['kind']]+=1
                cv2.rectangle(image,(0,0),(width,35),(22,24,34),-1)
                cv2.putText(image,f"{args.video.stem} | frame {frame}/{expected} | faces {len(visible)} | objects {len(objects)} | current model",
                    (12,24),cv2.FONT_HERSHEY_SIMPLEX,.6,(245,245,245),1,cv2.LINE_AA)
                writer.write(image)
                sample=dict(frame=frame,timeMs=(frame-1)*1000/fps,tracks=tracks,objects=objects)
                predictions.write(json.dumps(sample,separators=(',',':'),ensure_ascii=False)+'\n')
                if frame in ground:
                    score=evaluate(ground[frame],tracks,width,height);score['annotatedFrames']=1
                    for key,value in score.items():total[key]+=value
                if frame in (1,expected//2,expected):cv2.imwrite(str(args.output/(args.video.stem+f'_preview_{frame:04}.jpg')),image)
    finally:
        if writer is not None:writer.release()
        capture.release()
    if args.collect_only:
        if frame!=expected:raise RuntimeError(f'Incomplete input decoding: {frame}/{expected}')
        summary=dict(video=args.video.name,frames=frame,width=width,height=height,fps=fps,
            processingSeconds=round(time.perf_counter()-started,2),source=str(args.video),predictionsComplete=True)
        (args.output/(args.video.stem+'_inference.json')).write_text(json.dumps(summary,indent=2)+'\n',encoding='utf-8')
        print(json.dumps(dict(type='done',summary=summary)),flush=True)
        return
    check=cv2.VideoCapture(str(video_path),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);decoded=int(check.get(cv2.CAP_PROP_FRAME_COUNT));check.release()
    if frame!=expected or decoded!=frame:raise RuntimeError(f'Incomplete export: input={expected},processed={frame},output={decoded}')
    summary=dict(video=args.video.name,output=video_path.name,width=width,height=height,fps=fps,frames=frame,
        durationSeconds=frame/fps,processingSeconds=round(time.perf_counter()-started,2),allFramesProcessed=True,
        labelledFrames=len(ground),labelledInstances=sum(map(len,ground.values())),groundTruthStatuses=dict(all_label_status),
        maxVisibleFaces=max_faces,maxVisibleObjects=max_objects,predictedStatusFrameCounts=dict(states),objectFrameCounts=dict(kinds),
        confirmedSignalFrameCounts=dict(signals),evaluation=metrics(total) if ground else None)
    (args.output/(args.video.stem+'_metrics.json')).write_text(json.dumps(summary,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    print(json.dumps(dict(type='done',summary=summary)),flush=True)


if __name__=='__main__':main()
