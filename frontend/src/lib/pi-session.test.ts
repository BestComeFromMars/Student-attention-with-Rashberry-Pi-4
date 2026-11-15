import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservationSession } from './session';
import type { PiStatus, PersonDetector } from './types';
import {DetectionHistory} from './history';

let session: ObservationSession;
let device: PiStatus;
let disconnected: boolean;
let fetcher: ReturnType<typeof vi.fn>;
const createDetector = vi.fn<(source: string) => Promise<PersonDetector>>();
beforeEach(async () => {
  vi.useFakeTimers();
  disconnected = false;
  device = { online: true, deviceOnline: true, state: 'streaming', desired: true, cameraReleased: false,
    bootId: 'boot-1', generation: 1, width: 1280, height: 720, error: null };
  fetcher = vi.fn().mockImplementation(async (url: string) => {
    if (disconnected) throw new TypeError('offline');
    if (url.endsWith('/stop')) device = { ...device, online: false, desired: false, state: 'off', cameraReleased: true };
    return { ok: true, json: async () => ({ ...device }) };
  });
  vi.stubGlobal('fetch', fetcher);
  createDetector.mockReset().mockImplementation(async () => ({ detect: async () => [], dispose: vi.fn() }));
  session = new ObservationSession({ history:false,createDetector: source => createDetector(source), enumerateDevices: async () => [] });
  await session.selectCamera('raspberry-pi');
});
afterEach(async () => {
  session.dispose();
  await vi.advanceTimersByTimeAsync(0);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Pi session recovery', () => {
  it('counts down only after acknowledgment, survives source changes, and waits for a new boot before allowing another shutdown',async()=>{
    let acknowledge!:(response:Response)=>void;
    fetcher.mockImplementationOnce(()=>new Promise<Response>(yes=>{acknowledge=yes;}));
    const shutting=session.shutdownPi();await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().piShutdownRemaining).toBeUndefined();
    acknowledge(new Response(JSON.stringify({...device,state:'shutting_down'})));await shutting;
    expect(session.getSnapshot().piShutdownRemaining).toBe(20);
    await vi.advanceTimersByTimeAsync(1000);expect(session.getSnapshot().piShutdownRemaining).toBe(19);
    device={...device,state:'off',desired:false};await vi.advanceTimersByTimeAsync(2000);
    expect(session.getSnapshot()).toMatchObject({piShuttingDown:true,piShutdownRemaining:17});
    await session.selectCamera('');await vi.advanceTimersByTimeAsync(1000);
    expect(session.getSnapshot().piShutdownRemaining).toBe(16);
    disconnected=true;await vi.advanceTimersByTimeAsync(16000);
    expect(session.getSnapshot()).toMatchObject({piShuttingDown:true,piShutdownRemaining:0,piShutdownOffline:false});
    disconnected=false;device={...device,deviceOnline:false,state:'offline'};await vi.advanceTimersByTimeAsync(3000);
    expect(session.getSnapshot().piShutdownOffline).toBe(true);
    device={...device,deviceOnline:true,state:'off',bootId:'boot-2'};await vi.advanceTimersByTimeAsync(3000);
    expect(session.getSnapshot()).toMatchObject({piShuttingDown:false,piShutdownRemaining:undefined});
  });
  it('catches up after monitoring is resumed and stops updates after disposal',async()=>{
    await session.shutdownPi();expect(session.getSnapshot().piShutdownRemaining).toBe(20);
    session.setPiShutdownMonitoring(false);await vi.advanceTimersByTimeAsync(5000);
    session.setPiShutdownMonitoring(true);expect(session.getSnapshot().piShutdownRemaining).toBe(15);
    session.dispose();await vi.advanceTimersByTimeAsync(5000);
    expect(session.getSnapshot().piShutdownRemaining).toBe(15);
  });
  it('does not start a countdown when the shutdown request fails',async()=>{
    fetcher.mockRejectedValueOnce(new Error('offline'));
    await session.shutdownPi();expect(session.getSnapshot()).toMatchObject({piShuttingDown:false,piShutdownRemaining:undefined});
  });
  it('keeps the logical history block when a disconnected Pi recreates its AI session',async()=>{
    session.dispose();const posts:string[]=[];
    const history=new DetectionHistory(async(path,options)=>{
      if(options?.method==='POST')posts.push(String(path));
      return new Response(JSON.stringify({number:1}));
    });
    session=new ObservationSession({history,createDetector:source=>createDetector(source),enumerateDevices:async()=>[]});
    try{
      await session.startCamera();await session.startDetection();await history.flush();
      const id=history.getSnapshot().activeId;
      disconnected=true;await vi.advanceTimersByTimeAsync(1500);
      expect(session.getSnapshot().detection).toBe('paused');
      disconnected=false;await vi.advanceTimersByTimeAsync(1500);await history.flush();
      expect(session.getSnapshot().detection).toBe('running');expect(createDetector).toHaveBeenCalledTimes(2);
      expect(history.getSnapshot().activeId).toBe(id);expect(posts).toHaveLength(1);
    }finally{session.stopCamera();await history.flush();history.dispose();}
  });
  it('disposes a late detector initialization from an earlier camera generation', async () => {
    let finish!: (detector: PersonDetector) => void;
    const dispose = vi.fn();
    createDetector.mockImplementationOnce(() => new Promise<PersonDetector>(yes => { finish = yes; }));
    await session.startCamera();
    const opening = session.startDetection();
    device = { ...device, generation: 2 };
    await vi.advanceTimersByTimeAsync(1500);
    finish({ detect: async () => [], dispose });
    await opening;
    expect(dispose).toHaveBeenCalledOnce();
    expect(createDetector).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().detection).toBe('running');
  });
  it('waits for backend readiness and resumes video without another start command', async () => {
    device = { ...device, online: false, state: 'waiting_backend' };
    await session.startCamera();
    expect(session.getSnapshot().camera).toBe('requesting');
    device = { ...device, online: true, state: 'streaming' };
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.getSnapshot().camera).toBe('on');
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/start'))).toHaveLength(1);
  });
  it('recreates AI after connection loss only if detection was running', async () => {
    await session.startCamera();
    await session.startDetection();
    expect(createDetector).toHaveBeenCalledTimes(1);
    disconnected = true;
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.getSnapshot()).toMatchObject({ camera: 'requesting', detection: 'paused', tracks: [] });
    disconnected = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.getSnapshot()).toMatchObject({ camera: 'on', detection: 'running' });
    expect(createDetector).toHaveBeenCalledTimes(2);
    session.pauseDetection();
    disconnected = true;
    await vi.advanceTimersByTimeAsync(1500);
    disconnected = false;
    await vi.advanceTimersByTimeAsync(1500);
    expect(createDetector).toHaveBeenCalledTimes(2);
  });
  it('retries explicit stop while backend is offline and never automatically starts again', async () => {
    await session.startCamera();
    disconnected = true;
    session.stopCamera();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getSnapshot().piStopping).toBe(true);
    disconnected = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.getSnapshot()).toMatchObject({ camera: 'off', piStopping: false });
    expect(device.desired).toBe(false);
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/start'))).toHaveLength(1);
  });
  it('requires explicit camera-on after a new Pi boot', async () => {
    await session.startCamera();
    await session.startDetection();
    device = { ...device, bootId: 'boot-2', generation: 0, desired: false, online: false, state: 'off' };
    await vi.advanceTimersByTimeAsync(1500);
    expect(session.getSnapshot()).toMatchObject({ camera: 'off', detection: 'idle', tracks: [] });
    expect(fetcher.mock.calls.filter(call => call[0].endsWith('/start'))).toHaveLength(1);
  });
  it('invalidates an in-flight result when camera generation changes', async () => {
    let resolve!: (tracks: []) => void;
    createDetector.mockResolvedValueOnce({ detect: () => new Promise<[]>(yes => { resolve = yes; }), dispose: vi.fn() });
    await session.startCamera();
    await session.startDetection();
    device = { ...device, generation: 2 };
    await vi.advanceTimersByTimeAsync(1500);
    resolve([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(createDetector).toHaveBeenCalledTimes(2);
    expect(session.getSnapshot().tracks).toEqual([]);
  });
});
