import { PI_DEVICE } from './types';
import type { CameraState, DetectionState, PersonDetector, StudentTrack, PiStatus, TrackedObject } from './types';
import {AttentionCaptures,captureFace,type AttentionCapture} from './attention-captures';
import {DetectionHistory} from './history';
import {FrameEncoder} from './frame-encoder';
import {currentGeometry} from './current-geometry';
import type {CameraFrame} from './pixel-camera';

export const PI_SHUTDOWN_WAIT_MS=20000;

export interface SessionSnapshot {
  memory?:import('./types').MemoryStatus;
  camera: CameraState;
  detection: DetectionState;
  error: string | null;
  tracks: StudentTrack[];
  captures?:AttentionCapture[];
  objects?: TrackedObject[];
  devices: { deviceId: string; label: string }[];
  selectedDevice: string;
  cameraLabel: string;
  resolution: { width: number; height: number } | null;
  fps: number;
  startedAt: number | null;
  pi?: PiStatus;
  piMessage?: string;
  piStopping?: boolean;
  piShuttingDown?: boolean;
  piShutdownRemaining?:number;
  piShutdownOffline?:boolean;
  piStreamVersion?: number;
  trackingVersion?: number;
  frameReady?:boolean;
  resultFrameAt?:number;
  inferenceMs?:number;
  retrying?:boolean;
  discoveringDevices?: boolean;
  deviceDiscoveryMessage?: string;
  devicesNeedRefresh?: boolean;
}

interface Dependencies {
  history?:DetectionHistory|false;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  createDetector: (source: string) => Promise<PersonDetector>;
  now: () => number;
}

function cameraError(error: unknown): string {
  const name = error instanceof Error || (typeof error === 'object' && error !== null && 'name' in error)
    ? String(error.name) : '';
  switch (name) {
    case 'NotAllowedError': return 'Quyền camera chưa được cấp. Cho phép camera trong thanh địa chỉ rồi thử lại.';
    case 'NotFoundError': return 'Không tìm thấy webcam. Hãy kết nối camera rồi thử lại.';
    case 'NotReadableError': return 'Camera đang bận hoặc không thể truy cập. Đóng ứng dụng khác đang dùng camera rồi thử lại.';
    case 'OverconstrainedError': return 'Camera đã chọn không còn khả dụng. Hãy chọn một camera khác.';
    case 'CameraPreviewError': return 'Camera đã được cấp quyền nhưng chưa phát hình. Thử lại hoặc chọn webcam khác.';
    case 'SecurityError': return 'Trình duyệt đang chặn camera. Mở ứng dụng tại http://localhost:3000 và kiểm tra quyền truy cập.';
    default: return 'Không thể mở camera. Kiểm tra thiết bị và quyền camera của trình duyệt.';
  }
}

export class ObservationSession {
  private state: SessionSnapshot = {
    camera: 'off', detection: 'idle', error: null, tracks: [], objects:[], devices: [],
    selectedDevice: PI_DEVICE, cameraLabel: '', resolution: null, fps: 0, startedAt: null,
  };
  private listeners = new Set<() => void>();
  private names = new Map<string, string>();
  private captures=new AttentionCaptures();
  readonly history?:DetectionHistory;
  private portraitEncoder:FrameEncoder|null=null;
  private portraitTasks=0;
  private portraitPublish:ReturnType<typeof setTimeout>|undefined;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private piImage:HTMLImageElement|null=null;
  private resultCanvas:HTMLCanvasElement|null=null;
  private presenter:((frame:import('./pixel-camera').CameraFrame|null)=>void)|null=null;
  attachPresenter=(present:(frame:import('./pixel-camera').CameraFrame|null)=>void)=>{
    this.presenter=present;return ()=>{if(this.presenter===present)this.presenter=null;};
  };
  private startPixelTracking=()=>this.detector?.startTracking?.(this.video,this.state.selectedDevice===PI_DEVICE?this.piImage:null,
    frame=>{this.presenter?.(frame);if(frame)this.capturePortraits(frame);});
  private newCaptures(){
    const runId=this.history?.getSnapshot().activeId;
    this.captures=new AttentionCaptures(captureFace,runId?capture=>this.history?.enqueue(runId,capture):undefined);
  }
  private beginHistory(){
    if(this.history&&!this.history.getSnapshot().activeId){
      this.history.begin(this.state.selectedDevice===PI_DEVICE?'pi':'webcam',this.state.cameraLabel||'Camera');this.newCaptures();
    }
  }
  private capturePortraits(frame:CameraFrame){
    if(this.state.detection!=='running'||this.portraitTasks>=40)return;
    const store=this.captures,now=this.dependencies.now(),wallAt=Date.now();
    const tracks=currentGeometry(this.state.tracks,[],frame).tracks;
    for(const track of tracks){
      if(this.portraitTasks>=40)break;
      const captureId=store.portraitDue(track,now),box=track.faceBox;if(!captureId||!box)continue;
      const w=box.width*frame.image.width,h=box.height*frame.image.height;if(Math.min(w,h)<16)continue;
      const side=Math.round(Math.min(frame.image.width,frame.image.height,Math.max(w,h)*1.2));
      const x=Math.round(Math.max(0,Math.min(frame.image.width-side,(box.x+box.width/2)*frame.image.width-side/2)));
      const y=Math.round(Math.max(0,Math.min(frame.image.height-side,(box.y+box.height/2)*frame.image.height-side/2)));
      const runId=this.history?.getSnapshot().activeId,release=runId?this.history?.hold(runId):undefined;
      this.portraitTasks++;
      const encoded=(async()=>{
        if(!this.portraitEncoder&&typeof Worker!=='undefined'&&typeof OffscreenCanvas!=='undefined')this.portraitEncoder=new FrameEncoder();
        if(this.portraitEncoder){
          const result=await this.portraitEncoder.encodeCrop(frame.image,x,y,side,side);result.bitmap.close();
          return new Promise<string>((yes,no)=>{const reader=new FileReader();reader.onload=()=>yes(String(reader.result));reader.onerror=()=>no(reader.error);reader.readAsDataURL(result.image);});
        }
        // Fallback only: resize the crop before JPEG encoding, never a full-frame readback.
        const canvas=document.createElement('canvas');canvas.width=canvas.height=160;
        canvas.getContext('2d')?.drawImage(frame.image,x,y,side,side,0,0,160,160);
        return canvas.toDataURL('image/jpeg',.82);
      })();
      void encoded.then(photo=>{
        if(store.setPortrait(track,photo,now,wallAt,captureId)&&this.captures===store&&!this.disposed&&this.portraitPublish===undefined){
          this.portraitPublish=setTimeout(()=>{this.portraitPublish=undefined;if(this.captures===store&&!this.disposed)this.publish({captures:store.snapshot()});},50);
        }
      }).catch(()=>{}).finally(()=>{this.portraitTasks--;release?.();});
    }
  }
  private deviceEnumerationEpoch = 0;
  private deviceDiscoveryEpoch = 0;
  private deviceDiscovery: Promise<void> | null = null;
  private releaseDeviceDiscovery: (() => void) | null = null;
  private cameraEpoch = 0;
  private epoch = 0;
  private detector: PersonDetector | null = null;
  private detectorPromise: Promise<PersonDetector> | null = null;
  private inference: Promise<StudentTrack[]> | null = null;
  private frameFailures=0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private videoFrameWait:{video:HTMLVideoElement;id:number}|null=null;
  private samples: number[] = [];
  private disposed = false;
  private cancelPreview: (() => void) | null = null;
  private readonly dependencies: Dependencies;
  private piRequested = false;
  private piDetectionWanted = false;
  private piDetectorEpoch = 0;
  private piStopPending = false;
  private piTimer: ReturnType<typeof setTimeout> | undefined;
  private piPowerTimer:ReturnType<typeof setTimeout>|undefined;
  private piShutdownTick:ReturnType<typeof setTimeout>|undefined;
  private piShutdownDeadline=0;
  private piShutdownBootId='';
  private piShutdownMonitoring=true;
  private piQueue: Promise<unknown> = Promise.resolve();
  private piStartAbort: AbortController | null = null;

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.history=dependencies.history===false?undefined:dependencies.history??new DetectionHistory();
    this.dependencies = {
      getUserMedia: constraints => {
        if (!navigator.mediaDevices?.getUserMedia) {
          return Promise.reject(new DOMException('Camera unavailable', 'SecurityError'));
        }
        return navigator.mediaDevices.getUserMedia(constraints);
      },
      enumerateDevices: () => navigator.mediaDevices?.enumerateDevices?.() ?? Promise.resolve([]),
      createDetector: async source => (await import('./backend-api')).createDetector(source),
      now: () => performance.now(),
      ...dependencies,
    };
  }

  getSnapshot = (): SessionSnapshot => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  attachVideo = (video: HTMLVideoElement | null) => {
    this.video = video;
    if (video) {
      video.srcObject = this.stream;
      if (this.stream) void video.play().catch(() => {});
    }
  };
  attachPiImage=(image:HTMLImageElement|null)=>{this.piImage=image;};
  attachResultCanvas=(canvas:HTMLCanvasElement|null)=>{this.resultCanvas=canvas;};
  private clearResultFrame(){if(this.resultCanvas){this.resultCanvas.width=0;this.resultCanvas.height=0;}}

  private publish(update: Partial<SessionSnapshot>) {
    if (this.disposed) return;
    const events = [
      update.camera === 'on' && this.state.camera !== 'on' ? 'camera_on' : null,
      update.camera === 'off' && this.state.camera === 'on' ? 'camera_off' : null,
      update.detection === 'running' && this.state.detection !== 'running' ? 'detection_running' : null,
      update.detection === 'paused' && this.state.detection === 'running' ? 'detection_paused' : null,
      update.error && update.error !== this.state.error ? 'camera_error' : null,
    ].filter(Boolean);
    for (const event of events) {
      // Best effort only; no old events are queued while the backend is absent.
      try { void fetch('/api/client/events', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client-Event': '1' },
        body: JSON.stringify({ event, source: this.state.selectedDevice === PI_DEVICE ? 'pi' : 'computer' }),
        keepalive: true, signal: AbortSignal.timeout(2000) }).catch(() => {}); } catch { /* Browser is closing. */ }
    }
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener());
  }

  async refreshDevices(reportErrors = false) {
    const request = ++this.deviceEnumerationEpoch;
    try {
      const devices = (await this.dependencies.enumerateDevices())
        .filter(device => device.kind === 'videoinput')
        .map(device => ({ deviceId: device.deviceId, label: device.label }));
      if (this.disposed) return;
      const selectedMissing = this.state.camera === 'off' && this.state.selectedDevice &&
        this.state.selectedDevice !== PI_DEVICE && devices.every(device => device.deviceId) &&
        !devices.some(device => device.deviceId === this.state.selectedDevice);
      if (request === this.deviceEnumerationEpoch) this.publish({ devices, devicesNeedRefresh: false,
        ...(selectedMissing ? { selectedDevice: '' } : {}) });
      return devices;
    } catch (error) {
      if (reportErrors) throw error;
      // Some browsers withhold this list until permission is granted.
    }
  }

  markDevicesChanged() {
    if (!this.state.devicesNeedRefresh) this.publish({ devicesNeedRefresh: true });
  }

  discoverDevices() {
    if (this.disposed) return Promise.resolve();
    if (this.deviceDiscovery) return this.deviceDiscovery;
    const request = ++this.deviceDiscoveryEpoch;
    const current = () => !this.disposed && request === this.deviceDiscoveryEpoch;
    const run = async () => {
      let temporary: MediaStream | null = null;
      const release = () => {
        const stream = temporary;
        temporary = null;
        stream?.getTracks().forEach(track => track.stop());
        if (this.releaseDeviceDiscovery === release) this.releaseDeviceDiscovery = null;
      };
      this.releaseDeviceDiscovery = release;
      this.publish({ discoveringDevices: true, deviceDiscoveryMessage: undefined });
      try {
        const initial = await this.refreshDevices(true);
        if (!current()) return;
        let listed = initial;
        // Device names and non-default cameras can be hidden before permission.
        // Probe only after the explicit menu action; never attach this stream
        // to preview or inference, and enumerate while its permission is live.
        if (!this.stream && !initial?.some(device => device.deviceId && device.label)) {
          temporary = await this.dependencies.getUserMedia({ audio: false, video: true });
          if (!current()) return;
          listed = await this.refreshDevices(true);
        }
        if (!current()) return;
        const count = new Set((listed ?? []).filter(device => device.deviceId).map(device => device.deviceId)).size;
        this.publish({ deviceDiscoveryMessage: count
          ? 'Đã cập nhật danh sách. Chọn camera rồi bấm Bật camera.'
          : 'Trình duyệt chưa cung cấp camera. Kiểm tra quyền camera và kết nối thiết bị.' });
      } catch (error) {
        if (current()) this.publish({ deviceDiscoveryMessage: cameraError(error) });
      } finally {
        release();
        if (current()) this.publish({ discoveringDevices: false });
      }
    };
    const pending = run();
    this.deviceDiscovery = pending;
    void pending.finally(() => { if (this.deviceDiscovery === pending) this.deviceDiscovery = null; });
    return pending;
  }

  private async startPreview(video: HTMLVideoElement, stream: MediaStream, request: number) {
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel!: () => void;
    const cancelled = new Promise<void>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Camera preview timed out')), 10000);
      cancel = () => reject(new DOMException('Camera preview cancelled', 'AbortError'));
    });
    this.cancelPreview = cancel;
    try {
      await Promise.race([video.play(), cancelled]);
    } catch (error) {
      if (request !== this.cameraEpoch || this.disposed) throw error;
      throw new DOMException('Camera preview did not start', 'CameraPreviewError');
    } finally {
      clearTimeout(timer);
      if (this.cancelPreview === cancel) this.cancelPreview = null;
    }
  }

  async startCamera() {
    if (this.disposed || this.state.camera !== 'off') return;
    const request = ++this.cameraEpoch;
    this.publish({ camera: 'requesting', error: null });
    try {
      if (this.state.selectedDevice === PI_DEVICE) {
        this.piRequested = true;
        this.piStopPending = false;
        await this.piCommand('start');
        if (request !== this.cameraEpoch || this.disposed) return;
        await this.pollPi();
        return;
      }
      const deviceId = this.state.selectedDevice;
      const selected = deviceId ? { deviceId: { exact: deviceId } } : {};
      let stream: MediaStream;
      try {
        stream = await this.dependencies.getUserMedia({
          audio: false,
          video: {
            width: { ideal: Number(import.meta.env.VITE_CAMERA_WIDTH)||1920 },
            height: { ideal: Number(import.meta.env.VITE_CAMERA_HEIGHT)||1080 }, frameRate: { ideal: 30 },
            ...selected,
          },
        });
      } catch (error) {
        if (request !== this.cameraEpoch || this.disposed) return;
        if (!error || typeof error !== 'object' || !('name' in error) || error.name !== 'OverconstrainedError') throw error;
        // Keep the chosen device, but drop resolution/FPS preferences for older drivers.
        stream = await this.dependencies.getUserMedia({ audio: false,
          video: deviceId ? selected : true });
      }
      if (request !== this.cameraEpoch || this.disposed) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach(item => item.stop());
        throw new Error('No video track');
      }
      this.stream = stream;
      const settings = track.getSettings();
      track.addEventListener('ended', () => {
        if (this.stream !== stream) return;
        this.stopCamera();
        this.publish({ error: 'Camera đã ngắt kết nối. Kết nối lại thiết bị rồi bấm Bật camera.' });
      }, { once: true });
      if (this.video) {
        await this.startPreview(this.video, stream, request);
      }
      if (request !== this.cameraEpoch || this.disposed) return;
      this.publish({
        camera: 'on', cameraLabel: track.label || 'Webcam',
        selectedDevice: settings.deviceId || this.state.selectedDevice,
        resolution: { width: settings.width || 1280, height: settings.height || 720 },
        startedAt: Date.now(),
      });
    } catch (error) {
      if (request !== this.cameraEpoch || this.disposed) return;
      this.stopCamera();
      this.publish({ error: this.state.selectedDevice === PI_DEVICE && error instanceof Error ? error.message : cameraError(error) });
    }
  }

  stopCamera(sendPiCommand = true) {
    this.history?.end();
    this.piStartAbort?.abort();
    this.piStartAbort=null;
    ++this.deviceEnumerationEpoch;
    ++this.deviceDiscoveryEpoch;
    this.deviceDiscovery = null;
    this.releaseDeviceDiscovery?.();
    this.clearResultFrame();
    const stopPi = this.state.selectedDevice === PI_DEVICE && (this.piRequested || this.state.camera !== 'off');
    this.piRequested = false;
    this.piDetectionWanted = false;
    clearTimeout(this.piTimer);
    ++this.cameraEpoch;
    this.invalidate();
    this.cancelPreview?.();
    this.cancelPreview = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.detector?.dispose();
    this.detector = null;
    this.detectorPromise = null;
    this.names.clear();
    this.newCaptures();
    this.samples = [];
    this.publish({
      camera: 'off', detection: 'idle', tracks: [], captures:[],objects:[],memory:undefined, fps: 0,frameReady:false,retrying:false, discoveringDevices: false,
      resolution: null, cameraLabel: '', startedAt: null, error: null,
      piMessage: undefined,
    });
    if (stopPi && sendPiCommand) {
      this.piStopPending = true;
      this.publish({ piStopping: true });
      void this.sendPiStop();
    }
  }

  private piCommand(command: 'start' | 'stop' | 'shutdown') {
    const cameraEpoch=this.cameraEpoch;
    const run = this.piQueue.then(async () => {
      if(command==='start'&&(cameraEpoch!==this.cameraEpoch||this.state.selectedDevice!==PI_DEVICE||!this.piRequested))
        throw new DOMException('Pi source no longer active','AbortError');
      const abort=command==='start'?new AbortController():null;
      if(abort)this.piStartAbort=abort;
      try {
        const response = await fetch(command === 'shutdown' ? '/api/pi/shutdown' : '/api/pi/camera/' + command, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pi-Control': '1' },
          body: JSON.stringify(command === 'shutdown' ? { confirm: true } : {}),
          keepalive: true, signal: abort?AbortSignal.any([abort.signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? 'Không gửi được lệnh tới Raspberry Pi.');
        return data;
      } finally {
        if(this.piStartAbort===abort)this.piStartAbort=null;
      }
    });
    this.piQueue = run.catch(() => {});
    return run;
  }

  private async sendPiStop() {
    if (!this.piStopPending) return;
    try {
      const device = await this.piCommand('stop');
      if (this.piRequested) return;
      this.piStopPending = false;
      if(this.state.selectedDevice!==PI_DEVICE)return;
      this.publish({ piStopping: false, piMessage: device.cameraReleased ? 'Webcam Pi đã dừng.' : 'Đang giải phóng webcam Pi…' });
    } catch {
      if (!this.disposed && this.state.selectedDevice===PI_DEVICE && !this.piRequested && this.piStopPending) {
        this.publish({ piMessage: 'Chưa gửi được lệnh tắt. Đang thử lại; Pi sẽ dừng webcam khi mất heartbeat.' });
        this.piTimer = setTimeout(() => { void this.sendPiStop(); }, 2000);
      }
    }
  }

  private releasePiDetector() {
    if(this.state.selectedDevice!==PI_DEVICE)return;
    ++this.piDetectorEpoch;
    this.invalidate();
    this.detector?.dispose();
    this.detector = null;
    this.detectorPromise = null;
    this.names.clear();
    this.newCaptures();this.publish({captures:[],memory:undefined});
    this.samples = [];
  }

  private async pollPi() {
    clearTimeout(this.piTimer);
    if (!this.piRequested || this.disposed || this.state.selectedDevice !== PI_DEVICE) return;
    const request = this.cameraEpoch;
    try {
      const response = await fetch('/api/pi/status', { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const source: PiStatus = await response.json();
      if (typeof source.online !== 'boolean' || typeof source.bootId !== 'string') throw new Error();
      if (request !== this.cameraEpoch || !this.piRequested || this.disposed) return;
      const previous = this.state.pi;
      if (previous?.bootId && source.bootId && source.bootId !== previous.bootId) {
        this.stopCamera(false);
        this.publish({ pi: source, piMessage: 'Pi vừa khởi động lại. Bấm Bật camera để bắt đầu phiên mới.' });
        return;
      }
      if (source.deviceOnline && !source.desired) {
        this.stopCamera(false);
        this.publish({ pi: source, piMessage: 'Webcam Pi đã tắt.' });
        return;
      }
      if (previous && source.generation !== previous.generation) this.releasePiDetector();
      this.publish({ pi: source });
      if (!source.online || source.state !== 'streaming') {
        if (this.state.camera === 'on') this.releasePiDetector();
        this.publish({ camera: 'requesting', tracks: [], objects:[], fps: 0,
          detection: this.piDetectionWanted ? 'paused' : 'idle',
          piMessage: source.error ?? (source.state === 'waiting_backend' ? 'Đang chờ AI sẵn sàng…' : 'Đang kết nối lại Raspberry Pi…') });
      } else {
        const restored = this.state.camera !== 'on' || previous?.generation !== source.generation;
        this.publish({ camera: 'on', cameraLabel: 'Raspberry Pi 4', error: null, piMessage: 'Raspberry Pi đang phát hình.',
          startedAt: this.state.startedAt ?? Date.now(), resolution: { width: source.width, height: source.height },
          ...(restored ? { piStreamVersion: (this.state.piStreamVersion ?? 0) + 1 } : {}) });
        if (this.piDetectionWanted && this.state.detection !== 'running' && this.state.detection !== 'loading') void this.startDetection();
        else if (this.piDetectionWanted && restored) {
          this.publish({ detection: 'paused' });
          void this.startDetection();
        }
      }
    } catch {
      if (request !== this.cameraEpoch || !this.piRequested || this.disposed) return;
      this.releasePiDetector();
      this.publish({ camera: 'requesting', tracks: [], objects:[], fps: 0, detection: this.piDetectionWanted ? 'paused' : 'idle',
        piMessage: 'Mất kết nối. Hệ thống sẽ tự tiếp tục khi Pi và backend sẵn sàng.' });
    } finally {
      if (request === this.cameraEpoch && this.piRequested && !this.disposed) this.piTimer = setTimeout(() => { void this.pollPi(); }, 1500);
    }
  }

  piStreamError() {
    if (!this.piRequested || this.disposed || this.state.selectedDevice!==PI_DEVICE) return;
    this.releasePiDetector();
    this.publish({ camera: 'requesting', tracks: [], objects:[], fps: 0, detection: this.piDetectionWanted ? 'paused' : 'idle' });
  }

  async shutdownPi() {
    if (this.state.piShuttingDown) return;
    if (this.state.selectedDevice === PI_DEVICE) this.stopCamera(false);
    this.piStopPending = false;
    this.publish({ piShuttingDown: true,piShutdownRemaining:undefined,piShutdownOffline:false, piMessage: 'Đang gửi lệnh tắt Raspberry Pi…' });
    try {
      const accepted=await this.piCommand('shutdown');
      if(this.disposed)return;
      this.piShutdownBootId=accepted.bootId??this.state.pi?.bootId??'';
      this.piShutdownDeadline=this.dependencies.now()+PI_SHUTDOWN_WAIT_MS;
      this.updatePiShutdownCountdown();
      this.publish({ piMessage: 'Pi đã nhận lệnh tắt; đang chờ và kiểm tra kết nối.' });
      this.watchPiPowerCycle();
    } catch (error) {
      clearTimeout(this.piShutdownTick);
      this.publish({ piShuttingDown: false,piShutdownRemaining:undefined,piShutdownOffline:undefined, ...(this.state.selectedDevice===PI_DEVICE
        ?{error:error instanceof Error ? error.message : 'Không gửi được lệnh tắt Pi.'}:{}) });
    }
  }

  private updatePiShutdownCountdown(){
    clearTimeout(this.piShutdownTick);
    if(this.disposed||!this.piShutdownMonitoring||!this.state.piShuttingDown)return;
    const remaining=Math.max(0,Math.ceil((this.piShutdownDeadline-this.dependencies.now())/1000));
    this.publish({piShutdownRemaining:remaining});
    if(remaining)this.piShutdownTick=setTimeout(()=>this.updatePiShutdownCountdown(),1000);
  }

  setPiShutdownMonitoring(enabled:boolean){
    this.piShutdownMonitoring=enabled;
    clearTimeout(this.piShutdownTick);clearTimeout(this.piPowerTimer);
    if(enabled&&this.state.piShuttingDown&&this.piShutdownDeadline){this.updatePiShutdownCountdown();this.watchPiPowerCycle();}
  }

  private watchPiPowerCycle() {
    clearTimeout(this.piPowerTimer);
    if (this.disposed || !this.piShutdownMonitoring || !this.state.piShuttingDown) return;
    this.piPowerTimer = setTimeout(() => {
      void fetch('/api/pi/status', { signal: AbortSignal.timeout(5000) }).then(r => {if(!r.ok)throw new Error();return r.json();}).then((pi: PiStatus) => {
        if(this.disposed||!this.piShutdownMonitoring||!this.state.piShuttingDown||typeof pi.deviceOnline!=='boolean')return;
        const newBoot=Boolean(this.piShutdownBootId&&pi.bootId&&pi.bootId!==this.piShutdownBootId);
        if (pi.deviceOnline && pi.state === 'off'&&(newBoot||!this.piShutdownBootId&&this.state.piShutdownOffline)) {
          clearTimeout(this.piShutdownTick);
          this.publish({ pi, piShuttingDown: false,piShutdownRemaining:undefined,piShutdownOffline:undefined, piMessage: 'Pi đã khởi động. Bấm Bật camera để bắt đầu.' });
        }else{
          this.publish({piShutdownOffline:!pi.deviceOnline});
        }
      }).catch(() => {}).finally(() => this.watchPiPowerCycle());
    }, 3000);
  }

  async selectCamera(deviceId: string) {
    if (deviceId === this.state.selectedDevice) return;
    const restart = this.state.camera !== 'off';
    this.stopCamera();
    this.publish({ selectedDevice: deviceId, ...(deviceId!==PI_DEVICE?{piMessage:undefined,piStopping:false}:{}) });
    if (deviceId === PI_DEVICE && this.state.piShuttingDown) this.watchPiPowerCycle();
    if (restart) await this.startCamera();
  }

  async startDetection() {
    if (this.disposed || this.state.camera !== 'on' ||
      this.state.detection === 'loading' || this.state.detection === 'running') return;
    if (this.state.selectedDevice === PI_DEVICE) this.piDetectionWanted = true;
    const epoch = this.invalidate();
    this.publish({ detection: 'loading', error: null, fps: 0,inferenceMs:undefined,resultFrameAt:undefined });
    const cameraEpoch = this.cameraEpoch;
    const piDetectorEpoch = this.piDetectorEpoch;
    let pending: Promise<PersonDetector> | null = null;
    try {
      if (!this.detector && !this.detectorPromise) {
        this.detectorPromise = this.dependencies.createDetector(this.state.selectedDevice).then(detector => {
          if (this.disposed || cameraEpoch !== this.cameraEpoch || piDetectorEpoch !== this.piDetectorEpoch) {
            detector.dispose();
            throw new Error('Session disposed');
          }
          this.detector = detector;
          return detector;
        });
      }
      pending = this.detectorPromise;
      await (this.detectorPromise ?? Promise.resolve(this.detector));
      if (!this.isCurrent(epoch) || this.state.camera !== 'on') return;
      this.samples = [];
      this.publish({ detection: 'running' });
      await this.startPixelTracking();
      if(!this.isCurrent(epoch)){this.detector?.stopTracking?.();return;}
      this.beginHistory();
      void this.step(epoch);
    } catch {
      if (this.detectorPromise === pending) this.detectorPromise = null;
      if (this.isCurrent(epoch)) this.publish({
        detection: 'paused',
        error: 'Không thể kết nối mô hình AI. Kiểm tra backend đang chạy bằng npm start rồi thử lại.',
      });
    }
  }

  pauseDetection() {
    this.clearResultFrame();
    this.piDetectionWanted = false;
    this.invalidate();
    this.publish({ detection: this.state.camera === 'on' ? 'paused' : 'idle', fps: 0, tracks: [],objects:[],memory:undefined,frameReady:false,retrying:false });
  }

  reset() {
    this.history?.end();
    this.clearResultFrame();
    const running = this.state.detection === 'running';
    const loading = this.state.detection === 'loading';
    const epoch = this.invalidate();
    this.detector?.reset?.();
    this.names.clear();
    this.newCaptures();
    this.samples = [];
    this.publish({ tracks: [],captures:[],objects:[],memory:undefined,frameReady:false,retrying:false, trackingVersion: (this.state.trackingVersion ?? 0)+1,
      fps: 0, error: null, ...(loading ? { detection: 'paused' as const } : {}) });
    if (running){this.beginHistory();void Promise.resolve(this.startPixelTracking()).then(()=>this.step(epoch));}
  }

  rename(id: string, name: string) {
    const cleaned = name.trim().slice(0, 60);
    if (!cleaned) return;
    this.names.set(id, cleaned);
    this.publish({ tracks: this.state.tracks.map(track => track.id === id ? { ...track, displayName: cleaned } : track),captures:this.captures.rename(id,cleaned) });
  }

  clearCaptures(){this.captures.clearRecords();this.publish({captures:[]});}

  dismissError() {
    this.publish({ error: null });
  }

  private invalidate() {
    this.detector?.stopTracking?.();
    this.frameFailures=0;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if(this.videoFrameWait){this.videoFrameWait.video.cancelVideoFrameCallback(this.videoFrameWait.id);this.videoFrameWait=null;}
    return ++this.epoch;
  }

  private isCurrent(epoch: number) {
    return !this.disposed && epoch === this.epoch;
  }

  private schedule(epoch: number, delay: number) {
    if (this.isCurrent(epoch)) this.timer = setTimeout(() => { void this.step(epoch); }, delay);
  }

  private async step(epoch: number): Promise<void> {
    if (!this.isCurrent(epoch) || this.state.detection !== 'running' || !this.detector) return;
    // Reset/resume waits for any old request: HTTP inference is never overlapped.
    if (this.inference) {
      await this.inference.catch(() => {});
      if (this.isCurrent(epoch)) return this.step(epoch);
      return;
    }
    const piSource = this.state.selectedDevice === PI_DEVICE;
    // Sampling belongs to AI, not to playback. Leave the native video track at
    // its camera FPS and bound JPEG/readback/UI work even when inference is fast.
    const targetRate=12;
    if (!piSource && (!this.video || this.video.readyState < 2 || !this.video.videoWidth || !this.video.videoHeight)) {
      this.schedule(epoch, 1000 / targetRate);
      return;
    }
    if(piSource && this.piImage && !this.piImage.naturalWidth){this.schedule(epoch,1000/targetRate);return;}
    const started = this.dependencies.now();
    const videoTime=this.video?.currentTime;
    let request: Promise<StudentTrack[]> | null = null;
    try {
      request = this.detector.detect(this.video,this.piImage);
      this.inference = request;
      const detections = await request;
      if (!this.isCurrent(epoch)) return;
      const now = this.dependencies.now();
      const frameReady=!!(this.resultCanvas && this.detector.paintFrame?.(this.resultCanvas));
      const tracks=detections.map(track=>({...track,displayName:this.names.get(track.id)||track.displayName}));
      const captures=this.captures.update(tracks,!this.detector.startTracking&&frameReady?this.resultCanvas:null,now);
      this.samples.push(now);
      this.samples = this.samples.filter(sample => now - sample <= 15000);
      const fps = this.samples.length > 1
        ? (this.samples.length - 1) * 1000 / Math.max(1, now - this.samples[0]) : 0;
      this.publish({
        tracks,captures,retrying:false,memory:this.detector.memory,
        objects:this.detector.objects??detections.flatMap(track=>(track.objects??[]).map((object,index)=>({...object,
          id:`${track.id}-${object.kind}-${index}`,trackedAt:object.observedAt,trackingState:'detected' as const,ownerId:track.id}))),
        frameReady,resultFrameAt:this.detector.frameTime??detections[0]?.frameTime??started,
        inferenceMs:Math.max(0,now-started),fps: Math.min(targetRate, fps),
        ...(!piSource && this.video ? { resolution: { width: this.video.videoWidth, height: this.video.videoHeight } } : {}),
      });
      this.frameFailures=0;
    } catch (error) {
      if (this.isCurrent(epoch)) {
        const frameStatus=error instanceof Error&&'status' in error?error.status:undefined;
        if([408,422,429,500].includes(Number(frameStatus))&&++this.frameFailures<=2){
          // A failed request has no new AI decision. Keep the last overlay
          // while retrying; camera playback remains independent throughout.
          this.publish({retrying:true,fps:0});
          this.schedule(epoch,this.frameFailures*250);
          return;
        }
        const wanted = this.piDetectionWanted;
        this.pauseDetection();
        const status=error instanceof Error&&'status' in error?error.status:undefined;
        const expired=status===404||status===410;
        const disconnected = error instanceof TypeError || status === 502 || status === 503 || status === 504;
        if (piSource && (expired || disconnected)) this.piDetectionWanted = wanted;
        if (expired || disconnected) {
          this.detector?.dispose();
          this.detector = null;
          this.detectorPromise = null;
          this.names.clear();
          this.newCaptures();
        }
        this.publish({ retrying:false,...(expired || disconnected ? { tracks: [],captures:[],objects:[] } : {}),
          error: expired ? 'Phiên backend đã kết thúc. Bấm Tiếp tục nhận diện để tạo phiên mới.'
            : disconnected ? 'Mất kết nối backend. Camera vẫn bật; bấm Tiếp tục nhận diện khi backend sẵn sàng.'
            : error instanceof Error ? error.message : 'Nhận diện bị gián đoạn. Kiểm tra backend rồi bấm Tiếp tục nhận diện.' });
      }
    } finally {
      if (this.inference === request) this.inference = null;
    }
    if (this.isCurrent(epoch) && this.state.detection === 'running') {
      const video=this.video;
      const delay=Math.max(16,1000/targetRate-(this.dependencies.now()-started));
      // Always yield to painting, including when a slow response arrives after
      // the next camera frame. Never synchronously start another full readback.
      this.timer=setTimeout(()=>{
        this.timer=null;
        if(!this.isCurrent(epoch))return;
        if(!piSource && video && typeof video.requestVideoFrameCallback==='function' && video.currentTime===videoTime){
          this.videoFrameWait={video,id:video.requestVideoFrameCallback(()=>{
            this.videoFrameWait=null;
            if(this.isCurrent(epoch))void this.step(epoch);
          })};
        }else void this.step(epoch);
      },delay);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.stopCamera();
    clearTimeout(this.piPowerTimer);clearTimeout(this.piShutdownTick);
    this.disposed = true;
    this.listeners.clear();
  }
}
