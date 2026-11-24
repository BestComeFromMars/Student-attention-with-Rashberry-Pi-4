import type { Box, StudentTrack } from './types';

export interface AttentionCapture {
  id: string; personId?: number; displayName: string; labels: string[]; firstAt: number; lastAt: number; count: number;
  photo?: string; photoAt?: number; photoBeforeAlert?: boolean;
  captureId?: string; revision?: number;
}
type Portrait = { photo: string; at: number; wallAt: number };
type CaptureFrame = HTMLCanvasElement | HTMLVideoElement;
const owner = (track: StudentTrack) => String(track.personId ?? track.geometryId ?? track.id);
export const CAPTURE_LIMIT = 40;
function latestAttentionLabels(alerts: NonNullable<StudentTrack['alerts']>, action?: StudentTrack['actionAlert']): string[] {
  let latest: { label: string; observedAt: number } | undefined;
  for (const alert of alerts) {
    if (!latest || alert.observedAt > latest.observedAt) latest = { label: alert.label, observedAt: alert.observedAt };
  }
  if (action && (!latest || action.observedAt >= latest.observedAt)) latest = { label: action.label, observedAt: action.observedAt };
  return latest ? [latest.label] : [];
}

/** Crop only a current, independently located face from the paired analyzed image. */
export function captureFace(frame: CaptureFrame, track: StudentTrack): string | undefined {
  if (track.status !== 'visible' || track.faceVisibility === 'unavailable' || track.trackingState && !['face', 'visual'].includes(track.trackingState)) return;
  const width = 'videoWidth' in frame ? frame.videoWidth : frame.width;
  const height = 'videoHeight' in frame ? frame.videoHeight : frame.height;
  const box: Box | undefined = track.faceBox ?? (track.boxKind === 'face' ? track.box : undefined);
  if (!box || !width || !height || ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
    box.x < 0 || box.y < 0 || box.width <= 0 || box.height <= 0 || box.x + box.width > 1.000001 || box.y + box.height > 1.000001) return;
  const w = box.width * width, h = box.height * height;
  if (Math.min(w, h) < 16) return;
  const side = Math.min(width, height, Math.max(w, h) * 1.2);
  const x = Math.max(0, Math.min(width - side, (box.x + box.width / 2) * width - side / 2));
  const y = Math.max(0, Math.min(height - side, (box.y + box.height / 2) * height - side / 2));
  try {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 160;
    const context = canvas.getContext('2d'); if (!context) return;
    context.drawImage(frame, x, y, side, side, 0, 0, 160, 160);
    return canvas.toDataURL('image/jpeg', .82);
  } catch { return; }
}

/** Count warning episodes separately from portraits. Only the recent 40 keep image bytes. */
export class AttentionCaptures {
  private entries = new Map<string, AttentionCapture>();
  private faces = new Map<string, Portrait>();
  private owners = new Map<string, string>();
  private warnings = new Set<string>();
  private records = new Map<string, AttentionCapture>();
  private identities = new Map<string, string>();
  private photoAttempts = new Map<string, number>();
  private playbackPhotos = new Map<string, { warningAt: number; preferred: boolean }>();
  constructor(private readonly crop = captureFace, private readonly changed?: (capture: AttentionCapture) => void) { }
  clear() { this.clearRecords(); this.owners.clear(); this.warnings.clear(); this.identities.clear(); this.photoAttempts.clear(); }
  clearRecords() { this.entries.clear(); this.faces.clear(); this.records.clear(); this.playbackPhotos.clear(); }
  snapshot() { return [...this.entries.values()].sort((a, b) => b.lastAt - a.lastAt).map(entry => ({ ...entry, labels: [...entry.labels] })); }
  private identify(track: StudentTrack) {
    const identity = owner(track);
    if (this.owners.get(track.id) !== identity) {
      // Keep one stable captureId per student track within a run so ByteTrack
      // reacquisition never splits one student into duplicate history cards.
      this.faces.delete(track.id); this.photoAttempts.delete(track.id);
      this.owners.set(track.id, identity);
    }
    if (!this.identities.has(track.id)) this.identities.set(track.id, crypto.randomUUID());
    return this.identities.get(track.id)!;
  }
  private commit(entry: AttentionCapture, photoChanged = false) {
    entry.revision = (this.records.get(entry.captureId!)?.revision ?? 0) + 1;
    const { photo, ...metadata } = entry;
    this.records.set(entry.captureId!, { ...metadata, labels: [...entry.labels] });
    this.entries.set(entry.id, entry);
    this.changed?.({ ...entry, labels: [...entry.labels], photo: photoChanged ? photo : undefined });
    while (this.entries.size > CAPTURE_LIMIT) { const oldest = [...this.entries.values()].sort((a, b) => a.lastAt - b.lastAt)[0]; this.entries.delete(oldest.id); }
  }
  portraitDue(track: StudentTrack, now: number) {
    if (track.status !== 'visible' || track.faceVisibility === 'unavailable' || !track.faceBox && track.boxKind !== 'face') return;
    const key = this.identify(track), attempt = this.photoAttempts.get(track.id);
    if (attempt !== undefined && now - attempt < 1000) return;
    const entry = this.entries.get(track.id) ?? this.records.get(key);
    const activeAlert = track.attention === 'needs_attention' && ((track.alerts ?? []).some(a => !a.held) || Boolean(track.actionAlert));
    // Only schedule background portrait crops when an alert or existing record
    // still lacks a direct during-alert photo; never re-photograph after alert.
    if (entry?.photo && !entry.photoBeforeAlert) return;
    if (!activeAlert && !entry) return;
    this.photoAttempts.set(track.id, now); return key;
  }
  setPortrait(track: StudentTrack, photo: string, now: number, wallAt: number, captureId: string) {
    if (this.identities.get(track.id) !== captureId || this.owners.get(track.id) !== owner(track)) return;
    const previous = this.faces.get(track.id); if (previous && previous.at > now) return;
    this.faces.set(track.id, { photo, at: now, wallAt });
    const metadata = this.records.get(captureId), entry = this.entries.get(track.id) ?? metadata;
    const current = track.attention === 'needs_attention' && ((track.alerts ?? []).some(a => !a.held) || Boolean(track.actionAlert));
    if (entry && current && (!entry.photo || entry.photoBeforeAlert) && (entry.photoAt ?? 0) <= wallAt) {
      this.commit({ ...entry, photo, lastAt: Math.max(entry.lastAt, wallAt), photoAt: wallAt, photoBeforeAlert: false }, true); return true;
    }
    return this.fillPortrait(track, owner(track), photo, wallAt);
  }
  fillPortrait(track: StudentTrack, identity: string, photo: string, photoAt: number) {
    if (owner(track) !== identity || this.owners.get(track.id) !== identity) return false;
    const captureId = this.identities.get(track.id);
    const entry = this.entries.get(track.id) ?? (captureId ? this.records.get(captureId) : undefined);
    if (!entry || entry.photoAt !== undefined) return false;
    this.commit({ ...entry, photo, photoAt, photoBeforeAlert: photoAt < entry.firstAt }, true);
    return true;
  }
  setPlaybackPhoto(track: StudentTrack, identity: string, photo: string, photoAt: number, warningAt: number,
    warningWallAt: number, preferred: boolean) {
    if (owner(track) !== identity || this.owners.get(track.id) !== identity) return false;
    const captureId = this.identities.get(track.id);
    if (!captureId) return false;
    const entry = this.entries.get(track.id) ?? this.records.get(captureId);
    const previous = this.playbackPhotos.get(captureId);
    if (!entry || previous && (previous.warningAt > warningAt || previous.warningAt === warningAt && (!preferred || previous.preferred))) return false;
    this.playbackPhotos.set(captureId, { warningAt, preferred });
    this.commit({ ...entry, photo, photoAt, photoBeforeAlert: photoAt < warningWallAt }, true);
    return true;
  }
  update(tracks: StudentTrack[], frame: CaptureFrame | null, now: number, wallAt = Date.now()): AttentionCapture[] {
    const visible = new Set<string>();
    for (const track of tracks) {
      const captureId = this.identify(track);
      const entry = this.entries.get(track.id) ?? this.records.get(captureId);
      if (entry && entry.displayName !== track.displayName) { entry.displayName = track.displayName; this.commit(entry); }
      if (track.status !== 'visible') continue;
      visible.add(track.id);
      const alerts = (track.alerts ?? []).filter(alert => !alert.held);
      const action = track.actionAlert;
      const current = track.attention === 'needs_attention' && (alerts.length > 0 || Boolean(action));
      const labels = latestAttentionLabels(alerts, action);
      const event = current && !this.warnings.has(captureId);
      if (current) this.warnings.add(captureId);
      else if (!(track.alerts?.some(alert => alert.held) || action) &&
        (track.faceVisibility !== 'unavailable' || track.signals?.some(signal => signal.state === 'clear'))) this.warnings.delete(captureId);
      // Cache at most one thumbnail per second for briefly hidden faces.
      const cached = this.faces.get(track.id);
      let fresh: Portrait | undefined;
      if (frame && (!cached || now - cached.at >= 1000)) {
        const photo = this.crop(frame, track);
        if (photo) { fresh = { photo, at: now, wallAt }; this.faces.set(track.id, fresh); }
      }
      if (!current) continue;
      if (event) {
        const portrait = fresh ?? (cached && now - cached.at <= 2000 ? cached : undefined) ??
          (entry?.photo ? { photo: entry.photo, wallAt: entry.photoAt ?? entry.lastAt, at: now - 1 } : undefined);
        this.commit({
          id: track.id, captureId, personId: track.personId, displayName: track.displayName, labels,
          firstAt: entry?.firstAt ?? wallAt, lastAt: wallAt, count: (entry?.count ?? 0) + 1,
          photo: portrait?.photo, photoAt: portrait?.wallAt ?? entry?.photoAt, photoBeforeAlert: portrait ? portrait.at < now : entry?.photoAt !== undefined ? true : undefined
        }, Boolean(portrait?.photo && portrait.photo !== entry?.photo));
      } else if (entry) {
        const labelsChanged = labels.join('|') !== entry.labels.join('|');
        const needsPhoto = Boolean(fresh && (labelsChanged || !entry.photo || entry.photoBeforeAlert));
        if (needsPhoto || labelsChanged || wallAt - entry.lastAt >= 1000) {
          this.commit({
            ...entry, labels, lastAt: wallAt,
            ...(needsPhoto && fresh ? { photo: fresh.photo, photoAt: fresh.wallAt, photoBeforeAlert: false } : {})
          }, needsPhoto);
        }
      }
    }
    for (const [id, face] of this.faces) if (!visible.has(id) || now - face.at > 2000) this.faces.delete(id);
    while (this.entries.size > CAPTURE_LIMIT) {
      const oldest = [...this.entries.values()].sort((a, b) => a.lastAt - b.lastAt)[0]; this.entries.delete(oldest.id);
    }
    return this.snapshot();
  }
  rename(id: string, name: string) { const entry = this.entries.get(id); if (entry) { entry.displayName = name; this.commit(entry); } return this.snapshot(); }
}
