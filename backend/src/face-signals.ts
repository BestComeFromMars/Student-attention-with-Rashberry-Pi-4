import type { FaceObservation } from './types.js';

interface Point { x: number; y: number; }
const LEFT_EYE = [33, 160, 158, 133, 153, 144];
const RIGHT_EYE = [362, 385, 387, 263, 373, 380];
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function eyeRatio(points: Point[], indices: number[]) {
  const [a, b, c, d, e, f] = indices.map(index => points[index]);
  return (distance(b, f) + distance(c, e)) / (2 * Math.max(1e-6, distance(a, d)));
}
export function measureFace(points: Point[], faceWidth: number): FaceObservation {
  const needed = [...LEFT_EYE, ...RIGHT_EYE, 1];
  if (faceWidth < 40 || needed.some(index => !points[index] || !Number.isFinite(points[index].x) || !Number.isFinite(points[index].y))) {
    return { valid: false, eyeAspectRatio: 0, yawOffset: 0 };
  }
  const left = { x: (points[33].x + points[133].x) / 2, y: (points[33].y + points[133].y) / 2 };
  const right = { x: (points[362].x + points[263].x) / 2, y: (points[362].y + points[263].y) / 2 };
  const span = distance(left, right);
  if (span < 10) return { valid: false, eyeAspectRatio: 0, yawOffset: 0 };
  const mid = { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
  const nose = points[1];
  const yawOffset = Math.abs(((nose.x - mid.x) * (right.x - left.x) + (nose.y - mid.y) * (right.y - left.y)) / (span * span));
  const ratio = (eyeRatio(points, LEFT_EYE) + eyeRatio(points, RIGHT_EYE)) / 2;
  return { valid: Number.isFinite(ratio) && ratio > 0 && ratio < 1 && yawOffset < 2, eyeAspectRatio: ratio, yawOffset };
}
