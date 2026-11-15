"""Compare arrival of IDENTICAL decoded RTSP frames; never store camera images.

Uses the running backend on localhost:3001. Restores camera-off if initially off.
The result measures decoder delay difference, not glass-to-glass camera latency.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import zlib
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

os.environ['OPENCV_FFMPEG_LOGLEVEL'] = '-8'
# Set before importing OpenCV (Windows native environment can be cached).
# Both clients use TCP; this isolates decoder threading as the tested variable.
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
if __name__ == '__main__' and os.name == 'nt' and os.environ.get('PI_BENCH_NATIVE_ENV') != '1':
    # As in PiController.spawn, Windows native getenv must receive these at
    # process creation, rather than from Python's C runtime after startup.
    sys.exit(subprocess.call([sys.executable, __file__, *sys.argv[1:]],
        env={**os.environ, 'PI_BENCH_NATIVE_ENV': '1'}, creationflags=subprocess.CREATE_NO_WINDOW))
import cv2


def api(path, body=None):
    request = urllib.request.Request('http://127.0.0.1:3001/api/pi/' + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'Content-Type': 'application/json', 'X-Pi-Control': '1'})
    with urllib.request.urlopen(request, timeout=6) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=int, default=15)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    config = dict(line.split('=', 1) for line in (Path(__file__).resolve().parents[1]/'.env').read_text().splitlines()
                  if '=' in line and not line.lstrip().startswith('#'))
    url = urlsplit(config['PI_RTSP_URL'])
    if url.hostname.endswith('.local'):
        credentials = url.netloc.rsplit('@', 1)[0] + '@' if '@' in url.netloc else ''
        url = url._replace(netloc=credentials + socket.gethostbyname(url.hostname) + ':' + str(url.port or 8554))
    cv2.setLogLevel(0)
    cv2.setNumThreads(1)
    prior = api('status')
    started_here = not prior['desired']
    stop = threading.Event()
    threads, samples, summary, errors = [], {}, {}, []
    try:
        if started_here:
            api('camera/start', {})
        deadline = time.monotonic()+15
        while time.monotonic() < deadline:
            if api('status').get('online'):
                break
            time.sleep(.25)
        for label, low_delay in [('automatic', False), ('latest', True)]:
            params = [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 4000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 4000]
            if low_delay:
                params += [cv2.CAP_PROP_N_THREADS, 1]
            opened_at = time.monotonic()
            capture = cv2.VideoCapture(urlunsplit(url), cv2.CAP_FFMPEG, params)
            if not capture.isOpened():
                capture.release()
                raise RuntimeError('RTSP unavailable')
            def read(cap=capture, key=label, began=opened_at):
                times, frames = [], []
                samples[key] = frames
                try:
                    while not stop.is_set():
                        ok, frame = cap.read()
                        if not ok:
                            errors.append(key + ': disconnected')
                            break
                        at = time.monotonic()
                        if not times:
                            summary[key] = {'firstFrameMs': round((at-began)*1000, 2)}
                        times.append(at)
                        frames.append((zlib.crc32(frame), at))
                finally:
                    cap.release()
                    if len(times)>1:
                        steady = [at for at in times if at >= times[0]+2]
                        if len(steady)>1:
                            times = steady
                        intervals = sorted((b-a)*1000 for a,b in zip(times,times[1:]))
                        summary[key].update(fps=round((len(times)-1)/(times[-1]-times[0]), 2),
                                            p95IntervalMs=round(intervals[int(len(intervals)*.95)], 2))
            thread = threading.Thread(target=read, daemon=True)
            threads.append(thread)
            thread.start()
        stop.wait(args.seconds)
    finally:
        stop.set()
        for thread in threads:
            thread.join(timeout=6)
        if started_here:
            api('camera/stop', {})
    def unique_frames(rows):
        unique, duplicates = {}, set()
        for signature, at in rows:
            if signature in unique:
                duplicates.add(signature)
            unique[signature] = at
        return {key:value for key,value in unique.items() if key not in duplicates}
    common_start = max((rows[0][1] for rows in samples.values() if rows), default=0)+2
    before, after = (unique_frames([(sig,at) for sig,at in samples.get(key, []) if at>=common_start])
                     for key in ['automatic', 'latest'])
    differences = sorted((before[key]-after[key])*1000 for key in before.keys() & after.keys())
    result = {'note': 'Same decoded frames on two RTSP clients. Decoder arrival difference only; not glass-to-glass latency.',
              'summary': summary, 'matchedUniqueFrames': len(differences), 'errors': errors}
    if differences:
        result.update(medianEarlierMs=round(differences[len(differences)//2], 2),
                      p10EarlierMs=round(differences[int(len(differences)*.1)], 2),
                      p90EarlierMs=round(differences[int(len(differences)*.9)], 2))
    args.output.write_text(json.dumps(result, indent=2)+'\n')
    print(json.dumps(result, indent=2), flush=True)
    if errors or len(differences)<30:
        raise RuntimeError('Insufficient uninterrupted matching frames')


if __name__ == '__main__':
    main()
