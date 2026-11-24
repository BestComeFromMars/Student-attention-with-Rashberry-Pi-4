import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';
const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const SPEECH_DURATION_MS = 1500;
interface Evidence { count: number; durationMs: number; observedAt?: number; active: boolean; peak: number; confirmed: boolean; }

/** Continuous mouth/lip articulation duration with peak-opening validation. */
class ChannelMotion {
  private at: number | null = null;
  private lastStepMs = 0;
  private low: number | null = null;
  private high: number | null = null;
  private peak = 0;
  private startedAt: number | null = null;
  private lastMotionAt: number | null = null;
  private movements = 0;
  constructor(private readonly excursion: number, private readonly minPeak: number) {}

  clear() {
    this.at = this.low = this.high = this.startedAt = this.lastMotionAt = null;
    this.lastStepMs = 0;
    this.peak = 0;
    this.movements = 0;
  }

  update(value: number | null | undefined, at: number) {
    if (!usable(value)) { this.clear(); return; }
    if (this.at !== null && (at < this.at || at - this.at > 1500)) this.clear();
    if (at === this.at) return;
    // Silence expires the current speaking burst even while fresh frames continue.
    if (this.lastMotionAt !== null && at - this.lastMotionAt > 1600) this.clear();
    if (this.at !== null) this.lastStepMs = at - this.at;
    this.at = at;
    if (this.low === null || this.high === null) {
      this.low = this.high = value;
      return;
    }
    this.low = Math.min(this.low, value);
    this.high = Math.max(this.high, value);
    if (this.high - this.low >= this.excursion - 1e-8) {
      this.peak = Math.max(this.peak, this.high);
      this.low = this.high = value;
      this.startedAt ??= at;
      this.lastMotionAt = at;
      this.movements += 1;
    }
  }

  evidence(minDurationMs: number, minMovements: number): Evidence {
    const activeWindow = this.lastStepMs > 450 ? Math.min(950, Math.round(this.lastStepMs * 1.15)) : 450;
    const active = this.lastMotionAt !== null && this.at !== null && this.at - this.lastMotionAt <= activeWindow;
    const durationMs = this.startedAt !== null && this.lastMotionAt !== null ? this.lastMotionAt - this.startedAt : 0;
    const opened = this.peak >= this.minPeak - 1e-8;
    const confirmed = active && opened && this.movements >= minMovements && durationMs >= minDurationMs;
    return { count: this.movements, durationMs, observedAt: this.lastMotionAt ?? undefined, active, peak: this.peak, confirmed };
  }
  get pending() {
    const activeWindow = this.lastStepMs > 450 ? Math.min(950, Math.round(this.lastStepMs * 1.15)) : 450;
    const active = this.lastMotionAt !== null && this.at !== null && this.at - this.lastMotionAt <= activeWindow;
    return active && this.movements >= 1 && this.peak >= this.minPeak - 1e-8;
  }
}

/** Multi-cue speech motion: lip aperture & jaw blendshape must agree when both exist. */
export class SpeechMotion {
  constructor(private readonly thresholds: ObservationSettings['thresholds'] = defaultObservationSettings().thresholds) {
    this.mouth = new ChannelMotion(.042, .062);
    this.jaw = new ChannelMotion(.085, .14);
  }
  private mouth: ChannelMotion;
  private jaw: ChannelMotion;
  private mouthSeen = false;
  clear() { this.mouth.clear(); this.jaw.clear(); this.mouthSeen = false; }
  update(mouth: number | null | undefined, jaw: number | null | undefined, at: number) {
    if (usable(mouth)) this.mouthSeen = true;
    this.mouth.update(mouth, at);
    this.jaw.update(jaw, at);
  }
  get evidence(): Evidence {
    const minMovements = this.thresholds.talkingMs >= 1000 ? 3 : 2;
    const mouthEv = this.mouth.evidence(this.thresholds.talkingMs, minMovements);
    const rawJawEv = this.jaw.evidence(this.thresholds.talkingMs, minMovements);
    // When lip aperture is measured on a face, closed lips (peak < 0.062) veto
    // phantom jawOpen fluctuations caused by chin-resting, biting, or low-res noise.
    const jawVetoed = this.mouthSeen && mouthEv.peak < .062;
    const jawEv: Evidence = jawVetoed ? { ...rawJawEv, confirmed: false, active: false } : rawJawEv;
    const candidates = [mouthEv, jawEv];
    return candidates.sort((a, b) =>
      Number(b.confirmed) - Number(a.confirmed) ||
      Number(b.active) - Number(a.active) ||
      b.durationMs - a.durationMs ||
      b.count - a.count
    )[0];
  }
  get pending() {
    const minMovements = this.thresholds.talkingMs >= 1000 ? 3 : 2;
    const mouthEv = this.mouth.evidence(this.thresholds.talkingMs, minMovements);
    const jawAllowed = !this.mouthSeen || mouthEv.peak >= .062;
    return this.mouth.pending || (jawAllowed && this.jaw.pending);
  }
}
