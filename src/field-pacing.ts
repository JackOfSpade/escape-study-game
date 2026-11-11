import { BARRICADE_ATTACK } from "./barricade-combat";
import type { Furniture, Game, Problem } from "./model";

/** Initial tuning heuristics, not measured solve-time percentiles. */
export const FIELD_PACING = {
  version: 1,
  minEstimate: 30,
  maxEstimate: 900,
  depthSeconds: [180, 300, 450, 600],
  factors: [1.8, 1.65, 1.5, 1.35],
  buffers: [60, 45, 30, 30],
  onboardingSeconds: 90,
  spawnGraceSeconds: 180,
  travelSeconds: 30,
  minHoldSeconds: 30,
  maxHoldSeconds: 1800,
  maxHp: 100_000,
} as const;
export interface FieldPacing {
  version: 1;
  floors: {
    floor: number;
    estimatedSolveSeconds: number;
    deadline: number;
    planning?: {
      at: number;
      holdSeconds: number;
      upstreamSeconds: number;
      graceSeconds: number;
      referenceDps: number;
      hp: number;
      maxHp: number;
      locked: boolean;
    };
  }[];
}
export function validSolveEstimate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= FIELD_PACING.minEstimate &&
    value <= FIELD_PACING.maxEstimate
  );
}
export function solveEstimate(
  problem?: Pick<Problem, "contract" | "estimatedSolveSeconds" | "segments">,
  fallbackDepth = 1,
) {
  // A segmented question paces one terminal visit: its first (or current) part.
  const part = problem?.segments?.[0]?.estimatedSolveSeconds;
  if (validSolveEstimate(part)) return part;
  const proposed = problem?.contract.depth ?? fallbackDepth;
  const depth = Number.isFinite(proposed)
    ? Math.max(1, Math.min(4, Math.floor(proposed)))
    : 1;
  const fallback = FIELD_PACING.depthSeconds[depth - 1];
  return validSolveEstimate(problem?.estimatedSolveSeconds)
    ? problem.estimatedSolveSeconds
    : fallback;
}
/** Upstream face slots, matching engine contact limits; assume permanent surge
 * pressure rather than promising that every horde actually sustains this DPS. */
export function fieldPressureDps(o: Pick<Furniture, "w" | "h">) {
  return (
    (Math.max(1, Math.floor(Math.max(o.w, o.h))) *
      BARRICADE_ATTACK.surgeDamage) /
    BARRICADE_ATTACK.cooldown
  );
}
function roomOrder(g: Game, floor: number) {
  const f = g.floors[floor];
  return (
    f.generation?.sectors
      ?.filter((s) => s.room !== undefined)
      .sort((a, b) => a.order - b.order)
      .map((s) => s.room!) ??
    f.generation?.stages?.map((s) => s.room) ?? [2, 3, 0, 1]
  );
}
function entry(g: Game, floor: number) {
  return g.floors[floor].furniture.find((o) => o.field?.publicEntry);
}
/** Opt in only when constructing a new study-paced world. Loading saves never
 * initializes or reapplies policy; the serialized HP remains authoritative. */
export function initializeFieldPacing(g: Game, fallbackDepth = 1) {
  if (g.fieldPacing || g.rules !== "force-fields") return;
  g.fieldPacing = {
    version: 1,
    floors: g.floors
      .filter((f) => !!entry(g, f.index))
      .map((f) => ({
        floor: f.index,
        estimatedSolveSeconds: Math.max(
          solveEstimate(undefined, fallbackDepth),
          ...Object.values(g.encounters)
            .filter((e) => e.floor === f.index && !!e.questionRoom)
            .map((e) => solveEstimate(e.problem, fallbackDepth)),
        ),
        deadline: 0,
      })),
  };
  rebalanceFields(g);
}
/** Generation supplies duration metadata; it never chooses HP or resets time.
 * Alternative questions raise a shared floor estimate instead of adding work. */
export function adoptQuestionPacing(g: Game, floor: number, problem: Problem) {
  const budget = g.fieldPacing?.floors.find((f) => f.floor === floor);
  if (!budget) return;
  const estimate = solveEstimate(problem);
  if (estimate <= budget.estimatedSolveSeconds) return;
  budget.estimatedSolveSeconds = estimate;
  rebalanceFields(g);
}
export function rebalanceFields(g: Game) {
  const policy = g.fieldPacing;
  if (!policy || policy.version !== 1) return;
  let deadline = FIELD_PACING.onboardingSeconds;
  // Spawn grace is an absolute run-start allowance, never a refreshed timer.
  const grace = Math.max(0, FIELD_PACING.spawnGraceSeconds - g.time);
  let protection = grace;
  const remaining = (o: Furniture | undefined) =>
    o?.field && !o.destroyed ? Math.max(0, o.hp) / fieldPressureDps(o) : 0;
  for (const budget of policy.floors
    .slice()
    .sort((a, b) => a.floor - b.floor)) {
    const f = g.floors[budget.floor],
      gate = entry(g, budget.floor);
    if (!f || !gate) continue;
    const stage = Math.min(3, budget.floor);
    deadline +=
      FIELD_PACING.factors[stage] * budget.estimatedSolveSeconds +
      FIELD_PACING.buffers[stage] +
      FIELD_PACING.travelSeconds;
    budget.deadline = Math.round(deadline * 100) / 100;
    protection += remaining(f.furniture.find((o) => o.id === "main-gate"));
    const needed = Math.max(
      FIELD_PACING.minHoldSeconds,
      Math.min(FIELD_PACING.maxHoldSeconds, deadline - g.time - protection),
    );
    // No shortening an existing promise, healing a damaged field or reviving a
    // breach. Repeated generation/retries/reloads cannot refill the barrier.
    if (!gate.destroyed && gate.hp === gate.maxHp) {
      const hp = Math.max(
        gate.maxHp,
        Math.min(
          FIELD_PACING.maxHp,
          Math.ceil(needed * fieldPressureDps(gate)),
        ),
      );
      gate.hp = gate.maxHp = hp;
    }
    budget.planning = {
      at: g.time,
      holdSeconds: Math.round(needed * 100) / 100,
      upstreamSeconds: Math.round((protection - grace) * 100) / 100,
      graceSeconds: grace,
      referenceDps: fieldPressureDps(gate),
      hp: gate.hp,
      maxHp: gate.maxHp,
      locked: gate.destroyed || gate.hp !== gate.maxHp,
    };
    protection += remaining(gate);
    for (const room of roomOrder(g, budget.floor))
      protection += remaining(
        f.furniture.find(
          (o) => o.id === `f${budget.floor}-room${room}-forward`,
        ),
      );
  }
}
