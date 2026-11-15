import { center, iou } from './geometry.js';
import type { DetectedPerson, StudentTrack } from './types.js';

export const LOST_AFTER_MS = 3000;

export function alphabeticId(index: number): string {
  let result = '';
  for (let current = index + 1; current > 0; current = Math.floor((current - 1) / 26)) {
    result = String.fromCharCode(65 + (current - 1) % 26) + result;
  }
  return result;
}

export class StudentTracker {
  private tracks: StudentTrack[] = [];
  private nextIndex = 0;
  private velocity = new Map<string, { x: number; y: number }>();
  private lostAt = new Map<string, number>();
  private alertUntil = new Map<string, number>();

  update(detections: DetectedPerson[], now: number): StudentTrack[] {
    // Reacquisition may produce a new face geometry ID while the old ROI is
    // still carried by its body. Prefer the real face, once, for that owner.
    detections = detections.filter(detection => !detection.trackingState || detection.trackingState === 'face' ||
      !detections.some(other => other !== detection && (!other.trackingState || other.trackingState === 'face') &&
        detection.personId != null && other.personId === detection.personId));
    this.tracks = this.tracks.filter(track => {
      // A slow inference request is not evidence that a person disappeared.
      const continuing = detections.some(detection =>
        track.geometryId != null && track.geometryId === detection.geometryId ||
        track.personId != null && track.personId === detection.personId);
      if (continuing || track.status === 'visible' || now - (this.lostAt.get(track.id) ?? track.lastSeen) <= LOST_AFTER_MS ||
          now < (this.alertUntil.get(track.id) ?? 0)) return true;
      this.velocity.delete(track.id);
      this.lostAt.delete(track.id);
      this.alertUntil.delete(track.id);
      return false;
    });
    const candidates: { track: number; detection: number; cost: number }[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const track = this.tracks[ti];
      const velocity = this.velocity.get(track.id) ?? { x: 0, y: 0 };
      const seconds = Math.min((now - track.lastSeen) / 1000, 0.5);
      const predicted = {
        ...track.box,
        x: track.box.x + velocity.x * seconds,
        y: track.box.y + velocity.y * seconds,
      };
      for (let di = 0; di < detections.length; di++) {
        const sameGeometry = track.geometryId != null && detections[di].geometryId === track.geometryId;
        const detection=detections[di];
        const beforeFace=track.faceBox??(track.boxKind==='face'?track.box:undefined);
        const currentFace=detection.faceBox??(detection.boxKind==='face'?detection.box:undefined);
        // ByteTrack may reacquire the same body under another native ID. A
        // currently verified, overlapping face can preserve its display ID;
        // a stale face ID, absent face or another live owner cannot do so.
        const faceContinues=sameGeometry&&detection.trackingState==='face'&&detection.faceVisibility==='visible'&&
          beforeFace&&currentFace&&iou(beforeFace,currentFace)>=.25&&now-track.lastSeen<=2000&&
          !detections.some(other=>other!==detection&&other.personBox&&other.personId===track.personId);
        if (!faceContinues&&(track.personBox&&detection.personBox||!sameGeometry)&&track.personId!=null&&detection.personId!=null&&track.personId!==detection.personId)continue;
        const samePerson = track.personId != null && detections[di].personId === track.personId;
        // A location retained only to display an old warning must not transfer
        // that warning to a new person entering the same area of the camera.
        if (track.status === 'lost' && now-(this.lostAt.get(track.id) ?? now)>LOST_AFTER_MS &&
            !sameGeometry && !samePerson) continue;
        if (sameGeometry || samePerson) {
          // The current native body is the identity anchor. A face-only alias
          // must not steal it and split one child into two display identities.
          candidates.push({ track: ti, detection: di, cost: samePerson ? -3 : -2 });
          continue;
        }
        const overlap = iou(predicted, detections[di].box);
        const a = center(predicted);
        const b = center(detections[di].box);
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (overlap > 0.05 || distance < 0.18) {
          candidates.push({ track: ti, detection: di, cost: (1 - overlap) * 0.65 + distance * 1.75 });
        }
      }
    }
    candidates.sort((a, b) => a.cost - b.cost || a.track - b.track || a.detection - b.detection);
    const matchedTracks = new Set<number>();
    const matchedDetections = new Set<number>();
    for (const match of candidates) {
      if (matchedTracks.has(match.track) || matchedDetections.has(match.detection)) continue;
      const track = this.tracks[match.track];
      const detection = detections[match.detection];
      const a = center(track.box);
      const b = center(detection.box);
      const seconds = Math.max(0.05, (now - track.lastSeen) / 1000);
      this.velocity.set(track.id, {
        x: Math.max(-1, Math.min(1, (b.x - a.x) / seconds)),
        y: Math.max(-1, Math.min(1, (b.y - a.y) / seconds)),
      });
      this.tracks[match.track] = { ...track, ...detection,
        geometryId:detection.geometryId,
        faceBox:detection.faceVisibility==='unavailable'?undefined:detection.faceBox,
        personId: detection.personId ?? track.personId,
        lastSeen: now, status: detection.trackingState === 'body' || detection.trackingState === 'coasting' || detection.trackingState === 'predicted' ? 'lost' : 'visible' };
      this.lostAt.delete(track.id);
      matchedTracks.add(match.track);
      matchedDetections.add(match.detection);
    }
    this.tracks = this.tracks.map((track, index) => {
      if (matchedTracks.has(index)) return track;
      if (!this.lostAt.has(track.id)) this.lostAt.set(track.id, now);
      const replaced = detections.some(detection => detection.trackingState==='face' &&
        (track.personId!=null && detection.personId===track.personId ||
          track.geometryId!=null&&detection.geometryId===track.geometryId));
      return { ...track, status: 'lost', ...(replaced || track.trackingState==='coasting'?{trackingState:'predicted' as const}:{}) };
    });
    const unmatched = detections.filter((detection, index) => !matchedDetections.has(index) &&
      (!detection.trackingState || detection.trackingState === 'face'||(detection.boxKind==='person'&&detection.personId!=null)));
    unmatched.sort((a, b) => a.box.x - b.box.x);
    for (const detection of unmatched) {
      const index = this.nextIndex++;
      const id = alphabeticId(index);
      this.tracks.push({
        ...detection, id, displayName: 'Học sinh ' + id,
        color: '#eab308', lastSeen: now, status: 'visible',
      });
    }
    return this.snapshot();
  }

  rename(id: string, name: string): StudentTrack[] {
    const cleaned = name.trim().slice(0, 60);
    if (cleaned) this.tracks = this.tracks.map(track => track.id === id ? { ...track, displayName: cleaned } : track);
    return this.snapshot();
  }

  retainAlerts(tracks: StudentTrack[]) {
    this.alertUntil.clear();
    for (const track of tracks) {
      const until = Math.max(track.actionAlert?.expiresAt??0, ...(track.alerts ?? []).map(alert => alert.expiresAt));
      if (until) this.alertUntil.set(track.id, until);
      else this.alertUntil.delete(track.id);
    }
  }

  reset() {
    this.tracks = [];
    this.nextIndex = 0;
    this.velocity.clear();
    this.lostAt.clear();
    this.alertUntil.clear();
  }

  private snapshot(): StudentTrack[] {
    return this.tracks.map(track => ({ ...track, box: { ...track.box } }));
  }
}
