import express from 'express';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { Sessions } from './sessions.js';
import { PiSource } from './pi-source.js';
import { HttpError } from './errors.js';
import type { InferenceEngine } from './types.js';
import type { PiController } from './pi-controller.js';
import { log } from './logger.js';
import {observationSettingsSchema} from './observation-settings.js';
import {historyApi} from './history-api.js';
import type {HistoryStore} from './history-store.js';

export interface AppOptions {
  history?:HistoryStore;
  engine: InferenceEngine;
  pi?: PiSource;
  sessions?: Sessions;
  piToken?: string;
  piController?: PiController;
}
export function createApp({ engine, pi = new PiSource(), sessions = new Sessions(), piToken = '', piController,history }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_request, response, next) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.get('/api/health', (_request, response) => {
    response.json({ status: engine.startupState === 'loading' ? 'loading' : engine.startupState === 'error' ? 'error' : 'ok',
      modelReady: engine.ready, inference: 'backend', detector: engine.detector ?? 'classroom',
      ...(engine.startupError ? { error: engine.startupError } : {}),
      ...(engine.capabilities ? { capabilities: engine.capabilities } : {}),
      ...(engine.metrics ? { metrics: engine.metrics } : {}) });
  });
  app.use('/api/history',historyApi(history));
  app.get('/api/observation-settings',(_request,response)=>response.json(observationSettingsSchema()));
  app.post('/api/sessions',express.json({limit:'16kb'}), (request, response) => {
    if (!engine.ready) throw new HttpError(503, 'AI backend chưa sẵn sàng.');
    const sessionId = sessions.create(request.body?.settings);
    log('NHẬN DIỆN', `Bắt đầu phiên ${sessionId.slice(0, 8)}.`);
    response.status(201).json({ sessionId });
  });
  app.get('/api/sessions/:id/settings',(request,response)=>response.json({settings:sessions.settings(String(request.params.id))}));
  app.put('/api/sessions/:id/settings',express.json({limit:'16kb'}),(request,response)=>{
    response.json({settings:sessions.configure(String(request.params.id),request.body)});
  });
  app.delete('/api/sessions/:id', (request, response) => {
    sessions.delete(String(request.params.id),engine);
    log('NHẬN DIỆN', `Đã kết thúc phiên ${String(request.params.id).slice(0, 8)}; thu hồi dữ liệu theo dõi.`);
    response.status(204).end();
  });
  const jpeg = express.raw({ type: 'image/jpeg', limit: '4mb' });
  const requireJpeg: RequestHandler = (request, _response, next) => {
    if (!request.is('image/jpeg')) throw new HttpError(415, 'Content-Type phải là image/jpeg.');
    if (!Buffer.isBuffer(request.body) || request.body.length < 4) throw new HttpError(400, 'Thiếu khung hình JPEG.');
    next();
  };
  app.post('/api/sessions/:id/detect', jpeg, requireJpeg, async (request, response) => {
    const id=String(request.params.id);
    const started=performance.now();
    const header=request.get('X-Frame-Id'),frameId=header===undefined?undefined:Number(header);
    if(frameId!==undefined&&(!Number.isSafeInteger(frameId)||frameId<0))throw new HttpError(400,'Frame ID không hợp lệ.');
    const tracks=await sessions.detect(id, request.body, engine,'upload',frameId);
    response.json({tracks,objects:sessions.objects(id),memory:sessions.memory(id),processingMs:performance.now()-started});
  });
  app.post('/api/sessions/:id/track',jpeg,requireJpeg,async(request,response)=>{
    const frameId=Number(request.get('X-Frame-Id'));
    if(!Number.isSafeInteger(frameId)||frameId<0)throw new HttpError(400,'Frame ID không hợp lệ.');
    const header=request.get('X-Frame-Captured-At'),capturedAt=header===undefined?undefined:Number(header);
    if(capturedAt!==undefined&&(!header?.trim()||!Number.isFinite(capturedAt)||capturedAt<0||capturedAt>Number.MAX_SAFE_INTEGER))
      throw new HttpError(400,'Thời điểm chụp khung hình không hợp lệ.');
    response.json(await sessions.track(String(request.params.id),request.body,engine,frameId,capturedAt));
  });
  app.post('/api/sessions/:id/detect/pi', async (request, response) => {
    const frame=pi.frame();
    const frameAt=pi.status().receivedAt;
    const started=performance.now();
    const tracks=await sessions.detect(String(request.params.id),frame,engine,'pi');
    response.json({ tracks,objects:sessions.objects(String(request.params.id)),memory:sessions.memory(String(request.params.id)),frameAgeMs:Math.max(0,Date.now()-frameAt),processingMs:performance.now()-started });
  });
  const authorizePi: RequestHandler = (request, _response, next) => {
    if (piToken) {
      const supplied = Buffer.from(request.get('X-Pi-Token') ?? '');
      const expected = Buffer.from(piToken);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new HttpError(401, 'PI_TOKEN không khớp.');
    }
    next();
  };
  app.post('/api/pi/frame', authorizePi, jpeg, requireJpeg, async (request, response) => {
    try { await pi.update(request.body); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, 'Không thể giải mã ảnh từ Raspberry Pi.');
    }
    response.status(202).json({ accepted: true });
  });
  app.get('/api/pi/status', (_request, response) => response.json({ ...pi.status(), ...piController?.status() }));
  app.get('/api/pi/stream', (_request, response) => pi.stream(response));
  app.post('/api/client/events', express.json({ limit: '1kb' }), (request, response) => {
    const origin = request.get('Origin');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '') ||
      origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || request.get('X-Client-Event') !== '1') {
      throw new HttpError(403, 'Sự kiện chỉ được gửi từ ứng dụng trên máy này.');
    }
    const messages: Record<string, string> = { camera_on: 'Đã bật camera trên web.', camera_off: 'Đã tắt camera trên web.',
      camera_error: 'Web báo không thể thực hiện thao tác camera/AI. Xem thông báo trên giao diện.',
      detection_running: 'Nhận diện đang chạy trên web.', detection_paused: 'Đã tạm dừng nhận diện; video tiếp tục phát.' };
    const { event, source } = request.body ?? {};
    if (typeof event !== 'string' || !Object.hasOwn(messages, event) || !['pi', 'computer'].includes(source)) throw new HttpError(400, 'Sự kiện không hợp lệ.');
    log(source === 'pi' ? 'WEB / PI' : 'WEBCAM', messages[event], event === 'camera_error' ? 'warn' : 'info', `client:${source}:${event}`);
    response.status(204).end();
  });
  const localControl: RequestHandler = (request, _response, next) => {
    const address = request.socket.remoteAddress;
    const origin = request.get('Origin');
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
      (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) ||
      request.get('X-Pi-Control') !== '1' || !request.is('application/json')) {
      throw new HttpError(403, 'Chỉ điều khiển Pi từ ứng dụng trên máy này.');
    }
    if (!piController) throw new HttpError(503, 'Chưa cấu hình kết nối điều khiển Raspberry Pi.');
    next();
  };
  for (const command of ['start', 'stop', 'shutdown'] as const) {
    const path = command === 'shutdown' ? '/api/pi/shutdown' : '/api/pi/camera/' + command;
    app.post(path, localControl, express.json({ limit: '2kb' }), async (request, response) => {
      if (command === 'shutdown' && request.body?.confirm !== true) throw new HttpError(400, 'Cần xác nhận tắt Raspberry Pi.');
      response.status(202).json(await piController!.command(command));
    });
  }
  app.use((_request, response) => response.status(404).json({ error: 'Không tìm thấy API.' }));
  const errors: ErrorRequestHandler = (error, request, response, _next) => {
    const bodyErrors: Record<string, number> = {
      'entity.too.large': 413, 'encoding.unsupported': 415, 'charset.unsupported': 415,
      'entity.parse.failed': 400, 'request.aborted': 400, 'request.size.invalid': 400,
    };
    const status = error instanceof HttpError ? error.status : bodyErrors[error?.type] ?? 500;
    const message = error instanceof HttpError ? error.message : status === 413 ? 'Khung hình vượt quá 4 MB.'
      : status === 415 ? 'Kiểu mã hóa khung hình không được hỗ trợ.'
      : status === 400 ? 'Yêu cầu khung hình không hợp lệ.' : 'Lỗi máy chủ. Thử lại hoặc khởi động lại backend.';
    if (status >= 400) log(status === 409 ? 'XUNG ĐỘT' : 'API', `${request.method} ${request.route?.path ?? request.path} · ${status}: ${message}`,
      status >= 500 ? 'error' : 'warn', `${request.method}:${request.route?.path ?? request.path}:${status}`);
    if (status >= 500) log('CHẨN ĐOÁN', String(error?.stack ?? error), 'debug');
    response.status(status).json({ error: message });
  };
  app.use(errors);
  return app;
}
