import {
  CONFIG,
  distance,
  event,
  type Actor,
  type Game,
  type Point,
  type Station,
} from "./model";
import { npcReasoningAvailable, npcThinkingRate } from "./npc-cognition";
import { npcThinkingScale } from "./study-pacing";
import { walkSegment } from "./navigation";
import { solid, stationSpot } from "./spatial";
import { sectorBounds } from "./floor-plan";

export interface StudyLoop {
  floor: number;
  encounter: string;
  station: string;
  phase: "draw" | "return" | "work";
  waypoints: Point[];
  next: number;
  started: number;
  lastWork: number;
  window: number;
}
type Threat = Point & { at?: number };
export const STUDY_LOOP = {
  interval: 1,
  threats: 8,
  candidates: 16,
  abandonAfter: 14,
  stalledAfter: 20,
  retryAfter: 6,
  contact: 1.15,
  margin: 0.9,
};
const metrics = new WeakMap<Game, { decisions: number; candidates: number }>();
/** Opt-in bounded counters for synthetic benchmarks; no timers or stored player data. */
export function studyLoopMetrics(g: Game) {
  let m = metrics.get(g);
  if (!m) metrics.set(g, (m = { decisions: 0, candidates: 0 }));
  return m;
}
function phase(g: Game, a: Actor, next: StudyLoop["phase"]) {
  const p = a.studyLoop!;
  if (p.phase === next) return;
  p.phase = next;
  event(
    g,
    `npc-loop-${next}`,
    `${a.name} ${next === "draw" ? "is drawing pursuit away from a terminal" : next === "return" ? "is looping back to a terminal" : "is using a short terminal work window"}.`,
    a.floor,
    a.id,
    p.encounter,
  );
}
/** A short, fixed-cost pursuit approximation. Walls are not assumed to protect the solver.
 * Only supplied observations are projected; hidden live zombie positions are never read. */
function forecast(g: Game, a: Actor, route: Point[], threats: Threat[]) {
  const speed = CONFIG.playerSpeed * 0.5;
  const enemies = threats.map((z) => ({ ...z }));
  let from: Point = a,
    seconds = 0,
    clearance = Infinity;
  for (const to of route) {
    const duration = distance(from, to) / a.speed;
    for (let sample = 1; sample <= 6; sample++) {
      const target = {
        x: from.x + ((to.x - from.x) * sample) / 6,
        y: from.y + ((to.y - from.y) * sample) / 6,
      };
      for (const z of enemies) {
        const gap = distance(z, target),
          move = Math.min(gap, (duration / 6) * speed);
        if (gap > 0) {
          z.x += ((target.x - z.x) / gap) * move;
          z.y += ((target.y - z.y) / gap) * move;
        }
        const uncertainty = Math.max(0, g.time - (z.at ?? g.time)) * speed;
        clearance = Math.min(clearance, distance(z, target) - uncertainty);
      }
    }
    seconds += duration;
    from = to;
  }
  const window =
    Math.min(
      ...enemies.map(
        (z) =>
          (distance(z, from) -
            STUDY_LOOP.contact -
            Math.max(0, g.time - (z.at ?? g.time)) * speed) /
          speed,
      ),
    ) - STUDY_LOOP.margin;
  return { seconds, clearance, window };
}
function usable(g: Game, a: Actor, s: Station) {
  const e = g.encounters[s.encounter];
  return (
    !!e &&
    e.floor === a.floor &&
    e.reward === "stairs" &&
    e.state !== "consumed" &&
    e.mode === "solo" &&
    (!e.owner || e.owner === a.id) &&
    a.seen.includes(s.id) &&
    npcReasoningAvailable(e, a) &&
    !g.survivors.some(
      (b) =>
        b !== a &&
        b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        b.station === s.id &&
        b.activity !== "fleeing",
    )
  );
}
function abandon(g: Game, a: Actor) {
  if (a.studyLoop)
    event(
      g,
      "npc-loop-abandon",
      `${a.name} could not create a useful terminal work window and is retreating.`,
      a.floor,
      a.id,
      a.studyLoop.encounter,
    );
  delete a.studyLoop;
  a.studyLoopCheckAt = g.time + STUDY_LOOP.retryAfter;
}
/** Return a movement target or a short permission to resume normal physical study.
 * This never completes a puzzle, grants access or creates learner evidence. */
export function studyLoopDecision(
  g: Game,
  a: Actor,
  observed: Threat[],
): { mode: "move"; target: Point } | { mode: "work" } | undefined {
  if (g.rules !== "force-fields" || a.id === "human") return;
  const f = g.floors[a.floor];
  let p = a.studyLoop;
  if (
    a.access.includes(a.floor) ||
    !a.alive ||
    a.escaped ||
    (p &&
      (p.floor !== a.floor ||
        !f.stations.some((s) => s.id === p!.station && usable(g, a, s)) ||
        a.intent !== p.encounter))
  ) {
    delete a.studyLoop;
    return;
  }
  if (
    !p &&
    a.activity === "studying" &&
    f.stations.some((s) => s.id === a.station && distance(a, s) < 1.3)
  )
    a.studyLoopBlockedSince = g.time;
  // Perception is already ordered by distance; retain a fixed-size local sample.
  const threats = observed.slice(0, STUDY_LOOP.threats);
  if (!threats.length) {
    delete a.studyLoop;
    return;
  }
  const close = threats.some((z) => distance(a, z) < 2.1);
  if (p && close && p.phase !== "work" && g.time < p.next) return;
  if (p && close && p.phase === "work") {
    phase(g, a, "draw");
    p.waypoints = [];
    return;
  }
  if (!p) {
    a.studyLoopBlockedSince ??= g.time;
    if (g.time - a.studyLoopBlockedSince < STUDY_LOOP.stalledAfter) return;
  }
  if (!p && g.time < (a.studyLoopCheckAt ?? 0)) return;
  if (!p) {
    // Actor-specific offset spreads the first expensive decision across ticks.
    if (a.studyLoopCheckAt === undefined) {
      a.studyLoopCheckAt =
        g.time +
        (Array.from(a.id).reduce((n, c) => n + c.charCodeAt(0), 0) % 23) / 30;
      return;
    }
    a.studyLoopCheckAt = g.time + STUDY_LOOP.interval;
    const s = f.stations
      .filter((s) => usable(g, a, s) && (!a.intent || s.encounter === a.intent))
      .sort((b, c) => distance(a, b) - distance(a, c))[0];
    if (!s || !threats.some((z) => distance(z, a) < 6 || distance(z, s) < 7))
      return;
    if (a.intent !== s.encounter) {
      a.intent = s.encounter;
      a.thought = 0;
      a.milestone = 0;
    }
    p = a.studyLoop = {
      floor: a.floor,
      encounter: s.encounter,
      station: s.id,
      phase: "draw",
      waypoints: [],
      next: 0,
      started: g.time,
      lastWork: g.time,
      window: 0,
    };
    event(
      g,
      "npc-loop-start",
      `${a.name} is trying to create space to resume a terminal.`,
      a.floor,
      a.id,
      s.encounter,
    );
  }
  const s = f.stations.find((s) => s.id === p!.station)!;
  // Take an actual opening immediately, including while passing the terminal on a loop.
  const standingWindow =
    Math.min(
      ...threats.map(
        (z) =>
          (distance(a, z) - STUDY_LOOP.contact) / (CONFIG.playerSpeed * 0.5) -
          Math.max(0, g.time - (z.at ?? g.time)),
      ),
    ) - STUDY_LOOP.margin;
  if (distance(a, s) < 1.3 && standingWindow > 0.2) {
    phase(g, a, "work");
    p.waypoints = [];
    p.lastWork = g.time;
    p.window = standingWindow;
    delete a.fleeTarget;
    a.fleeUntil = 0;
    a.taskSearch = {
      floor: a.floor,
      seen: a.seen.length,
      after: 0,
      station: s.id,
    };
    a.station = s.id;
    return { mode: "work" };
  }
  if (p.phase === "work" && distance(a, s) < 1.3) p.lastWork = g.time;
  if (g.time - p.lastWork > STUDY_LOOP.abandonAfter) {
    abandon(g, a);
    return;
  }
  while (p.waypoints.length && distance(a, p.waypoints[0]) < 0.55)
    p.waypoints.shift();
  if (g.time < p.next) {
    if (p.phase === "work") return close ? undefined : { mode: "work" };
    return p.waypoints.length
      ? { mode: "move", target: p.waypoints[0] }
      : undefined;
  }
  p.next = g.time + STUDY_LOOP.interval;
  const m = metrics.get(g);
  if (m) m.decisions++;
  const e = g.encounters[p.encounter],
    reasoningRate =
      npcThinkingRate(a, e) *
      npcThinkingScale(g) *
      (a.role === "analyst" ? 1.2 : 1);
  const nextMilestone =
    Math.max(0, 24 * (a.milestone + 1) - a.thought) /
    Math.max(0.01, reasoningRate);
  const remaining =
    (Math.max(0, (1 - e.npcProgress) / 0.23 - 1) * 24) /
      Math.max(0.01, reasoningRate) +
    nextMilestone;
  const minimum =
    p.phase === "work" && distance(a, s) < 1.3
      ? 0.2
      : Math.min(1.25, Math.max(0.65, remaining));
  // Direct and two-leg loops, clockwise and counterclockwise, around the remembered terminal.
  // Version 3/4 stages and version 5 sector blocks: a rect of interior cells.
  const stage = f.generation?.stages?.find(
    (stage) => s.y > stage.front + 1 && s.y < stage.rear,
  );
  const block = f.generation?.sectors ? sectorBounds(f, s) : undefined;
  const spot = stationSpot(f, s);
  const candidates: Point[][] = [[spot]];
  for (let i = 0; i < STUDY_LOOP.candidates; i++) {
    const angle = ((i % 8) * Math.PI) / 4,
      radius = i < 8 ? 5 : 8;
    const y = s.y + Math.sin(angle) * radius,
      x = s.x + Math.cos(angle) * radius;
    candidates.push([
      {
        x: block ? Math.max(block.x1 + 0.4, Math.min(block.x2 + 0.6, x)) : x,
        y: stage
          ? Math.max(stage.front + 1.4, Math.min(stage.rear - 0.4, y))
          : block
            ? Math.max(block.y1 + 0.4, Math.min(block.y2 + 0.6, y))
            : y,
      },
      spot,
    ]);
  }
  let returning: { route: Point[]; score: number; window: number } | undefined;
  let drawing: { point: Point; score: number } | undefined;
  for (const route of candidates) {
    if (m) m.candidates++;
    const first = route[0],
      origin = { ...a, x: first.x, y: first.y };
    if (solid(f, origin) || !walkSegment(f, a, first)) continue;
    if (route.length === 1 || walkSegment(f, origin, spot)) {
      const estimate = forecast(g, a, route, threats);
      if (
        estimate.clearance > STUDY_LOOP.contact &&
        estimate.window >= minimum
      ) {
        const score =
          Math.min(estimate.window, Math.max(remaining, minimum)) -
          estimate.seconds * 0.2;
        if (!returning || score > returning.score)
          returning = { route, score, window: estimate.window };
      }
    }
    if (route.length > 1 && distance(a, first) > 1) {
      const estimate = forecast(g, a, [first], threats);
      if (estimate.clearance < STUDY_LOOP.contact) continue;
      const clearance = Math.min(...threats.map((z) => distance(z, first)));
      const score =
        clearance +
        Math.min(9, distance(first, s)) * 0.45 -
        estimate.seconds * 0.15;
      if (!drawing || score > drawing.score) drawing = { point: first, score };
    }
  }
  if (returning) {
    p.waypoints = returning.route.map((q) => ({ x: q.x, y: q.y }));
    p.window = returning.window;
    if (distance(a, s) < 1.3) {
      phase(g, a, "work");
      p.waypoints = [];
      p.lastWork = g.time;
    } else phase(g, a, "return");
  } else if (drawing) {
    const current = p.phase === "draw" && p.waypoints[0];
    const keep =
      current &&
      distance(a, current) > 0.6 &&
      walkSegment(f, a, current) &&
      forecast(g, a, [current], threats).clearance > STUDY_LOOP.contact;
    p.waypoints = [keep ? current : drawing.point];
    p.window = 0;
    phase(g, a, "draw");
  } else {
    abandon(g, a);
    return;
  }
  if (p.phase === "work") {
    delete a.fleeTarget;
    a.fleeUntil = 0;
    a.taskSearch = {
      floor: a.floor,
      seen: a.seen.length,
      after: 0,
      station: s.id,
    };
    a.station = s.id;
    return { mode: "work" };
  }
  return { mode: "move", target: p.waypoints[0] };
}
