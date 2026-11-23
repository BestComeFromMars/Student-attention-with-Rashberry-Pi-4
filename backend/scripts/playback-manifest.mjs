import { gzipSync } from 'node:zlib';
import { playbackBoxes } from './playback-geometry.mjs';

export function playbackManifest(recording, portraits, version, geometry, pixelFrames) {
  const portraitsAt = Map.groupBy(portraits, portrait => portrait.at);
  const samples = recording.requests.map(({ sourceSeconds, data }) => ({ at: sourceSeconds,
    portraits: portraitsAt.get(sourceSeconds),
    tracks: data.tracks.map(({ id, displayName, personId, geometryId, status, box, boxKind, faceBox,
      faceVisibility, trackingState, color, lastSeen, attention, alerts, actionAlert, signals }) => ({
      id, displayName, personId, geometryId, status, box, boxKind, faceBox, faceVisibility, trackingState, color,
      lastSeen, attention, alerts, actionAlert, signals: signals?.filter(signal => signal.state === 'clear').slice(0, 1),
    })) }));
  if (!geometry) return { version, samples };
  const sourceVersion = recording.sourceSha256.slice(0, 16);
  const keys = new Map();
  const frames = playbackBoxes(geometry.decisions, pixelFrames).map(boxes => boxes.flatMap(({ key, box }) => {
    const x=Math.round(box.x*10000),y=Math.round(box.y*10000);
    const width=Math.round((box.x+box.width)*10000)-x,height=Math.round((box.y+box.height)*10000)-y;
    if(width<=0||height<=0)return [];
    if (!keys.has(key)) keys.set(key, keys.size);
    return [keys.get(key),x,y,width,height];
  }));
  const measurements = recording.requests.map(({ end, data }) => ({
    at: end,
    tracks: data.tracks.map(({ observation, actions }) => [observation ?? null,
      actions?.filter(action => action.state !== 'unavailable') ?? []]),
    objects: data.objects,
  }));
  const fps=geometry.decisions.length>1?1/(geometry.decisions[1].sourceSeconds-geometry.decisions[0].sourceSeconds):30;
  return { version, samples,
    editable: gzipSync(JSON.stringify({ sourceVersion, fps, keys: [...keys.keys()], frames, measurements })).toString('base64') };
}

