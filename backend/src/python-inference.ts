import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {constants as osConstants,setPriority} from 'node:os';
import { mkdir } from 'node:fs/promises';
import type { FrameDetections, InferenceEngine, AICapabilities } from './types.js';
import { HttpError } from './errors.js';
import { log, nativeLog } from './logger.js';
import {localAIEnv} from '../local-ai-env.mjs';
import {createPixelTracker} from './pixel-tracker.js';

export async function createPythonEngine(directory: string, signal?: AbortSignal): Promise<InferenceEngine> {
  signal?.throwIfAborted();
  const backend = resolve(directory, '../..');
  const python = process.env.AI_PYTHON || resolve(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  await mkdir(resolve(backend,'.tmp/ultralytics/Ultralytics'),{recursive:true});
  if (!existsSync(python)) throw new Error('Chưa cài môi trường AI. Chạy npm run setup:ai trong backend.');
  const child = spawn(python, ['-X','faulthandler','-u', resolve(backend, 'ai/worker.py'), '--models', directory], {
    cwd: backend, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...await localAIEnv(backend), PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1',
      OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', OPENBLAS_NUM_THREADS:'1',
      NUMEXPR_NUM_THREADS:'1', YOLO_CONFIG_DIR: resolve(backend, '.tmp/ultralytics') },
  });
  // Rendering/decoding camera video takes precedence over background AI work
  // when they compete for CPU. This never changes the source/video clock.
  if(child.pid){try{setPriority(child.pid,osConstants.priority.PRIORITY_BELOW_NORMAL);}catch{/* OS may disallow priority changes. */}}
  let ready = false;
  let closing = false;
  let sequence = 0;
  let capabilities: AICapabilities | undefined;
  let lastFailure: Error | undefined;
  let stderrTail = '';
  let metrics: Record<string, unknown> | undefined;
  let initialized!: () => void;
  let initializationFailed!: (error: Error) => void;
  const initialization = new Promise<void>((yes, no) => { initialized = yes; initializationFailed = no; });
  const pending = new Map<number, {
    resolve: (result: FrameDetections) => void; reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  const fail = (error: Error) => {
    lastFailure = error;
    ready = false;
    initializationFailed(error);
    for (const job of pending.values()) { clearTimeout(job.timeout); job.reject(error); }
    pending.clear();
  };
  child.stderr.on('data', data => {
    stderrTail = (stderrTail + String(data)).slice(-8000);
  });
  const diagnostics = createInterface({ input: child.stderr });
  diagnostics.on('line', nativeLog);
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', code => {
    if (!closing) {
      const error = new HttpError(503, /bad allocation|not enough memory|insufficient memory|MemoryError/i.test(stderrTail)
      ? 'Không đủ bộ nhớ trống để nạp AI. Đóng bớt ứng dụng rồi khởi động lại backend.'
      : 'AI Python đã dừng (mã ' + code + '). Xem lỗi trong terminal backend.');
      log('AI', `${error.message} Mã thoát worker: ${code}. HTTP backend vẫn hoạt động.`, 'error');
      log('CHẨN ĐOÁN', stderrTail, 'debug');
      fail(error);
    }
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch { nativeLog(line); return; }
    if (message.type === 'ready') {
      capabilities = message.capabilities;
      ready = true;
      initialized();
      return;
    }
    if (message.metrics) {
      if(message.memory&&capabilities)capabilities={...capabilities,maxFaces:message.memory.limit,memory:message.memory};
      for (const [field, label] of [['analysisError', 'phân tích hành vi'], ['geometryError', 'tìm khuôn mặt'],
        ['bodyError', 'tìm người'], ['bodyTrackingError', 'bám người'], ['poseError', 'tư thế'], ['objectTrackingError', 'bám đồ vật']]) {
        if (message.metrics[field] && message.metrics[field] !== metrics?.[field]) log('AI',
          `Luồng ${label} đang gặp lỗi và sẽ thử ở khung tiếp theo. Bật AI_DEBUG=1 để xem chẩn đoán.`, 'warn');
        else if (!message.metrics[field] && metrics?.[field]) log('AI', `Luồng ${label} đã phục hồi.`);
      }
      metrics = message.metrics;
    }
    const job = pending.get(message.id);
    if (!job) return;
    pending.delete(message.id);
    clearTimeout(job.timeout);
    if (message.error) job.reject(new HttpError(422, 'AI không xử lý được khung hình: ' + message.error));
    else job.resolve({people:message.people ?? [],objects:message.objects ?? [],frameAt:message.frameAt,memory:message.memory});
  });
  const killChild = () => {
    if (process.platform === 'win32' && child.pid) {
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch { /* fall back to direct kill */ }
    }
    child.kill();
  };
  const startup = setTimeout(() => {
    fail(new Error('AI chưa khởi tạo được trong 90 giây.'));
    killChild();
  }, 90000);
  const cancelStartup = () => {
    closing = true;
    fail(new Error('Đã hủy khởi tạo AI.'));
    child.stdin.end();
    killChild();
  };
  signal?.addEventListener('abort', cancelStartup, { once: true });
  if (signal?.aborted) cancelStartup();
  try { await initialization; }
  catch (error) { killChild(); throw error; }
  finally { clearTimeout(startup); signal?.removeEventListener('abort', cancelStartup); }
  const pixels=createPixelTracker(python,backend,{...await localAIEnv(backend),PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'});
  const engine:InferenceEngine = {
    trackFrame:(jpeg,context)=>pixels.track(jpeg,context.sessionId,context.frameId,context.capturedAt),
    seedGeometry:(session,seeds)=>pixels.seed(session,seeds,true),
    detector: 'classroom',
    get ready() { return ready && !closing; },
    get startupError() { return lastFailure?.message; },
    get capabilities() { return capabilities; },
    get metrics() { return metrics; },
    async detect(jpeg, context) {
      // Legacy face-detector callers keep their face rectangles. The web API
      // uses detectFrame and receives canonical person tracks with optional faces.
      return (await this.detectFrame!(jpeg,context)).people.filter(person=>person.faceVisibility!=='unavailable'&&(person.faceBox||person.boxKind==='face'))
        .map(person=>({...person,box:person.faceBox??person.box,boxKind:'face' as const}));
    },
    detectFrame(jpeg, context) {
      if (!ready || closing) return Promise.reject(new HttpError(503, 'AI chưa sẵn sàng.'));
      if (pending.size >= 4) return Promise.reject(new HttpError(429, 'AI đang bận. Thử lại sau.'));
      const id = ++sequence;
      return new Promise((yes, no) => {
        const timeout = setTimeout(() => { pending.delete(id); no(new HttpError(504, 'Khung hình xử lý quá thời gian.')); }, 30000);
        pending.set(id, { resolve: yes, reject: no, timeout });
        child.stdin.write(JSON.stringify({ type: 'frame', id, session: context?.sessionId ?? 'default',
          at:process.env.AI_EXPORT_VIDEO_TIMELINE==='1'?context?.frameAt:undefined,frameId:context?.frameId,image: jpeg.toString('base64') }) + '\n', error => {
          if (error) { clearTimeout(timeout); pending.delete(id); no(error); }
        });
      });
    },
    configure(sessionId, features) {
      if (!closing) child.stdin.write(JSON.stringify({ type: 'configure', session: sessionId, features }) + '\n');
    },
    release(sessionId) {
      pixels.release(sessionId);
      if (!closing) child.stdin.write(JSON.stringify({ type: 'release', session: sessionId }) + '\n');
    },
    async close() {
      if (closing) return;
      closing = true;
      await pixels.close();
      fail(new HttpError(503, 'Backend đang dừng.'));
      lines.close();
      diagnostics.close();
      child.stdin.end();
      await new Promise<void>(yes => {
        const timer = setTimeout(() => { killChild(); yes(); }, 15000);
        child.once('exit', () => { clearTimeout(timer); yes(); });
        if (child.exitCode !== null) { clearTimeout(timer); yes(); }
      });
    },
  };
  return engine;
}
