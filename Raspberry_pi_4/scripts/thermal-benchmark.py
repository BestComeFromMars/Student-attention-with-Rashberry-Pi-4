"""Explicit live-camera benchmark; frames stay in RAM and camera is stopped on exit."""
import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit
from urllib.request import Request, urlopen

os.environ['OPENCV_FFMPEG_LOGLEVEL'] = '-8'
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp'
import cv2

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'Raspberry_pi_4'))
from deploy import ssh_command

PROBE = r'''
import json,os,time,subprocess
from pathlib import Path
seconds=SECONDS
ticks=os.sysconf('SC_CLK_TCK')
def snapshot():
 values=list(map(int,Path('/proc/stat').read_text().splitlines()[0].split()[1:9]))
 processes={}
 for p in Path('/proc').iterdir():
  if not p.name.isdigit(): continue
  try:
   name=(p/'comm').read_text().strip()
   if name not in ('ffmpeg','mediamtx','python3','labwc','pcmanfm','wf-panel-pi','wireplumber'): continue
   stat=(p/'stat').read_text().rsplit(')',1)[1].split()
   processes[p.name]=(name,int(stat[11])+int(stat[12]))
  except (OSError,ValueError,IndexError): pass
 return values,processes
before,procs=snapshot()
start=time.monotonic()
temps=[]
while time.monotonic()-start < seconds:
 temps.append(int(Path('/sys/class/thermal/thermal_zone0/temp').read_text())/1000)
 time.sleep(1)
after,current=snapshot()
elapsed=time.monotonic()-start
total=sum(after)-sum(before)
idle=(after[3]+after[4])-(before[3]+before[4])
cpu={}
for pid,(name,value) in current.items():
 if pid in procs: cpu[name]=cpu.get(name,0)+(value-procs[pid][1])/ticks/elapsed*100
print(json.dumps({'seconds':round(elapsed,2),'systemCpuPercent':round(100*(total-idle)/total,2),
 'processCpuPercent':{k:round(v,2) for k,v in cpu.items()},'temperatureStartC':temps[0],
 'temperatureEndC':temps[-1],'temperatureMaxC':max(temps),
 'throttled':subprocess.check_output(['vcgencmd','get_throttled'],text=True).strip()}),flush=True)
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--label', required=True)
    parser.add_argument('--seconds', type=int, default=40)
    parser.add_argument('--ssh-host', default='facepi.local')
    args = parser.parse_args()
    if not args.label.replace('-', '').isalnum() or not 10 <= args.seconds <= 180:
        parser.error('Use an alphanumeric label and 10–180 seconds.')
    values = dict(line.split('=', 1) for line in (ROOT / 'backend/.env').read_text().splitlines()
                  if '=' in line and not line.lstrip().startswith('#'))
    control = urlsplit(values['PI_CONTROL_URL'])
    address = socket.gethostbyname(control.hostname)
    base = urlunsplit(control._replace(netloc=address + ':' + str(control.port or 80)))
    def command(path, data=None):
        req = Request(base + path, headers={'Authorization': 'Bearer ' + values['PI_TOKEN'], 'Content-Type': 'application/json'},
                      data=json.dumps(data).encode() if data is not None else None)
        with urlopen(req, timeout=5) as response:
            return json.load(response)
    stop = threading.Event()
    def heartbeat():
        while not stop.is_set():
            try:
                command('/heartbeat', {'ready': True})
            except OSError:
                pass
            stop.wait(2)
    cap = probe = None
    try:
        command('/stop', {})
        command('/heartbeat', {'ready': True})
        command('/start', {})
        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        deadline = time.monotonic() + 20
        while command('/health')['state'] != 'streaming':
            if time.monotonic() > deadline:
                raise RuntimeError('Pi camera did not become ready')
            time.sleep(.3)
        rtsp = urlsplit(values['PI_RTSP_URL'])
        credentials = rtsp.netloc.rsplit('@', 1)[0] + '@'
        source = urlunsplit(rtsp._replace(netloc=credentials + address + ':' + str(rtsp.port or 8554)))
        cv2.setLogLevel(0)
        cv2.setNumThreads(1)
        cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG, [cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 4000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 4000])
        if not cap.isOpened():
            raise RuntimeError('RTSP unavailable')
        for _ in range(15):
            if not cap.read()[0]:
                raise RuntimeError('No warmup frame')
        probe = subprocess.Popen(ssh_command(args.ssh_host) + ['python3 -u -'], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        probe.stdin.write(PROBE.replace('SECONDS', str(args.seconds)).encode())
        probe.stdin.close()
        started = time.monotonic()
        last = started
        intervals = []
        frames = 0
        dimensions = None
        while time.monotonic() - started < args.seconds:
            ok, frame = cap.read()
            if not ok:
                raise RuntimeError('RTSP disconnected during measurement')
            now = time.monotonic()
            intervals.append((now-last)*1000)
            last = now
            dimensions = [frame.shape[1], frame.shape[0]]
            # Match the backend reader's JPEG handoff; never write the image.
            cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
            frames += 1
        elapsed = time.monotonic()-started
        remote = probe.stdout.read().decode()
        errors = probe.stderr.read().decode()
        if probe.wait(timeout=10) != 0:
            raise RuntimeError('Remote thermal probe failed: ' + errors[-500:])
        result = json.loads(remote)
        intervals.sort()
        result.update(label=args.label, frames=frames, deliveredFps=round(frames/elapsed,2),
                      dimensions=dimensions, intervalP95Ms=round(intervals[int(len(intervals)*.95)],2),
                      maximumGapMs=round(max(intervals),2))
        output = ROOT / '.qa' / ('pi-thermal-' + args.label + '.json')
        output.parent.mkdir(exist_ok=True)
        output.write_text(json.dumps(result, indent=2) + '\n')
        print(json.dumps(result, indent=2), flush=True)
    finally:
        stop.set()
        if cap is not None:
            cap.release()
        if probe is not None and probe.poll() is None:
            probe.kill()
            probe.wait()
        try:
            command('/stop', {})
            command('/heartbeat', {'ready': False})
        except OSError:
            pass


if __name__ == '__main__':
    main()
