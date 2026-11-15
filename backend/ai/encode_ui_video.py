"""Encode browser-rendered frames; annotations come only from the real UI."""
import argparse
from collections import defaultdict
import csv
import json
from pathlib import Path
import sys
import cv2
from export_video_io import counts,evaluate,metrics


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--stem',required=True)
    parser.add_argument('--frames',type=Path,required=True)
    args=parser.parse_args();cv2.setNumThreads(1)
    info=json.loads((args.work/(args.stem+'_inference.json')).read_text(encoding='utf-8'))
    width,height,expected,fps=[info[key] for key in ('width','height','frames','fps')]
    target=args.work/(args.stem+'_ui.mp4')
    # Windows' installed H.264 encoder makes the MP4 playable in the web UI.
    writer=cv2.VideoWriter(str(target),cv2.CAP_MSMF,cv2.VideoWriter_fourcc(*'H264'),fps,(width,height)) if sys.platform=='win32' else cv2.VideoWriter(str(target),cv2.VideoWriter_fourcc(*'mp4v'),fps,(width,height))
    if not writer.isOpened():raise RuntimeError('Cannot initialize video writer')
    try:
        for frame in range(1,expected+1):
            image=cv2.imread(str(args.frames/f'{frame:06}.jpg'))
            if image is None or image.shape[:2]!=(height,width):raise RuntimeError('Invalid screenshot size')
            writer.write(image)
            if frame%50==0 or frame==expected:print(f'{args.stem}: H264 {frame}/{expected}',flush=True)
    finally:writer.release()
    # Check actual decoding of every frame, not just the MP4 frame-count header.
    capture=cv2.VideoCapture(str(target),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);decoded=0
    try:
        if abs(capture.get(cv2.CAP_PROP_FPS)-fps)>.01:raise RuntimeError('FPS changed')
        while True:
            ok,image=capture.read()
            if not ok:break
            if image.shape[:2]!=(height,width):raise RuntimeError('Resolution changed')
            decoded+=1
    finally:capture.release()
    if decoded!=expected:raise RuntimeError(f'Incomplete encoded video: {decoded}/{expected}')
    ground=defaultdict(list)
    labels=Path(__file__).resolve().parents[1]/'tests/derived_release/derived_status_boxes.csv'
    if labels.exists() and args.stem.startswith('class_'):
        with labels.open(encoding='utf-8-sig',newline='') as stream:
            for row in csv.DictReader(stream):
                if row['video']==args.stem:ground[int(row['frame_id'])].append(row)
    total=counts()
    with (args.work/(args.stem+'_predictions.jsonl')).open(encoding='utf-8') as stream:
        for line in stream:
            prediction=json.loads(line)
            if prediction['frame'] in ground:
                result=evaluate(ground[prediction['frame']],prediction['tracks'],width,height)
                result['annotatedFrames']=1
                for key,value in result.items():total[key]+=value
    (args.work/(args.stem+'_ui_verified.json')).write_text(json.dumps(dict(frames=decoded,fps=fps,width=width,height=height,
        source=str(target),evaluation=metrics(total) if ground else None),indent=2),encoding='utf-8')


if __name__=='__main__':main()
