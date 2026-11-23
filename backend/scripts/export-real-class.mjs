import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { createInferenceEngine } from '../dist/inference.js';
import { Sessions } from '../dist/sessions.js';
import { localAIEnv } from '../local-ai-env.mjs';
import { playbackManifest } from './playback-manifest.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const backend = resolve(root, 'backend');
const results = resolve(backend, 'tests/test_results');
const qa = resolve(root, '.qa/real-class-export');
const demoName = 'class100';
const clipNames = [demoName, 'class101', 'class102'];
const args = process.argv.slice(2);
const renderOnly = args.includes('--render-only');
const publishOnly = args.includes('--publish-only');
const classes = args.filter(arg => !['--render-only','--publish-only'].includes(arg));
const names = classes.length ? classes : clipNames;
if (names.some(name => !clipNames.includes(name))) throw Error('Expected class100, class101 or class102');
try { loadEnvFile(resolve(backend, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const env = await localAIEnv(backend);
const python = resolve(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const stride = 12;
const clockStart = Date.UTC(2000, 0, 1);
process.env.AI_EXPORT_SERIAL_NATIVE = '1';
process.env.AI_EXPORT_VIDEO_TIMELINE = '1';
process.env.AI_EXPORT_WAIT_FOR_FACES = '1';

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(Error(command + ' exited ' + code)));
  });
}

async function analyze(name, work, sourcePath, sourceSha256) {
  const prepared = resolve(work, name + '_input_frames');
  await mkdir(work, { recursive: true });
  await run(python, [resolve(backend, 'ai/export_video_io.py'), '--video', sourcePath, '--output', work,
    '--prepare-only', '--sample-stride', String(stride)]);
  const info = JSON.parse(await readFile(resolve(prepared, 'metadata.json'), 'utf8'));
  const engine = await createInferenceEngine(resolve(backend, 'models/classroom'));
  let clock = clockStart;
  const sessions = new Sessions(() => clock);
  const id = sessions.create();
  const replay = {
    release: sessionId => engine.release?.(sessionId),
    detectFrame: (jpeg, context) => engine.detectFrame(jpeg, { ...context, frameAt: clock }),
  };
  const requests = [];
  const started = Date.now();
  let peakPrivateMemoryMB = 0;
  try {
    for (let frame = 0; frame < info.frames; frame += stride) {
      const seconds = frame / info.fps;
      clock = clockStart + Math.round(seconds * 1000);
      const jpeg = await readFile(resolve(prepared, String(frame + 1).padStart(6, '0') + '.jpg'));
      const tracks = await sessions.detect(id, jpeg, replay, 'upload', frame);
      const errors = Object.entries(engine.metrics ?? {}).filter(([key, value]) => key.endsWith('Error') && value);
      if (errors.length) throw Error(JSON.stringify(errors));
      peakPrivateMemoryMB = Math.max(peakPrivateMemoryMB, Number(engine.metrics?.privateMemoryMB) || 0);
      const data = { tracks, objects: sessions.objects(id), memory: sessions.memory(id) };
      requests.push({ index: requests.length + 1, end: clock, sourceSeconds: seconds, completedSourceSeconds: seconds, status: 200, data });
      if (requests.length % 10 === 1) console.log(`${name}: AI frame ${frame + 1}/${info.frames} (${tracks.filter(track => track.status === 'visible').length} people)`);
    }
    await writeFile(resolve(work, 'recording.json'), JSON.stringify({ complete: true, sourcePath, sourceSha256,
      endedAt: clock, requests, capabilities: engine.capabilities, peakPrivateMemoryMB,
      processingSeconds: (Date.now() - started) / 1000 }));
  } finally {
    sessions.delete(id, engine);
    await engine.close();
  }
}

await mkdir(results, { recursive: true });
for (const name of names) {
  const work = resolve(qa, name);
  const sourcePath = resolve(backend, 'tests/video real class', name + '.mp4');
  const sourceSha256 = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  if (!renderOnly && !publishOnly) await analyze(name, work, sourcePath, sourceSha256);
  const recording = JSON.parse(await readFile(resolve(work, 'recording.json'), 'utf8'));
  if (!recording.complete || recording.sourceSha256 !== sourceSha256)
    throw Error(name + ': no complete AI recording for this source');
  const { requests } = recording;
  const video = resolve(work, name + '.mp4');
  if (!publishOnly) await run(process.execPath, [resolve(root, 'frontend/scripts/render-decision-video.mjs'), '--work', work,
    '--output', video, '--source-pixels', ...(name===demoName?['--refine-offline']:[])]);
  const info = JSON.parse(await readFile(resolve(work, 'encoded.json'), 'utf8'));
  if (!info.allSourceFramesPreserved || !info.nativeFpsPreserved || info.decisions !== info.frames || info.output !== video)
    throw Error(name + ': no verified video to publish');
  const output = resolve(results, name + '.mp4');
  await copyFile(video, output + '.tmp');
  await rename(output + '.tmp', output);
  await run(python, [resolve(backend, 'ai/prepare_playback_portraits.py'), '--work', work]);
  const portraits = JSON.parse(await readFile(resolve(work, 'portraits.json'), 'utf8'));
  const asset = resolve(backend, 'storage/demo-video');
  await mkdir(asset, { recursive: true });
  // Publish the pair under a shared version so active playback stays synchronized.
  const version = createHash('sha256').update(await readFile(video)).digest('hex').slice(0, 16);
  const media = resolve(asset, version + '.mp4');
  await copyFile(video, media + '.tmp');
  await rename(media + '.tmp', media);
  const manifest = resolve(asset, name + '.json');
  const geometryPath = resolve(work, 'decision-overlays.json');
  const geometry = JSON.parse(await readFile(geometryPath, 'utf8'));
  const playbackPixels = resolve(work, 'playback-pixels.json');
  await run(python, [resolve(backend, 'ai/prepare_pixel_export.py'), '--work', work, '--source-frames',
    '--appearance-from', geometryPath, '--output', playbackPixels]);
  const { frames } = JSON.parse(await readFile(playbackPixels, 'utf8'));
  const original = resolve(asset, sourceSha256.slice(0, 16) + '.mp4');
  await copyFile(sourcePath, original, constants.COPYFILE_EXCL).catch(error => { if(error.code!=='EEXIST')throw error; });
  await writeFile(manifest + '.tmp', JSON.stringify(playbackManifest(recording, portraits, version, geometry, frames)));
  await rename(manifest + '.tmp', manifest);
  const clips = {};
  for (const clip of clipNames) {
    try { clips[clip] = JSON.parse(await readFile(resolve(asset, clip + '.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const catalog = resolve(asset, 'timeline.json');
  await writeFile(catalog + '.tmp', JSON.stringify({ ...(clips[demoName] ?? clips[name]), clips }));
  await rename(catalog + '.tmp', catalog);
  console.log(`${name}: verified output (${requests.length} AI results, ${info.frames} video frames)`);
}
