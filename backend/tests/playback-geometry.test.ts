import { expect, it } from 'vitest';
import { playbackBoxes } from '../scripts/playback-geometry.mjs';

const face = (x: number) => ({ x, y: .2, width: .1, height: .15 });
type Box = ReturnType<typeof face>;
const decision = (frame: number, ...boxes: Box[]) => ({
  frame, geometry: boxes.map(box => ({ kind: 'face', id: 'A', box })),
});
const pixels = (frame: number, box?: Box, reanchored: string[] = []) => ({
  frame,
  geometry: { boxes: box ? [{ key: 'face:A', box }] : [] },
  reanchored,
});

it('uses current pixels for a new or reacquired box without sliding back to its old track', () => {
  const decisions = [
    decision(0, face(.12)), decision(1, face(.15)), decision(2, face(.2)),
    decision(3, face(.515)), decision(4, face(.524)), decision(5, face(.53)),
    decision(6, face(.53)),
  ];
  const measured = [
    pixels(0), pixels(1, face(.5)), pixels(2, face(.51)),
    pixels(3, face(.515)), pixels(4, face(.521)), pixels(5, face(.8), ['face:A']),
    pixels(6),
  ];
  expect(playbackBoxes(decisions, measured).map((boxes: { box: Box }[]) => boxes[0]?.box.x))
    .toEqual([undefined, .5, .51, .515, .524, .8, undefined]);
});

it('clips rectangles to the frame and emits each label only once', () => {
  const [[entry, duplicate]] = playbackBoxes([decision(0, face(-.04), face(.6))]);
  expect(duplicate).toBeUndefined();
  expect(entry.box.x).toBe(0);
  expect(entry.box.width).toBeCloseTo(.06);
});
