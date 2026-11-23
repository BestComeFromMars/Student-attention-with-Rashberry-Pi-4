import {defaultObservationSettings,type ObservationSettings} from './observation-settings.js';
const usable = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export const SPEECH_DURATION_MS = 2500;
interface Evidence { count: number; durationMs: number; observedAt?:number; active:boolean; }

/** Local rises and falls, independent of a fixed mouth-open threshold. */
class ChannelCycles {
  private at: number | null = null;
  private lastStepMs = 0;
  private low: number | null = null;
  private peak: { at: number; value: number; rest: number } | null = null;
  private cycles: {start:number;end:number}[] = [];
  private motionAt: number | null = null;
  private motionValue: number | null = null;
  constructor(private excursion: number,private windowMs=5000) {}

  clear() {
    this.at = this.low = null;
    this.lastStepMs = 0;
    this.peak = null;
    this.cycles = [];
    this.motionAt = this.motionValue = null;
  }

  update(value: number | null | undefined, at: number) {
    if (!usable(value)) { this.clear(); return; }
    if (this.at !== null && (at < this.at || at-this.at > 1500)) this.clear();
    if (at === this.at) return;
    // Silence expires the current utterance, even while fresh images continue.
    if (this.motionAt !== null && at-this.motionAt > 1600) this.clear();
    if (this.at !== null) this.lastStepMs = at - this.at;
    this.at = at;
    this.cycles = this.cycles.filter(cycle => at-cycle.start <= this.windowMs);
    this.motionValue ??= value;
    if (Math.abs(value-this.motionValue) >= this.excursion-1e-8) {
      this.motionValue = value;
      this.motionAt = at;
    }
    this.low ??= value;
    if (this.peak) {
      if (at-this.peak.at > 1800) {
        this.peak = null;
        this.low = value;
      } else {
        this.peak.value = Math.max(this.peak.value, value);
        const drop = Math.max(this.excursion * .85, (this.peak.value-this.peak.rest) * .42);
        if (this.peak.value-value >= drop-1e-8) {
          // Distinct fresh measurements must support the opening over time;
          // very short spikes and a held-open mouth are not repeated articulation.
          if (at-this.peak.at >= 45) {
            this.cycles.push({start:this.peak.at,end:at});
          }
          this.peak = null;
          this.low = value;
        }
      }
    } else if (value-this.low >= this.excursion-1e-8) {
      this.peak = { at, value, rest: this.low };
    } else {
      this.low = Math.min(this.low, value);
    }
  }

  get evidence(): Evidence {
    const first=this.cycles[0],last=this.cycles.at(-1);
    const activeWindow=this.lastStepMs>450?Math.min(950,Math.round(this.lastStepMs*1.15)):450;
    return {count:this.cycles.length,durationMs:first&&last?last.end-first.start:0,observedAt:last?.end,
      active:last!==undefined&&this.at!==null&&(this.at-last.end<=activeWindow||(this.peak!==null&&this.at-last.end<=1400))};
  }
  get pending() { return this.peak !== null; }
}

/** The two channels are alternatives; their cycles are never added together. */
export class SpeechMotion {
  constructor(private readonly thresholds:ObservationSettings['thresholds']=defaultObservationSettings().thresholds){
    const window=Math.max(5000,thresholds.talkingMs+3500);
    this.mouth=new ChannelCycles(.042,window);this.jaw=new ChannelCycles(.072,window);
  }
  private mouth:ChannelCycles;
  private jaw:ChannelCycles;
  clear() { this.mouth.clear(); this.jaw.clear(); }
  update(mouth: number | null | undefined, jaw: number | null | undefined, at: number) {
    this.mouth.update(mouth, at);
    this.jaw.update(jaw, at);
  }
  get evidence(): Evidence {
    const candidates = [this.mouth.evidence, this.jaw.evidence];
    // Duration and cycles must come from the same channel.
    return candidates.sort((a,b) => Number(b.active&&b.count >= this.thresholds.talkingCycles && b.durationMs >= this.thresholds.talkingMs)-
      Number(a.active&&a.count >= this.thresholds.talkingCycles && a.durationMs >= this.thresholds.talkingMs) || Number(b.active)-Number(a.active)||b.count-a.count || b.durationMs-a.durationMs)[0];
  }
  get pending() { return this.mouth.pending || this.jaw.pending; }
}
