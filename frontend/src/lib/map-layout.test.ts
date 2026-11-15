import { describe, expect, it } from 'vitest';
import { mapLayout } from './map-layout';
import type { StudentTrack } from './types';

const tracks = (count: number, clustered = false): StudentTrack[] => Array.from({ length: count }, (_, i) => ({
  id: String(i + 1), displayName: 'Student', color: '', lastSeen: 0, status: 'visible',
  box: { x: clustered ? .5 : .04 + i % 8 * .12, y: clustered ? .5 : .065 + Math.floor(i / 8) * .19, width: .06, height: .08 },
}));
describe('dense classroom map', () => {
  it('keeps image coordinates when markers fit without collisions', () => {
    const layout = mapLayout(tracks(40), 320, 400);
    expect(layout.separated).toBe(false);
    expect(layout.points.get('1')!.x).toBeCloseTo(.07 * 320);
  });
  it.each([[320, 400], [270, 195], [150, 105]])('separates all 40 clustered points inside %i × %i', (width, height) => {
    const layout = mapLayout(tracks(40, true), width, height);
    const points = [...layout.points.values()];
    expect(points).toHaveLength(40);
    expect(layout.separated).toBe(true);
    for (let i = 0; i < points.length; i++) {
      expect(points[i].x).toBeGreaterThanOrEqual(layout.size / 2);
      expect(points[i].x).toBeLessThanOrEqual(width - layout.size / 2);
      expect(points[i].y).toBeGreaterThanOrEqual(layout.size / 2);
      expect(points[i].y).toBeLessThanOrEqual(height - layout.size / 2);
      for (let j = i + 1; j < points.length; j++) expect(Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y)).toBeGreaterThanOrEqual(layout.size + 3);
    }
  });
  it('does not swap crowded positions when response ordering changes', () => {
    const students = tracks(40, true);
    expect(mapLayout(students, 270, 195).points).toEqual(mapLayout([...students].reverse(), 270, 195).points);
  });
});
