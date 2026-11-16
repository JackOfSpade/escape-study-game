interface ResolutionSample {
  gpuMs?: number;
  stalled?: boolean;
}

/** Display-relative rendering budget with hysteresis. GPU queries measure the
 * work affected by pixel count. Without queries, missed refreshes are the
 * fallback signal; flagged simulation/UI stalls do not enter that estimate. */
export class AdaptiveResolution {
  private period = 1 / 60;
  private measured = false;
  private slowTime = 0;
  private fastTime = 0;

  constructor(private ratio: number) {}

  reset(ratio = this.ratio) {
    this.ratio = ratio;
    this.period = 1 / 60;
    this.measured = false;
    this.slowTime = this.fastTime = 0;
  }

  update(renderMs: number, dt: number, cap: number, sample?: ResolutionSample) {
    cap = Math.max(0.5, Math.min(1.5, cap));
    this.ratio = Math.min(this.ratio, cap);
    if (!Number.isFinite(renderMs) || !Number.isFinite(dt)) return this.ratio;
    // Simulation steps happen regularly between rendering-only frames. Skip
    // their timing without erasing eligible samples already accumulated.
    if (sample?.stalled) return this.ratio;
    if (dt < 1 / 240 || dt > 1 / 24) {
      this.slowTime = this.fastTime = 0;
      return this.ratio;
    }
    const elapsed = dt;
    if (!this.measured) {
      this.period = dt;
      this.measured = true;
    } else if (dt < this.period) {
      this.period += (dt - this.period) * 0.2;
    } else if (dt <= this.period * 1.15) {
      // Jitter may drift the estimate gently, but sustained missed refreshes
      // must not redefine a 120 Hz display as 60 Hz and hide the overload.
      this.period += (dt - this.period) * 0.002;
    }
    const budgetMs = this.period * 1000,
      gpuMs = sample?.gpuMs,
      hasGpuTime = gpuMs !== undefined && Number.isFinite(gpuMs) && gpuMs >= 0,
      slow = hasGpuTime ? gpuMs > budgetMs * 0.75 : dt > this.period * 1.3,
      fast = hasGpuTime
        ? gpuMs < budgetMs * 0.45
        : dt <= this.period * 1.1 && renderMs < budgetMs * 0.45;
    if (slow) {
      this.slowTime += elapsed;
      this.fastTime = 0;
    } else {
      this.slowTime = Math.max(0, this.slowTime - elapsed);
      this.fastTime = fast ? this.fastTime + elapsed : 0;
    }
    const next =
      this.slowTime > 0.7
        ? Math.min(1, cap)
        : this.fastTime > 8
          ? cap
          : this.ratio;
    if (next !== this.ratio) {
      this.ratio = next;
      this.slowTime = this.fastTime = 0;
    }
    return this.ratio;
  }
}
