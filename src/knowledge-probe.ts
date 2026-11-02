import { QUESTION_ADAPTATION_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";
import { scopeKey } from "./learning-model";
import type { Contract, Encounter, Game, Problem } from "./model";
import { isRecord as object } from "./records";

/**
 * Knowledge probing for the private Terminal AI conversation.
 *
 * The stance: assume the learner already has the knowledge. The tutor opens
 * with the highest-leverage question, treats one correct answer as evidence
 * for everything that answer necessarily depends on, reads how the answer was
 * given (precision, structure, hedging) as a signal, and when the learner says
 * they do not know something it stops probing, records the gap, and lets the
 * once-only gameplay reward proceed. Gameplay rewards never certify mastery;
 * the separate assessment path still judges independence.
 */
export interface ProbeFacet {
  id: string;
  description: string;
  /** For a sub-facet the tutor declared: the facet it is a prerequisite part of. */
  partOf?: string;
}
export type ProbeFindingStatus = "demonstrated" | "implied" | "gap";
export interface ProbeFinding {
  id: string;
  status: ProbeFindingStatus;
  /** For implied facets: the demonstrated facet whose answer entails this one. */
  impliedBy?: string;
  note?: string;
  /** Declares a new sub-facet: the known facet it is part of, with its description. */
  partOf?: string;
  description?: string;
}
/** Maximum retained legacy depth. New tutor calls explicitly enforce depth 1;
 * keeping this parser default reads existing observations without erasing them. */
export const SUB_FACET_DEPTH = 2;
/** How many sub-facets one reply may declare. */
export const SUB_FACETS_PER_REPLY = 16;
export type AnswerFluency = "fluent" | "partial" | "guessing" | "declared-gap";
export interface AnswerSignal {
  fluency: AnswerFluency;
  note?: string;
}
export type ProbeOutcome = "continue" | "solved" | "gap";
export interface ProbeReply {
  complete: boolean;
  outcome: ProbeOutcome;
  findings: ProbeFinding[];
  signal?: AnswerSignal;
}
export interface ProbeTurn extends ProbeReply {
  requestId: string;
  questionSequence: number;
  at: string;
}
/** Per-encounter probe record. Facets are frozen with the question. */
export interface KnowledgeProbe {
  facets: ProbeFacet[];
  turns: ProbeTurn[];
}
/** A learner-declared gap recorded when the terminal conceded the key. */
export interface KnowledgeGapRecord {
  id: string;
  encounter: string;
  runId: string;
  track: string;
  objectiveIds: string[];
  depth: number;
  facet: ProbeFacet;
  /** The learner's own words from the turn that declared the gap. */
  statement: string;
  /** For a declared sub-facet: the facet it is a prerequisite part of. */
  partOf?: ProbeFacet;
  requestId: string;
  provider: string;
  at: string;
  /** Set when the same facet was later demonstrated or implied at a terminal. */
  resolved?: {
    at: string;
    encounter: string;
    requestId: string;
    status: "demonstrated" | "implied";
  };
}
/** A facet established at a terminal (answered, or implied by an answer); carried across runs, never mastery. */
export interface KnowledgeEstablishedRecord {
  id: string;
  encounter: string;
  runId: string;
  track: string;
  objectiveIds: string[];
  depth: number;
  facet: ProbeFacet;
  status: "demonstrated" | "implied";
  /** For implied facets: the facet whose correct answer entailed this one. */
  impliedBy?: string;
  /** For a declared sub-facet: the facet it is a prerequisite part of. */
  partOf?: ProbeFacet;
  requestId: string;
  provider: string;
  at: string;
}
export type FacetState = ProbeFindingStatus | "open";
export interface ProbeState {
  facets: (ProbeFacet & { status: FacetState; impliedBy?: string })[];
  established: number;
  gaps: number;
  total: number;
  outcome?: ProbeOutcome;
  lastSignal?: AnswerSignal;
}

export const PROBE_STANCE =
  'Assume the learner already has this knowledge; they will tell you when they do not. Before interpreting uncertainty as missing knowledge, check whether the prompt is ambiguous or omits material scenario, implementation, business rules or timing facts. Acknowledge missing facts and clarify only what makes the existing task answerable; identify any added facts as a clarification, without revealing the concept\'s solution or adding tasks, rubric demands or a new product decision. Distinguish an intentional design choice from an unspecified implementation detail. When the prompt leaves a design choice open, accept reasonable examples or assumptions the learner explicitly chooses and explains; do not demand a hidden preferred implementation. Requesting clarification alone is not evidence of partial knowledge, guessing or a gap. For a clarification-only turn, keep complete:false and omit knowledge findings and knowledge.signal; continue knowledge probing after the task is clear. Do not walk the rubric item by item. Open with the single highest-leverage question: focused reasoning whose correct answer necessarily entails other facets already in the issued task. Do not widen the question or add hidden project demands. When a demonstrated facet X necessarily entails Y and Z, mark Y and Z implied by X instead of asking them separately. Read how the answer is given, but do not turn uncertainty into a gap without evidence. Ask about a facet only when nothing so far establishes it. At D1 ask for conceptual reasoning on the issued task, not implementation, specialist protocol internals or exhaustive prerequisite recall. A prerequisite clarification may descend at most one level below an original question facet; never recursively drill into prerequisites of prerequisites. Supplied setup facts such as a completed secure connection are not assessment targets. When the learner states they do not know an assessed facet or asks for its answer, do not lecture and do not withhold the reward. This does not prevent a brief definition of non-assessed supporting terminology. Record only the specific facet they explicitly do not know; leave all unasked siblings unknown. If they want to clarify which part is missing, ask at most one directly relevant prerequisite question, one level down, rather than making them finish a diagnostic tree. A correct part does not establish its apex: known parts never imply the apex. If they choose to continue, return to the apex and ask it again; a since-established part clears the way to re-ask the apex. Return complete:true with outcome:"gap" when the learner declares the remaining task unknown or wants to move on, naming only the explicitly established gaps. Unasked details remain unassessed and never prevent completion. A declared gap is a study target, never mastery or a reason to keep the learner at the terminal. ' +
  QUESTION_ADAPTATION_GUIDANCE;

export const TERMINAL_DIALOGUE_FORMAT = {
  text: "string",
  complete: "boolean",
  outcome: "solved|gap (only with complete:true; omit while continuing)",
  knowledge: {
    facets: [
      {
        id: "a probe facet id from probe.facets",
        status: "demonstrated|implied|gap",
        impliedBy: "the demonstrated facet id, for implied only",
        note: "short evidence excerpt or reason",
        partOf:
          "to declare a prerequisite the question did not list: the known facet id it is part of (new id + description required; at most one prerequisite level for new conversations)",
        description: "the new sub-facet's description, for declared parts only",
      },
    ],
    signal: {
      fluency: "fluent|partial|guessing|declared-gap",
      note: "how the latest answer was given",
    },
  },
} as const;

export const TERMINAL_DIALOGUE_INSTRUCTION =
  "Continue this private puzzle conversation. Judge the learner's accumulated answers against every part of the question and rubric. Return {text,complete,outcome?,knowledge?}. " +
  PROBE_STANCE +
  ' Ask a focused follow-up with complete:false while a facet is still open. Set complete:true with outcome:"solved" when the learner\'s messages and saved work supply a correct, sufficiently supported solution; set complete:true with outcome:"gap" when the learner has declared they do not know what remains or wants to move on; do not require a prerequisite tree, and name those facets as gaps in knowledge.facets. In knowledge.facets use ids from probe.facets, or declare a prerequisite part the question did not list as a new id with partOf (a known facet id) and description, with status demonstrated, implied (with impliedBy) or gap; add knowledge.signal only when the learner supplies an answer to assess. Your own explanations are assistance, not learner evidence. Do not demand a separate submission or repeat already demonstrated reasoning. Do not claim execution without matching receipts. Gameplay completion is separate from independent mastery.';

const facetId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

/** The facets a terminal probes: stable scope facets when the problem has them, else its rubric. */
export function probeFacets(
  problem: Pick<Problem, "rubric" | "scopeDefinitions">,
): ProbeFacet[] {
  const facets: ProbeFacet[] = [];
  const seen = new Set<string>();
  for (const scope of problem.scopeDefinitions ?? [])
    for (const f of scope.facets ?? [])
      if (
        f &&
        typeof f.id === "string" &&
        f.id &&
        typeof f.description === "string" &&
        !seen.has(f.id)
      ) {
        seen.add(f.id);
        facets.push({ id: f.id, description: f.description });
      }
  if (facets.length) return facets;
  problem.rubric.forEach((criterion, i) => {
    const id = `rubric-${i + 1}-${facetId(criterion) || "criterion"}`;
    if (seen.has(id)) return;
    seen.add(id);
    facets.push({ id, description: criterion });
  });
  return facets;
}

/** The request-side probe contract sent with every terminal-dialogue turn. */
export function probeContract(
  problem: Pick<Problem, "rubric" | "scopeDefinitions">,
  /** The encounter's grown universe; declared sub-facets keep their stored ids. */
  facets: ProbeFacet[] = probeFacets(problem),
) {
  return {
    stance: PROBE_STANCE,
    facets: structuredClone(facets),
    maxPrerequisiteDepth: 1,
    findingStatuses: ["demonstrated", "implied", "gap"],
    fluency: ["fluent", "partial", "guessing", "declared-gap"],
  };
}
/** The probe contract for the next turn at an encounter: its frozen and declared facets. */
export const encounterProbeContract = (
  e: Pick<Encounter, "probe">,
  problem: Pick<Problem, "rubric" | "scopeDefinitions">,
) =>
  probeContract(
    problem,
    e.probe?.facets.length ? e.probe.facets : probeFacets(problem),
  );

/** Completion feedback is bounded by the completion verdict. */
export const FEEDBACK_LIMIT = 8000;
/**
 * The feedback recorded on the submission when the key is conceded on a
 * declared gap. It always fits the completion verdict's bound: the gap list
 * shrinks first, then the tail of the tutor's reply. The reply itself is
 * delivered whole as the tutor message; only this record is bounded.
 */
export function concessionFeedback(
  gapDescriptions: string[],
  text: string,
  limit = FEEDBACK_LIMIT,
) {
  const head = (list: string) =>
    `Key conceded on a declared knowledge gap (${list}). Recorded for later study; no mastery claimed.`;
  const full = gapDescriptions.length
    ? gapDescriptions.join("; ")
    : "recorded earlier";
  const room = limit - text.length - 2 - head("").length;
  const list =
    full.length <= room
      ? full
      : room >= 24
        ? cutCodeUnits(full, room - 1).trimEnd() + "…"
        : `${gapDescriptions.length || "earlier"} recorded`;
  const out = `${head(list)}\n\n${text}`;
  return out.length <= limit ? out : cutCodeUnits(out, limit - 1) + "…";
}
/** The first `length` UTF-16 code units, never ending on half of a surrogate pair. */
function cutCodeUnits(value: string, length: number) {
  const cut = value.slice(0, Math.max(0, length));
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const FINDING_STATUSES = new Set<string>(["demonstrated", "implied", "gap"]);
const FLUENCY = new Set<string>([
  "fluent",
  "partial",
  "guessing",
  "declared-gap",
]);
const shortText = (v: unknown, limit: number) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, limit) : undefined;

/**
 * Validate the optional knowledge fields of a terminal-dialogue reply.
 * Structural errors throw (the reply is interrupted, never silently applied);
 * ids outside the probe universe are dropped so a stray label cannot create
 * or erase a facet the question never had.
 */
export function parseProbeReply(
  answer: Record<string, unknown>,
  facets: ProbeFacet[],
  maxPrerequisiteDepth = SUB_FACET_DEPTH,
): ProbeReply {
  if (typeof answer.complete !== "boolean")
    throw Error("Invalid tutor reply: complete must be boolean");
  const complete = answer.complete;
  if (
    answer.outcome !== undefined &&
    answer.outcome !== "solved" &&
    answer.outcome !== "gap"
  )
    throw Error(
      'Invalid tutor knowledge report: outcome must be "solved" or "gap"',
    );
  let outcome: ProbeOutcome = "continue";
  if (complete) outcome = answer.outcome === "gap" ? "gap" : "solved";
  const known = new Map(facets.map((f) => [f.id, f] as const));
  // A model may repeat a declared part in its own spelling ("Generating
  // Functions") after the game stored it normalised ("generating-functions").
  const resolve = (value: unknown): string | undefined => {
    if (typeof value !== "string") return undefined;
    if (known.has(value)) return value;
    const normal = facetId(value);
    return normal && known.has(normal) ? normal : undefined;
  };
  const depthOf = (id: string): number => {
    let depth = 0;
    for (
      let f = known.get(id);
      f?.partOf !== undefined && depth <= SUB_FACET_DEPTH;
      f = known.get(f.partOf)
    )
      depth++;
    return depth;
  };
  const findings: ProbeFinding[] = [];
  let declared = 0;
  let signal: AnswerSignal | undefined;
  if (answer.knowledge !== undefined) {
    if (!object(answer.knowledge))
      throw Error(
        "Invalid tutor knowledge report: knowledge must be an object",
      );
    const k = answer.knowledge;
    if (k.facets !== undefined) {
      if (!Array.isArray(k.facets) || k.facets.length > 64)
        throw Error(
          "Invalid tutor knowledge report: knowledge.facets must be a bounded array",
        );
      const seen = new Set<string>();
      for (const raw of k.facets) {
        if (
          !object(raw) ||
          typeof raw.id !== "string" ||
          typeof raw.status !== "string" ||
          !FINDING_STATUSES.has(raw.status)
        )
          throw Error(
            "Invalid tutor knowledge report: each facet needs id and status demonstrated|implied|gap",
          );
        let id = resolve(raw.id) ?? raw.id;
        const finding: ProbeFinding = {
          id,
          status: raw.status as ProbeFindingStatus,
        };
        if (!known.has(id)) {
          // A facet the question never listed is accepted only as a declared
          // prerequisite part of a known facet, with its own description.
          const parent = resolve(raw.partOf);
          const description = shortText(raw.description, 200);
          id = facetId(id) || (description ? facetId(description) : "");
          if (
            !parent ||
            !known.has(parent) ||
            !description ||
            !id ||
            parent === id ||
            depthOf(parent) >= maxPrerequisiteDepth ||
            declared >= SUB_FACETS_PER_REPLY
          )
            continue;
          if (!known.has(id)) {
            declared++;
            known.set(id, { id, description, partOf: parent });
            finding.partOf = parent;
            finding.description = description;
          }
          finding.id = id;
        }
        if (seen.has(id)) continue;
        seen.add(id);
        const impliedBy = resolve(raw.impliedBy);
        if (finding.status === "implied" && impliedBy && impliedBy !== id)
          finding.impliedBy = impliedBy;
        const note = shortText(raw.note, 400);
        if (note) finding.note = note;
        findings.push(finding);
      }
    }
    if (k.signal !== undefined) {
      if (
        !object(k.signal) ||
        typeof k.signal.fluency !== "string" ||
        !FLUENCY.has(k.signal.fluency)
      )
        throw Error(
          "Invalid tutor knowledge report: signal.fluency must be fluent|partial|guessing|declared-gap",
        );
      signal = { fluency: k.signal.fluency as AnswerFluency };
      const note = shortText(k.signal.note, 400);
      if (note) signal.note = note;
    }
  }
  // An implied facet needs a demonstrated anchor in this reply or an earlier one;
  // without one it still counts as the tutor's judgment, just unanchored.
  return { complete, outcome, findings, ...(signal ? { signal } : {}) };
}

/** Cumulative facet state: later turns re-judge earlier ones, per facet. */
export function probeState(e: Pick<Encounter, "probe">): ProbeState {
  const probe = e.probe;
  if (!probe) return { facets: [], established: 0, gaps: 0, total: 0 };
  const latest = new Map<string, ProbeFinding>();
  for (const turn of probe.turns)
    for (const f of turn.findings) latest.set(f.id, f);
  const facets = probe.facets.map((f) => {
    const finding = latest.get(f.id);
    return {
      ...f,
      status: (finding?.status ?? "open") as FacetState,
      ...(finding?.impliedBy ? { impliedBy: finding.impliedBy } : {}),
    };
  });
  const last = probe.turns.at(-1);
  return {
    facets,
    established: facets.filter((f) =>
      ["demonstrated", "implied"].includes(f.status),
    ).length,
    gaps: facets.filter((f) => f.status === "gap").length,
    total: facets.length,
    ...(last?.outcome && last.outcome !== "continue"
      ? { outcome: last.outcome }
      : {}),
    ...(last?.signal ? { lastSignal: last.signal } : {}),
  };
}

/** One line for the terminal HUD. */
export function probeSummary(e: Pick<Encounter, "probe">): string {
  const s = probeState(e);
  if (!s.total) return "";
  const parts = [`${s.established} of ${s.total} facets established`];
  if (s.gaps) parts.push(`${s.gaps} recorded gap${s.gaps === 1 ? "" : "s"}`);
  if (s.lastSignal)
    parts.push(
      `last answer ${s.lastSignal.fluency === "declared-gap" ? "declared a gap" : s.lastSignal.fluency}`,
    );
  return parts.join(" · ");
}

const gapKey = (encounter: string, facet: string) => `${encounter}#${facet}`;
/** The declared parent of a sub-facet, for carried records. */
function parentOf(e: Pick<Encounter, "probe">, facet: ProbeFacet) {
  if (!facet.partOf) return {};
  const parent = e.probe?.facets.find((x) => x.id === facet.partOf);
  return parent
    ? { partOf: { id: parent.id, description: parent.description } }
    : {};
}
const chain = (r: { partOf?: ProbeFacet }) =>
  r.partOf ? ` (part of ${r.partOf.description})` : "";

/**
 * Record one validated terminal reply. When the terminal concedes the key on
 * a declared gap, every facet not established by then is recorded as a gap
 * in the carried study state, once per encounter facet.
 */
export function recordProbeTurn(
  g: Game,
  e: Encounter,
  reply: ProbeReply,
  context: {
    requestId: string;
    questionSequence: number;
    provider: string;
    statement: string;
    at?: string;
  },
): KnowledgeGapRecord[] {
  const problem = e.problem;
  if (!problem) return [];
  const at = context.at ?? new Date().toISOString();
  e.probe ??= { facets: probeFacets(problem), turns: [] };
  if (e.probe.turns.some((t) => t.requestId === context.requestId)) return [];
  // Declared sub-facets join the encounter's universe so later turns, the
  // HUD and the carried records treat them like the question's own facets.
  for (const f of reply.findings)
    if (
      f.partOf !== undefined &&
      f.description !== undefined &&
      !e.probe.facets.some((x) => x.id === f.id) &&
      e.probe.facets.some((x) => x.id === f.partOf)
    )
      e.probe.facets.push({
        id: f.id,
        description: f.description,
        partOf: f.partOf,
      });
  e.probe.turns.push({
    ...reply,
    requestId: context.requestId,
    questionSequence: context.questionSequence,
    at,
  });
  // Chat after the key was awarded is kept as probe history, but it neither
  // rewrites what the terminal established nor opens new study targets.
  if (e.state === "consumed") return [];
  syncEstablished(g, e, context, at);
  if (reply.outcome !== "gap") return [];
  const state = probeState(e);
  const declared = new Set(
    reply.findings.filter((f) => f.status === "gap").map((f) => f.id),
  );
  // A concession alone does not establish which parts are missing. Unasked
  // siblings stay unknown; only an explicit, question-bound finding is a gap.
  const gapFacets = state.facets.filter((f) => declared.has(f.id));
  const encounterRef = `${e.runId ?? g.id}/${e.id}`;
  const existing = new Set(
    (g.study.knowledgeGaps ?? []).map((r) => gapKey(r.encounter, r.facet.id)),
  );
  const created: KnowledgeGapRecord[] = [];
  for (const facet of gapFacets) {
    if (existing.has(gapKey(encounterRef, facet.id))) continue;
    const record: KnowledgeGapRecord = {
      id: `gap-${encounterRef}-${facet.id}`,
      encounter: encounterRef,
      runId: e.runId ?? g.id,
      track: problem.contract.track,
      objectiveIds: [...problem.contract.objectiveIds],
      depth: problem.contract.depth,
      facet: { id: facet.id, description: facet.description },
      ...parentOf(e, facet),
      statement: context.statement.slice(0, 1000),
      requestId: context.requestId,
      provider: context.provider,
      at,
    };
    (g.study.knowledgeGaps ??= []).push(record);
    created.push(record);
  }
  return created;
}

/**
 * Mirror this encounter's established facets into the carried study state:
 * a correct answer to X records X, and every Y and Z it implied, so a later
 * terminal on the same scope does not probe them again. A later re-judgment
 * within the encounter replaces or withdraws the record.
 */
function syncEstablished(
  g: Game,
  e: Encounter,
  context: { requestId: string; provider: string },
  at: string,
) {
  const problem = e.problem;
  if (!problem) return;
  const encounterRef = `${e.runId ?? g.id}/${e.id}`;
  const records = (g.study.knowledgeEstablished ??= []);
  const established = probeState(e).facets.filter(
    (f) => f.status === "demonstrated" || f.status === "implied",
  );
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.encounter !== encounterRef) continue;
    const current = established.find((f) => f.id === r.facet.id);
    if (!current) {
      records.splice(i, 1);
      continue;
    }
    if (current.status !== r.status || current.impliedBy !== r.impliedBy) {
      const { impliedBy: _dropped, ...rest } = r;
      records[i] = {
        ...rest,
        status: current.status as "demonstrated" | "implied",
        ...(current.impliedBy ? { impliedBy: current.impliedBy } : {}),
        requestId: context.requestId,
        at,
      };
    }
  }
  for (const f of established) {
    if (
      records.some((r) => r.encounter === encounterRef && r.facet.id === f.id)
    )
      continue;
    records.push({
      id: `known-${encounterRef}-${f.id}`,
      encounter: encounterRef,
      runId: e.runId ?? g.id,
      track: problem.contract.track,
      objectiveIds: [...problem.contract.objectiveIds],
      depth: problem.contract.depth,
      facet: { id: f.id, description: f.description },
      status: f.status as "demonstrated" | "implied",
      ...(f.impliedBy ? { impliedBy: f.impliedBy } : {}),
      ...parentOf(e, f),
      requestId: context.requestId,
      provider: context.provider,
      at,
    });
  }
  if (!records.length) delete g.study.knowledgeEstablished;
  reconcileKnowledgeGaps(g);
}
const normalizedFacetText = (value: string) =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();

/** Repair derived gap resolutions using retained observations, including saves
 * written before facet IDs were scoped. Raw probe turns and observations stay
 * unchanged; an unsupported resolution never hides an outstanding study gap. */
export function reconcileKnowledgeGaps(g: Pick<Game, "study">): void {
  const known = (g.study.knowledgeEstablished ?? []).map((record) => ({
    record,
    at: Date.parse(record.at),
    text: normalizedFacetText(record.facet.description),
  }));
  for (const gap of g.study.knowledgeGaps ?? []) {
    const at = Date.parse(gap.at),
      text = normalizedFacetText(gap.facet.description);
    const candidates = known.filter(
      ({ record, at: establishedAt, text: knownText }) =>
        record.track === gap.track &&
        establishedAt >= at &&
        ((text !== "" && knownText === text) ||
          (record.facet.id === gap.facet.id &&
            record.depth === gap.depth &&
            gap.objectiveIds.length > 0 &&
            gap.objectiveIds.every((id) => record.objectiveIds.includes(id)))),
    );
    const supported = candidates.find(
      ({ record }) =>
        record.encounter === gap.resolved?.encounter &&
        record.status === gap.resolved?.status,
    );
    if (supported) continue;
    const replacement = candidates.reduce<
      (typeof candidates)[number] | undefined
    >(
      (latest, candidate) =>
        !latest || candidate.at > latest.at ? candidate : latest,
      undefined,
    )?.record;
    if (replacement)
      gap.resolved = {
        at: replacement.at,
        encounter: replacement.encounter,
        requestId: replacement.requestId,
        status: replacement.status,
      };
    else delete gap.resolved;
  }
}

/** Established records for an encounter. */
export function encounterEstablished(
  g: Game,
  e: Encounter,
): KnowledgeEstablishedRecord[] {
  const ref = `${e.runId ?? g.id}/${e.id}`;
  return (g.study.knowledgeEstablished ?? []).filter(
    (r) => r.encounter === ref,
  );
}

/** Gap records for an encounter, for the terminal and inspector views. */
export function encounterGaps(g: Game, e: Encounter): KnowledgeGapRecord[] {
  const ref = `${e.runId ?? g.id}/${e.id}`;
  return (g.study.knowledgeGaps ?? []).filter((r) => r.encounter === ref);
}

/** Short progress-context note so the next question can target recorded gaps. */
export function knowledgeGapContext(g: Game, track: string): string {
  const gaps = (g.study.knowledgeGaps ?? []).filter((r) => r.track === track);
  if (!gaps.length) return "";
  const open = gaps.filter((r) => !r.resolved).slice(-20);
  const closed = gaps.filter((r) => r.resolved).slice(-10);
  const lines = [];
  if (open.length)
    lines.push(
      "Learner-declared knowledge gaps recorded at earlier terminals (study targets, not failures). Ask about these directly, then re-ask whatever facet they blocked:\n" +
        open
          .map(
            (r) =>
              `- ${r.objectiveIds.join(", ")} D${r.depth} · ${r.facet.description}${chain(r)} · learner said: ${JSON.stringify(r.statement.slice(0, 200))}`,
          )
          .join("\n"),
    );
  if (closed.length)
    lines.push(
      "Gaps since closed: the learner later established these facets, so the facet each one blocked can be asked again (known parts do not imply it):\n" +
        closed
          .map(
            (r) =>
              `- ${r.objectiveIds.join(", ")} D${r.depth} · ${r.facet.description}${chain(r)} · ${r.resolved!.status} on ${r.resolved!.at.slice(0, 10)}`,
          )
          .join("\n"),
    );
  return lines.join("\n\n");
}

/** Gap records still open, for views that target study. */
export const openGaps = (g: Game) =>
  (g.study.knowledgeGaps ?? []).filter((r) => !r.resolved);

/** Progress-context note listing facets already established, so they are not probed again. */
export function knowledgeEstablishedContext(g: Game, track: string): string {
  const known = (g.study.knowledgeEstablished ?? []).filter(
    (r) => r.track === track,
  );
  if (!known.length) return "";
  return (
    "Facets already established at earlier terminals (answered, or implied by a correct answer). Treat them as known: do not re-probe them unless the current answer contradicts one. Terminal observations, not curriculum mastery:\n" +
    known
      .slice(-40)
      .map(
        (r) =>
          `- ${r.objectiveIds.join(", ")} D${r.depth} · ${r.facet.description}${chain(r)} · ${r.status}${r.impliedBy ? ` (implied by ${r.impliedBy})` : ""}`,
      )
      .join("\n")
  );
}

/** Both notes for the next tutor request on a track. */
export function knowledgeProbeContext(g: Game, track: string): string {
  return [knowledgeEstablishedContext(g, track), knowledgeGapContext(g, track)]
    .filter(Boolean)
    .join("\n\n");
}

/** Bounded probe records for one track, for the question generator. */
export interface ProbeRecords {
  note: string;
  established: {
    facetId: string;
    description: string;
    status: "demonstrated" | "implied";
    impliedBy?: string;
    partOf?: ProbeFacet;
    objectiveIds: string[];
    depth: number;
  }[];
  openGaps: {
    facetId: string;
    description: string;
    statement: string;
    partOf?: ProbeFacet;
    objectiveIds: string[];
    depth: number;
    /** True only when this gap may become a facet of the contract's scopeDefinitions without rewriting a stable definition. */
    reuseInScopeDefinitions: boolean;
  }[];
  closedGaps: {
    facetId: string;
    description: string;
    partOf?: ProbeFacet;
    objectiveIds: string[];
    depth: number;
    resolvedAt: string;
  }[];
}
export const PROBE_RECORDS_NOTE =
  "Terminal probe observations for this track, never curriculum mastery. Build the question around openGaps inside the eligible scope and make the facet they blocked the question's apex. Only an openGap with reuseInScopeDefinitions:true (recorded on exactly the scope being generated) may contribute its exact facet id and description to scopeDefinitions; for every other gap, copy existingScopeDefinitions for that scope exactly and use the gap only to shape the prompt and apex. Never rewrite an existing stable scope definition. Do not spend the question on facets listed as established unless the scope requires them; a closedGap means the facet it blocked should be asked again, since known parts never imply it. The scheduler alone chooses the scope; copy the eligible contract exactly.";
export function probeRecordsForTrack(
  g: Game,
  track: string,
  /** The contract being generated; without it no gap may seed a scope facet. */
  contract?: Pick<Contract, "objectiveIds" | "depth">,
): ProbeRecords {
  const onTrack = <T extends { track: string }>(rows: T[] | undefined) =>
    (rows ?? []).filter((r) => r.track === track);
  const parent = (r: { partOf?: ProbeFacet }) =>
    r.partOf ? { partOf: { ...r.partOf } } : {};
  const gaps = onTrack(g.study.knowledgeGaps);
  // A gap may seed a scope facet only when it is one of a question's own
  // facets (not a declared part) recorded on exactly the scope this contract
  // registers, and that definition is unregistered or already holds the facet
  // unchanged. Anything else would rewrite a stable definition.
  const scopes = g.study.learner?.scopes ?? {};
  const reusable = (r: KnowledgeGapRecord) =>
    !!contract &&
    !r.partOf &&
    r.depth === contract.depth &&
    r.objectiveIds.length > 0 &&
    r.objectiveIds.every((id) => {
      if (!contract.objectiveIds.includes(id)) return false;
      const existing = scopes[scopeKey(id, contract.depth)];
      return (
        !existing ||
        existing.facets.some(
          (f) => f.id === r.facet.id && f.description === r.facet.description,
        )
      );
    });
  return {
    note: PROBE_RECORDS_NOTE,
    established: onTrack(g.study.knowledgeEstablished)
      .slice(-40)
      .map((r) => ({
        facetId: r.facet.id,
        description: r.facet.description,
        status: r.status,
        ...(r.impliedBy ? { impliedBy: r.impliedBy } : {}),
        ...parent(r),
        objectiveIds: [...r.objectiveIds],
        depth: r.depth,
      })),
    openGaps: gaps
      .filter((r) => !r.resolved)
      .slice(-20)
      .map((r) => ({
        facetId: r.facet.id,
        description: r.facet.description,
        statement: r.statement.slice(0, 200),
        ...parent(r),
        objectiveIds: [...r.objectiveIds],
        depth: r.depth,
        reuseInScopeDefinitions: reusable(r),
      })),
    closedGaps: gaps
      .filter((r) => r.resolved)
      .slice(-20)
      .map((r) => ({
        facetId: r.facet.id,
        description: r.facet.description,
        ...parent(r),
        objectiveIds: [...r.objectiveIds],
        depth: r.depth,
        resolvedAt: r.resolved!.at,
      })),
  };
}
