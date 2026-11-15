import { mkdir, rename } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { root, run, exists } from './runtime.mjs';

const target = process.argv[2];
if (!['frontend', 'backend'].includes(target)) throw new Error('Expected frontend or backend');
const stage = resolve(root, '.runtime/build', target + '-' + Date.now() + '-' + process.pid);
const destination = resolve(root, target, 'dist');
const previous = resolve(root, '.runtime/previous', target + '-dist-' + Date.now());
for (const path of [stage, destination, previous]) {
  const local = relative(root, path);
  if (local.startsWith('..') || isAbsolute(local)) throw new Error('Build outputs must stay inside the workspace');
}
await mkdir(stage, { recursive: true });
await mkdir(resolve(root, '.runtime/previous'), { recursive: true });
if (target === 'frontend') {
  const { build } = await import('../frontend/node_modules/vite/dist/node/index.js');
  await build({ root: resolve(root, 'frontend'), configFile: resolve(root, 'frontend/vite.config.ts'),
    build: { outDir: stage, emptyOutDir: true } });
} else await run(process.execPath, [resolve(root, 'backend/node_modules/typescript/bin/tsc'), '--outDir', stage], { cwd: resolve(root, 'backend') });
const hadPrevious = await exists(destination);
if (hadPrevious) await rename(destination, previous);
try { await rename(stage, destination); }
catch (error) { if (hadPrevious) await rename(previous, destination); throw error; }
console.log('Build ' + target + ': OK');
