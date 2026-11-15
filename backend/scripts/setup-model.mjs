import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { x as extract } from 'tar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const models = [
  { name: 'detector', source: 'https://www.kaggle.com/api/v1/models/mediapipe/face-detection/tfJs/short/1/download' },
  { name: 'landmarks', source: 'https://www.kaggle.com/api/v1/models/mediapipe/face-landmarks-detection/tfJs/face-mesh/1/download' },
];
function safePath(base, name) {
  const path = resolve(base, name);
  const rel = relative(base, path);
  if (isAbsolute(name) || rel.startsWith('..') || isAbsolute(rel) || path === base) throw new Error('Invalid model path: ' + name);
  return path;
}
async function installed(directory, source) {
  try {
    const marker = JSON.parse(await readFile(resolve(directory, 'installation.json'), 'utf8'));
    const graph = JSON.parse(await readFile(resolve(directory, 'model.json'), 'utf8'));
    if (marker.source !== source || !graph.modelTopology || !graph.weightsManifest?.length) return false;
    for (const name of ['model.json', ...graph.weightsManifest.flatMap(group => group.paths)]) {
      const record = marker.files?.find(file => file.path === name);
      if (!record) return false;
      const bytes = await readFile(safePath(directory, name));
      if (bytes.length !== record.bytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) return false;
    }
    return true;
  } catch { return false; }
}
for (const model of models) {
  const directory = resolve(root, 'models/facemesh', model.name);
  if (await installed(directory, model.source)) {
    console.log('FaceMesh ' + model.name + ': đủ tệp, SHA-256 hợp lệ.');
    continue;
  }
  await mkdir(directory, { recursive: true });
  await rm(resolve(directory, 'installation.json'), { force: true });
  console.log('Đang tải mô hình FaceMesh ' + model.name + '...');
  let bytes;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(model.source, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      bytes = Buffer.from(await response.arrayBuffer());
      if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('Nguồn mô hình không trả về tệp gzip.');
      break;
    } catch (error) { if (attempt === 2) throw error; }
  }
  const archive = resolve(directory, 'download.tar.gz');
  await writeFile(archive, bytes);
  try {
    await extract({
      file: archive, cwd: directory, strict: true,
      filter: (name, entry) => {
        const cleaned = name.startsWith('./') ? name.slice(2) : name;
        return entry.type === 'File' && !cleaned.includes('/') && !cleaned.includes('\\')
          && (cleaned === 'model.json' || /^group[\w.-]+$/.test(cleaned));
      },
    });
  } finally { await rm(archive, { force: true }); }
  const graph = JSON.parse(await readFile(resolve(directory, 'model.json'), 'utf8'));
  if (!graph.modelTopology || !graph.weightsManifest?.length) throw new Error('Mô hình FaceMesh không hợp lệ.');
  const files = [];
  for (const name of ['model.json', ...graph.weightsManifest.flatMap(group => group.paths)]) {
    const path = safePath(directory, name);
    const contents = await readFile(path);
    files.push({ path: name, bytes: (await stat(path)).size, sha256: createHash('sha256').update(contents).digest('hex') });
  }
  await writeFile(resolve(directory, 'installation.json'), JSON.stringify({ source: model.source, installedAt: new Date().toISOString(), files }, null, 2) + '\n');
  console.log('Đã cài FaceMesh ' + model.name + ' local.');
}
