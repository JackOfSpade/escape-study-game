import { STATUS_ICONS } from "./study-map";

export interface Counts {
  passed: number;
  total: number;
}
export interface TopicState extends Counts {
  status: string;
}
export interface MapSnapshot {
  tiers: Record<string, Counts>;
  topics: Record<string, TopicState>;
}
export interface TopicChange {
  key: string;
  from: TopicState;
  to: TopicState;
  completed: boolean;
}
export interface TierChange {
  tier: string;
  from: Counts;
  to: Counts;
}
export interface ProgressDelta {
  gained: number;
  lost: number;
  topics: TopicChange[];
  tiers: TierChange[];
}

/** Reads the counts the map renders as data attributes. */
export function readMapSnapshot(root: ParentNode): MapSnapshot {
  const snapshot: MapSnapshot = { tiers: {}, topics: {} };
  for (const node of root.querySelectorAll<HTMLElement>(
    ".study-map-tier[data-tier]",
  ))
    snapshot.tiers[node.dataset.tier!] = {
      passed: Number(node.dataset.passed),
      total: Number(node.dataset.total),
    };
  for (const node of root.querySelectorAll<HTMLElement>(".study-map-topic"))
    snapshot.topics[`${node.dataset.topicKey}/D${node.dataset.tier}`] = {
      passed: Number(node.dataset.passed),
      total: Number(node.dataset.total),
      status: node.dataset.status ?? "",
    };
  return snapshot;
}

/** What changed between two snapshots; items missing from `before` are ignored. */
export function progressDelta(
  before: MapSnapshot,
  after: MapSnapshot,
): ProgressDelta {
  const delta: ProgressDelta = { gained: 0, lost: 0, topics: [], tiers: [] };
  for (const [key, to] of Object.entries(after.topics)) {
    const from = before.topics[key];
    if (!from) continue;
    if (from.passed === to.passed && from.status === to.status) continue;
    if (to.passed > from.passed) delta.gained += to.passed - from.passed;
    else if (to.passed < from.passed) delta.lost += from.passed - to.passed;
    delta.topics.push({
      key,
      from: { ...from },
      to: { ...to },
      completed: to.passed === to.total && from.passed < from.total,
    });
  }
  for (const [tier, to] of Object.entries(after.tiers)) {
    const from = before.tiers[tier];
    if (!from) continue;
    if (from.passed === to.passed && from.total === to.total) continue;
    delta.tiers.push({ tier, from: { ...from }, to: { ...to } });
  }
  return delta;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

export function summaryText(delta: ProgressDelta): string {
  const parts: string[] = [];
  if (delta.gained > 0)
    parts.push(
      `+${delta.gained} ${delta.gained === 1 ? "checkpoint" : "checkpoints"} verified`,
    );
  const completed = delta.topics.filter((topic) => topic.completed).length;
  if (delta.gained > 0 && completed > 0)
    parts.push(`${plural(completed, "topic")} complete`);
  if (delta.lost > 0)
    parts.push(
      `${plural(delta.lost, "checkpoint")} ${delta.lost === 1 ? "needs" : "need"} a recheck`,
    );
  if (parts.length) return parts.join(" · ");
  if (delta.topics.length)
    return `Assessment saved · ${plural(delta.topics.length, "topic")} marked to practise`;
  return "Assessment saved · no change this time";
}

const iconFor = (status: string) =>
  STATUS_ICONS[status as keyof typeof STATUS_ICONS] ?? STATUS_ICONS.unassessed;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const PARTICLE_COLORS = ["var(--accent)", "var(--study-success)", "#f7e08a"];

interface TierItem {
  change: TierChange;
  root: HTMLElement;
  strong: HTMLElement;
  bar: HTMLProgressElement;
  savedStrong: string;
  savedValue: number;
}
interface TopicItem {
  change: TopicChange;
  node: HTMLElement;
  icon: HTMLElement;
  count: HTMLElement;
  savedClass: string;
  savedStatus: string;
  savedIcon: string;
  savedCount: string;
}

const setNumber = (strong: HTMLElement, value: number) => {
  const text = strong.firstChild;
  if (text?.nodeType === Node.TEXT_NODE) text.nodeValue = String(value);
};

/**
 * Shows the pre-question state of a freshly rendered map, then animates it to
 * the current one. The DOM always ends up exactly as rendered.
 */
export function playProgressReveal(
  progressEl: HTMLElement,
  before: MapSnapshot,
  opts: { reducedMotion: boolean; onDone?: () => void },
): { cancel(): void } {
  const delta = progressDelta(before, readMapSnapshot(progressEl));
  window.scrollTo({
    top: progressEl.getBoundingClientRect().top + window.scrollY - 16,
    behavior: opts.reducedMotion ? "auto" : "smooth",
  });

  const host =
    progressEl.querySelector<HTMLElement>(".study-skill-map") ?? progressEl;
  const banner = document.createElement("div");
  banner.className = "study-reveal-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.textContent = summaryText(delta);
  host.insertBefore(banner, host.firstChild);
  const bannerTimer = window.setTimeout(() => banner.remove(), 4500);
  const removeBanner = () => {
    window.clearTimeout(bannerTimer);
    banner.remove();
  };

  const tiers: TierItem[] = [];
  const topics: TopicItem[] = [];
  for (const change of delta.tiers) {
    const root = [
      ...progressEl.querySelectorAll<HTMLElement>(".study-map-tier"),
    ].find((node) => node.dataset.tier === change.tier);
    const strong = root?.querySelector<HTMLElement>(".study-map-total strong");
    const bar = root?.querySelector<HTMLProgressElement>("progress");
    if (root && strong && bar)
      tiers.push({
        change,
        root: root.querySelector<HTMLElement>(".study-map-root") ?? root,
        strong,
        bar,
        savedStrong: strong.innerHTML,
        savedValue: bar.value,
      });
  }
  const nodes = [
    ...progressEl.querySelectorAll<HTMLElement>(".study-map-topic"),
  ];
  for (const change of delta.topics) {
    const node = nodes.find(
      (item) => `${item.dataset.topicKey}/D${item.dataset.tier}` === change.key,
    );
    const icon = node?.querySelector<HTMLElement>(".study-node-status");
    const count = node?.querySelector<HTMLElement>(".study-topic-count");
    if (node && icon && count)
      topics.push({
        change,
        node,
        icon,
        count,
        savedClass: node.className,
        savedStatus: node.dataset.status ?? "",
        savedIcon: icon.textContent ?? "",
        savedCount: count.innerHTML,
      });
  }

  if (opts.reducedMotion || (!tiers.length && !topics.length)) {
    opts.onDone?.();
    return { cancel: removeBanner };
  }

  let finished = false;
  let raf = 0;
  let layer: HTMLElement | undefined;
  const timers: number[] = [];
  const animations: Animation[] = [];
  const later = (fn: () => void, ms: number) =>
    void timers.push(window.setTimeout(fn, ms));
  const anim = (
    el: Element,
    keyframes: Keyframe[],
    options: KeyframeAnimationOptions,
  ) => {
    if (typeof el.animate !== "function") return undefined;
    const animation = el.animate(keyframes, options);
    animations.push(animation);
    return animation;
  };
  const paintTopic = (item: TopicItem, state: TopicState) => {
    item.icon.textContent = iconFor(state.status);
    item.node.dataset.status = state.status;
    item.node.classList.toggle("is-complete", state.status === "complete");
    item.count.textContent = `${state.passed} of ${state.total}`;
  };
  const paintTier = (item: TierItem, value: number) => {
    setNumber(item.strong, Math.round(value));
    item.bar.value = value;
  };

  function finish(done: boolean) {
    if (finished) return;
    finished = true;
    for (const timer of timers) window.clearTimeout(timer);
    window.cancelAnimationFrame(raf);
    for (const type of ["pointerdown", "keydown", "wheel"])
      window.removeEventListener(type, skip);
    for (const animation of animations) animation.cancel();
    layer?.remove();
    for (const chip of progressEl.querySelectorAll(".study-reveal-chip"))
      chip.remove();
    for (const item of tiers) {
      item.root.classList.remove("is-rising");
      item.strong.innerHTML = item.savedStrong;
      item.bar.value = item.savedValue;
    }
    for (const item of topics) {
      item.node.className = item.savedClass;
      item.node.dataset.status = item.savedStatus;
      item.icon.textContent = item.savedIcon;
      item.icon.style.transform = "";
      item.count.innerHTML = item.savedCount;
    }
    if (done) opts.onDone?.();
  }
  function skip() {
    finish(true);
  }

  function burst(source: HTMLElement, count: number) {
    if (!layer) {
      layer = document.createElement("div");
      layer.className = "study-reveal-layer";
      document.body.append(layer);
    }
    const rect = source.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    for (let i = 0; i < count; i++) {
      const dot = document.createElement("span");
      dot.className = "study-reveal-particle";
      dot.style.left = `${cx - 3}px`;
      dot.style.top = `${cy - 3}px`;
      dot.style.background = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
      layer.append(dot);
      const angle = Math.random() * Math.PI * 2;
      const distance = 40 + Math.random() * 50;
      const animation = anim(
        dot,
        [
          { transform: "translate(0, 0) scale(1)", opacity: 1 },
          {
            transform: `translate(${Math.cos(angle) * distance}px, ${Math.sin(angle) * distance}px) scale(0)`,
            opacity: 0,
          },
        ],
        {
          duration: 700 + Math.random() * 200,
          easing: "ease-out",
          fill: "forwards",
        },
      );
      if (animation) animation.onfinish = () => dot.remove();
      else dot.remove();
    }
  }

  function levelUp(item: TopicItem) {
    const { from, to, completed } = item.change;
    const scroller = item.node.closest<HTMLElement>(".study-map-scroll");
    if (scroller) {
      const box = scroller.getBoundingClientRect();
      const top = item.node.getBoundingClientRect().top;
      if (top < box.top || top > box.bottom - 40)
        scroller.scrollTop += top - box.top - box.height / 2;
    }
    item.node.classList.add("is-leveling");
    later(() => item.node.classList.remove("is-leveling"), 900);
    anim(
      item.icon,
      [{ transform: "rotateY(0deg)" }, { transform: "rotateY(90deg)" }],
      {
        duration: 150,
        easing: "ease-in",
        fill: "forwards",
      },
    );
    later(() => {
      paintTopic(item, to);
      anim(
        item.icon,
        [{ transform: "rotateY(90deg)" }, { transform: "rotateY(0deg)" }],
        { duration: 150, easing: "ease-out" },
      );
    }, 150);
    const change = to.passed - from.passed;
    if (change !== 0) {
      const chip = document.createElement("span");
      chip.className = `study-reveal-chip${change < 0 ? " is-loss" : ""}`;
      chip.textContent = `${change > 0 ? "+" : "−"}${Math.abs(change)}`;
      item.node.append(chip);
      anim(
        chip,
        [
          { transform: "translateY(0)", opacity: 1 },
          { transform: "translateY(-28px)", opacity: 0 },
        ],
        { duration: 1000, easing: "ease-out", fill: "forwards" },
      );
      later(() => chip.remove(), 1000);
    }
    if (change > 0) burst(item.icon, completed ? 28 : 14);
    if (completed) {
      item.node.classList.add("is-completed-burst");
      later(() => item.node.classList.remove("is-completed-burst"), 1200);
    }
  }

  for (const item of tiers) paintTier(item, item.change.from.passed);
  for (const item of topics) paintTopic(item, item.change.from);
  for (const type of ["pointerdown", "keydown", "wheel"])
    window.addEventListener(type, skip, { passive: true });

  later(() => {
    const started = performance.now();
    for (const item of tiers) item.root.classList.add("is-rising");
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, now - started) / 900);
      const eased = easeOutCubic(t);
      for (const item of tiers) {
        const { from, to } = item.change;
        paintTier(item, from.passed + (to.passed - from.passed) * eased);
        if (t >= 1) item.root.classList.remove("is-rising");
      }
      if (t < 1) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    topics.forEach((item, index) => later(() => levelUp(item), index * 220));
    later(
      () => finish(true),
      Math.max(900, (topics.length - 1) * 220 + 1100) + 50,
    );
  }, 450);

  return {
    cancel() {
      finish(false);
      removeBanner();
    },
  };
}
