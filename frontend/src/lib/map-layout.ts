import { center } from './geometry';
import type { StudentTrack } from './types';
const order = new Intl.Collator('en', { numeric: true });

export interface MapPoint { x: number; y: number; sourceX: number; sourceY: number; }

/** Image coordinates stay exact until markers collide. Crowded markers use
 * nearby free cells; the diagram is an image map, not a calibrated seating plan. */
export function mapLayout(tracks: StudentTrack[], width: number, height: number) {
  const points = new Map<string, MapPoint>();
  if (width <= 0 || height <= 0 || !tracks.length) return { points, size: 28, separated: false };
  let size = tracks.length > 20 ? 28 : 38;
  const cells = (side: number) => Math.floor(width / (side + 4)) * Math.floor(height / (side + 4));
  while (size > 10 && cells(size) < tracks.length) size--;
  const radius = size / 2;
  const sources = tracks.map(track => {
    const source = center(track.box);
    return { id: track.id, sourceX: source.x * width, sourceY: source.y * height,
      x: Math.max(radius, Math.min(width - radius, source.x * width)),
      y: Math.max(radius, Math.min(height - radius, source.y * height)) };
  });
  const separated = sources.some((point, index) => sources.slice(index + 1).some(other =>
    Math.hypot(point.x - other.x, point.y - other.y) < size + 3));
  if (!separated) {
    for (const point of sources) points.set(point.id, point);
  } else {
    const columns = Math.max(1, Math.floor(width / (size + 4)));
    const rows = Math.max(Math.ceil(tracks.length / columns), Math.floor(height / (size + 4)));
    const available = Array.from({ length: columns * rows }, (_, index) => ({
      x: (index % columns + .5) * width / columns, y: (Math.floor(index / columns) + .5) * height / rows,
    }));
    // Stable ordering prevents a response's array order from swapping positions.
    for (const point of sources.sort((a, b) => order.compare(a.id, b.id))) {
      let best = 0, distance = Infinity;
      available.forEach((cell, index) => {
        const cost = (cell.x - point.x) ** 2 + (cell.y - point.y) ** 2;
        if (cost < distance) { best = index; distance = cost; }
      });
      points.set(point.id, { ...point, ...available.splice(best, 1)[0] });
    }
  }
  return { points, size, separated };
}
