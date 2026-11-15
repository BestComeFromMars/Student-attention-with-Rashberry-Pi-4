import type { ObjectRegion, StudentTrack } from './types.js';

// Scene measurements run independently of face tracking. Never retain an old
// object rectangle just because its behavior alert is held on the map.
export const OBJECT_REGION_MAX_AGE_MS = 5000;
export const OBJECT_REGION_DELAY_MS = 1500;
export function visibleObjects(track: StudentTrack, now: number): ObjectRegion[] {
  if (track.status !== 'visible' || ['body', 'coasting', 'predicted'].includes(track.trackingState ?? '')) return [];
  const observation = track.observation;
  const flags = { phone: observation?.phoneHeld, book: observation?.bookInteraction, laptop: observation?.laptopInteraction };
  return (observation?.objectRegions ?? []).filter(region => {
    const box = region.box;
    return (flags[region.kind] === true || (region.interaction === false && flags[region.kind] == null)) && Number.isFinite(region.observedAt) &&
      region.observedAt === observation?.objectsAt && region.observedAt <= now &&
      now-region.observedAt <= OBJECT_REGION_MAX_AGE_MS &&
      Number.isFinite(region.confidence) && region.confidence >= .25 && region.confidence <= 1 &&
      box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
      box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0 &&
      box.x+box.width <= 1.000001 && box.y+box.height <= 1.000001;
  }).map(region => now-region.observedAt > OBJECT_REGION_DELAY_MS ? {...region, delayed:true} : region);
}
