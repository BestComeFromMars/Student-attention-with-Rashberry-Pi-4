import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { backendHealth } from './dev/backend-health.ts';
import { viteCacheDirectory } from './dev/cache-directory.ts';
import { cameraLifecycle } from './dev/camera-lifecycle.ts';

// Generated files must be deletable by the same Windows account that runs Vite.
// Keep sandbox/admin/user caches separate, including dependency re-optimization.
const cacheDir = viteCacheDirectory(import.meta.url);

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.BACKEND_URL || 'http://127.0.0.1:3001';
  return {
  cacheDir,
  plugins: [react(), backendHealth(backend), cameraLifecycle()],
  server: {
    proxy: { '/api': { target: backend, changeOrigin: true, proxyTimeout: 90000 } },
  },
  build: { chunkSizeWarningLimit: 1500 },
  };
});
