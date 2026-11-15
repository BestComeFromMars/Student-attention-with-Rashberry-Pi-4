import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createInferenceEngine } from '../dist/inference.js';
import { StudentTracker } from '../dist/tracker.js';
import { AttentionEvaluator } from '../dist/attention.js';
import assert from 'node:assert/strict';

const engine = await createInferenceEngine(fileURLToPath(new URL('../models/classroom/', import.meta.url)));
try {
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#152c29' } }).jpeg().toBuffer();
  const started = performance.now();
  const people = await engine.detect(jpeg);
  if (!Array.isArray(people)) throw new Error('Invalid inference result');
  assert.equal(people.length, 0, 'An empty image must not create a student');
  console.log('Backend đã giải mã JPEG và suy luận bằng mô hình local: ' + Math.round(performance.now() - started) + ' ms, ' + people.length + ' người trong ảnh tổng hợp.');
  const portrait = await readFile(new URL('../test-fixtures/portrait.jpg', import.meta.url));
  // Face parts and objects cropped from the already licensed public fixture.
  // These are negative smoke checks, not a labeled classroom accuracy dataset.
  for (const [name, rectangle] of Object.entries({
    ear: { left: 280, top: 165, width: 47, height: 140 },
    sleeve: { left: 120, top: 500, width: 160, height: 200 },
    background: { left: 0, top: 0, width: 220, height: 300 },
  })) {
    const crop = await sharp(portrait).extract(rectangle).resize(640, 480, { fit: 'contain' }).jpeg().toBuffer();
    const negative = await engine.detect(crop, { sessionId: 'negative-' + name });
    await delay(250);
    assert.equal((await engine.detect(crop, { sessionId: 'negative-' + name })).length, 0,
      name + ' alone must not create a student after analysis');
    assert.equal(negative.length, 0);
    engine.release('negative-' + name);
  }
  let faces = [];
  const tracker = new StudentTracker();
  const attention = new AttentionEvaluator();
  let tracks=[];
  const deadline=Date.now()+60000;
  while(Date.now()<deadline) {
    faces = await engine.detect(portrait,{sessionId:'model-verification'});
    tracks=attention.evaluate(tracker.update(faces,Date.now()),Date.now());
    const observation=faces[0]?.observation;
    if (observation?.valid &&
        typeof observation.phoneHeld==='boolean' && faces[0].personId!=null &&
        observation.bodyPose&&tracks[0].signals.filter(signal=>
          !['head_turned','torso_turned','turned_smiling','upper_body_slumped'].includes(signal.type))
          .every(signal=>signal.state!=='unavailable')) break;
    await delay(190);
  }
  if (!faces.length || faces.some(face => face.boxKind !== 'face') || !faces.some(face => face.observation?.valid)) {
    throw new Error('Không xác nhận được bbox mặt và điểm mắt trên ảnh kiểm thử TensorFlow.');
  }
  console.log('Pipeline nhận diện được ' + faces.length + ' khuôn mặt và điểm mắt hợp lệ trên ảnh kiểm thử chính thức.');
  const measured = faces[0].observation;
  assert.equal(measured.facePresent,true,'MediaPipe must confirm a mesh matching the requested face box');
  assert(Number.isFinite(measured.leftEyeAspectRatio) && Number.isFinite(measured.rightEyeAspectRatio),
    'Both per-eye EAR measurements must reach the evaluator');
  assert(Math.abs(measured.eyeAspectRatio - (measured.leftEyeAspectRatio + measured.rightEyeAspectRatio) / 2) < 1e-6);
  assert.equal(engine.metrics?.analysisError,null);
  assert.equal(engine.metrics?.geometryError,null);
  assert.equal(engine.capabilities.cavt,'disabled_observation_only');
  assert.equal(engine.capabilities.attentionScoring,false);
  assert.equal(faces[0].observation.cavtScore,undefined,'Observation mode must not produce an engagement score');
  assert(tracks.every(track=>track.attention!=='focused'),'Observation mode must not classify concentration');
  assert(faces[0].personId!=null,'YOLO11s and ByteTrack must provide a body ID');
  assert.equal(tracks[0].signals.length,11);
  assert.equal(engine.capabilities.behaviors,11);
  assert.equal(measured.bodyPose?.keypoints.length,17,'Timestamped pose must be attached to the detected person');
  console.log(JSON.stringify({capabilities:engine.capabilities,metrics:engine.metrics,observation:faces[0].observation}));
  assert(tracks[0].signals.filter(signal=>!['head_turned','torso_turned','turned_smiling','upper_body_slumped'].includes(signal.type))
    .every(signal=>signal.state!=='unavailable'),'Seven original observations must reach the evaluator: '+JSON.stringify(tracks[0].signals));
  const output=new URL('../../.qa/',import.meta.url);
  await mkdir(output,{recursive:true});
  await writeFile(new URL('model-verification.json',output),JSON.stringify({
    verifiedAt:new Date().toISOString(),fixture:'TensorFlow official portrait; not action-labeled video',
    capabilities:engine.capabilities,metrics:engine.metrics,observation:faces[0].observation,signals:tracks[0].signals,
  },null,2)+'\n');
  engine.release('model-verification');
  const fresh=await engine.detect(portrait,{sessionId:'model-verification'});
  assert(!fresh.some(face=>face.observation?.valid),'A released session must not reuse old face measurements');
  let rejected = false;
  try { await engine.detect(Buffer.from('not-a-jpeg')); } catch { rejected = true; }
  if (!rejected) throw new Error('Invalid JPEG should be rejected');
  console.log('Đã kiểm tra từ chối ảnh hỏng. Không mở server hoặc webcam.');
} finally {
  await engine.close();
  console.log('Luồng AI đã dừng.');
}
