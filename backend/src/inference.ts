import { Worker } from 'node:worker_threads';
import { checkModel } from './model-health.js';
import { HttpError } from './errors.js';
import { resolve } from 'node:path';
import type { DetectedPerson, InferenceEngine } from './types.js';
import { createPythonEngine } from './python-inference.js';

interface Job {
  id: number;
  jpeg: Buffer;
  resolve: (people: DetectedPerson[]) => void;
  reject: (error: Error) => void;
}
export async function createInferenceEngine(modelDirectory: string, signal?: AbortSignal): Promise<InferenceEngine> {
  signal?.throwIfAborted();
  if (process.env.AI_ENGINE !== 'facemesh') return createPythonEngine(modelDirectory, signal);
  modelDirectory = resolve(modelDirectory,'../facemesh');
  if (!await checkModel(resolve(modelDirectory, 'detector')) || !await checkModel(resolve(modelDirectory, 'landmarks'))) {
    throw new Error('Mô hình FaceMesh thiếu hoặc hỏng. Chạy npm run setup:model trong backend.');
  }
  const worker = new Worker(new URL('./inference-worker.js', import.meta.url), { workerData: { modelDirectory } });
  let ready = false;
  let closed = false;
  let nextId = 0;
  let active: Job | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const queue: Job[] = [];
  let initialized!: () => void;
  let failed!: (error: Error) => void;
  const initialization = new Promise<void>((resolve, reject) => { initialized = resolve; failed = reject; });
  const fail = (error: Error) => {
    ready = false;
    failed(error);
    if (timeout) clearTimeout(timeout);
    timeout = null;
    active?.reject(error);
    active = null;
    queue.splice(0).forEach(job => job.reject(error));
  };
  const pump = () => {
    if (active || !ready || closed) return;
    active = queue.shift() ?? null;
    if (!active) return;
    worker.postMessage({ id: active.id, jpeg: active.jpeg });
    timeout = setTimeout(() => {
      fail(new HttpError(503, 'AI xử lý quá thời gian. Khởi động lại backend.'));
      void worker.terminate();
    }, 60000);
  };
  worker.on('error', error => fail(error));
  worker.on('exit', code => {
    if (!closed) fail(new HttpError(503, 'Luồng AI đã dừng (mã ' + code + '). Khởi động lại backend.'));
  });
  worker.on('message', (message: { type?: string; id?: number; people?: DetectedPerson[]; error?: string }) => {
    if (message.type === 'ready') {
      ready = true;
      initialized();
      pump();
      return;
    }
    if (!active || message.id !== active.id) return;
    if (timeout) clearTimeout(timeout);
    timeout = null;
    if (message.error) active.reject(new HttpError(422, message.error));
    else active.resolve(message.people ?? []);
    active = null;
    pump();
  });
  const startupTimeout = setTimeout(() => {
    fail(new Error('Không thể khởi tạo AI trong 60 giây.'));
    void worker.terminate();
  }, 60000);
  const cancelStartup = () => {
    closed = true;
    fail(new Error('Đã hủy khởi tạo AI.'));
    void worker.terminate();
  };
  signal?.addEventListener('abort', cancelStartup, { once: true });
  if (signal?.aborted) cancelStartup();
  try { await initialization; }
  catch (error) { await worker.terminate(); throw error; }
  finally { clearTimeout(startupTimeout); signal?.removeEventListener('abort', cancelStartup); }
  return {
    detector: 'facemesh',
    get ready() { return ready && !closed; },
    detect(jpeg) {
      if (!ready || closed) return Promise.reject(new HttpError(503, 'AI chưa sẵn sàng.'));
      if (queue.length >= 4) return Promise.reject(new HttpError(429, 'Máy chủ AI đang bận. Thử lại sau.'));
      return new Promise((resolve, reject) => { queue.push({ id: ++nextId, jpeg, resolve, reject }); pump(); });
    },
    async close() {
      if (closed) return;
      closed = true;
      fail(new HttpError(503, 'Backend đang dừng.'));
      await worker.terminate();
    },
  };
}
