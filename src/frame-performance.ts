interface FrameWork {
  simulationMs: number;
  renderMs: number;
  /** Whole frame callback work, including persist and UI time. */
  totalMs: number;
  steps: number;
  /** Optional synchronous persist() invocation time within the frame. */
  persistMs?: number;
  /** Optional UI refresh callback time within the frame. */
  uiMs?: number;
}
const valid = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;
const validOptional = (v: unknown) => v === undefined || valid(v);
const RENDER_BIN_MS = 0.05;
/** Bounded local timing summaries. No per-frame history or gameplay state retained. */
export class FramePerformance {
  private run = "";
  private start = 0;
  private last = 0;
  private frames = 0;
  private slow = 0;
  private maxFrame = 0;
  private simulation = 0;
  private render = 0;
  private total = 0;
  private persist = 0;
  private ui = 0;
  private maxSimulation = 0;
  private maxRender = 0;
  private maxWork = 0;
  private maxPersist = 0;
  private maxUi = 0;
  private steps = 0;
  // Fixed histogram: no growing per-frame history or sort allocation. The
  // last bin overflows and uses maxRender for a conservative tail estimate.
  private renderBins = new Uint32Array(1024);
  reset() {
    this.run = "";
    this.renderBins.fill(0);
    this.frames =
      this.slow =
      this.maxFrame =
      this.simulation =
      this.render =
      this.total =
      this.persist =
      this.ui =
      this.maxSimulation =
      this.maxRender =
      this.maxWork =
      this.maxPersist =
      this.maxUi =
      this.steps =
        0;
  }
  sample(run: string, time: number, work: FrameWork) {
    if (
      !Number.isFinite(time) ||
      !valid(work.simulationMs) ||
      !valid(work.renderMs) ||
      !valid(work.totalMs) ||
      !valid(work.steps) ||
      !validOptional(work.persistMs) ||
      !validOptional(work.uiMs)
    )
      return;
    const persistMs = work.persistMs ?? 0;
    const uiMs = work.uiMs ?? 0;
    if (this.run !== run || time < this.last) {
      this.reset();
      this.run = run;
      this.start = this.last = time;
    }
    const interval = time - this.last;
    this.last = time;
    this.frames++;
    if (interval > 1000 / 30) this.slow++;
    this.maxFrame = Math.max(this.maxFrame, interval);
    this.simulation += work.simulationMs;
    this.render += work.renderMs;
    this.renderBins[
      Math.min(
        this.renderBins.length - 1,
        Math.ceil(work.renderMs / RENDER_BIN_MS),
      )
    ]++;
    this.total += work.totalMs;
    this.persist += persistMs;
    this.ui += uiMs;
    this.maxSimulation = Math.max(this.maxSimulation, work.simulationMs);
    this.maxRender = Math.max(this.maxRender, work.renderMs);
    this.maxWork = Math.max(this.maxWork, work.totalMs);
    this.maxPersist = Math.max(this.maxPersist, persistMs);
    this.maxUi = Math.max(this.maxUi, uiMs);
    this.steps += work.steps;
    const wallMs = time - this.start;
    if (wallMs < 2000) return;
    const round = (n: number) => Math.round(n * 100) / 100;
    const rank = Math.ceil(this.frames * 0.95);
    let cumulative = 0,
      p95Render = this.maxRender;
    for (let i = 0; i < this.renderBins.length - 1; i++) {
      cumulative += this.renderBins[i];
      if (cumulative >= rank) {
        p95Render = Math.min(this.maxRender, i * RENDER_BIN_MS);
        break;
      }
    }
    const report = {
      frames: this.frames,
      wallMs: round(wallMs),
      fps: round(((this.frames - 1) * 1000) / wallMs),
      slowFrames: this.slow,
      maxFrameMs: round(this.maxFrame),
      avgSimulationMs: round(this.simulation / this.frames),
      maxSimulationMs: round(this.maxSimulation),
      avgRenderMs: round(this.render / this.frames),
      p95RenderMs: round(p95Render),
      maxRenderMs: round(this.maxRender),
      avgWorkMs: round(this.total / this.frames),
      maxWorkMs: round(this.maxWork),
      avgPersistMs: round(this.persist / this.frames),
      maxPersistMs: round(this.maxPersist),
      avgUiMs: round(this.ui / this.frames),
      maxUiMs: round(this.maxUi),
      steps: this.steps,
    };
    this.reset();
    return report;
  }
}
