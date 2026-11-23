import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';
import { StrictMode } from 'react';

const { detect } = vi.hoisted(() => ({ detect: vi.fn() }));
vi.mock('./components/FaceOverlay', () => ({
  default: () => <div aria-label="Khung nhận diện khuôn mặt" />,
}));
vi.mock('./lib/backend-api', () => ({
  createDetector: async () => ({ detect, dispose: vi.fn() }),
}));
// Keep these camera/health cases independent of the history transport. The
// real history service and panel have their own persistence/integration tests.
vi.mock('./lib/history',async importOriginal=>{
  const actual=await importOriginal<typeof import('./lib/history')>();
  return {...actual,DetectionHistory:class extends actual.DetectionHistory{
    constructor(){super(async(input,options)=>{
      const path=String(input),data=options?.body?JSON.parse(String(options.body)):{};
      const value=path.endsWith('/days')?{days:[]}:path.includes('/days/')?{runs:[]}:
        options?.method==='POST'?{...data,date:actual.vietnamDay(data.startedAt),number:1}:{};
      return new Response(JSON.stringify(value),{status:200});
    });}
  }};
});

let stop: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  // App lifecycle tests have no pixels; optical-flow pixels are covered by
  // the dedicated tracker tests and Chrome video integration checks.
  vi.spyOn(HTMLCanvasElement.prototype,'getContext').mockReturnValue(null);
  detect.mockResolvedValue([{ id: 'A', displayName: 'Học sinh A', color: '#22c5a5', lastSeen: 0, status: 'visible', box: { x: 0.1, y: 0.2, width: 0.2, height: 0.5 }, confidence: 0.9 }]);
  stop = vi.fn();
  const track = { stop, getSettings: () => ({ width: 1280, height: 720 }), label: 'Test webcam', addEventListener: vi.fn() };
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [track], getVideoTracks: () => [track] });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices: vi.fn().mockResolvedValue([]), addEventListener: vi.fn(), removeEventListener: vi.fn() },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(1280);
  vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(720);
  vi.spyOn(HTMLMediaElement.prototype, 'readyState', 'get').mockReturnValue(4);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', modelReady: true, detector: 'classroom' }) }));
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 16));
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function startComputerCamera() {
  const source = screen.getByRole('combobox', { name: 'Chọn webcam' });
  if (source.textContent?.includes('Raspberry Pi 4')) {
    await act(async () => { fireEvent.click(source); });
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Webcam máy tính/ })); });
  }
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Bật camera' })); });
}

describe('teacher controls', () => {
  it('scans once on entry and adds a signalled new camera only after manual refresh', async () => {
    const enumerate=vi.mocked(navigator.mediaDevices.enumerateDevices);
    const integrated={kind:'videoinput',deviceId:'integrated',label:'Integrated Webcam'} as MediaDeviceInfo;
    enumerate.mockResolvedValue([integrated]);
    await act(async()=>{render(<StrictMode><App/></StrictMode>);});
    expect(enumerate).toHaveBeenCalledTimes(1);
    await act(async()=>{fireEvent.click(screen.getByRole('combobox'));});
    expect(screen.getByRole('option',{name:/Integrated Webcam/})).toBeDefined();
    expect(enumerate).toHaveBeenCalledTimes(1);
    enumerate.mockResolvedValue([integrated,{kind:'videoinput',deviceId:'usb',label:'USB Camera'} as MediaDeviceInfo]);
    const listeners=vi.mocked(navigator.mediaDevices.addEventListener).mock.calls;
    const update=listeners.filter(call=>call[0]==='devicechange').at(-1)![1] as ()=>void;
    await act(async()=>{update();window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));});
    expect(enumerate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('option',{name:/USB Camera/})).toBeNull();
    expect(screen.getByRole('status').textContent).toContain('Bấm Làm mới danh sách');
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Làm mới danh sách'}));});
    expect(enumerate).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('option',{name:/USB Camera/})).toBeDefined();
    expect(screen.getByRole('combobox').textContent).toContain('Raspberry Pi 4');
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('opens the exact integrated camera selected from the discovered device list', async () => {
    vi.mocked(navigator.mediaDevices.enumerateDevices).mockResolvedValue([
      {kind:'videoinput',deviceId:'integrated',label:'Integrated Camera'},
      {kind:'videoinput',deviceId:'usb',label:'USB Camera'},
    ] as MediaDeviceInfo[]);
    await act(async()=>{render(<App/>);});
    await act(async()=>{fireEvent.click(screen.getByRole('combobox'));});
    await act(async()=>{fireEvent.click(screen.getByRole('option',{name:/Integrated Camera/}));});
    await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Bật camera'}));});
    expect(getUserMedia.mock.calls[0][0].video.deviceId).toEqual({exact:'integrated'});
    expect(getUserMedia.mock.calls[0][0].audio).toBe(false);
  });
  it('defaults to Pi, shows readiness without opening and keeps two sources while offline', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Backend offline'));
    await act(async () => { render(<App />); });
    const source = screen.getByRole('combobox', { name: 'Chọn webcam' });
    expect(source.textContent).toContain('Raspberry Pi 4');
    expect(source.textContent).toContain('Chưa tìm thấy');
    await act(async () => { fireEvent.click(source); });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect((screen.getByRole('button', { name: 'Tắt Raspberry Pi' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('option', { name: /Raspberry Pi 4.*Chưa tìm thấy/ })).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Raspberry Pi 4/ })); });
    expect(source.textContent).toContain('Raspberry Pi 4');
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalledWith('/api/pi/camera/start', expect.anything());
    await act(async () => { fireEvent.click(source); });
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: /Webcam máy tính/ })); });
    expect(screen.getByRole('button', { name: 'Tắt Raspberry Pi' })).toBeDefined();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('reports a Pi as ready while its webcam is off and updates when it disappears', async () => {
    let online = true;
    vi.mocked(fetch).mockImplementation(async url => ({ ok: true, json: async () => String(url) === '/api/pi/status'
      ? { deviceOnline: online, state: online ? 'off' : 'offline', error: null }
      : { status: 'ok', modelReady: true, detector: 'classroom' } }) as Response);
    await act(async () => { render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('combobox', { name: 'Chọn webcam' })); });
    expect(screen.getByRole('option', { name: /Raspberry Pi 4.*Sẵn sàng/ }).querySelector('.camera-status-ready')).not.toBeNull();
    expect((screen.getByRole('button', { name: 'Tắt Raspberry Pi' }) as HTMLButtonElement).disabled).toBe(false);
    expect(getUserMedia).not.toHaveBeenCalled();
    online = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(screen.getByRole('option', { name: /Raspberry Pi 4.*Chưa tìm thấy/ }).querySelector('.camera-status-missing')).not.toBeNull();
  });
  it('confirms Pi poweroff without stopping an active computer webcam', async () => {
    let piOffline = false;
    vi.mocked(fetch).mockImplementation(async url => ({ ok: true, json: async () => String(url) === '/api/pi/status'
      ? { deviceOnline: !piOffline, state: piOffline ? 'offline' : 'off', error: null }
      : { status: 'ok', modelReady: true, detector: 'classroom' } }) as Response);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await act(async () => { render(<App />); });
    expect(screen.queryByLabelText('Demo video')).toBeNull();
    expect(screen.getByRole('button', { name: 'Ngưỡng nhận diện' }).textContent).toBe('');
    expect(screen.getByRole('button', { name: 'Tắt Raspberry Pi' }).textContent).toBe('');
    await startComputerCamera();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tắt Raspberry Pi' })); });
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith('/api/pi/shutdown', expect.objectContaining({ method: 'POST', body: '{"confirm":true}' }));
    expect(stop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeDefined();
    expect(screen.getByRole('button',{name:'Pi đang tắt · 20s'}).textContent).toContain('20s');
    await act(async()=>{await vi.advanceTimersByTimeAsync(1000);});
    expect(screen.getByRole('button',{name:'Pi đang tắt · 19s'}).textContent).toContain('19s');
    piOffline = true;
    await act(async()=>{await vi.advanceTimersByTimeAsync(22000);});
    expect(screen.getByRole('button',{name:'An toàn rút điện'}).textContent).toContain('An toàn rút điện');
  });
  it('keeps the camera button functional when effects are replayed by development refresh or StrictMode', async () => {
    await act(async () => { render(<StrictMode><App /></StrictMode>); });
    await startComputerCamera();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeDefined();
  });
  it('releases the stream on real unmount after a development effect replay', async () => {
    let mounted!: ReturnType<typeof render>;
    await act(async () => { mounted = render(<StrictMode><App /></StrictMode>); });
    await startComputerCamera();
    await act(async () => { mounted.unmount(); });
    expect(stop).toHaveBeenCalledOnce();
  });
  it('releases the device when navigating away and allows starting again after returning', async () => {
    await act(async () => { render(<App />); });
    await startComputerCamera();
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Bật camera' })).toBeDefined();
    await startComputerCamera();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeDefined();
  });
  it('renders safely with camera off and detection disabled', async () => {
    await act(async () => { render(<App />); });
    expect(screen.getByRole('button', { name: 'Bật camera' })).toBeDefined();
    expect((screen.getByRole('button', { name: 'Bắt đầu nhận diện' }) as HTMLButtonElement).disabled).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('connects camera, detects a person, synchronizes labels and pauses without releasing video', async () => {
    await act(async () => { render(<App />); });
    await startComputerCamera();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Bắt đầu nhận diện' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    expect(screen.getByRole('region',{name:'Danh sách cần chú ý'})).toBeDefined();
    expect(screen.getByText('Chưa có cảnh báo trong lần này.')).toBeDefined();
    expect(screen.queryByRole('region',{name:'Sơ đồ lớp học'})).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tạm dừng nhận diện' })); });
    expect(stop).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Khung nhận diện khuôn mặt')).toBeNull();
    expect(screen.queryByRole('list',{name:'Người đã ghi nhận cảnh báo'})).toBeNull();
    expect(screen.getByRole('button', { name: 'Tiếp tục nhận diện' })).toBeDefined();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Tắt camera' })); });
    expect(stop).toHaveBeenCalledOnce();
    expect(screen.queryByRole('textbox', { name: 'Tên học sinh A' })).toBeNull();
  });
  it('keeps a reachable backend with missing models silent and detection disabled', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', modelReady: false }) } as Response);
    await act(async () => { render(<App />); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button',{name:'Bắt đầu nhận diện'}) as HTMLButtonElement).disabled).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('reconnects automatically when the backend starts after the frontend', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Connection refused'));
    await act(async () => { render(<App />); });
    expect(screen.getByRole('alert').textContent).toContain('Chưa kết nối được');
    await startComputerCamera();
    expect((screen.getByRole('button', { name: 'Bắt đầu nhận diện' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect((screen.getByRole('button', { name: 'Bắt đầu nhận diện' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('waits for loading AI and then enables detection without refreshing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'loading', modelReady: false }) } as Response);
    await act(async () => { render(<App />); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(getUserMedia).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it('does not display connection notices for a reachable backend reporting a model error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'error', modelReady: false, error: 'ENOENT: /models/face.onnx' }) } as Response);
    await act(async () => { render(<App />); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button',{name:'Bắt đầu nhận diện'}) as HTMLButtonElement).disabled).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('requires the face backend instead of treating legacy person boxes as faces', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', modelReady: true }) } as Response);
    await act(async () => { render(<App />); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect((screen.getByRole('button',{name:'Bắt đầu nhận diện'}) as HTMLButtonElement).disabled).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
  });
  it('replaces the map with a warning capture list without starting the camera or inference', async () => {
    await act(async () => { render(<App />); });
    expect(screen.getByRole('region',{name:'Danh sách cần chú ý'})).toBeDefined();
    expect(screen.queryByRole('switch',{name:'Hiển thị sơ đồ'})).toBeNull();
    expect(screen.queryByRole('img',{name:/Sơ đồ vị trí/})).toBeNull();
    expect((screen.getByRole('button',{name:'Xóa lịch sử ngày đang xem'}) as HTMLButtonElement).disabled).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });
  it('never displays connection success during startup or subsequent healthy polls', async () => {
    await act(async () => { render(<StrictMode><App /></StrictMode>); });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('keeps an unavailable backend error dismissible and recovers silently', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Connection refused'));
    await act(async () => { render(<App />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.getByRole('alert').textContent).toContain('Chưa kết nối được');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Đóng thông báo' })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole('alert')).toBeNull();
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ status: 'ok', modelReady: true, detector: 'classroom' }) } as Response);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('reports a later backend loss and removes the error without a success notice on recovery', async () => {
    await act(async () => { render(<App />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.queryByRole('status')).toBeNull();
    let failHealth = true;
    vi.mocked(fetch).mockImplementation(async url => {
      if (String(url) === '/api/health' && failHealth) { failHealth = false; throw new TypeError('Connection lost'); }
      return { ok: true, json: async () => ({ status: 'ok', modelReady: true, detector: 'classroom' }) } as Response;
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole('alert').textContent).toContain('Chưa kết nối được');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('keeps camera errors readable without replaying an expired connection success', async () => {
    getUserMedia.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    await act(async () => { render(<App />); });
    await startComputerCamera();
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(screen.getByRole('alert').textContent).toContain('Quyền camera chưa được cấp');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Đóng thông báo' })); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
  it('enlarges the existing live camera and restores the view with Escape without restarting the stream', async () => {
    await act(async () => { render(<App />); });
    await startComputerCamera();
    const video = screen.getByLabelText('Video trực tiếp từ webcam');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Phóng to camera' })); });
    expect(screen.getByRole('region', { name: 'Camera lớp học' }).getAttribute('data-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: 'Thu nhỏ camera' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(screen.getByLabelText('Danh sách cần chú ý').hasAttribute('inert')).toBe(true);
    expect(screen.getByRole('navigation', { name: 'Điều khiển camera' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Tắt camera' })).toBeDefined();
    expect(screen.getByLabelText('Video trực tiếp từ webcam')).toBe(video);
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    await act(async () => { fireEvent.keyDown(window, { key: 'Escape' }); });
    expect(screen.getByRole('button', { name: 'Phóng to camera' })).toBeDefined();
    expect(document.body.style.overflow).toBe('');
    expect(screen.getByLabelText('Danh sách cần chú ý').hasAttribute('inert')).toBe(false);
    expect(screen.getByLabelText('Video trực tiếp từ webcam')).toBe(video);
    expect(stop).not.toHaveBeenCalled();
  });
  it('restores page scrolling and navigation if the expanded camera unmounts', async () => {
    let mounted!: ReturnType<typeof render>;
    await act(async () => { mounted = render(<App />); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Phóng to camera' })); });
    expect(document.body.style.overflow).toBe('hidden');
    await act(async () => { mounted.unmount(); });
    expect(document.body.style.overflow).toBe('');
  });
});
