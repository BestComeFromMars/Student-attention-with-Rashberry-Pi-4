"""Keep every source frame at its native FPS and animate received AI boxes.

PNG annotations come from the actual React overlay components. No inference,
background-frame interpolation, face drawing rules or video speed changes happen here.
"""
import argparse,json,subprocess
from pathlib import Path
import cv2
import numpy as np
import imageio_ffmpeg


def frame_decisions(decisions,fps,frames):
    current=-1
    for frame in range(frames):
        at=frame/fps
        while current+1<len(decisions) and decisions[current+1]['sourceSeconds']<=at+1e-9:current+=1
        yield current


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--output',type=Path);parser.add_argument('--probe-only',action='store_true')
    args=parser.parse_args();cv2.setNumThreads(1)
    recording=json.loads((args.work/'recording.json').read_text(encoding='utf8'))
    source=Path(recording['sourcePath'])
    reader=cv2.VideoCapture(str(source),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1])
    if not reader.isOpened():raise RuntimeError('Cannot decode source video')
    width,height=[int(reader.get(key)) for key in (cv2.CAP_PROP_FRAME_WIDTH,cv2.CAP_PROP_FRAME_HEIGHT)]
    fps=reader.get(cv2.CAP_PROP_FPS);expected=int(reader.get(cv2.CAP_PROP_FRAME_COUNT))
    info=dict(width=width,height=height,fps=fps,frames=expected,durationSeconds=expected/fps)
    (args.work/'source-info.json').write_text(json.dumps(info,indent=2),encoding='utf8')
    if args.probe_only:reader.release();return
    if args.output is None:raise ValueError('Output path is required')
    manifest=json.loads((args.work/'decision-overlays.json').read_text(encoding='utf8'));decisions=manifest['decisions']
    if any(not np.isfinite(d['sourceSeconds']) or d['sourceSeconds']<0 for d in decisions):raise ValueError('Invalid decision time')
    if any(a['sourceSeconds']>b['sourceSeconds'] for a,b in zip(decisions,decisions[1:])):raise ValueError('Decisions are not ordered')
    args.output.parent.mkdir(parents=True,exist_ok=True)
    # MSMF's default bitrate made a 17 s clip exceed 120 MB. H.264 with a
    # bounded quality setting and fast-start keeps playback/seek lightweight.
    encoder=subprocess.Popen([imageio_ffmpeg.get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-y',
        '-f','rawvideo','-pixel_format','bgr24','-video_size',f'{width}x{height}','-framerate',str(fps),'-i','pipe:0',
        '-an','-c:v','libx264','-preset','veryfast','-crf','18','-threads','2','-pix_fmt','yuv420p',
        '-fps_mode','passthrough','-movflags','+faststart',str(args.output)],stdin=subprocess.PIPE)
    cached=-2;overlay=None;alpha=None;inverse=None;decoded=0;segments=[]
    try:
        for frame,decision in enumerate(frame_decisions(decisions,fps,expected)):
            ok,image=reader.read()
            if not ok:raise RuntimeError(f'Missing source frame {frame}')
            if decision!=cached:
                segments.append(dict(startFrame=frame,sourceSeconds=frame/fps,decision=decision,
                    requestIndex=decisions[decision]['requestIndex'] if decision>=0 else None))
                if decision>=0:
                    rgba=cv2.imread(str(args.work/decisions[decision]['file']),cv2.IMREAD_UNCHANGED)
                    if rgba is None or rgba.shape!=(height,width,4):raise RuntimeError('Overlay must be a native-size transparent PNG')
                    alpha=rgba[:,:,3:4].astype(np.uint16);inverse=255-alpha
                    overlay=rgba[:,:,:3].astype(np.uint16)*alpha
                cached=decision
            if decision>=0:image=((image.astype(np.uint16)*inverse+overlay+127)//255).astype(np.uint8)
            encoder.stdin.write(image.tobytes());decoded+=1
            if frame in (0,expected//2,expected-1):
                name='dau' if frame==0 else 'cuoi' if frame==expected-1 else 'giua'
                cv2.imwrite(str(args.output.with_name(args.output.stem+f'_{name}_video.jpg')),image)
            if frame%100==0 or frame==expected-1:print(f'Original source frames: {decoded}/{expected}',flush=True)
        if reader.read()[0]:raise RuntimeError('Source contains more frames than declared')
    finally:
        reader.release();encoder.stdin.close()
        if encoder.wait()!=0:raise RuntimeError('H.264 encoder failed')
    check=cv2.VideoCapture(str(args.output),cv2.CAP_FFMPEG,[cv2.CAP_PROP_N_THREADS,1]);verified=0;max_timestamp_error=0
    try:
        if abs(check.get(cv2.CAP_PROP_FPS)-fps)>.001:raise RuntimeError('Native FPS changed')
        while True:
            ok,image=check.read()
            if not ok:break
            if image.shape[:2]!=(height,width):raise RuntimeError('Native resolution changed')
            max_timestamp_error=max(max_timestamp_error,abs(check.get(cv2.CAP_PROP_POS_MSEC)-verified*1000/fps))
            verified+=1
    finally:check.release()
    if verified!=expected or decoded!=expected:raise RuntimeError('Source/output frame counts differ')
    if max_timestamp_error>.1:raise RuntimeError('Output frame timestamps do not preserve source speed')
    result=dict(info,source=str(source),output=str(args.output),allSourceFramesPreserved=True,
        nativeFpsPreserved=True,frameTimestampMaxErrorMs=max_timestamp_error,backgroundFramesInterpolated=False,
        frontendOverlaysAnimatedAtSourceFPS=manifest.get('interpolatedAtSourceFPS',False),
        usesFutureAI=False,codec='H.264/libx264',fastStart=True,bitrateMbps=args.output.stat().st_size*8/(expected/fps)/1e6,
        decisions=len(decisions),segments=segments,
        mode='Original source frames and timestamps; causal frontend SVG animation at native FPS; H.264 fast-start. Not a screencast.')
    (args.work/'encoded.json').write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps({key:value for key,value in result.items() if key!='segments'}),flush=True)


if __name__=='__main__':main()
