import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createInferenceEngine } from '../dist/inference.js';
import { createApp } from '../dist/app.js';
import { PiSource } from '../dist/pi-source.js';

// Real models/worker + real HTTP routes. Pi JPEG input is a public fixture in
// RAM; this does not claim to test two people in front of the physical Pi.
const engine = await createInferenceEngine(fileURLToPath(new URL('../models/classroom/', import.meta.url)));
const pi = new PiSource();
const server = createApp({ engine, pi }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = 'http://127.0.0.1:' + server.address().port;
const results = [];
const arrivalResults = [];
async function api(path, options = {}) {
  const response = await fetch(base + '/api' + path, { ...options, signal: AbortSignal.timeout(35000) });
  assert(response.ok, path + ': HTTP ' + response.status + ' ' + (!response.ok ? await response.text() : ''));
  return response.status === 204 ? undefined : response.json();
}
try {
  for (const name of ['two-frontal-profile', 'two-different-profiles', 'near-and-far', 'two-small']) {
    const original = await sharp(await readFile(new URL('../test-fixtures/faces/' + name + '.jpg', import.meta.url))).jpeg({quality:84}).toBuffer();
    const shifted = await sharp(original).extract({ left: 3, top: 0, width: 1277, height: 720 })
      .extend({ left: 0, right: 3, top: 0, bottom: 0, background: '#dcdcdc' }).jpeg({ quality: 84 }).toBuffer();
    for (const source of ['upload', 'pi-route']) {
      const { sessionId } = await api('/sessions', { method: 'POST' });
      const counts = [], times = [];
      let firstIds;
      try {
        for (let frame = 0; frame < 12; frame++) {
          const image = frame % 2 ? shifted : original;
          if (source === 'pi-route') await pi.update(image);
          const started = performance.now();
          const { tracks } = await api('/sessions/' + sessionId + '/detect' + (source === 'pi-route' ? '/pi' : ''), {
            method: 'POST', ...(source === 'upload' ? { headers: { 'Content-Type': 'image/jpeg' }, body: image } : {}),
          });
          times.push(performance.now() - started);
          const visible = tracks.filter(track => track.status === 'visible');
          counts.push(visible.length);
          if (visible.length !== 2) console.error(JSON.stringify({name,source,frame,tracks,metrics:engine.metrics}));
          assert.equal(visible.length, 2, name + '/' + source + '/frame ' + frame + ' must keep both faces');
          // A count alone can pass with a duplicate/background detection.
          assert.equal(visible.filter(track => track.box.x < .5).length, 1, 'one box on the left');
          assert.equal(visible.filter(track => track.box.x > .6).length, 1, 'one box on the right');
          const ids = visible.map(track => track.id).sort();
          firstIds ??= ids;
          assert.deepEqual(ids, firstIds, 'IDs must survive the controlled 3px motion');
          assert(!engine.metrics?.analysisError, String(engine.metrics?.analysisError));
          assert(!engine.metrics?.geometryError, String(engine.metrics?.geometryError));
          await delay(120);
        }
        const steady = times.slice(1).sort((a, b) => a - b);
        const result = { name, source, frames: counts.length, minimumFaces: Math.min(...counts), maximumFaces: Math.max(...counts),
          firstFrameMs: +times[0].toFixed(1), p95ResponseMs: +steady[Math.floor(steady.length * .95)].toFixed(1) };
        results.push(result);
        console.log(JSON.stringify(result));
      } finally {
        await api('/sessions/' + sessionId, { method: 'DELETE' });
      }
    }
  }
  // The second student enters an already running session, instead of both
  // faces being present in the initial synchronous detector scan.
  for (const name of ['two-frontal-profile', 'near-and-far']) {
    const two = await sharp(await readFile(new URL('../test-fixtures/faces/' + name + '.jpg', import.meta.url))).jpeg({quality:84}).toBuffer();
    const cover = await sharp({ create: { width: 640, height: 720, channels: 3, background: '#dcdcdc' } }).png().toBuffer();
    const one = await sharp(two).composite([{ input: cover, left: 640, top: 0 }]).jpeg().toBuffer();
    for (const source of ['upload', 'pi-route']) {
      const { sessionId } = await api('/sessions', { method: 'POST' });
      const detect = async image => {
        if (source === 'pi-route') await pi.update(image);
        return api('/sessions/' + sessionId + '/detect' + (source === 'pi-route' ? '/pi' : ''), {
          method: 'POST', ...(source === 'upload' ? { headers: { 'Content-Type': 'image/jpeg' }, body: image } : {}),
        });
      };
      try {
        let originalId;
        for (let frame = 0; frame < 10; frame++) {
          const { tracks } = await detect(one);
          const visible = tracks.filter(track => track.status === 'visible');
          assert.equal(visible.length, 1, 'one person before entry');
          originalId ??= visible[0].id;
          assert.equal(visible[0].id, originalId);
          await delay(120);
        }
        const started = performance.now();
        let firstSeenMs, stableFrames = 0;
        const trace = [];
        while (performance.now() - started < 4000 && stableFrames < 8) {
          const { tracks } = await detect(two);
          const visible = tracks.filter(track => track.status === 'visible');
          trace.push({ elapsedMs: Math.round(performance.now()-started), visible: visible.length, metrics: engine.metrics });
          assert(visible.length <= 2, 'entry must not produce duplicate/background tracks');
          assert(visible.some(track => track.box.x < .5 && track.id === originalId), 'first person keeps their ID');
          if (visible.some(track => track.box.x > .6)) {
            firstSeenMs ??= performance.now() - started;
            stableFrames++;
          } else stableFrames = 0;
          await delay(100);
        }
        assert(firstSeenMs !== undefined && firstSeenMs < 2500, name + '/' + source + ': second face must appear within 2.5s: '+JSON.stringify({firstSeenMs,trace}));
        assert.equal(stableFrames, 8, 'new face stays visible for eight consecutive responses: '+JSON.stringify(trace));
        const result = { name, source, firstSeenMs: +firstSeenMs.toFixed(1), stableFrames, originalIdPreserved: true };
        arrivalResults.push(result);
        console.log(JSON.stringify({ arrival: result }));
      } finally { await api('/sessions/' + sessionId, { method: 'DELETE' }); }
    }
  }
  const portrait = await readFile(new URL('../test-fixtures/portrait.jpg', import.meta.url));
  for (const [name, rectangle] of Object.entries({
    ear: { left: 280, top: 165, width: 47, height: 140 },
    sleeve: { left: 120, top: 500, width: 160, height: 200 },
    background: { left: 0, top: 0, width: 220, height: 300 },
  })) {
    const jpeg = await sharp(portrait).extract(rectangle).resize(640, 480, { fit: 'contain' }).jpeg().toBuffer();
    try {
      for (let frame = 0; frame < 5; frame++) {
        assert.equal((await engine.detect(jpeg, { sessionId: 'negative-' + name })).length, 0, name + ' must not create a face');
        await delay(300);
      }
    } finally { engine.release('negative-' + name); }
  }
  await mkdir(new URL('../../.qa/', import.meta.url), { recursive: true });
  await writeFile(new URL('../../.qa/face-recall-verification.json', import.meta.url), JSON.stringify({
    verifiedAt: new Date().toISOString(), note: 'Two different public faces per synthetic JPEG, real local models and HTTP routes; not physical Pi/classroom accuracy.',
    results, arrivalResults, negativeCases: ['ear', 'sleeve', 'background'],
  }, null, 2) + '\n');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  pi.close();
  await engine.close();
}
