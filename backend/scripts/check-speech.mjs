import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { AttentionEvaluator } from '../dist/attention.js';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: node scripts/check-speech.mjs INPUT.json REPORT.json');
const data = JSON.parse(await readFile(resolve(input), 'utf8'));
if (!Array.isArray(data.samples) || !data.samples.length) throw new Error('No face measurements to replay');

function replay(samples) {
  const evaluator = new AttentionEvaluator();
  const states = {}, labels = {}, changes = [];
  let previous, maxCycles = 0;
  for (const observation of samples) {
    const at = observation.observedAt;
    const track = evaluator.evaluate([{ id: 'A', displayName: 'A', lastSeen: at, status: 'visible',
      color: '', box: { x: .2, y: .2, width: .4, height: .5 }, observation }], at)[0];
    const speech = track.signals.find(signal => signal.type === 'talking');
    states[speech.state] = (states[speech.state] || 0) + 1;
    labels[track.reason] = (labels[track.reason] || 0) + 1;
    maxCycles = Math.max(maxCycles, speech.cycles || 0);
    if (speech.state !== previous) changes.push({ at, state: speech.state, cycles: speech.cycles });
    previous = speech.state;
  }
  return { states, labels, maxCycles, changes };
}

const motion = replay(data.samples);
const first = data.samples.find(sample => sample.valid || sample.mouthValid);
assert(first, 'The real face model must produce at least one valid measurement');
// Control: the same measured face repeated at fresh timestamps must not invent
// articulation, even though it can have a naturally parted mouth.
const staticFace = replay(data.samples.map(sample => ({ ...first, observedAt: sample.observedAt })));
assert.equal(staticFace.states.confirmed || 0, 0, 'A static face must not be classified as speaking');
const report = {
  input: resolve(input), video: data.video, samples: data.samples.length,
  valid: data.samples.filter(sample => sample.valid).length, motion, staticFace,
  mouthValid: data.samples.filter(sample => sample.valid || sample.mouthValid).length,
  note: 'Offline real-video smoke test; no action labels, no precision/recall claim, no audio used',
};
await writeFile(resolve(output), JSON.stringify(report, null, 2)+'\n');
console.log(JSON.stringify({ samples: report.samples, speechStates: motion.states, maxCycles: motion.maxCycles,
  staticConfirmed: staticFace.states.confirmed || 0, output: resolve(output) }));
