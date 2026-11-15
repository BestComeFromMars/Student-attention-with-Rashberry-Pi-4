"""USB camera controller. Only runtime state is written, under /run (RAM)."""
import hmac
import json
import os
import signal
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class Camera:
    def __init__(self, state_file=None, clock=time.monotonic, popen=subprocess.Popen,
                 poweroff=None):
        self.lock = threading.RLock()
        self.clock, self.popen = clock, popen
        try:
            self.fps = max(5,min(30,int(os.environ.get('CAMERA_FPS','15'))))
        except ValueError:
            self.fps = 15
        try:
            self.input_fps = max(self.fps,min(30,int(os.environ.get('CAMERA_INPUT_FPS','25'))))
        except ValueError:
            self.input_fps = max(25,self.fps)
        self.poweroff = poweroff or self.schedule_poweroff
        self.state_file = Path(state_file) if state_file else None
        self.desired = False
        self.generation = 0
        if self.state_file and self.state_file.exists():
            try:
                saved = json.loads(self.state_file.read_text())
                self.desired = saved.get('desired') is True
                self.generation = int(saved.get('generation', 0))
            except (ValueError, OSError, TypeError):
                pass
        self.process = None
        self.last_progress = 0.
        self.has_frames = False
        self.lease_until = 0.
        self.backend_ready = False
        self.shutting_down = False
        self.error = None
        self.retry_at = 0.
        self.failures = 0
        self.boot_id = Path('/proc/sys/kernel/random/boot_id').read_text().strip() if os.name != 'nt' else 'test-boot'

    def persist(self):
        if self.state_file:
            self.state_file.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.state_file.with_suffix('.tmp')
            temporary.write_text(json.dumps({'desired': self.desired, 'generation': self.generation}))
            temporary.replace(self.state_file)

    def command(self):
        return ['ffmpeg', '-hide_banner', '-loglevel', 'warning', '-nostdin',
                # Bound MJPEG decode/conversion workers instead of waking all CPU
                # cores. H.264 encoding stays on the Pi hardware at the same quality.
                '-filter_threads', '1', '-thread_queue_size', '4', '-threads:v', '1',
                '-f', 'v4l2', '-input_format', 'mjpeg',
                '-video_size', '1280x720', '-framerate', str(self.input_fps), '-i',
                os.environ.get('CAMERA_DEVICE', '/dev/video0'), '-an', '-threads', '1',
                # This webcam offers 25/30 FPS only. Drop frames before the
                # color conversion/hardware encoder, preserving all face pixels.
                '-vf', 'fps='+str(self.fps),
                '-pix_fmt', 'yuv420p', '-progress', 'pipe:1', '-stats_period', '1',
                '-c:v', 'h264_v4l2m2m', '-b:v', '4000000', '-g', str(max(5,self.fps//2)), '-bf', '0',
                '-profile:v', '66', '-f', 'rtsp', '-rtsp_transport', 'tcp',
                'rtsp://127.0.0.1:8554/camera']

    def heartbeat(self, ready):
        with self.lock:
            self.backend_ready = ready
            self.lease_until = self.clock() + 10
            return self.status()

    def start(self):
        with self.lock:
            if self.shutting_down:
                raise RuntimeError('Pi đang tắt máy.')
            self.desired = True
            self.persist()
            return self.status()

    def stop_capture(self):
        process, self.process = self.process, None
        self.has_frames = False
        if process is not None and process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGINT)
            except ProcessLookupError:
                pass
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=2)

    def stop(self):
        with self.lock:
            self.desired = False
            self.persist()
            self.stop_capture()
            self.error = None
            self.retry_at = 0.
            return self.status()

    @staticmethod
    def schedule_poweroff():
        subprocess.run(['sudo', '-n', '/usr/local/sbin/student-attention-poweroff'],
                       check=True, capture_output=True, timeout=5)

    def shutdown(self):
        with self.lock:
            if not self.shutting_down:
                self.stop()
                self.poweroff()
                self.shutting_down = True
            return self.status()

    def progress(self, process):
        previous = 0
        try:
            for line in process.stdout:
                if line.startswith(b'frame='):
                    try:
                        frame = int(line.split(b'=', 1)[1])
                        with self.lock:
                            if self.process is process and frame > previous:
                                previous = frame
                                self.has_frames = True
                                self.last_progress = self.clock()
                                self.error = None
                                self.failures = 0
                    except ValueError:
                        pass
        finally:
            process.stdout.close()

    def recover(self):
        with self.lock:
            if self.shutting_down or not self.desired or not self.backend_ready or self.clock() >= self.lease_until:
                self.stop_capture()
                return
            running = self.process is not None and self.process.poll() is None
            if running and self.clock() - self.last_progress < 6:
                return
            if self.clock() < self.retry_at:
                return
            self.stop_capture()
            try:
                self.process = self.popen(self.command(), stdout=subprocess.PIPE, start_new_session=True)
                self.generation += 1
                self.persist()
                self.last_progress = self.clock()
                threading.Thread(target=self.progress, args=(self.process,), daemon=True).start()
            except OSError:
                self.error = 'Không mở được webcam. Kiểm tra thiết bị và FFmpeg; đang thử lại.'
            self.failures += 1
            self.retry_at = self.clock() + min(8, 2 ** min(self.failures - 1, 3))
            if running:
                self.error = 'Luồng camera bị gián đoạn; đang phục hồi.'

    def status(self):
        with self.lock:
            running = self.process is not None and self.process.poll() is None
            lease = self.backend_ready and self.clock() < self.lease_until
            state = ('shutting_down' if self.shutting_down else 'off' if not self.desired
                     else 'waiting_backend' if not lease else 'streaming' if running and self.has_frames
                     else 'reconnecting' if self.error else 'starting')
            return {'state': state, 'desired': self.desired, 'camera_released': not running,
                    'boot_id': self.boot_id, 'camera_generation': self.generation,
                    'resolution': [1280, 720], 'fps': self.fps, 'error': self.error}

    def close(self):
        with self.lock:
            self.stop_capture()  # Preserve the explicit choice across a service restart.


def handler_for(camera, token):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)

        def dispatch(self, mutate=False):
            try:
                if not token or not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + token):
                    self.reply(401, {'message': 'Unauthorized'})
                    return
                if not mutate and self.path == '/health':
                    result = camera.status()
                elif mutate and self.path in ('/start', '/stop', '/shutdown'):
                    result = getattr(camera, self.path[1:])()
                elif mutate and self.path == '/heartbeat':
                    length = int(self.headers.get('Content-Length', '0'))
                    if length < 1 or length > 2048:
                        self.reply(400, {'message': 'Invalid heartbeat'})
                        return
                    data = json.loads(self.rfile.read(length))
                    if not isinstance(data, dict) or type(data.get('ready')) is not bool:
                        self.reply(400, {'message': 'ready must be boolean'})
                        return
                    result = camera.heartbeat(data['ready'])
                else:
                    self.reply(404, {'message': 'Not found'})
                    return
                self.reply(200, result)
            except (BrokenPipeError, ConnectionResetError):
                pass
            except (ValueError, json.JSONDecodeError):
                self.reply(400, {'message': 'Invalid request'})
            except Exception:
                self.reply(503, {'message': 'Không hoàn tất được lệnh trên Pi. Kiểm tra dịch vụ thiết bị.'})

        def do_GET(self):
            self.dispatch()

        def do_POST(self):
            self.dispatch(True)
    return Handler


def main():
    token = os.environ.get('PI_TOKEN', '')
    if len(token) < 32:
        raise SystemExit('Configure PI_TOKEN with at least 32 characters.')
    camera = Camera(os.environ.get('CAMERA_STATE_FILE', '/run/student-attention/state.json'))
    stopping = threading.Event()
    def supervise():
        while not stopping.wait(.5):
            camera.recover()
    threading.Thread(target=supervise, daemon=True).start()
    server = ThreadingHTTPServer(('0.0.0.0', 8765), handler_for(camera, token))
    server.daemon_threads = True
    def terminate(*_):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        server.serve_forever()
    finally:
        stopping.set()
        camera.close()
        server.server_close()


if __name__ == '__main__':
    main()
