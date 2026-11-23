"""Native desktop viewer playing a video as a 1x realtime camera through the
production backend AI + pixel-tracking workflow, rendering bboxes and labels
with the exact same geometry, colors, z-order, and badge styling as the web UI.
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


ALERTS = {
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
ACTIONS = {
    'slumped_on_desk': 'Gục người',
    'read': 'Đọc',
    'take_notes': 'Viết',
    'raise_hand': 'Giơ tay',
    'stand': 'Đứng',
    'turn_around': 'Quay người',
    'talk_with_others': 'Trao đổi',
    'applaud': 'Vỗ tay',
}
OBJECTS = {'phone': 'Điện thoại', 'book': 'Sách/vở', 'laptop': 'Laptop'}

FONT_SIZE = 13
LABEL_HEIGHT = 25
LABEL_PADDING = 8


def hex_to_rgb(color: str):
    return (int(color[1:3], 16), int(color[3:5], 16), int(color[5:7], 16))


def hex_to_bgr(color: str):
    r, g, b = hex_to_rgb(color)
    return (b, g, r)


def load_font(size: int = FONT_SIZE):
    for path in (
        'C:/Windows/Fonts/seguisb.ttf',
        'C:/Windows/Fonts/segoeui.ttf',
        'C:/Windows/Fonts/arialbd.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def overlay_caption(track):
    """Exact port of frontend/src/lib/overlay-caption.ts."""
    alerts = sorted(
        track.get('alerts') or [],
        key=lambda a: (0 if a.get('type') == 'upper_body_slumped' else 1, 1 if a.get('held') else 0),
    )
    alert = alerts[0] if alerts else None
    warning = bool(alert) or bool(track.get('actionAlert')) or track.get('attention') == 'needs_attention'
    action = track.get('actionAlert') or next(
        (item for item in (track.get('actions') or []) if item.get('state') == 'confirmed' and item.get('type') in ACTIONS),
        None,
    )
    if alert:
        short = ALERTS.get(alert.get('type'), alert.get('label', ''))
    elif action:
        short = ACTIONS.get(action.get('type'), action.get('label', ''))
    elif track.get('studyContext') == 'book':
        short = 'Sách/vở'
    elif warning:
        short = 'Chú ý'
    else:
        short = None
    heading = f"{track.get('id', '?')} · {short}" if short else str(track.get('id', '?'))
    return {
        'heading': heading,
        'warning': warning,
        'color': '#ef4444' if warning else '#38bdf8',
        'background': '#7f1d1d' if warning else '#0f172a',
    }


def top_right_label(box_px, label_w, label_h, viewport_w, viewport_h):
    """Exact port of frontend/src/lib/overlay-anchor.ts."""
    bx, by, bw, _bh = box_px
    x = max(0, min(round(bx + bw - label_w), viewport_w - label_w))
    y = max(0, min(round(by - label_h if by >= label_h else by), viewport_h - label_h))
    return int(x), int(y)


class LabelCache:
    """Renders translucent rounded badges matching frontend/src/components/OverlayLabel.tsx."""
    def __init__(self):
        self.font = load_font(FONT_SIZE)
        self.cache = {}

    def patch(self, text: str, background: str, accent: str):
        key = (text, background, accent)
        hit = self.cache.get(key)
        if hit is not None:
            return hit
        if len(self.cache) > 256:
            self.cache.clear()
        text_w = self.font.getlength(text)
        width = max(28, int(round(text_w + LABEL_PADDING * 2)))
        height = LABEL_HEIGHT
        image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        bg_rgb = hex_to_rgb(background)
        ac_rgb = hex_to_rgb(accent)
        draw.rounded_rectangle(
            (0, 0, width - 1, height - 1),
            radius=2,
            fill=(*bg_rgb, int(round(255 * 0.94))),
            outline=(*ac_rgb, int(round(255 * 0.80))),
            width=1,
        )
        draw.text((LABEL_PADDING, 4), text, font=self.font, fill=(248, 250, 252, 255))
        rgba = np.asarray(image)
        bgr_arr = rgba[:, :, [2, 1, 0]].astype(np.float32)
        alpha = (rgba[:, :, 3:4].astype(np.float32)) / 255.0
        entry = (bgr_arr, alpha, width, height)
        self.cache[key] = entry
        return entry


def blend_patch(canvas: np.ndarray, patch_entry, x: int, y: int):
    bgr_arr, alpha, pw, ph = patch_entry
    h, w = canvas.shape[:2]
    if x >= w or y >= h or x + pw <= 0 or y + ph <= 0:
        return
    sx0, sy0 = max(0, -x), max(0, -y)
    dx0, dy0 = max(0, x), max(0, y)
    cw = min(pw - sx0, w - dx0)
    ch = min(ph - sy0, h - dy0)
    if cw <= 0 or ch <= 0:
        return
    roi = canvas[dy0:dy0 + ch, dx0:dx0 + cw].astype(np.float32)
    src = bgr_arr[sy0:sy0 + ch, sx0:sx0 + cw]
    a = alpha[sy0:sy0 + ch, sx0:sx0 + cw]
    canvas[dy0:dy0 + ch, dx0:dx0 + cw] = np.clip(src * a + roi * (1.0 - a), 0, 255).astype(np.uint8)


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


def encode_camera_jpeg(frame: np.ndarray, max_dim: int = 1280, quality: int = 84) -> bytes:
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


def current_geometry(tracks: list, objects: list, tracked_boxes: list, use_pixel_track: bool):
    """Exact port of frontend/src/lib/current-geometry.ts."""
    if not use_pixel_track:
        shown_tracks = [
            t for t in tracks
            if t.get('status') == 'visible' and t.get('trackingState') != 'predicted'
        ]
        return shown_tracks, list(objects)

    boxes = {entry['key']: entry['box'] for entry in tracked_boxes if 'key' in entry and 'box' in entry}
    shown_tracks = []
    for track in tracks:
        if track.get('trackingState') == 'predicted':
            continue
        person_box = boxes.get(f"person:{track['id']}")
        face_box = boxes.get(f"face:{track['id']}")
        box = person_box or face_box
        if not box:
            continue
        shown_tracks.append({
            **track,
            'box': box,
            'personBox': person_box,
            'faceBox': face_box,
            'boxKind': 'person' if person_box else 'face',
            'displayBoxes': None,
            'status': 'visible',
            'faceVisibility': 'visible' if face_box else 'unavailable',
            'trackingState': 'face' if face_box else 'visual',
        })
    shown_objects = []
    for obj in objects:
        box = boxes.get(f"object:{obj['id']}")
        if box:
            shown_objects.append({**obj, 'box': box, 'displayBox': None})
    return shown_tracks, shown_objects


def rect_px(box, width: int, height: int):
    x = box['x'] * width
    y = box['y'] * height
    w = box['width'] * width
    h = box['height'] * height
    left = max(0, min(width - 1, int(round(x))))
    top = max(0, min(height - 1, int(round(y))))
    right = max(left + 1, min(width - 1, int(round(x + w))))
    bottom = max(top + 1, min(height - 1, int(round(y + h))))
    return (x, y, w, h), (left, top, right, bottom)


def draw_overlays(canvas: np.ndarray, tracks: list, objects: list, tracked_boxes: list, labels: LabelCache, use_pixel_track: bool):
    """Draw boxes & labels matching PersonOverlay, FaceOverlay, ObjectOverlay, OverlayLabel."""
    height, width = canvas.shape[:2]
    shown_tracks, shown_objects = current_geometry(tracks, objects, tracked_boxes, use_pixel_track)
    tracks_by_id = {t['id']: t for t in shown_tracks}

    counts = {'person': 0, 'face': 0, 'object': 0}
    person_labels = []
    face_labels = []
    object_labels = []

    # Layer 1: Person frames (normal first, warnings on top; 1px/2px stroke like SVG 1.5/2).
    person_tracks = [t for t in shown_tracks if t.get('personBox') and t.get('status') == 'visible']
    person_tracks.sort(key=lambda t: 1 if (t.get('alerts') or t.get('actionAlert') or t.get('attention') == 'needs_attention') else 0)
    for track in person_tracks:
        counts['person'] += 1
        cap = overlay_caption(track)
        box = (track.get('displayBoxes') or {}).get('person') or track['personBox']
        box_f, (l, t, r, b) = rect_px(box, width, height)
        thickness = 2 if cap['warning'] else 1
        cv2.rectangle(canvas, (l, t), (r, b), hex_to_bgr(cap['color']), thickness, cv2.LINE_AA)
        person_labels.append((cap['warning'], box_f, cap['heading'], cap['background'], cap['color']))

    # Layer 2: Face frames (#22c55e green normal / #ef4444 red warning, 2px stroke).
    for track in shown_tracks:
        face_box = (track.get('displayBoxes') or {}).get('face') or track.get('faceBox') or (
            track.get('box') if track.get('boxKind') == 'face' else None
        )
        if not face_box or track.get('faceVisibility') == 'unavailable':
            continue
        counts['face'] += 1
        cap = overlay_caption(track)
        box_f, (l, t, r, b) = rect_px(face_box, width, height)
        stroke = '#ef4444' if cap['warning'] else '#22c55e'
        cv2.rectangle(canvas, (l, t), (r, b), hex_to_bgr(stroke), 2, cv2.LINE_AA)
        if not track.get('personBox'):
            face_labels.append((cap['warning'], box_f, cap['heading'], cap['background'], cap['color']))

    # Layer 3: Object frames (matches ObjectOverlay.tsx).
    for obj in shown_objects:
        counts['object'] += 1
        owner = tracks_by_id.get(obj.get('ownerId'), {})
        candidate = obj.get('interaction') is False
        confirmed = (
            not candidate
            and obj.get('kind') != 'book'
            and any(s.get('type') == obj.get('kind') and s.get('state') == 'confirmed' for s in (owner.get('signals') or []))
        )
        color = '#2dd4bf' if obj.get('kind') == 'book' and not candidate else '#ef4444' if confirmed else '#fbbf24'
        bg = '#7f1d1d' if confirmed else '#0f172a'
        box = obj.get('displayBox') or obj['box']
        box_f, (l, t, r, b) = rect_px(box, width, height)
        cv2.rectangle(canvas, (l, t), (r, b), hex_to_bgr(color), 1, cv2.LINE_AA)
        text = f"{obj['id']} · {OBJECTS.get(obj.get('kind'), obj.get('kind', ''))}"
        object_labels.append((confirmed, box_f, text, bg, color))

    # Layer 4: Badges (normal first, warnings on top, exact topRightLabel placement).
    all_labels = face_labels + object_labels + person_labels
    all_labels.sort(key=lambda item: 1 if item[0] else 0)
    for _warning, box_f, heading, bg, accent in all_labels:
        patch_entry = labels.patch(heading, bg, accent)
        _, _, pw, ph = patch_entry
        lx, ly = top_right_label(box_f, pw, ph, width, height)
        blend_patch(canvas, patch_entry, lx, ly)

    return counts


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
    src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280)
    src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720)
    win_w = min(args.width, src_w)
    win_h = max(240, round(win_w * src_h / max(1, src_w)))

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
        'ai_fps': 0.0,
        'ai_times': [],
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
                now_m = time.monotonic()
                with state_lock:
                    state['tracks'] = result.get('tracks', [])
                    state['objects'] = result.get('objects', [])
                    state['memory'] = result.get('memory')
                    state['ai_ms'] = elapsed_ms
                    state['ai_count'] += 1
                    times = [t for t in state['ai_times'] if now_m - t <= 5.0]
                    times.append(now_m)
                    state['ai_times'] = times
                    state['ai_fps'] = (len(times) - 1) / max(0.25, times[-1] - times[0]) if len(times) > 1 else (1000.0 / max(1.0, elapsed_ms))

    worker = threading.Thread(target=ai_worker, daemon=True)
    worker.start()

    labels = LabelCache()
    window_name = f'StudentAttention - {args.video.name}'
    headless = args.headless_smoke > 0
    if not headless:
        cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
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
    last_title_at = 0.0
    smoke_start = time.monotonic()
    use_pixel_track = not args.no_pixel_track

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
                            paused = True
                            pause_started = time.monotonic()
                        else:
                            break
                    else:
                        last_frame = frame
                        frame_id += 1
                        captured_ms = int(time.time() * 1000)

                        tracked_boxes = []
                        if use_pixel_track:
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
                            ai_fps = state['ai_fps']
                            ai_count = state['ai_count']

                        if need_ai:
                            detect_jpeg = encode_camera_jpeg(frame, max_dim=1280, quality=84)
                            with state_lock:
                                if state['pending'] is None:
                                    state['pending'] = (detect_jpeg, frame_id)
                                    ai_event.set()

                        # Resize to viewport size BEFORE drawing so strokes & labels match the web SVG 1:1.
                        if frame.shape[1] != win_w or frame.shape[0] != win_h:
                            canvas = cv2.resize(frame, (win_w, win_h), interpolation=cv2.INTER_AREA)
                        else:
                            canvas = frame.copy()
                        counts = draw_overlays(canvas, tracks_snapshot, objects_snapshot, tracked_boxes, labels, use_pixel_track)

                        shown_frames += 1
                        now_m = time.monotonic()
                        if now_m - fps_window_start >= 0.5:
                            display_fps = shown_frames / (now_m - fps_window_start)
                            shown_frames = 0
                            fps_window_start = now_m

                        if not headless:
                            cv2.imshow(window_name, canvas)
                            if now_m - last_title_at >= 0.4:
                                last_title_at = now_m
                                title = (
                                    f"{args.video.name} | {counts['person']} nguoi · {counts['face']} mat | "
                                    f"AI: {ai_fps:.1f} lan/s · {ai_ms/1000:.2f}s | Cam: {display_fps:.0f} FPS | "
                                    f"[Space] Tam dung  [L] Lap:{'ON' if loop_enabled else 'OFF'}  [R] Lai  [Q] Thoat"
                                )
                                cv2.setWindowTitle(window_name, title)

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
