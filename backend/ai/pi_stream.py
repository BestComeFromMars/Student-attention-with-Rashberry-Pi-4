"""Read RTSP using bundled OpenCV/FFmpeg. Binary JPEG frames, latest-only handoff."""
import json
import os
import struct
import sys
import threading
import time
import socket
from urllib.parse import urlsplit, urlunsplit

os.environ['OPENCV_FFMPEG_LOGLEVEL'] = '-8'
os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'rtsp_transport;tcp|fflags;nobuffer|flags;low_delay'
import cv2


def main():
    # URL is sent over stdin, never exposed in process arguments or logs.
    config = json.loads(sys.stdin.buffer.readline(8192))
    url = urlsplit(config['url'])
    if url.hostname and url.hostname.endswith('.local'):
        credentials = url.netloc.rsplit('@', 1)[0] + '@' if '@' in url.netloc else ''
        config['url'] = urlunsplit(url._replace(netloc=credentials + socket.gethostbyname(url.hostname) + ':' + str(url.port or 8554)))
    cv2.setLogLevel(0)
    cv2.setNumThreads(1)
    capture = cv2.VideoCapture(config['url'], cv2.CAP_FFMPEG, [
        cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 4000, cv2.CAP_PROP_READ_TIMEOUT_MSEC, 4000,
        # H264 has no B frames. FFmpeg's automatic frame threading can otherwise
        # hold up to 16 decoded frames (~0.5 s at 30 FPS) before returning them.
        cv2.CAP_PROP_N_THREADS, 1])
    if not capture.isOpened():
        raise RuntimeError('RTSP unavailable')
    condition = threading.Condition()
    latest = [None]
    stopped = threading.Event()

    def read():
        try:
            while not stopped.is_set():
                ok, frame = capture.read()
                if not ok:
                    break
                with condition:
                    latest[0] = (time.monotonic(), frame)
                    condition.notify()
        finally:
            stopped.set()
            with condition:
                condition.notify()

    def parent():
        # Parent closing stdin also stops this worker, including on Windows.
        sys.stdin.buffer.read()
        stopped.set()
        with condition:
            condition.notify()
    threading.Thread(target=read, daemon=True).start()
    threading.Thread(target=parent, daemon=True).start()
    try:
        while not stopped.is_set():
            with condition:
                condition.wait_for(lambda: latest[0] is not None or stopped.is_set(), timeout=5)
                item, latest[0] = latest[0], None
            if stopped.is_set() or item is None:
                break
            captured, frame = item
            if time.monotonic() - captured > 1:
                continue
            ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if ok and jpeg.nbytes <= 4 * 1024 * 1024:
                sys.stdout.buffer.write(struct.pack('>I', jpeg.nbytes))
                sys.stdout.buffer.write(jpeg.tobytes())
                sys.stdout.buffer.flush()
    finally:
        stopped.set()
        # read() owns capture; process termination bounds a blocked native read.


if __name__ == '__main__':
    try:
        main()
    except (Exception, BrokenPipeError):
        print('Pi video reader disconnected.', file=sys.stderr)
        sys.exit(1)
