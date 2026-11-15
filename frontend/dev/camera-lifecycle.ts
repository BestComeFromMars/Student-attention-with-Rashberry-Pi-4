import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

export function cameraLifecycle(): Plugin {
  const controllers = new Set(['../src/lib/session.ts', '../src/hooks/useObservation.ts']
    .map(path => fileURLToPath(new URL(path, import.meta.url)).replaceAll('\\', '/')));
  return {
    name: 'student-attention-camera-lifecycle',
    apply: 'serve',
    handleHotUpdate({ file, server }) {
      if (!controllers.has(file.replaceAll('\\', '/'))) return;
      // Stateful controllers keep old class methods across ordinary Fast Refresh.
      // Recreate them after a controller edit; pagehide releases any active stream.
      server.ws.send({ type: 'full-reload' });
      return [];
    },
  };
}
