import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import * as tf from '@tensorflow/tfjs';
import { setThreadsCount, setWasmPaths } from '@tensorflow/tfjs-backend-wasm';
import { createDetector, SupportedModels } from '@tensorflow-models/face-landmarks-detection';
import sharp from 'sharp';
import type { DetectedPerson } from './types.js';
import { normalizeBox } from './geometry.js';
import { measureFace } from './face-signals.js';

const port = parentPort!;
const directory: string = workerData.modelDirectory;
try {
  const require = createRequire(import.meta.url);
  setWasmPaths(dirname(require.resolve('@tensorflow/tfjs-backend-wasm')) + sep);
  setThreadsCount(1);
  if (!await tf.setBackend('wasm')) throw new Error('WASM unavailable');
} catch {
  await tf.setBackend('cpu');
}
await tf.ready();

async function localModel(name: string): Promise<tf.io.IOHandler> {
  const base = resolve(directory, name);
  const graph = JSON.parse(await readFile(resolve(base, 'model.json'), 'utf8'));
  const buffers: Buffer[] = [];
  const weightSpecs: tf.io.WeightsManifestEntry[] = [];
  for (const group of graph.weightsManifest) {
    weightSpecs.push(...group.weights);
    for (const path of group.paths) buffers.push(await readFile(resolve(base, path)));
  }
  const bytes = Buffer.concat(buffers);
  return {
    load: async () => ({
      modelTopology: graph.modelTopology, weightSpecs,
      weightData: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      format: graph.format, generatedBy: graph.generatedBy, convertedBy: graph.convertedBy,
      signature: graph.signature, userDefinedMetadata: graph.userDefinedMetadata,
    }),
  };
}
const model = await createDetector(SupportedModels.MediaPipeFaceMesh, {
  runtime: 'tfjs', maxFaces: 30, refineLandmarks: false,
  detectorModelUrl: await localModel('detector'),
  landmarkModelUrl: await localModel('landmarks'),
});
const warmup = tf.zeros([240, 320, 3], 'int32') as tf.Tensor3D;
try { await model.estimateFaces(warmup, { staticImageMode: true, flipHorizontal: false }); }
finally { warmup.dispose(); }
port.postMessage({ type: 'ready', backend: tf.getBackend() });

async function detect(bytes: Uint8Array): Promise<DetectedPerson[]> {
  const image = sharp(Buffer.from(bytes), { limitInputPixels: 4_000_000, failOn: 'error' });
  const metadata = await image.metadata();
  if (metadata.format !== 'jpeg') throw new Error('Chỉ chấp nhận ảnh JPEG.');
  const { data, info } = await image.removeAlpha().toColourspace('srgb')
    .resize({ width: 960, height: 960, fit: 'inside', withoutEnlargement: true })
    .raw().toBuffer({ resolveWithObject: true });
  const input = tf.tensor3d(new Uint8Array(data), [info.height, info.width, 3], 'int32');
  try {
    // Static mode runs face detection for every request; no cross-session model tracking.
    const faces = await model.estimateFaces(input, { staticImageMode: true, flipHorizontal: false });
    const people: DetectedPerson[] = [];
    for (const face of faces) {
      const { xMin, yMin, width, height } = face.box;
      const box = normalizeBox([xMin, yMin, width, height], info.width, info.height);
      if (!box) continue;
      people.push({ box, boxKind: 'face', observation: measureFace(face.keypoints, width) });
    }
    return people;
  } finally { input.dispose(); }
}
port.on('message', async ({ id, jpeg }: { id: number; jpeg: Uint8Array }) => {
  try { port.postMessage({ id, people: await detect(jpeg) }); }
  catch {
    port.postMessage({ id, error: 'Không thể phân tích khuôn mặt từ ảnh JPEG. Kiểm tra nguồn hình hoặc thử lại.' });
  }
});
