import type { Box } from './types.js';

export function center(box: Box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

export function iou(a: Box, b: Box): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

export function normalizeBox(
  bbox: [number, number, number, number], frameWidth: number, frameHeight: number,
): Box | null {
  if (frameWidth <= 0 || frameHeight <= 0 || !bbox.every(Number.isFinite)) return null;
  const [x, y, width, height] = bbox;
  if (width <= 0 || height <= 0) return null;
  const left = Math.max(0, Math.min(1, x / frameWidth));
  const top = Math.max(0, Math.min(1, y / frameHeight));
  const right = Math.max(0, Math.min(1, (x + width) / frameWidth));
  const bottom = Math.max(0, Math.min(1, (y + height) / frameHeight));
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function interpolateBox(from: Box, to: Box, elapsedMs: number): Box {
  const amount = 1 - Math.exp(-Math.max(0, elapsedMs) / 85);
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    width: from.width + (to.width - from.width) * amount,
    height: from.height + (to.height - from.height) * amount,
  };
}
