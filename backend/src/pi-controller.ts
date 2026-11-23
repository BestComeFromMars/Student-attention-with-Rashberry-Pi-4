import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { PiSource } from './pi-source.js';
import { HttpError } from './errors.js';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { log } from './logger.js';

// Windows mDNS can return only an IPv6 address for all:true, while the Pi's
// HTTP controller listens on IPv4. Resolve .local explicitly without pinning DHCP IPs.
const resolvedHosts = new Map<string, { address: string; at: number }>();
export function forgetPiAddress(base: string) { resolvedHosts.delete(new URL(base).hostname); }
export async function piControlUrl(path: string, base: string) {
  const url = new URL(path, base);
  if (url.hostname.endsWith('.local')) {
    const hostname = url.hostname;
    let cached = resolvedHosts.get(hostname);
    if (!cached || Date.now() - cached.at > 60000) {
      try {
        cached = { address: (await lookup(hostname, { family: 4 })).address, at: Date.now() };
      } catch (error) {
        // A missed multicast reply must not interrupt a still-working connection.
        // A real HTTP connection failure discards this address in request().
        const fallback = process.env.PI_HOST_FALLBACK;
        if (!cached && fallback && isIP(fallback) === 4) {
          cached = { address: fallback, at: Date.now() };
          log('PI', 'Hotspot chưa phân giải tên .local; đang dùng địa chỉ dự phòng trong cấu hình riêng.', 'warn', 'pi-host-fallback');
        }
        if (!cached) throw error;
        cached.at = Date.now();
      }
      resolvedHosts.set(hostname, cached);
    }
    url.hostname = cached.address;
  }
  return url;
}

export interface PiDeviceStatus {
  deviceOnline: boolean;
  state: 'off' | 'waiting_backend' | 'starting' | 'streaming' | 'reconnecting' | 'shutting_down' | 'offline';
  desired: boolean;
  cameraReleased: boolean;
  bootId: string;
  generation: number;
  error: string | null;
}
interface Options {
  url: string; token: string; rtspUrl: string; ready: () => boolean;
  python?: string; fetcher?: typeof fetch;
}

/** One controller/decoder per backend, never one decoder per browser. */
export class PiController {
  private device: PiDeviceStatus = { deviceOnline: false, state: 'offline', desired: false,
    cameraReleased: false, bootId: '', generation: 0, error: null };
  private timer?: ReturnType<typeof setTimeout>;
  private child?: ChildProcessWithoutNullStreams;
  private closed = false;
  private poweringOff = false;
  private abort = new AbortController();
  private queue: Promise<unknown> = Promise.resolve();
  private workerEpoch = 0;
  private lastFrame = 0;
  private receivedStatusAt = 0;
  private fetcher: typeof fetch;
  private started = false;
  private reportedOffline = false;
  private consecutiveFailures = 0;
  constructor(private source: PiSource, private options: Options) {
    const url = new URL(options.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !options.token || !options.rtspUrl.startsWith('rtsp://')) throw new Error('Cấu hình Pi không hợp lệ.');
    this.fetcher = options.fetcher ?? fetch;
  }
  status(): PiDeviceStatus {
    const fresh = this.device.deviceOnline && Date.now() - this.receivedStatusAt < 9000;
    return { ...this.device, deviceOnline: fresh, state: fresh ? this.device.state : 'offline' };
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }
  private async sendOnce(path: string, body: object) {
    const response = await this.fetcher(await piControlUrl(path, this.options.url), {
      method: 'POST', headers: { Authorization: 'Bearer ' + this.options.token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(4000)]),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    const states = ['off', 'waiting_backend', 'starting', 'streaming', 'reconnecting', 'shutting_down'];
    if (!states.includes(data.state) || typeof data.desired !== 'boolean' || typeof data.camera_released !== 'boolean' ||
      typeof data.boot_id !== 'string' || !Number.isInteger(data.camera_generation)) throw new Error();
    return data;
  }
  private async request(path: string, body: object = {}, tolerant = false) {
    if (this.closed) throw new HttpError(503, 'Backend đang dừng.');
    try {
      let data: Awaited<ReturnType<PiController['sendOnce']>>;
      try {
        data = await this.sendOnce(path, body);
      } catch {
        if (this.closed) throw new Error();
        // Refresh cached .local IPv4 resolution once before declaring failure.
        forgetPiAddress(this.options.url);
        data = await this.sendOnce(path, body);
      }
      this.consecutiveFailures = 0;
      const changed = data.boot_id !== this.device.bootId || data.camera_generation !== this.device.generation;
      const previous = this.device;
      this.device = { deviceOnline: true, state: data.state, desired: data.desired,
        cameraReleased: data.camera_released, bootId: data.boot_id, generation: data.camera_generation,
        error: data.error ? 'Camera Pi đang lỗi; thiết bị sẽ tự thử lại.' : null };
      this.receivedStatusAt = Date.now();
      if (!previous.deviceOnline) log('PI', this.reportedOffline ? 'Đã kết nối lại Raspberry Pi.' : 'Đã kết nối Raspberry Pi; thiết bị sẵn sàng.');
      this.reportedOffline = false;
      if (previous.bootId && previous.bootId !== data.boot_id) log('PI', 'Phát hiện Pi vừa khởi động lại; camera mặc định tắt.');
      if (previous.state !== data.state || previous.error !== this.device.error) {
        const states: Record<string, string> = {
          off: 'Camera đã tắt, webcam được giải phóng.', waiting_backend: 'Camera đang chờ AI sẵn sàng.',
          starting: 'Đang mở webcam trên Pi.', streaming: 'Webcam Pi đang phát video.',
          reconnecting: 'Webcam Pi đang thử kết nối lại.', shutting_down: 'Pi đã nhận lệnh tắt hệ điều hành.',
        };
        log('CAMERA PI', states[data.state], data.error ? 'warn' : 'info');
      }
      if (changed || data.state !== 'streaming') this.stopReader();
      return this.status();
    } catch {
      this.consecutiveFailures += 1;
      forgetPiAddress(this.options.url);
      // Tolerate a single transient heartbeat timeout while already connected so
      // brief Wi-Fi jitter does not flicker the UI or drop the RTSP reader.
      if (tolerant && this.device.deviceOnline && this.consecutiveFailures < 2 && Date.now() - this.receivedStatusAt < 8000) {
        return this.status();
      }
      if (!this.closed && (!this.reportedOffline || this.device.deviceOnline)) log('PI',
        'Mất kết nối Raspberry Pi; tự thử lại. Webcam sẽ dừng khi heartbeat hết hạn.', 'warn');
      this.reportedOffline = true;
      this.device = { ...this.device, deviceOnline: false, state: 'offline', error: 'Chưa liên lạc được với Raspberry Pi; đang thử lại.' };
      this.stopReader();
      throw new HttpError(503, 'Không gửi được lệnh tới Raspberry Pi. Kiểm tra nguồn điện, Wi-Fi và cấu hình thiết bị.');
    }
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    void this.poll();
  }
  private async poll() {
    if (this.closed) return;
    try {
      const previousBoot = this.device.bootId;
      await this.serialize(() => this.request('/heartbeat', { ready: !this.poweringOff && this.options.ready() }, true));
      if (this.poweringOff && previousBoot && this.device.bootId !== previousBoot) this.poweringOff = false;
      if (!this.closed && !this.poweringOff && this.device.state === 'streaming' && this.options.ready()) {
        if (this.child && Date.now() - this.lastFrame > 7000) this.stopReader();
        if (!this.child) this.startReader();
      }
    } catch { /* A failed heartbeat is reflected in status; retry without flooding logs. */ }
    if (!this.closed) this.timer = setTimeout(() => { void this.poll(); }, 2000);
  }
  command(command: 'start' | 'stop' | 'shutdown') {
    return this.serialize(async () => {
      if (this.poweringOff) throw new HttpError(409, 'Pi đang tắt máy.');
      log('ĐIỀU KHIỂN', { start: 'Yêu cầu bật camera Pi.', stop: 'Yêu cầu tắt camera Pi.', shutdown: 'Người dùng đã xác nhận tắt Raspberry Pi.' }[command]);
      if (command !== 'start') this.stopReader();
      const status = await this.request('/' + command);
      if (command === 'shutdown') {
        this.poweringOff = true;
      }
      return status;
    });
  }
  private startReader() {
    const backend = fileURLToPath(new URL('../', import.meta.url));
    const python = this.options.python ?? process.env.AI_PYTHON ?? resolve(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    const epoch = ++this.workerEpoch;
    const child = spawn(python, ['-u', resolve(backend, 'ai/pi_stream.py')], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1',
        // Windows OpenCV's native runtime may not observe Python os.environ
        // changes. Supply FFmpeg options before the Python process starts.
        OPENCV_FFMPEG_LOGLEVEL: '-8',
        OPENCV_FFMPEG_CAPTURE_OPTIONS: 'rtsp_transport;tcp|fflags;nobuffer|flags;low_delay' },
    });
    this.child = child;
    this.lastFrame = Date.now();
    let buffer = Buffer.alloc(0);
    let latest: Buffer | null = null;
    let updating = false;
    let firstFrame = true;
    const drain = async () => {
      updating = true;
      try {
        while (latest && epoch === this.workerEpoch) {
          const frame = latest; latest = null;
          await this.source.update(frame, true);
          if (firstFrame && epoch === this.workerEpoch) {
            firstFrame = false;
            const size = this.source.status();
            log('VIDEO', `Đã nhận hình Pi ${size.width}×${size.height}; sẵn sàng cho web và AI.`);
          }
        }
      } catch { this.stopReader(); }
      finally { updating = false; }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (epoch !== this.workerEpoch) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (length < 4 || length > 4 * 1024 * 1024) { this.stopReader(); return; }
        if (buffer.length < length + 4) break;
        latest = Buffer.from(buffer.subarray(4, length + 4));
        buffer = buffer.subarray(length + 4);
        this.lastFrame = Date.now();
      }
      if (latest && !updating) void drain();
    });
    const failed = () => {
      if (epoch === this.workerEpoch) {
        log('VIDEO', 'Luồng đọc hình Pi bị ngắt; sẽ tự mở lại khi kết nối sẵn sàng.', 'warn', 'video-reader');
        this.stopReader();
      }
    };
    child.on('error', failed);
    child.on('close', () => {
      // close is already being emitted: do not install another close waiter.
      if (epoch === this.workerEpoch) {
        log('VIDEO', 'Tiến trình đọc hình Pi đã kết thúc; đang chờ kết nối lại.', 'warn', 'video-reader');
        this.child = undefined;
        ++this.workerEpoch;
        this.source.close();
      }
    });
    child.stdin.on('error', failed);
    child.stderr.on('data', () => {}); // Native errors can contain credential-bearing URLs.
    const rtsp = new URL(this.options.rtspUrl);
    const resolved = resolvedHosts.get(rtsp.hostname);
    if (resolved) rtsp.hostname = resolved.address;
    child.stdin.write(JSON.stringify({ url: rtsp.toString() }) + '\n');
  }
  private readers = new Set<Promise<void>>();
  private stopReader() {
    ++this.workerEpoch;
    this.source.close();
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    log('VIDEO', 'Đã dừng nhận video Pi và xóa khung hình đang giữ.');
    const stopped = new Promise<void>(resolveStopped => {
      const force = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('close', () => { clearTimeout(force); resolveStopped(); });
      child.stdin.end();
    });
    this.readers.add(stopped);
    void stopped.finally(() => this.readers.delete(stopped));
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.abort.abort();
    this.stopReader();
    if (!this.poweringOff) {
      await piControlUrl('/heartbeat', this.options.url).then(url => this.fetcher(url, { method: 'POST',
        headers: { Authorization: 'Bearer ' + this.options.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ready: false }), signal: AbortSignal.timeout(1000) })).then(r => r.text()).catch(() => {});
    }
    await Promise.all([...this.readers]);
  }
}
