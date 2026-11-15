import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, rename, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {localAIEnv} from '../local-ai-env.mjs';

const backend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function main() {
  console.log('[AI] Checking Python environment and local models...');
  const temporary = resolve(backend, '.tmp');
  await mkdir(temporary, { recursive: true });
  await mkdir(resolve(temporary,'ultralytics/Ultralytics'),{recursive:true});
  const python = resolve(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const pipWheel = resolve(temporary, 'pip-25.3.whl');
  const env = { ...await localAIEnv(backend), TEMP: temporary, TMP: temporary,
    PIP_CACHE_DIR: resolve(backend, '.pip-cache'), PYTHONDONTWRITEBYTECODE: '1',
    OMP_NUM_THREADS:'1',MKL_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',
    YOLO_CONFIG_DIR: resolve(temporary, 'ultralytics') };
  async function run(command, args, extra = {}) {
    await new Promise((yes, no) => {
      const child = spawn(command, args, { cwd: backend, stdio: 'inherit', env: { ...env, ...extra }, windowsHide: true });
      child.on('error', no);
      child.on('exit', (code, signal) => code === 0 ? yes() : no(new Error(
        command + ' exited with ' + (signal ? 'signal ' + signal : 'code ' + code))));
    });
  }
  try { await access(python); }
  catch { await run(process.env.AI_PYTHON_BOOTSTRAP || 'python', ['-m', 'venv', '.venv']); }
  const requirements = await readFile(resolve(backend, 'ai/requirements.lock.txt'), 'utf8');
  const fingerprint = createHash('sha256').update(requirements + '|torch=2.5.1|torchvision=0.20.1').digest('hex');
  let installed = false;
  const installedMarker = resolve(backend, '.venv/student-attention-installed.txt');
  try { installed = (await readFile(installedMarker, 'utf8')).trim() === fingerprint; } catch {}
  if (!installed && !process.argv.includes('--models-only')) {
    console.log('[AI] Installing Python dependencies (first run or requirements changed)...');
    try { await access(pipWheel); }
    catch {
      const info = await (await fetch('https://pypi.org/pypi/pip/25.3/json')).json();
      const wheel = info.urls.find(file => file.filename.endsWith('.whl'));
      const bytes = Buffer.from(await (await fetch(wheel.url)).arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== wheel.digests.sha256) throw new Error('Pip wheel checksum mismatch');
      await writeFile(pipWheel, bytes);
    }
    const pipEnv = { PYTHONPATH: pipWheel };
    await run(python, ['-m', 'pip', 'install', 'torch==2.5.1', 'torchvision==0.20.1', '--no-deps',
      '--index-url', 'https://download.pytorch.org/whl/cpu', '--disable-pip-version-check'], pipEnv);
    await run(python, ['-m', 'pip', 'install', '-r', 'ai/requirements.lock.txt', '--disable-pip-version-check'], pipEnv);
    await run(python, ['-c', 'import torch,cv2,mediapipe,ultralytics,lap; print("AI imports OK")']);
    await writeFile(installedMarker, fingerprint + '\n');
  }
  else console.log('[AI] Python dependency setup skipped; checking model checksums.');
  const models = JSON.parse((await readFile(resolve(backend,'ai/models.json'),'utf8')).replace(/^\uFEFF/,'')).files
    .filter(model => !model.path.startsWith('cavt_'));
  const directory = resolve(backend, 'models/classroom');
  await mkdir(directory, { recursive: true });
  async function verified(path, model) {
    try {
      if ((await stat(path)).size !== model.bytes) return false;
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      return hash.digest('hex') === model.sha256;
    } catch { return false; }
  }
  const files = [];
  for (const model of models) {
    const {path:name,source} = model;
    const path = resolve(directory, name);
    console.log(`[AI] Checking ${name} (${Math.ceil(model.bytes / 1024 / 1024)} MB)...`);
    if (!await verified(path,model)) {
      console.log('Downloading ' + name);
      const part = path+'.part';
      if (model.driveId) {
        await run(python,['-m','gdown',model.driveId,'--output',part,'--quiet','--no-cookies']);
      } else {
        const response = await fetch(source, { signal: AbortSignal.timeout(180000) });
        if (!response.ok) throw new Error(name + ': HTTP ' + response.status);
        const download = model.archiveMember ? part + '.zip' : part;
        await pipeline(Readable.fromWeb(response.body),createWriteStream(download));
        if (model.archiveMember) {
          if (!await verified(download, model.archive)) throw new Error('Archive checksum mismatch: ' + name);
          await run(python, ['-c', 'import sys,zipfile,pathlib; pathlib.Path(sys.argv[2]).write_bytes(zipfile.ZipFile(sys.argv[1]).read(sys.argv[3]))',
            download, part, model.archiveMember]);
          const { rm } = await import('node:fs/promises');
          await rm(download);
        }
      }
      if (!await verified(part,model)) throw new Error('Model checksum mismatch: '+name);
      await rename(part,path);
    }
    files.push(model);
  }
  await writeFile(resolve(directory, 'installation.json'), JSON.stringify({ files }, null, 2) + '\n');
  const yoloMarker=resolve(directory,'yolo-inference.json');
  let exported;
  try {exported=JSON.parse(await readFile(yoloMarker,'utf8'));}catch{}
  const derived=[];
  let needsExport=false;
  console.log('[AI] Checking YOLO ONNX exports...');
  for(const name of ['yolo11s','yolo11m','yolo11n-pose']){
    const path=resolve(directory,name+'.onnx');
    if(!exported?.files?.find(file=>file.path===name+'.onnx')||
        !await verified(path,exported.files.find(file=>file.path===name+'.onnx'))){
      const {rm}=await import('node:fs/promises');
      await rm(path,{force:true});
      needsExport=true;
    }
  }
  if(needsExport){
    console.log('[AI] Exporting missing or invalid YOLO ONNX models...');
    await run(python,['ai/export_yolo.py',directory]);
  }
  for(const name of ['yolo11s','yolo11m','yolo11n-pose']){
    const path=resolve(directory,name+'.onnx');
    const hash=createHash('sha256');
    for await(const chunk of createReadStream(path))hash.update(chunk);
    derived.push({path:name+'.onnx',bytes:(await stat(path)).size,sha256:hash.digest('hex'),
      sourceSha256:files.find(file=>file.path===name+'.pt').sha256});
  }
  await writeFile(yoloMarker,JSON.stringify({inputSize:640,files:derived},null,2)+'\n');
  await run(python,['ai/prepare_desk_rest.py']);
  console.log('Observation models verified: YOLO11, SCRFD-10G, OpenCV VitTrack, MediaPipe and corroborated desk-rest evidence. Attention scoring disabled.');
}

try { await main(); }
catch (error) {
  console.error('[AI] Setup failed:', error?.stack || error);
  process.exitCode = 1;
}
