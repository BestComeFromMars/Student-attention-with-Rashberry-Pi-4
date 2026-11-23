const clamp = value => Math.max(0, Math.min(1, value));

function clip(box) {
  if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) return;
  const x = clamp(box.x), y = clamp(box.y);
  const right = clamp(box.x + box.width), bottom = clamp(box.y + box.height);
  if (right > x && bottom > y) return { x, y, width: right - x, height: bottom - y };
}

function edgeDifference(a, b) {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y),
    Math.abs(a.x + a.width - b.x - b.width), Math.abs(a.y + a.height - b.y - b.height));
}

/** Use the current measured box at a birth or reacquisition. Keep the
 * corrected pixel trajectory until it meets the continuous display track. */
export function playbackBoxes(decisions, pixelFrames) {
  if (pixelFrames && pixelFrames.length !== decisions.length)
    throw Error('Playback and pixel geometry must have the same frame count');
  let prior = new Map();
  return decisions.map((decision, index) => {
    const record = pixelFrames?.[index];
    if (pixelFrames && record?.frame !== decision.frame)
      throw Error('Playback and pixel geometry must refer to the same source frame');
    const pixels = record && new Map(record.geometry.boxes.map(({ key, box }) => [key, clip(box)]));
    const reanchored = new Set(record?.reanchored);
    const shown = new Map();
    const boxes = [];
    for (const { kind, id, box } of decision.geometry) {
      const key = kind + ':' + id;
      const original = clip(box), measured = pixels?.get(key);
      if (shown.has(key) || !original || (pixels && !measured)) continue;
      const before = prior.get(key);
      const entering = !before || reanchored.has(key);
      const difference = measured ? edgeDifference(original, measured) : 0;
      const followingMeasurement = entering ? difference > .002 : before.followingMeasurement && difference > .001;
      shown.set(key, { followingMeasurement });
      boxes.push({ key, box: measured && (entering || followingMeasurement) ? measured : original });
    }
    prior = shown;
    return boxes;
  });
}
