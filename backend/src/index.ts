import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createApp } from './app.js';
import { createInferenceEngine } from './inference.js';
import { PiSource } from './pi-source.js';
import { InferenceRuntime } from './inference-runtime.js';
import { PiController } from './pi-controller.js';
import { log } from './logger.js';
import {HistoryStore} from './history-store.js';

const port = Number(process.env.PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT phải nằm trong khoảng 1–65535.');
const engine = new InferenceRuntime(signal => createInferenceEngine(
  fileURLToPath(new URL('../models/classroom/', import.meta.url)), signal));
const pi = new PiSource();
const piController = process.env.PI_CONTROL_URL ? new PiController(pi, {
  url: process.env.PI_CONTROL_URL, token: process.env.PI_TOKEN ?? '',
  rtspUrl: process.env.PI_RTSP_URL ?? '', ready: () => engine.ready,
}) : undefined;
const history=new HistoryStore(process.env.HISTORY_DIR||fileURLToPath(new URL('../../uploads/detection-history/',import.meta.url)));
const server = createServer(createApp({ engine, pi, piToken: process.env.PI_TOKEN, piController,history }));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  log('HỆ THỐNG', 'Đang dừng backend; đóng kết nối web, video và các tiến trình AI. Pi vẫn được cấp nguồn.');
  pi.close();
  server.close();
  server.closeAllConnections();
  await Promise.all([engine.close(), piController?.close(),history.close()]);
  log('HỆ THỐNG', 'Đã dừng backend và thu hồi các tiến trình con.');
}
server.on('error', error => {
  log('HỆ THỐNG', (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
    ? `Cổng ${port} đang được chương trình khác sử dụng. Dừng backend cũ hoặc đổi PORT rồi chạy lại.`
    : 'Không thể mở backend: ' + error.message, 'error');
  process.exitCode = 1;
  void shutdown();
});
server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
  piController?.start();
  log('HỆ THỐNG', 'Backend http://localhost:' + port + ' · Web http://localhost:3000 · Ctrl+C để dừng.');
  if (!piController) log('PI', 'Chưa cấu hình Pi; webcam máy tính vẫn hoạt động. Xem backend/.env.example.');
  log('AI', 'Đang nạp mô hình; ứng dụng tự kết nối khi sẵn sàng.');
  void engine.start().then(() => {
    if (closing) return;
    if (engine.ready) log('AI', 'AI đã sẵn sàng. Có thể bật camera và bắt đầu nhận diện.');
    else log('AI', 'Không nạp được AI: ' + engine.startupError + '. Backend giữ /api/health để hiển thị lỗi.', 'error');
  });
});
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('message', message => {
  if (message === 'student-attention:stop') void shutdown().finally(() => { if (process.connected) process.disconnect(); });
});
process.on('disconnect', () => { void shutdown(); });
