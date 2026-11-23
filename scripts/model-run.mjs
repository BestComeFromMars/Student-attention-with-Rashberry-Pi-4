import { createServer } from 'node:http';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { localAIEnv } from '../backend/local-ai-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = resolve(root, 'backend');

function usage() {
  console.log('Cach dung:');
  console.log('  .\\model run <duong-dan-video.mp4> [so-RAM-GB] [--ram 8GB] [--loop] [--objects] [--width 1120]');
  console.log('');
  console.log('Vi du (tu dong uu tien video goc chua ve khung):');
  console.log('  .\\model run class100.mp4');
  console.log('  .\\model run class100.mp4 8');
  console.log('  .\\model run class100.mp4 16GB');
  console.log('  .\\model run "backend\\tests\\video real class\\class100.mp4" 8GB --objects');
}

function parseRamMb(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*(gb|g|mb|m)?$/i.exec(String(raw ?? '').trim());
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = (match[2] ?? '').toLowerCase();
  if (unit === 'mb' || unit === 'm' || (!unit && amount >= 512)) {
    return Math.round(amount);
  }
  return Math.round(amount * 1024);
}

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === 'run' ? rawArgs.slice(1) : rawArgs;
if (!args.length || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(args.length ? 0 : 1);
}

const flags = [];
let videoArg = null;
let ramArg = null;
for (let i = 0; i < args.length; i++) {
  const token = args[i];
  if (token === '--ram' && i + 1 < args.length) {
    ramArg = args[++i];
  } else if (token.startsWith('--ram=')) {
    ramArg = token.slice('--ram='.length);
  } else if (token.startsWith('--')) {
    flags.push(token);
    if (['--width', '--headless-smoke'].includes(token) && i + 1 < args.length) {
      flags.push(args[++i]);
    }
  } else if (!videoArg) {
    videoArg = token;
  } else if (ramArg === null && parseRamMb(token) !== null) {
    ramArg = token;
  }
}

let ramMb = null;
if (ramArg !== null) {
  ramMb = parseRamMb(ramArg);
  if (ramMb === null) {
    console.error(`MODEL: Gia tri RAM khong hop le: "${ramArg}". Vi du hop le: 8, 8GB, 16, 16GB, 8192MB.`);
    process.exit(1);
  }
}

if (!videoArg) {
  usage();
  process.exit(1);
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function resolveVideo(input) {
  const withExt = input.toLowerCase().endsWith('.mp4') ? input : `${input}.mp4`;
  const candidates = [
    resolve(process.cwd(), input),
    resolve(root, input),
    resolve(backend, 'tests/video real class', withExt),
    resolve(backend, 'tests/videos', withExt),
    resolve(backend, 'tests/test_results', withExt),
  ];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  throw new Error(`Khong tim thay video: ${input}`);
}

const videoPath = await resolveVideo(videoArg);
if (videoPath.toLowerCase().includes(`${resolve(backend, 'tests/test_results').toLowerCase()}`)) {
  console.warn('CANH BAO: Video nay nam trong backend\\tests\\test_results (da in san khung tu lan xuat truoc).');
  console.warn('          Nen dung video goc trong "backend\\tests\\video real class" hoac "backend\\tests\\videos" de khong bi ve de 2 lop khung.');
}

if (!await exists(resolve(backend, 'dist/inference.js'))) {
  console.log('MODEL: Chua co backend/dist, dang build backend...');
  await new Promise((ok, fail) => {
    const build = spawn(process.execPath, [resolve(root, 'scripts/build.mjs'), 'backend'], {
      cwd: root, stdio: 'inherit', windowsHide: true,
    });
    build.once('error', fail);
    build.once('exit', code => code === 0 ? ok() : fail(new Error(`Build backend failed (${code})`)));
  });
}

try { loadEnvFile(resolve(backend, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
delete process.env.AI_EXPORT_SERIAL_NATIVE;
delete process.env.AI_EXPORT_VIDEO_TIMELINE;
if (ramMb !== null) {
  // Match backend/ai/runtime_profile.py: <= 10752 MB -> lite (8 GB), > 10752 MB -> balanced (16 GB+).
  const aiProfile = ramMb <= 10752 ? 'lite' : 'balanced';
  process.env.AI_PROFILE = aiProfile;
  const ramGb = (ramMb / 1024).toFixed(ramMb % 1024 === 0 ? 0 : 1);
  console.log(`MODEL: Cau hinh test RAM ${ramGb} GB (${ramMb} MB) -> AI_PROFILE=${aiProfile} (dung cau hinh backend)`);
}
const env = await localAIEnv(backend);
for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = env.TEMP;

const [{ createInferenceEngine }, { InferenceRuntime }, { createApp }] = await Promise.all([
  import('../backend/dist/inference.js'),
  import('../backend/dist/inference-runtime.js'),
  import('../backend/dist/app.js'),
]);

console.log(`MODEL: Dang nap model AI...`);
const engine = new InferenceRuntime(signal => createInferenceEngine(resolve(backend, 'models/classroom'), signal));
await engine.start();
if (!engine.ready) {
  console.error('MODEL: Khong nap duoc AI runtime:', engine.startupError ?? 'Unknown error');
  await engine.close();
  process.exit(1);
}
if (engine.capabilities) {
  console.log(`MODEL: AI san sang (profile=${engine.capabilities.profile ?? 'auto'}, people=${engine.capabilities.people}, faces=${engine.capabilities.faces})`);
}

const app = createApp({ engine });
const server = createServer(app);
await new Promise(done => server.listen(0, '127.0.0.1', done));
const api = `http://127.0.0.1:${server.address().port}/api`;
const python = resolve(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

console.log(`MODEL: Mo cua so realtime -> ${videoPath}`);
let child;
let shuttingDown = false;
async function cleanup(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child && child.exitCode === null) child.kill('SIGTERM');
  server.closeAllConnections?.();
  await new Promise(done => server.close(() => done()));
  await engine.close();
  process.exit(code);
}
process.on('SIGINT', () => { void cleanup(0); });
process.on('SIGTERM', () => { void cleanup(0); });

child = spawn(python, [
  resolve(root, 'scripts/live_video_preview.py'),
  '--video', videoPath,
  '--api', api,
  ...flags,
], {
  cwd: root,
  env: { ...process.env, ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  stdio: 'inherit',
});

child.once('error', error => {
  console.error('MODEL: Loi mo cua so preview:', error.message);
  void cleanup(1);
});
child.once('exit', code => {
  void cleanup(code ?? 0);
});
