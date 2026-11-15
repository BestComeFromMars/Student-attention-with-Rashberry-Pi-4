import type { Plugin } from 'vite';

/** A missing backend is an expected startup state, not a Vite proxy stack trace. */
export function backendHealth(target: string): Plugin {
  return {
    name: 'student-attention-backend-health',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const path = request.url?.split('?')[0];
        if (request.method !== 'GET' || !['/api/health', '/api/pi/status'].includes(path ?? '')) return next();
        try {
          const upstream = await fetch(target.replace(/\/$/, '') + path, {
            signal: AbortSignal.timeout(5000),
          });
          const body = await upstream.text();
          response.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(body);
        } catch {
          response.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ status: 'unavailable', modelReady: false,
            error: 'Chưa kết nối backend. Chạy npm start trong thư mục backend.' }));
        }
      });
    },
  };
}
