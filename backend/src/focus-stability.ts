interface Sample { at: number; suitable: boolean; }

/** Smooth observable face cues using elapsed time, not the number of HTTP replies. */
export class FocusStability {
  private samples: Sample[] = [];
  private lastAt: number | null = null;
  private badSince: number | null = null;
  private focused = false;
  get isFocused() { return this.focused; }

  private reset() {
    this.samples = [];
    this.lastAt = this.badSince = null;
    this.focused = false;
  }

  update(valid: boolean, suitable: boolean, at: number, now: number, blocked: boolean) {
    if (!valid || blocked || !Number.isFinite(at) || now-at > 2000 || at > now+1000) {
      this.reset();
      return { focused: false, held: false };
    }
    if (this.lastAt !== null && (at < this.lastAt || at-this.lastAt > 2000)) this.reset();
    const fresh = at !== this.lastAt;
    if (fresh) {
      this.samples.push({ at, suitable });
      this.lastAt = at;
      if (suitable) this.badSince = null;
      else this.badSince ??= at;
    }
    const cutoff = now-3000;
    // Keep one preceding observation so the start of the window is covered.
    while (this.samples.length > 1 && this.samples[1].at <= cutoff) this.samples.shift();
    let goodMs = 0;
    let totalMs = 0;
    for (let index=0; index<this.samples.length; index++) {
      const sample = this.samples[index];
      const end = Math.min(this.samples[index+1]?.at ?? now, now);
      const elapsed = Math.max(0, end-Math.max(sample.at, cutoff));
      totalMs += elapsed;
      if (sample.suitable) goodMs += elapsed;
    }
    const ratio = totalMs > 0 ? goodMs/totalMs : suitable ? 1 : 0;
    const positiveSamples = this.samples.filter(sample => sample.suitable && sample.at >= cutoff).length;
    const span = at-Math.max(this.samples[0]?.at ?? at, cutoff);
    if (!this.focused) {
      this.focused = fresh && suitable && span >= 1000 && positiveSamples >= 3 && ratio >= .75;
    } else if (ratio < .55 || (this.badSince !== null && now-this.badSince > 1000)) {
      this.focused = false;
    }
    return { focused: this.focused, held: this.focused && !suitable };
  }
}
