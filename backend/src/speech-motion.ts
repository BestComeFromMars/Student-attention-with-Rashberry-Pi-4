import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';
const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const SPEECH_DURATION_MS = 1500;
interface Evidence { count: number; durationMs: number; observedAt?: number; active: boolean; }

/** Continuous mouth/lip articulation duration without brittle cycle counting. */
class ChannelMotion {
  private at: number | null = null;
  private lastStepMs = 0;
  private anchor: number | null = null;
  private startedAt: number | null = null;
  private lastMotionAt: number | null = null;
  private movements = 0;
  constructor(private readonly excursion: number) {}

  clear() {
    this.at = this.anchor = this.startedAt = this.lastMotionAt = null;
    this.lastStepMs = 0;
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
    if (this.anchor === null) {
      this.anchor = value;
      return;
    }
    if (Math.abs(value - this.anchor) >= this.excursion - 1e-8) {
      this.anchor = value;
      this.startedAt ??= at;
      this.lastMotionAt = at;
      this.movements += 1;
    }
  }

  get evidence(): Evidence {
    const activeWindow = this.lastStepMs > 450 ? Math.min(950, Math.round(this.lastStepMs * 1.15)) : 450;
    const active = this.lastMotionAt !== null && this.at !== null && this.at - this.lastMotionAt <= activeWindow;
    const durationMs = this.startedAt !== null && this.lastMotionAt !== null ? this.lastMotionAt - this.startedAt : 0;
    return { count: this.movements, durationMs, observedAt: this.lastMotionAt ?? undefined, active };
  }
  get pending() {
    const { active, count } = this.evidence;
    return active && count >= 1;
  }
}

/** The two channels (mouth aperture & jaw/lip blendshape) are independent alternatives. */
export class SpeechMotion {
  constructor(private readonly thresholds: ObservationSettings['thresholds'] = defaultObservationSettings().thresholds) {
    this.mouth = new ChannelMotion(.042);
    this.jaw = new ChannelMotion(.072);
  }
  private mouth: ChannelMotion;
  private jaw: ChannelMotion;
  clear() { this.mouth.clear(); this.jaw.clear(); }
  update(mouth: number | null | undefined, jaw: number | null | undefined, at: number) {
    this.mouth.update(mouth, at);
    this.jaw.update(jaw, at);
  }
  get evidence(): Evidence {
    const candidates = [this.mouth.evidence, this.jaw.evidence];
    const confirmed = (item: Evidence) => item.active && item.count >= 2 && item.durationMs >= this.thresholds.talkingMs;
    return candidates.sort((a, b) =>
      Number(confirmed(b)) - Number(confirmed(a)) ||
      Number(b.active) - Number(a.active) ||
      b.durationMs - a.durationMs ||
      b.count - a.count
    )[0];
  }
  get pending() { return this.mouth.pending || this.jaw.pending; }
}
