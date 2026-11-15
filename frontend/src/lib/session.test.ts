import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservationSession } from './session';
import type { StudentTrack, PersonDetector } from './types';
import {DetectionHistory,vietnamDay} from './history';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fakeStream() {
  const track = {
    stop: vi.fn(), label: 'USB webcam', getSettings: () => ({ width: 1280, height: 720, deviceId: 'usb' }),
    addEventListener: vi.fn(),
  };
  return {
    stream: { getTracks: () => [track], getVideoTracks: () => [track] } as unknown as MediaStream,
    track,
  };
}
const observation: StudentTrack = { id: 'A', displayName: 'Học sinh A', color: '#22c5a5', lastSeen: 0, status: 'visible', box: { x: 0.1, y: 0.2, width: 0.2, height: 0.5 }, confidence: 0.9 };
const sessions: ObservationSession[] = [];
function setup(overrides: Partial<ConstructorParameters<typeof ObservationSession>[0]> = {}) {
  const { stream, track } = fakeStream();
  const detector: PersonDetector = { detect: vi.fn().mockResolvedValue([observation]), dispose: vi.fn() };
  const getUserMedia = vi.fn().mockResolvedValue(stream);
  const createDetector = vi.fn().mockResolvedValue(detector);
  const session = new ObservationSession({
    history:false,
    getUserMedia, createDetector, enumerateDevices: vi.fn().mockResolvedValue([]),
    now: () => Date.now(), ...overrides,
  });
  // These lifecycle cases explicitly exercise the computer webcam.
  void session.selectCamera('');
  const video = { readyState: 4, videoWidth: 1280, videoHeight: 720, srcObject: null, play: vi.fn().mockResolvedValue(undefined) } as unknown as HTMLVideoElement;
  session.attachVideo(video);
  sessions.push(session);
  return { session, detector, stream, track, getUserMedia, createDetector, video };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  sessions.splice(0).forEach(session => session.dispose());
  vi.useRealTimers();
});

describe('camera lifecycle', () => {
  it('archives one block across pause/resume and technical reconnects, with a new block on reset or camera restart',async()=>{
    const calls:{path:string;method:string;body:any}[]=[];
    const history=new DetectionHistory(async(input,options)=>{
      const body=options?.body?JSON.parse(String(options.body)):undefined;calls.push({path:String(input),method:options?.method??'GET',body});
      return new Response(JSON.stringify(body?.id?{...body,date:vietnamDay(body.startedAt),number:calls.filter(c=>c.method==='POST').length}:{}),{status:200});
    });
    const {session}=setup({history});
    await session.startCamera();await session.startDetection();await history.flush();
    const first=history.getSnapshot().activeId;expect(first).toBeDefined();
    expect(history.getSnapshot().detail!.peopleCount).toBe(0);
    session.pauseDetection();await session.startDetection();expect(history.getSnapshot().activeId).toBe(first);
    session.reset();await vi.advanceTimersByTimeAsync(0);await history.flush();
    const second=history.getSnapshot().activeId;expect(second).toBeDefined();expect(second).not.toBe(first);
    session.stopCamera();await history.flush();expect(history.getSnapshot().activeId).toBeUndefined();
    expect(history.getSnapshot().runs).toHaveLength(2);
    await session.startCamera();await session.startDetection();await history.flush();
    expect(history.getSnapshot().activeId).not.toBe(second);
    expect(calls.filter(c=>c.method==='POST')).toHaveLength(3);
    expect(calls.filter(c=>c.method==='PATCH')).toHaveLength(2);
    session.stopCamera();await history.flush();history.dispose();
  });
  it('captures only after painting the analyzed frame, retains on pause and clears on camera stop',async()=>{
    const {session,detector}=setup();const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
    session.attachResultCanvas(canvas);
    const events:string[]=[];
    vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue({drawImage:()=>events.push('crop')} as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype,'toDataURL').mockReturnValue('data:image/jpeg;base64,captured');
    detector.paintFrame=vi.fn(()=>{events.push('paint');return true;});
    vi.mocked(detector.detect).mockResolvedValue([{...observation,personId:7,boxKind:'person',faceVisibility:'visible',trackingState:'face',
      faceBox:{x:.2,y:.2,width:.1,height:.2},attention:'needs_attention',alerts:[
        {type:'head_turned',label:'Quay lệch hướng lâu',observedAt:1000,expiresAt:6000,held:false}]}]);
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(0);
    expect(events.indexOf('paint')).toBeLessThan(events.indexOf('crop'));
    expect(session.getSnapshot().captures![0].photo).toBe('data:image/jpeg;base64,captured');
    session.pauseDetection();expect(session.getSnapshot().captures).toHaveLength(1);
    session.stopCamera();expect(session.getSnapshot().captures).toEqual([]);
    vi.restoreAllMocks();
  });
  it('ignores a late Pi start failure and stop retry while USB inference is already running',async()=>{
    const piStart=deferred<Response>();
    const fetcher=vi.fn().mockImplementation(async(url:string)=>url==='/api/pi/camera/start'?piStart.promise:
      {ok:!url.endsWith('/stop'),json:async()=>({error:'Pi offline'})});
    vi.stubGlobal('fetch',fetcher);
    try{
      const {session,track,detector}=setup();
      await session.selectCamera('raspberry-pi');
      const openingPi=session.startCamera();await vi.advanceTimersByTimeAsync(0);
      const startSignal=fetcher.mock.calls.find(call=>call[0]==='/api/pi/camera/start')![1].signal as AbortSignal;
      await session.selectCamera('usb');await session.startDetection();await vi.advanceTimersByTimeAsync(0);
      expect(startSignal.aborted).toBe(true);
      piStart.resolve({ok:false,json:async()=>({error:'Pi start failed'})} as Response);
      await openingPi;await vi.advanceTimersByTimeAsync(2500);
      session.piStreamError();
      expect(session.getSnapshot()).toMatchObject({selectedDevice:'usb',camera:'on',detection:'running',error:null});
      expect(session.getSnapshot().piMessage).toBeUndefined();
      expect(fetcher.mock.calls.filter(call=>call[0]==='/api/pi/camera/stop')).toHaveLength(1);
      expect(track.stop).not.toHaveBeenCalled();expect(detector.dispose).not.toHaveBeenCalled();
    }finally{vi.unstubAllGlobals();}
  });
  it('keeps a second USB camera running when the first USB stream reports a late disconnection',async()=>{
    const first=fakeStream(),second=fakeStream();
    const getUserMedia=vi.fn().mockResolvedValueOnce(first.stream).mockResolvedValueOnce(second.stream);
    const {session}=setup({getUserMedia});
    await session.startCamera();
    const oldEnded=first.track.addEventListener.mock.calls.find(call=>call[0]==='ended')![1];
    await session.selectCamera('other-usb');await session.startDetection();await vi.advanceTimersByTimeAsync(0);
    oldEnded();
    expect(session.getSnapshot()).toMatchObject({camera:'on',detection:'running',error:null});
    expect(first.track.stop).toHaveBeenCalledOnce();expect(second.track.stop).not.toHaveBeenCalled();
  });
  it('requests permission explicitly, lists hidden cameras while probing, then releases without preview or AI', async () => {
    const devices=[{kind:'videoinput',deviceId:'integrated',label:'Integrated Webcam'},
      {kind:'videoinput',deviceId:'usb',label:'USB Camera'}] as MediaDeviceInfo[];
    const enumerate=vi.fn().mockResolvedValueOnce([{kind:'videoinput',deviceId:'',label:''}]).mockResolvedValue(devices);
    const {session,getUserMedia,createDetector,track,video}=setup({enumerateDevices:enumerate});
    await session.selectCamera('raspberry-pi');
    await session.discoverDevices();
    expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({audio:false,video:true});
    expect(track.stop).toHaveBeenCalledOnce();
    expect(createDetector).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
    expect(session.getSnapshot()).toMatchObject({camera:'off',detection:'idle',selectedDevice:'raspberry-pi',discoveringDevices:false});
    expect(session.getSnapshot().devices.map(device=>device.deviceId)).toEqual(['integrated','usb']);
  });
  it('does not acquire another stream or stop a running webcam just to refresh devices', async () => {
    const enumerate=vi.fn().mockResolvedValue([{kind:'videoinput',deviceId:'usb',label:'USB Camera'}]);
    const {session,getUserMedia,track}=setup({enumerateDevices:enumerate});
    await session.startCamera();await session.discoverDevices();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({camera:'on',selectedDevice:'usb'});
  });
  it('shows permission denial inside discovery without changing the Pi selection or starting AI', async () => {
    const {session,createDetector}=setup({getUserMedia:vi.fn().mockRejectedValue(new DOMException('denied','NotAllowedError'))});
    await session.selectCamera('raspberry-pi');await session.discoverDevices();
    expect(session.getSnapshot()).toMatchObject({camera:'off',selectedDevice:'raspberry-pi',discoveringDevices:false,error:null});
    expect(session.getSnapshot().deviceDiscoveryMessage).toContain('Quyền camera');
    expect(createDetector).not.toHaveBeenCalled();
  });
  it('coalesces discovery clicks and stops a late permission stream after leaving the page', async () => {
    const permission=deferred<MediaStream>();
    const acquire=vi.fn().mockReturnValue(permission.promise);
    const {session,stream,track}=setup({getUserMedia:acquire});
    const first=session.discoverDevices(),second=session.discoverDevices();
    expect(first).toBe(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledOnce();
    session.stopCamera();permission.resolve(stream);await first;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({camera:'off',discoveringDevices:false,devices:[]});
  });
  it('releases the permission stream even if enumeration fails after permission is granted', async () => {
    const enumerate=vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new DOMException('denied','NotAllowedError'));
    const {session,track}=setup({enumerateDevices:enumerate});
    await session.discoverDevices();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().deviceDiscoveryMessage).toContain('Quyền camera');
    expect(session.getSnapshot().discoveringDevices).toBe(false);
  });
  it('does not let an older anonymous enumeration overwrite a newer full camera list', async () => {
    const old=deferred<MediaDeviceInfo[]>();
    const enumerate=vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue([{kind:'videoinput',deviceId:'usb',label:'USB Camera'}]);
    const {session}=setup({enumerateDevices:enumerate});
    const initial=session.refreshDevices();await session.refreshDevices();
    old.resolve([{kind:'videoinput',deviceId:'',label:''}] as MediaDeviceInfo[]);await initial;
    expect(session.getSnapshot().devices).toEqual([{deviceId:'usb',label:'USB Camera'}]);
  });
  it('retries unsupported resolution preferences once with basic video and no audio', async () => {
    const fallback = fakeStream();
    const acquire = vi.fn().mockRejectedValueOnce(new DOMException('', 'OverconstrainedError')).mockResolvedValueOnce(fallback.stream);
    const { session } = setup({ getUserMedia: acquire });
    await session.startCamera();
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(acquire.mock.calls[1][0]).toEqual({ audio: false, video: true });
    expect(session.getSnapshot().camera).toBe('on');
  });
  it('keeps the selected device when retrying simpler resolution constraints', async () => {
    const fallback = fakeStream();
    const acquire = vi.fn().mockRejectedValueOnce(new DOMException('', 'OverconstrainedError')).mockResolvedValueOnce(fallback.stream);
    const { session } = setup({ getUserMedia: acquire });
    await session.selectCamera('chosen-camera');
    await session.startCamera();
    expect(acquire.mock.calls[1][0]).toEqual({ audio: false, video: { deviceId: { exact: 'chosen-camera' } } });
  });
  it('distinguishes failed preview playback from a denied camera permission and permits retry', async () => {
    const { session, video, track } = setup();
    vi.mocked(video.play).mockRejectedValueOnce(new DOMException('Autoplay blocked', 'NotAllowedError'));
    await session.startCamera();
    expect(session.getSnapshot()).toMatchObject({ camera: 'off' });
    expect(session.getSnapshot().error).toContain('đã được cấp quyền nhưng chưa phát hình');
    expect(track.stop).toHaveBeenCalledOnce();
    await session.startCamera();
    expect(session.getSnapshot().camera).toBe('on');
  });
  it('releases a granted stream when preview playback never becomes ready', async () => {
    const { session, video, track } = setup();
    vi.mocked(video.play).mockReturnValueOnce(new Promise<void>(() => {}));
    const opening = session.startCamera();
    await vi.advanceTimersByTimeAsync(10001);
    await opening;
    expect(session.getSnapshot().camera).toBe('off');
    expect(session.getSnapshot().error).toContain('chưa phát hình');
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('cancels a pending preview immediately and ignores its late completion', async () => {
    const { session, video, track } = setup();
    const preview = deferred<void>();
    vi.mocked(video.play).mockReturnValueOnce(preview.promise);
    const opening = session.startCamera();
    await vi.advanceTimersByTimeAsync(0);
    session.stopCamera();
    await opening;
    preview.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot()).toMatchObject({ camera: 'off', error: null });
    expect(track.stop).toHaveBeenCalledOnce();
  });
  it('drops a removed webcam selection while off so the next click can use the default camera', async () => {
    const enumerate = vi.fn().mockResolvedValue([{ kind: 'videoinput', deviceId: 'available', label: 'Available webcam' }]);
    const { session, getUserMedia } = setup({ enumerateDevices: enumerate });
    await session.selectCamera('removed-camera');
    await session.refreshDevices();
    expect(session.getSnapshot().selectedDevice).toBe('');
    await session.startCamera();
    expect(getUserMedia.mock.calls[0][0].video.deviceId).toBeUndefined();
    expect(session.getSnapshot().camera).toBe('on');
  });
  it('connects to Raspberry Pi without requesting the browser webcam', async () => {
    const fetcher = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, json: async () => ({ online: true, deviceOnline: true, desired: true, bootId: 'boot-1', generation: 1, state: 'streaming', width: 1280, height: 720 }),
    } as Response);
    const { session, getUserMedia } = setup();
    await session.selectCamera('raspberry-pi');
    await session.startCamera();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ camera: 'on', cameraLabel: 'Raspberry Pi 4' });
    expect(fetcher).toHaveBeenCalledWith('/api/pi/status', expect.anything());
  });
  it('does not request camera or start AI before an explicit action', () => {
    const { getUserMedia, createDetector, session } = setup();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(createDetector).not.toHaveBeenCalled();
    expect(session.getSnapshot().camera).toBe('off');
  });
  it('requests video only and releases every track on stop', async () => {
    const { session, getUserMedia, track, video } = setup();
    await session.startCamera();
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false, video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
    });
    expect(session.getSnapshot().camera).toBe('on');
    session.stopCamera();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(session.getSnapshot()).toMatchObject({ camera: 'off', tracks: [], detection: 'idle' });
  });
  it.each([
    ['NotAllowedError', 'Quyền camera'],
    ['NotFoundError', 'Không tìm thấy webcam'],
    ['NotReadableError', 'Camera đang bận'],
  ])('shows actionable Vietnamese feedback for %s', async (name, message) => {
    const { session } = setup({ getUserMedia: vi.fn().mockRejectedValue(new DOMException('', name)) });
    await session.startCamera();
    expect(session.getSnapshot().camera).toBe('off');
    expect(session.getSnapshot().error).toContain(message);
  });
  it('stops a late stream when permission arrives after cancellation', async () => {
    const pending = deferred<MediaStream>();
    const { session, stream, track } = setup({ getUserMedia: () => pending.promise });
    const start = session.startCamera();
    expect(session.getSnapshot().camera).toBe('requesting');
    session.stopCamera();
    pending.resolve(stream);
    await start;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().camera).toBe('off');
  });
  it('handles rapid stop/start without attaching the first stale stream', async () => {
    const first = deferred<MediaStream>();
    const stale = fakeStream();
    const current = fakeStream();
    const getUserMedia = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(current.stream);
    const { session, video } = setup({ getUserMedia });
    const oldStart = session.startCamera();
    session.stopCamera();
    await session.startCamera();
    first.resolve(stale.stream);
    await oldStart;
    expect(stale.track.stop).toHaveBeenCalledOnce();
    expect(current.track.stop).not.toHaveBeenCalled();
    expect(video.srcObject).toBe(current.stream);
    expect(session.getSnapshot().camera).toBe('on');
  });
  it('resets the session and requests the chosen device on switch', async () => {
    const { session, getUserMedia, track } = setup();
    await session.startCamera();
    await session.startDetection();
    await vi.advanceTimersByTimeAsync(1);
    await session.selectCamera('other-camera');
    expect(track.stop).toHaveBeenCalled();
    expect(getUserMedia.mock.calls[1][0].video.deviceId).toEqual({ exact: 'other-camera' });
    expect(session.getSnapshot().tracks).toEqual([]);
    expect(session.getSnapshot().detection).toBe('idle');
  });
  it('releases the camera on unexpected hardware disconnection', async () => {
    const { session, track } = setup();
    await session.startCamera();
    const ended = track.addEventListener.mock.calls.find(call => call[0] === 'ended')![1];
    ended();
    expect(session.getSnapshot().camera).toBe('off');
    expect(session.getSnapshot().error).toContain('ngắt kết nối');
  });
});

describe('inference lifecycle', () => {
  it('holds the previous AI decision while retrying and clears it only when AI returns an empty result',async()=>{
    const {session,detector}=setup();
    vi.mocked(detector.detect).mockResolvedValueOnce([observation])
      .mockRejectedValueOnce(Object.assign(new Error('Transient failure'),{status:422})).mockResolvedValue([]);
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(90);
    expect(session.getSnapshot()).toMatchObject({tracks:[observation],retrying:true,detection:'running'});
    await vi.advanceTimersByTimeAsync(300);
    expect(session.getSnapshot()).toMatchObject({tracks:[],retrying:false,detection:'running'});
  });
  it.each([422,429,500])('retries an isolated %s frame error and continues detecting without another click',async status=>{
    const {session,detector}=setup();
    vi.mocked(detector.detect).mockRejectedValueOnce(Object.assign(new Error('Transient frame failure'),{status})).mockResolvedValue([observation]);
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot()).toMatchObject({camera:'on',detection:'running',retrying:true,error:null});
    await vi.advanceTimersByTimeAsync(600);
    expect(session.getSnapshot()).toMatchObject({detection:'running',retrying:false,tracks:[observation],error:null});
    expect(vi.mocked(detector.detect).mock.calls.length).toBeGreaterThan(2);
  });
  it('bounds frame retries, pauses after repeated failures and cancels retries on user pause',async()=>{
    const {session,detector}=setup();
    vi.mocked(detector.detect).mockRejectedValue(Object.assign(new Error('Repeated frame failure'),{status:422}));
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(1000);
    expect(detector.detect).toHaveBeenCalledTimes(3);
    expect(session.getSnapshot()).toMatchObject({camera:'on',detection:'paused',retrying:false});
    expect(session.getSnapshot().error).toContain('Repeated frame failure');
    await session.startDetection();await vi.advanceTimersByTimeAsync(0);session.pauseDetection();
    const count=vi.mocked(detector.detect).mock.calls.length;
    await vi.advanceTimersByTimeAsync(1500);expect(detector.detect).toHaveBeenCalledTimes(count);
  });
  it('paces small scenes on decoded video frames and cancels the callback on pause',async()=>{
    const detector={detect:vi.fn().mockResolvedValue([observation]),paintFrame:vi.fn().mockReturnValue(true),dispose:vi.fn()};
    const {session,video}=setup({createDetector:async()=>detector});
    const callbacks:VideoFrameRequestCallback[]=[];
    video.requestVideoFrameCallback=vi.fn(callback=>{callbacks.push(callback);return callbacks.length;});
    video.cancelVideoFrameCallback=vi.fn();
    session.attachResultCanvas(document.createElement('canvas'));
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(1);
    expect(detector.detect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(detector.detect,'no duplicate request for a stalled camera image').toHaveBeenCalledTimes(1);
    callbacks[0](performance.now(),{} as VideoFrameCallbackMetadata);
    await vi.advanceTimersByTimeAsync(1);
    expect(detector.detect).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    session.pauseDetection();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalledWith(2);
    callbacks[1](performance.now(),{} as VideoFrameCallbackMetadata);
    await vi.advanceTimersByTimeAsync(200);
    expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().tracks).toEqual([]);
  });
  it('yields to video rendering after slow AI and never overlaps requests',async()=>{
    const pending=deferred<StudentTrack[]>();
    const {session,detector,video,track}=setup();
    vi.mocked(detector.detect).mockReturnValueOnce(pending.promise).mockResolvedValue([observation]);
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(2000);
    expect(detector.detect).toHaveBeenCalledTimes(1);
    Object.defineProperty(video,'currentTime',{value:2,configurable:true});
    pending.resolve([observation]);await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().tracks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15);expect(detector.detect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(track.stop).not.toHaveBeenCalled();
  });
  it('bounds crowded-camera AI sampling to twelve Hz while retaining all tracks', async () => {
    const many=Array.from({length:20},(_,index)=>({...observation,id:String(index)}));
    const detector={detect:vi.fn().mockResolvedValue(many),paintFrame:vi.fn().mockReturnValue(true),dispose:vi.fn()};
    const {session}=setup({createDetector:async()=>detector});
    session.attachResultCanvas(document.createElement('canvas'));
    await session.startCamera();await session.startDetection();await vi.advanceTimersByTimeAsync(999);
    expect(detector.detect.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(detector.detect.mock.calls.length).toBeLessThanOrEqual(13);
    expect(session.getSnapshot().tracks).toHaveLength(20);
  });
  it('paints a paired result before publishing its boxes and clears it on pause, including late replies', async () => {
    const pending=deferred<StudentTrack[]>();
    const paintFrame=vi.fn().mockReturnValue(true);
    const detector={detect:vi.fn().mockResolvedValueOnce([observation]).mockReturnValue(pending.promise),paintFrame,dispose:vi.fn()};
    const {session,track}=setup({createDetector:async()=>detector});
    const canvas=document.createElement('canvas');
    session.attachResultCanvas(canvas);
    const ordered=vi.fn(()=>{if(session.getSnapshot().frameReady)expect(paintFrame).toHaveBeenCalled();});
    session.subscribe(ordered);
    await session.startCamera();await session.startDetection();
    await vi.advanceTimersByTimeAsync(40);
    expect(session.getSnapshot()).toMatchObject({frameReady:true,tracks:[observation]});
    expect(paintFrame).toHaveBeenCalledWith(canvas);
    session.pauseDetection();
    expect(session.getSnapshot()).toMatchObject({frameReady:false,tracks:[],detection:'paused'});
    expect([canvas.width,canvas.height]).toEqual([0,0]);
    pending.resolve([observation]);await vi.advanceTimersByTimeAsync(300);
    expect(paintFrame).toHaveBeenCalledTimes(1);
    expect(track.stop).not.toHaveBeenCalled();
  });
  it('also bounds paired small-class AI sampling so video rendering has time to run', async () => {
    const detector={detect:vi.fn().mockResolvedValue([observation]),paintFrame:vi.fn().mockReturnValue(true),dispose:vi.fn()};
    const {session}=setup({createDetector:async()=>detector});
    session.attachResultCanvas(document.createElement('canvas'));
    await session.startCamera();await session.startDetection();
    await vi.advanceTimersByTimeAsync(999);
    expect(detector.detect.mock.calls.length).toBeGreaterThanOrEqual(12);
    expect(detector.detect.mock.calls.length).toBeLessThanOrEqual(13);
  });
  it.each([404,410,502,503,504,'network'])('recreates a failed remote session on resume after %s without turning the camera off', async status => {
    const error = status==='network' ? new TypeError('Failed to fetch') : Object.assign(new Error('Remote session failed'),{status});
    const oldDetector = {detect:vi.fn().mockResolvedValue([observation]).mockResolvedValueOnce([observation]).mockRejectedValueOnce(error),dispose:vi.fn()};
    const freshDetector = {detect:vi.fn().mockResolvedValue([observation]),dispose:vi.fn()};
    const factory=vi.fn().mockResolvedValueOnce(oldDetector).mockResolvedValueOnce(freshDetector);
    const {session,track}=setup({createDetector:factory});
    await session.startCamera();
    await session.startDetection();
    await vi.advanceTimersByTimeAsync(0);
    session.rename('A','Tên phiên cũ');
    await vi.advanceTimersByTimeAsync(84);
    expect(session.getSnapshot()).toMatchObject({camera:'on',detection:'paused',tracks:[],objects:[]});
    expect(oldDetector.dispose).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
    await session.startDetection();
    await vi.advanceTimersByTimeAsync(0);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().error).toBeNull();
    expect(session.getSnapshot().detection).toBe('running');
  });
  it('limits AI to twelve requests per second and pauses independently of camera', async () => {
    const { session, detector, track } = setup();
    await session.startCamera();
    await session.startDetection();
    await vi.advanceTimersByTimeAsync(999);
    const calls = vi.mocked(detector.detect).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(11);
    expect(calls).toBeLessThanOrEqual(13);
    session.pauseDetection();
    expect(session.getSnapshot().tracks).toEqual([]);
    await vi.advanceTimersByTimeAsync(500);
    expect(detector.detect).toHaveBeenCalledTimes(calls);
    expect(track.stop).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ camera: 'on', detection: 'paused' });
  });
  it('keeps video running and allows retry when model loading fails', async () => {
    const detector: PersonDetector = { detect: vi.fn().mockResolvedValue([]), dispose: vi.fn() };
    const factory = vi.fn().mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce(detector);
    const { session } = setup({ createDetector: factory });
    await session.startCamera();
    await session.startDetection();
    expect(session.getSnapshot()).toMatchObject({ camera: 'on', detection: 'paused' });
    expect(session.getSnapshot().error).toContain('mô hình');
    await session.startDetection();
    expect(session.getSnapshot().detection).toBe('running');
  });
  it('ignores late inference after stopping the camera', async () => {
    const pending = deferred<StudentTrack[]>();
    const detector = { detect: vi.fn().mockReturnValue(pending.promise), dispose: vi.fn() };
    const { session } = setup({ createDetector: async () => detector });
    await session.startCamera();
    await session.startDetection();
    session.stopCamera();
    pending.resolve([observation]);
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot()).toMatchObject({ camera: 'off', tracks: [], detection: 'idle' });
  });
  it('clears boxes on pause and a late response cannot draw them again while video stays live', async () => {
    const pending=deferred<StudentTrack[]>();
    const detector={detect:vi.fn().mockResolvedValueOnce([observation]).mockReturnValue(pending.promise),dispose:vi.fn()};
    const {session,track}=setup({createDetector:async()=>detector});
    await session.startCamera();
    await session.startDetection();
    await vi.advanceTimersByTimeAsync(120);
    expect(session.getSnapshot().tracks).toHaveLength(1);
    session.pauseDetection();
    expect(session.getSnapshot()).toMatchObject({camera:'on',detection:'paused',tracks:[]});
    pending.resolve([observation]);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.getSnapshot().tracks).toEqual([]);
    expect(track.stop).not.toHaveBeenCalled();
  });
  it('ignores pre-reset data and never overlaps old/new inference', async () => {
    const pending = deferred<StudentTrack[]>();
    const detector = { detect: vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue([observation]), dispose: vi.fn() };
    const { session } = setup({ createDetector: async () => detector });
    await session.startCamera();
    await session.startDetection();
    session.reset();
    expect(detector.detect).toHaveBeenCalledTimes(1);
    pending.resolve([{ ...observation, box: { ...observation.box, x: 0.8 } }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(detector.detect).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().tracks[0]).toMatchObject({ id: 'A', box: { x: 0.1 } });
  });
  it('ignores a completed model load after stopping, without turning inference on', async () => {
    const pending = deferred<PersonDetector>();
    const { session, detector } = setup({ createDetector: () => pending.promise });
    await session.startCamera();
    const start = session.startDetection();
    session.stopCamera();
    pending.resolve(detector);
    await start;
    expect(detector.detect).not.toHaveBeenCalled();
    expect(session.getSnapshot().detection).toBe('idle');
  });
  it('closes the remote detector on unmount even with a pending request', async () => {
    const pending = deferred<StudentTrack[]>();
    const detector = { detect: vi.fn().mockReturnValue(pending.promise), dispose: vi.fn() };
    const { session, track } = setup({ createDetector: async () => detector });
    await session.startCamera();
    await session.startDetection();
    session.dispose();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(detector.dispose).toHaveBeenCalledOnce();
    pending.resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(detector.dispose).toHaveBeenCalledOnce();
  });
});
