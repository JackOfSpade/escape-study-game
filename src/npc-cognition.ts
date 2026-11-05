import { fnv1a } from "./hash";
import { type Actor, type Encounter, type Game, event } from "./model";
export type TechnicalFocus =
  "reasoning" | "implementation" | "testing" | "debugging";
export interface NpcProfile {
  topics: Record<string, number>;
  strengths: Record<TechnicalFocus, number>;
  confidence: number;
}
export interface NpcWork {
  contextKey?: string;
  id: string;
  actor: string;
  seq: number;
  at: number;
  stage: "contract" | "hypothesis" | "boundary" | "review" | "revision";
  focus: TechnicalFocus;
  scopeIds: string[];
  facet?: string;
  sourceRevision: number;
  sourceSequence: number;
  seed: number;
  provenance: "simulated-conceptual-work";
  validated: false;
  execution: "not-run";
}
const clamp = (n: number) => Math.max(0.15, Math.min(0.97, n));
export function makeNpcProfile(
  id: string,
  baseline: number,
  role: string,
): NpcProfile {
  const rating = (key: string) =>
    clamp(baseline * 0.35 + 0.12 + (fnv1a(`${id}/${key}`) % 1000) / 1500);
  const topics: Record<string, number> = {};
  for (const track of ["PY", "PE"])
    for (let i = 1; i <= (track === "PY" ? 16 : 20); i++) {
      const key = `${track}:T${String(i).padStart(2, "0")}`;
      topics[key] = rating(key);
    }
  for (const name of ["X03", "X07", "X08", "X09"])
    topics[`PE:${name}`] = rating(`PE:${name}`);
  return {
    topics,
    strengths: {
      reasoning: clamp(rating("reasoning") + (role === "analyst" ? 0.14 : 0)),
      implementation: clamp(
        rating("implementation") +
          (role === "builder" || role === "rusher" ? 0.12 : 0),
      ),
      testing: clamp(rating("testing") + (role === "skeptic" ? 0.18 : 0)),
      debugging: clamp(rating("debugging") + (role === "medic" ? 0.12 : 0)),
    },
    confidence: clamp(rating("confidence") + (role === "rusher" ? 0.15 : 0)),
  };
}
export const npcProfile = (a: Actor) =>
  a.technical ?? makeNpcProfile(a.id, a.skill, a.role);
export function taskSkill(a: Actor, e: Encounter) {
  if (!e.problem) return a.skill; // No academic scope invented for an unseen lock.
  const profile = npcProfile(a),
    c = e.problem.contract;
  const scores = c.objectiveIds
    .map((id) => profile.topics[id.split(".")[0]])
    .filter((n) => n !== undefined);
  return scores.length
    ? scores.reduce((sum, n) => sum + n, 0) / scores.length
    : Object.entries(profile.topics)
        .filter(([id]) => id.startsWith(`${c.track}:`))
        .reduce((sum, [, n], _, all) => sum + n / all.length, 0);
}
/** Question scope determines effort; survivor expertise determines personal speed. */
export function npcThinkingRate(a: Actor, e: Encounter) {
  const base = 0.65 + taskSkill(a, e) * 0.7;
  const effort = e.questionRoom && e.problem ? questionEffort(e) : 1;
  return (base * workRhythm(a, e)) / effort;
}
/** Reading, productive thought and final checking take different amounts of
 * time. Derive the rhythm from saved work, so pausing/reloading cannot reroll
 * a difficult step and frame rate never consumes additional world RNG. */
function workRhythm(a: Actor, e: Encounter) {
  const stage = reasoningStages[a.milestone % reasoningStages.length],
    focus = workFocus(e, a, stage),
    strength = npcProfile(a).strengths[focus],
    personal =
      fnv1a(`${a.id}/${e.questionRoom ?? e.id}/${a.milestone}/pace`) /
      0xffffffff,
    // Some steps click immediately; others need more reflection.
    stepPace = 0.85 + personal * 0.3,
    // Slower while getting oriented and checking; quicker in the middle.
    fraction = Math.max(0, Math.min(1, (a.thought - a.milestone * 24) / 24)),
    burst = 0.72 + 0.55 * Math.sin(Math.PI * fraction) ** 2,
    // A small within-task familiarity benefit, never academic mastery.
    familiarity = 0.9 + Math.min(3, a.milestone) * 0.05;
  return stepPace * burst * familiarity * (0.8 + strength * 0.4);
}
/** Room question difficulty controls study pacing. */
function questionEffort(e: Encounter) {
  if (!e.problem) return 1;
  const facets =
    e.problem.scopeDefinitions?.reduce(
      (n, scope) => n + scope.facets.length,
      0,
    ) ?? e.problem.rubric.length;
  return (
    1 +
    Math.max(0, e.problem.contract.depth - 1) * 0.35 +
    Math.max(0, facets - 4) * 0.06
  );
}

export function relevantFocus(text: string): TechnicalFocus {
  if (/\b(bug|fail|error|debug|trace)\b/i.test(text)) return "debugging";
  if (/\b(test|tests|edge|boundary|case)\b/i.test(text)) return "testing";
  if (/\b(code|implement|function|typescript|python|patch)\b/i.test(text))
    return "implementation";
  return "reasoning";
}

const reasoningStages = [
  "contract",
  "hypothesis",
  "boundary",
  "review",
] as const;
const contextCache = new WeakMap<
  Encounter,
  { problem: Encounter["problem"]; stamp: string; key: string }
>();
export function hasHumanStudyContext(e: Encounter) {
  return !!(
    e.humanEngaged ||
    e.generation ||
    e.problemPresentedSequence !== undefined ||
    [...e.group, ...e.tutor].some(
      (m) => m.kind === "human" && m.author === "human",
    ) ||
    e.history.some(
      (h) =>
        h.author === "human" && ["edit", "reasoning", "test"].includes(h.kind),
    )
  );
}
/** Only public, external inputs can restart modeled scoped work. Global time,
 * private tutoring, NPC notes and presentation events are deliberately absent. */
export function npcWorkContext(e: Encounter) {
  if (!e.problem || !hasHumanStudyContext(e)) return;
  const stamp = JSON.stringify([
      e.revision,
      e.group.length,
      e.history.length,
      e.submissions.map((s) => [s.id, s.status]),
    ]),
    cached = contextCache.get(e);
  if (cached?.problem === e.problem && cached.stamp === stamp)
    return cached.key;
  const publicTurn = e.group.reduce(
    (latest, m) =>
      m.kind === "human" && m.author === "human"
        ? Math.max(latest, m.seq)
        : latest,
    0,
  );
  const execution = e.history.reduce(
    (latest, h) =>
      h.kind === "execution" &&
      h.author === "runner" &&
      e.executions?.some(
        (j) =>
          j.id === h.executionId &&
          j.status === "finished" &&
          j.receipt?.executed,
      )
        ? Math.max(latest, h.seq)
        : latest,
    0,
  );
  const feedback = e.submissions
    .filter((s) => s.status === "needs-work")
    .at(-1);
  const key = JSON.stringify({
    revision: e.revision,
    scope: e.problem.contract.objectiveIds,
    depth: e.problem.contract.depth,
    publicTurn,
    execution,
    feedback: feedback?.id ?? null,
  });
  contextCache.set(e, { problem: e.problem, stamp, key });
  return key;
}
function workFacets(e: Encounter): (string | undefined)[] {
  const facets =
    e.problem?.scopeDefinitions?.flatMap((d) =>
      d.facets.map((f) => `${d.objectiveId}:${f.id}`),
    ) ?? [];
  return facets.length ? facets : [undefined];
}
function workFocus(e: Encounter, a: Actor, stage: NpcWork["stage"]) {
  if (stage === "boundary") return "testing";
  if (stage === "revision") return "debugging";
  const strengths = npcProfile(a).strengths;
  return (Object.keys(strengths) as TechnicalFocus[])
    .filter(
      (name) =>
        name !== "implementation" || (e.problem?.contract.depth ?? 1) >= 2,
    )
    .sort((x, y) => strengths[y] - strengths[x])[0];
}
export function npcReasoningAvailable(e: Encounter, a: Actor) {
  const contextKey = npcWorkContext(e);
  if (contextKey === undefined) return true; // Cheap unobserved world simulation.
  return reasoningStages.some((stage) =>
    workFacets(e).some(
      (facet) =>
        !(e.npcWork ?? []).some(
          (w) =>
            w.actor === a.id &&
            w.contextKey === contextKey &&
            w.stage === stage &&
            w.focus === workFocus(e, a, stage) &&
            w.facet === facet,
        ),
    ),
  );
}

export function recordNpcWork(
  g: Game,
  e: Encounter,
  a: Actor,
  mistake: boolean,
) {
  const stage: NpcWork["stage"] = mistake
    ? "revision"
    : reasoningStages[(a.milestone - 1) % reasoningStages.length];
  const focus = workFocus(e, a, stage),
    contextKey = npcWorkContext(e);
  const previous = e.npcWork ?? [];
  const remaining = workFacets(e).filter(
    (facet) =>
      contextKey === undefined ||
      !previous.some(
        (w) =>
          w.actor === a.id &&
          w.contextKey === contextKey &&
          w.stage === stage &&
          w.focus === focus &&
          w.facet === facet,
      ),
  );
  if (!remaining.length) return 0;
  const facet = remaining[fnv1a(`${a.id}/${a.milestone}`) % remaining.length];
  const overlap = previous.filter(
    (w) =>
      w.actor !== a.id &&
      w.stage === stage &&
      w.focus === focus &&
      w.facet === facet &&
      w.contextKey === contextKey &&
      w.sourceRevision === e.revision,
  ).length;
  const criterion = e.problem?.scopeDefinitions
    ?.flatMap((d) =>
      d.facets.map((f) => ({
        id: `${d.objectiveId}:${f.id}`,
        description: f.description,
      })),
    )
    .find((f) => f.id === facet)?.description;
  const text = `${a.name} recorded a ${mistake ? "revised, still unvalidated" : "simulated"} ${stage} work note${criterion ? ` about ${criterion}` : " for the retained puzzle"} at workspace revision ${e.revision}. No code execution or validated correctness is claimed.`;
  const sourceSequence = g.seq;
  const ev = event(g, "npc-milestone", text, a.floor, a.id, e.id);
  const work: NpcWork = {
    ...(contextKey !== undefined ? { contextKey } : {}),
    id: `npc-work-${g.id}-${ev.seq}`,
    actor: a.id,
    seq: ev.seq,
    at: g.time,
    stage,
    focus,
    facet,
    scopeIds: [...(e.problem?.contract.objectiveIds ?? [])],
    sourceRevision: e.revision,
    sourceSequence,
    seed: fnv1a(`${g.id}/${e.id}/${a.id}/${a.milestone}`),
    provenance: "simulated-conceptual-work",
    validated: false,
    execution: "not-run",
  };
  (e.npcWork ??= []).push(work);
  e.history.push({
    seq: ev.seq,
    author: a.id,
    kind: "npc-thought",
    text,
    at: g.time,
    revision: e.revision,
  });
  return (mistake ? 0.08 : 0.23) / (1 + Math.min(4, overlap) * 0.3);
}

export function recordNpcActivity(
  g: Game,
  a: Actor,
  previous: { activity?: Actor["activity"]; intent?: string; floor: number },
) {
  if (
    previous.activity === a.activity &&
    previous.intent === a.intent &&
    previous.floor === a.floor
  )
    return;
  const encounters = [...new Set([previous.intent, a.intent])]
    .map((id) => (id ? g.encounters[id] : undefined))
    .filter((e): e is Encounter => !!e);
  if (!encounters.length) return;
  const text = `${a.name} is ${a.activity ?? "moving"} on Floor ${a.floor + 1}${previous.intent && previous.intent !== a.intent ? "; left the previous puzzle" : ""}.`;
  const ev = event(
    g,
    "npc-activity",
    text,
    a.floor,
    a.id,
    a.intent ?? previous.intent,
  );
  for (const e of encounters)
    e.history.push({
      seq: ev.seq,
      author: a.id,
      kind: "activity",
      text,
      at: g.time,
      revision: e.revision,
    });
}
