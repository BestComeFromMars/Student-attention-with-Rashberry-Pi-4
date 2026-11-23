"""Native desktop popup viewer playing a video as a 1x realtime camera
through the production backend AI + pixel-tracking workflow (no browser/web).
"""
import argparse
import http.client
import json
import threading
import time
from pathlib import Path
from urllib.parse import urlparse

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont


LABELS = {
    'upper_body_slumped': 'Gục người',
    'eyes_closed': 'Nhắm mắt',
    'phone': 'Điện thoại',
    'head_down': 'Cúi đầu',
    'yawn': 'Ngáp',
    'talking': 'Nói chuyện',
    'laptop': 'Laptop',
    'head_turning': 'Quay đầu',
    'head_turned': 'Quay ngang',
    'torso_turned': 'Quay thân',
    'turned_smiling': 'Quay / cười',
}
OBJECTS = {'phone': 'Điện thoại', 'book': 'Sách/vở', 'laptop': 'Laptop'}


def bgr(color: str):
    return tuple(int(color[offset:offset + 2], 16) for offset in (5, 3, 1))


def load_font(size: int = 14):
    for path in (
        'C:/Windows/Fonts/segoeuib.ttf',
        'C:/Windows/Fonts/arialbd.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def caption_for_track(track):
    alerts = sorted(
        track.get('alerts', []),
        key=lambda alert: (alert.get('type') != 'upper_body_slumped', bool(alert.get('held'))),
    )
    action = track.get('actionAlert')
    warning = bool(alerts or action or track.get('attention') == 'needs_attention')
    if alerts:
        short = LABELS.get(alerts[0].get('type'), alerts[0].get('label', ''))
    elif action:
        short = 'Gục người' if action.get('type') == 'slumped_on_desk' else action.get('label', '')
    else:
        short = 'Chú ý' if warning else 'Sách/vở' if track.get('studyContext') == 'book' else ''
    return track.get('id', '?') + (f' · {short}' if short else ''), warning


class LabelCache:
    def __init__(self):
        self.font = load_font(14)
        self.cache = {}

    def patch(self, text: str, color: str, warning: bool):
        key = (text, color, warning)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        if len(self.cache) > 256:
            self.cache.clear()
        width = max(24, round(self.font.getlength(text)) + 14)
        image = Image.new('RGB', (width, 24), '#7f1d1d' if warning else '#0f172a')
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, width - 1, 23), outline=color)
        draw.text((7, 4), text, font=self.font, fill='#f8fafc')
        arr = np.asarray(image)[:, :, ::-1].copy()
        self.cache[key] = arr
        return arr


class ApiClient:
    def __init__(self, base_url: str, timeout: float = 30.0):
        parsed = urlparse(base_url)
        self.host = parsed.hostname or '127.0.0.1'
        self.port = parsed.port or 80
        self.prefix = parsed.path.rstrip('/')
        self.timeout = timeout
        self.conn = http.client.HTTPConnection(self.host, self.port, timeout=timeout)

    def _request(self, method: str, path: str, body=None, headers=None):
        full_path = self.prefix + path
        hdrs = dict(headers or {})
        for attempt in range(2):
            try:
                self.conn.request(method, full_path, body=body, headers=hdrs)
                resp = self.conn.getresponse()
                data = resp.read()
                return resp.status, data
            except (http.client.HTTPException, OSError):
                self.conn.close()
                self.conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
                if attempt == 1:
                    raise

    def create_session(self, objects_enabled: bool = False) -> str:
        if objects_enabled:
            s_status, s_data = self._request('GET', '/observation-settings')
            if s_status != 200:
                raise RuntimeError(f'Cannot load settings schema ({s_status})')
            defaults = json.loads(s_data).get('defaults', {})
            defaults['objectsEnabled'] = True
            payload = json.dumps({'settings': defaults}).encode('utf8')
        else:
            payload = b'{}'
        status, data = self._request('POST', '/sessions', payload, {'Content-Type': 'application/json'})
        if status not in (200, 201):
            raise RuntimeError(f'Cannot create session ({status}): {data.decode("utf8", "ignore")}')
        return json.loads(data)['sessionId']

    def delete_session(self, session_id: str):
        try:
            self._request('DELETE', f'/sessions/{session_id}')
        except Exception:
            pass

    def detect(self, session_id: str, jpeg_bytes: bytes, frame_id: int):
        status, data = self._request(
            'POST',
            f'/sessions/{session_id}/detect',
            jpeg_bytes,
            {'Content-Type': 'image/jpeg', 'X-Frame-Id': str(frame_id)},
        )
        if status != 200:
            return None
        return json.loads(data)

    def track(self, session_id: str, jpeg_bytes: bytes, frame_id: int, captured_at_ms: int):
        status, data = self._request(
            'POST',
            f'/sessions/{session_id}/track',
            jpeg_bytes,
            {
                'Content-Type': 'image/jpeg',
                'X-Frame-Id': str(frame_id),
                'X-Frame-Captured-At': str(captured_at_ms),
            },
        )
        if status != 200:
            return None
        return json.loads(data)

    def close(self):
        try:
            self.conn.close()
        except Exception:
            pass


def encode_camera_jpeg(frame: np.ndarray, max_dim: int = 1280, quality: int = 85) -> bytes:
    h, w = frame.shape[:2]
    largest = max(h, w)
    if largest > max_dim:
        scale = max_dim / float(largest)
        resized = cv2.resize(frame, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    else:
        resized = frame
    ok, encoded = cv2.imencode('.jpg', resized, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError('Failed to encode JPEG frame')
    return encoded.tobytes()


def draw_overlays(canvas: np.ndarray, tracks: list, objects: list, tracked_boxes: list, labels: LabelCache):
    height, width = canvas.shape[:2]
    tracks_by_id = {
        t['id']: t for t in tracks
        if t.get('status') == 'visible' and t.get('trackingState') != 'predicted'
    }
    objects_by_id = {o['id']: o for o in objects}

    entries = []
    if tracked_boxes:
        seen_keys = set()
        for entry in tracked_boxes:
            key = entry.get('key', '')
            if ':' not in key or key in seen_keys:
                continue
            kind, identity = key.split(':', 1)
            if kind == 'object' and identity not in objects_by_id:
                continue
            if kind in ('person', 'face') and identity not in tracks_by_id:
                continue
            seen_keys.add(key)
            entries.append((kind, identity, entry['box']))
    else:
        for track in tracks_by_id.values():
            display = track.get('displayBoxes') or {}
            if track.get('personBox') or display.get('person'):
                entries.append(('person', track['id'], display.get('person') or track['personBox']))
            face_box = display.get('face') or track.get('faceBox') or (track.get('box') if track.get('boxKind') == 'face' else None)
            if face_box and track.get('faceVisibility') != 'unavailable':
                entries.append(('face', track['id'], face_box))
        for obj in objects_by_id.values():
            entries.append(('object', obj['id'], obj['box']))

    person_ids_with_box = {identity for kind, identity, _ in entries if kind == 'person'}
    pending_labels = []
    counts = {'person': 0, 'face': 0, 'object': 0}

    for kind, identity, box in entries:
        left = max(0, min(width - 1, round(box['x'] * width)))
        top = max(0, min(height - 1, round(box['y'] * height)))
        right = max(left + 1, min(width - 1, round((box['x'] + box['width']) * width)))
        bottom = max(top + 1, min(height - 1, round((box['y'] + box['height']) * height)))

        if kind == 'object':
            obj = objects_by_id.get(identity)
            if obj is None:
                continue
            counts['object'] += 1
            owner = tracks_by_id.get(obj.get('ownerId'), {})
            warning = obj.get('interaction') is not False and any(
                s.get('type') == obj.get('kind') and s.get('state') == 'confirmed'
                for s in owner.get('signals', [])
            )
            color = '#ef4444' if warning else '#2dd4bf' if obj.get('kind') == 'book' and obj.get('interaction') is not False else '#fbbf24'
            text = f"{identity} · {OBJECTS.get(obj.get('kind'), obj.get('kind', ''))}"
            cv2.rectangle(canvas, (left, top), (right, bottom), bgr(color), 2, cv2.LINE_AA)
            pending_labels.append((right, top, text, color, warning))
        else:
            track = tracks_by_id.get(identity)
            if track is None:
                continue
            counts[kind] = counts.get(kind, 0) + 1
            text, warning = caption_for_track(track)
            color = '#ef4444' if warning else '#38bdf8' if kind == 'person' else '#22c55e'
            cv2.rectangle(canvas, (left, top), (right, bottom), bgr(color), 2, cv2.LINE_AA)
            if kind == 'person' or identity not in person_ids_with_box:
                pending_labels.append((right, top, text, color, warning))

    for right, top, text, color, warning in pending_labels:
        patch = labels.patch(text, color, warning)
        ph, pw = patch.shape[:2]
        x = max(0, min(right - pw, width - pw))
        y = max(0, min(top - ph if top >= ph else top, height - ph))
        canvas[y:y + ph, x:x + pw] = patch

    return counts


def draw_hud(canvas: np.ndarray, hud_text: str):
    h, w = canvas.shape[:2]
    bar_h = 30
    overlay = canvas.copy()
    cv2.rectangle(overlay, (0, 0), (w, bar_h), (15, 23, 42), -1)
    cv2.addWeighted(overlay, 0.72, canvas, 0.28, 0, canvas)
    cv2.putText(canvas, hud_text, (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (248, 250, 252), 1, cv2.LINE_AA)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--api', required=True)
    parser.add_argument('--loop', action='store_true')
    parser.add_argument('--objects', action='store_true')
    parser.add_argument('--no-pixel-track', action='store_true')
    parser.add_argument('--width', type=int, default=1120)
    parser.add_argument('--headless-smoke', type=float, default=0.0)
    args = parser.parse_args()

    cap = cv2.VideoCapture(str(args.video))
    if not cap.isOpened():
        raise RuntimeError(f'Cannot open video: {args.video}')

    source_fps = cap.get(cv2.CAP_PROP_FPS) or 25.0
    if source_fps < 1 or source_fps > 120:
        source_fps = 25.0
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)

    session_client = ApiClient(args.api)
    track_client = ApiClient(args.api, timeout=5.0)
    detect_client = ApiClient(args.api, timeout=30.0)
    session_id = session_client.create_session(objects_enabled=args.objects)

    state_lock = threading.Lock()
    state = {
        'tracks': [],
        'objects': [],
        'memory': None,
        'ai_ms': 0.0,
        'ai_count': 0,
        'pending': None,
        'stop': False,
    }
    ai_event = threading.Event()

    def ai_worker():
        while not state['stop']:
            ai_event.wait(0.05)
            ai_event.clear()
            with state_lock:
                job = state['pending']
                state['pending'] = None
            if job is None:
                continue
            jpeg_bytes, frame_id = job
            t0 = time.perf_counter()
            try:
                result = detect_client.detect(session_id, jpeg_bytes, frame_id)
            except Exception:
                result = None
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            if result is not None:
                with state_lock:
                    state['tracks'] = result.get('tracks', [])
                    state['objects'] = result.get('objects', [])
                    state['memory'] = result.get('memory')
                    state['ai_ms'] = elapsed_ms
                    state['ai_count'] += 1

    worker = threading.Thread(target=ai_worker, daemon=True)
    worker.start()

    labels = LabelCache()
    window_name = f'Realtime Camera Preview - {args.video.name}'
    headless = args.headless_smoke > 0
    if not headless:
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
        win_w = min(args.width, src_w)
        win_h = max(240, round(win_w * src_h / max(1, src_w)))
        cv2.resizeWindow(window_name, win_w, win_h)

    paused = False
    loop_enabled = args.loop
    frame_id = 0
    current_source_idx = -1
    start_wall = time.monotonic()
    pause_offset = 0.0
    pause_started = 0.0
    shown_frames = 0
    fps_window_start = time.monotonic()
    display_fps = source_fps
    last_frame = None
    smoke_start = time.monotonic()

    try:
        while True:
            if headless and (time.monotonic() - smoke_start) >= args.headless_smoke:
                break

            if not paused:
                elapsed_video = time.monotonic() - start_wall - pause_offset
                target_idx = int(elapsed_video * source_fps)

                if target_idx <= current_source_idx and last_frame is not None:
                    sleep_s = max(0.001, (current_source_idx + 1) / source_fps - elapsed_video)
                    time.sleep(min(sleep_s, 0.015))
                else:
                    # Advance like a real 1x camera: skip stale frames if behind schedule.
                    frame = None
                    while current_source_idx < target_idx:
                        ok, grabbed = cap.read()
                        if not ok:
                            if loop_enabled:
                                cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                                current_source_idx = -1
                                start_wall = time.monotonic()
                                pause_offset = 0.0
                                ok, grabbed = cap.read()
                                if not ok:
                                    frame = None
                                    break
                                current_source_idx = 0
                                frame = grabbed
                                break
                            frame = None
                            break
                        current_source_idx += 1
                        frame = grabbed

                    if frame is None:
                        if last_frame is not None and not headless:
                            # Hold final frame briefly until user closes or restarts.
                            paused = True
                            pause_started = time.monotonic()
                        else:
                            break
                    else:
                        last_frame = frame
                        frame_id += 1
                        captured_ms = int(time.time() * 1000)

                        # Register current frame in PixelTracking BEFORE submitting to AI
                        # so seedGeometry(frameId) always finds this exact frame in history.
                        tracked_boxes = []
                        if not args.no_pixel_track:
                            try:
                                track_jpeg = encode_camera_jpeg(frame, max_dim=480, quality=72)
                                tr = track_client.track(session_id, track_jpeg, frame_id, captured_ms)
                                if tr and isinstance(tr.get('boxes'), list):
                                    tracked_boxes = tr['boxes']
                            except Exception:
                                tracked_boxes = []

                        with state_lock:
                            need_ai = state['pending'] is None
                            tracks_snapshot = list(state['tracks'])
                            objects_snapshot = list(state['objects'])
                            ai_ms = state['ai_ms']
                            ai_count = state['ai_count']

                        if need_ai:
                            detect_jpeg = encode_camera_jpeg(frame, max_dim=1280, quality=84)
                            with state_lock:
                                if state['pending'] is None:
                                    state['pending'] = (detect_jpeg, frame_id)
                                    ai_event.set()

                        canvas = frame.copy()
                        counts = draw_overlays(canvas, tracks_snapshot, objects_snapshot, tracked_boxes, labels)

                        shown_frames += 1
                        now_m = time.monotonic()
                        if now_m - fps_window_start >= 0.5:
                            display_fps = shown_frames / (now_m - fps_window_start)
                            shown_frames = 0
                            fps_window_start = now_m

                        hud = (
                            f"{args.video.name} | Cam {display_fps:4.1f}/{source_fps:.0f} FPS | "
                            f"AI {ai_ms:4.0f}ms (#{ai_count}) | "
                            f"P:{counts['person']} F:{counts['face']} O:{counts['object']} | "
                            f"[Space] Pause  [L] Loop:{'ON' if loop_enabled else 'OFF'}  [R] Restart  [Q/Esc] Quit"
                        )
                        draw_hud(canvas, hud)
                        if not headless:
                            cv2.imshow(window_name, canvas)

            if not headless:
                key = cv2.waitKey(1) & 0xFF
                if key in (ord('q'), ord('Q'), 27):
                    break
                if key == ord(' '):
                    if not paused:
                        paused = True
                        pause_started = time.monotonic()
                    else:
                        paused = False
                        pause_offset += time.monotonic() - pause_started
                elif key in (ord('l'), ord('L')):
                    loop_enabled = not loop_enabled
                elif key in (ord('r'), ord('R')):
                    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
                    current_source_idx = -1
                    start_wall = time.monotonic()
                    pause_offset = 0.0
                    paused = False
                if cv2.getWindowProperty(window_name, cv2.WND_PROP_VISIBLE) < 1:
                    break

        if headless:
            with state_lock:
                vis = [t for t in state['tracks'] if t.get('status') == 'visible']
                print(json.dumps({
                    'video': str(args.video),
                    'framesProcessed': frame_id,
                    'aiResponses': state['ai_count'],
                    'lastAiMs': round(state['ai_ms'], 1),
                    'visibleTracks': len(vis),
                    'visiblePeople': len([t for t in vis if t.get('personBox')]),
                    'visibleFaces': len([t for t in vis if t.get('faceBox') and t.get('faceVisibility') != 'unavailable']),
                    'objects': len(state['objects']),
                    'memory': state['memory'],
                }))
    finally:
        state['stop'] = True
        ai_event.set()
        worker.join(timeout=2.0)
        cap.release()
        if not headless:
            cv2.destroyAllWindows()
        session_client.delete_session(session_id)
        session_client.close()
        track_client.close()
        detect_client.close()


if __name__ == '__main__':
    main()
