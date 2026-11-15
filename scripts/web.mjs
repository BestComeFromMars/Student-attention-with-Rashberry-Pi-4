import { createServer } from '../frontend/node_modules/vite/dist/node/index.js';
const server = await createServer({ server: { host: 'localhost', port: 3000, strictPort: true }, logLevel: 'warn' });
await server.listen();
console.log('WEB: http://localhost:3000 · Bật camera rồi bắt đầu nhận diện.');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server.close();
  if (process.connected) process.disconnect();
}
process.on('SIGINT', () => { void close(); });
process.on('SIGTERM', () => { void close(); });
process.on('message', message => { if (message === 'student-attention:stop') void close(); });
process.on('disconnect', () => { void close(); });
