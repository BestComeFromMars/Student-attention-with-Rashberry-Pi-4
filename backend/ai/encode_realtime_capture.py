"""Encode real frontend screencast time; never resimulate model predictions."""
import argparse,json,math,sys
from pathlib import Path
import cv2


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();cv2.setNumThreads(1)
    recording=json.loads((args.work/'recording.json').read_text(encoding='utf8'))
    assert recording['complete']
    start,end=recording['startedAt'],recording['endedAt'];duration=(end-start)/1000
    width,height=recording['source']['width'],recording['source']['height'];fps=30
    frames=math.ceil(duration*fps)
    samples=sorted(recording['screens'],key=lambda sample:sample['at'])
    if not samples:raise RuntimeError('No actual frontend frames recorded')
    box=recording['crop'];left,top=round(box['x']),round(box['y']);cw,ch=round(box['width']),round(box['height'])
    args.output.parent.mkdir(parents=True,exist_ok=True)
    writer=cv2.VideoWriter(str(args.output),cv2.CAP_MSMF,cv2.VideoWriter_fourcc(*'H264'),fps,(width,height)) if sys.platform=='win32' else cv2.VideoWriter(str(args.output),cv2.VideoWriter_fourcc(*'mp4v'),fps,(width,height))
    if not writer.isOpened():raise RuntimeError('Cannot encode output MP4')
    current=0;cached=None;cached_index=-1
    try:
        for index in range(frames):
            at=start+index*1000/fps
            while current+1<len(samples) and samples[current+1]['at']<=at:current+=1
            if current!=cached_index:
                image=cv2.imread(str(args.work/'screens'/samples[current]['file']))
                if image is None:raise RuntimeError('Missing screencast frame')
                crop=image[top:top+ch,left:left+cw]
                if crop.shape[:2]!=(ch,cw):raise RuntimeError('Camera viewport falls outside capture')
                cached=cv2.resize(crop,(width,height),interpolation=cv2.INTER_AREA);cached_index=current
            writer.write(cached)
            if index%100==0 or index==frames-1:print(f'Realtime output: {index+1}/{frames}',flush=True)
    finally:writer.release()
    capture=cv2.VideoCapture(str(args.output),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);decoded=0
    try:
        while True:
            ok,image=capture.read()
            if not ok:break
            if image.shape[:2]!=(height,width):raise RuntimeError('Wrong output dimensions')
            if decoded in (0,frames//2,frames-1):
                cv2.imwrite(str(args.work/f'preview_{decoded:06}.jpg'),image)
                name='dau' if decoded==0 else 'cuoi' if decoded==frames-1 else 'giua'
                cv2.imwrite(str(args.output.with_name(args.output.stem+f'_{name}_video.jpg')),image)
            decoded+=1
    finally:capture.release()
    if decoded!=frames:raise RuntimeError(f'Incomplete output: {decoded}/{frames}')
    result=dict(frames=decoded,fps=fps,width=width,height=height,durationSeconds=frames/fps,screencastFrames=len(samples),
        causalFrameHold=True,actualElapsedSeconds=duration,source=str(args.output))
    (args.work/'encoded.json').write_text(json.dumps(result,indent=2),encoding='utf8');print(json.dumps(result))


if __name__=='__main__':main()
