import { PROVIDERS } from "./model";
import {
  curriculumReadiness,
  ensureFinalProgress,
  finalRequirements,
  finalRequirementStatus,
  learningTarget,
} from "./final-requirements";
import {
  historicalRecords,
  independentProofValid,
  validateHistoricalMapping,
} from "./historical-proof";
import { historicalScope } from "./historical-scope";
import { importedProofValid } from "./imported-proof";
import {
  scopeFacetsValid,
  learningProgress,
  progressStatus,
  scopeKey,
  setProgressStatus,
  studyRatioPosition,
  learningAttemptRoot,
  servedLearningAttempts,
  type CellState,
  type LearnerLedger,
  type LearningAttempt,
  type LearningEvidence,
  type ReviewRecord,
} from "./learning-model";
import {
  type Provider,
  type Assessment,
  type Contract,
  type Encounter,
  type Roadmap,
  type Track,
} from "./model";
import {
  baselineCheckpointRefs,
  baselineCheckpointValid,
  baselineReviewSuspended,
} from "./observation-validity";
import {
  effectiveTarget,
  focusMaxTier,
  focusOf,
  roleFocused,
} from "./career-profile";
import { externalResolutionRow } from "./roadmap-active-work";
import { allocationCounters, formatIdentifier } from "./roadmap-identifiers";
import { sourceSessionStatus } from "./roadmap-structure";
export const encounterKey = (e: Encounter) => `${e.runId ?? "legacy"}/${e.id}`;
const localDateFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Toronto",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
export function localDate(at = new Date().toISOString()) {
  const parts = localDateFormat.formatToParts(new Date(at));
  return ["year", "month", "day"]
    .map((type) => parts.find((p) => p.type === type)!.value)
    .join("-");
}
export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const topic = (id: string) => id.split(":")[1].split(".")[0];
const reviewKey = scopeKey;
export function initialLearner(
  r: Roadmap,
  mode: "live" | "test" = "live",
): LearnerLedger {
  if (r.resume && r.resume.ratioPosition === undefined)
    throw Error(
      "Saved ratio position needs reconciliation before study can resume",
    );
  if (r.resume?.issues.length)
    throw Error(
      `Saved resume metadata needs reconciliation before study can resume: ${r.resume.issues.join(" ")}`,
    );
  const cells: LearnerLedger["cells"] = {},
    reviews: LearnerLedger["reviews"] = {};
  for (const track of ["PY", "PE"] as const)
    for (const o of r.tracks[track].objectives) {
      cells[o.id] = {
        states: [...o.cells] as CellState[],
        facets: {},
        proofs: {},
        sourceRefs: o.refs,
      };
      if (o.reviewDue) {
        const ev = /S\d{4}-EV\d+/.exec(o.refs)?.[0],
          session = ev?.split("-")[0];
        const row = r.raw
          .split("\n")
          .find((l) => session && l.startsWith(`| ${session} |`));
        reviews[reviewKey(o.id, 1)] = {
          objectiveId: o.id,
          depth: 1,
          due: o.reviewDue,
          stage: 0,
          verifiedReviews: 0,
          sequence: session,
          lastIndependentDate: row
            ? /\d{4}-\d{2}-\d{2}/.exec(row)?.[0]
            : undefined,
        };
      }
    }
  if (r.resume?.reviews)
    Object.assign(reviews, structuredClone(r.resume.reviews));
  const history =
    r.sharedProgress.split("### S0.4")[1]?.split("### S0.5")[0] ?? "";
  const sessions = [...history.matchAll(/^\| (S\d{4}) \| (.+)$/gm)].map(
    (m) => ({
      id: m[1],
      status: sourceSessionStatus(m[2].split("|")[0]),
    }),
  );
  const state = (t: Track) => ({
    tier: r.tracks[t].tier,
    cleared: r.tracks[t].cleared ?? 0,
    phase: r.tracks[t].phase,
    queue: [...r.tracks[t].remaining],
    lap: r.tracks[t].lap ?? (t === "PY" ? 2 : 1),
    suspended: structuredClone(r.tracks[t].suspended ?? []),
  });
  const result: LearnerLedger = {
    ...(r.resume?.identifierCounters
      ? { identifierCounters: structuredClone(r.resume.identifierCounters) }
      : {}),
    schema: 1,
    mode,
    sourceHash: r.sourceHash,
    version: 0,
    cycle: 0,
    cycleOffset: r.resume?.ratioPosition ?? 0,
    cells,
    scopes: {},
    verifiedScopes: [],
    tracks: { PY: state("PY"), PE: state("PE") },
    reviews,
    sessions,
    attempts: [],
    evidence: [],
    receipts: {},
    continuations: [],
  };
  ensureFinalProgress(r, result);
  return result;
}
function checkSource(r: Roadmap, l: LearnerLedger) {
  if (l.sourceHash !== r.sourceHash)
    throw Error(
      "Learner source does not match this roadmap; explicit migration required.",
    );
}
function nextSession(r: Roadmap, l: LearnerLedger) {
  if (l.currentSession) return l.currentSession;
  const counters = allocationCounters(r, l),
    n = counters.nextSession;
  if (n > 9999)
    throw Error(
      "Session identifier range exhausted; explicit schema migration required",
    );
  counters.nextSession++;
  for (const s of l.sessions)
    if (s.status === "open") s.status = "INTERRUPTED_AT_LAST_SAVE";
  const id = formatIdentifier("S", n, 4);
  l.identifierCounters = counters;
  l.sessions.push({ id, status: "open" });
  l.currentSession = id;
  return id;
}
function allocate(
  r: Roadmap,
  l: LearnerLedger,
  session: string,
  kind: "A" | "EV",
) {
  const counters = allocationCounters(r, l),
    values = kind === "A" ? counters.attempts : counters.evidence,
    n = values[session] ?? 1;
  if (n >= Number.MAX_SAFE_INTEGER)
    throw Error("Learning identifier counter exhausted");
  values[session] = n + 1;
  l.identifierCounters = counters;
  return formatIdentifier(`${session}-${kind}`, n);
}
export function registerScopes(r: Roadmap, l: LearnerLedger, e: Encounter) {
  checkSource(r, l);
  const c = e.problem?.contract;
  if (!c) throw Error("Task contract missing");
  for (const d of e.problem?.scopeDefinitions ?? []) {
    const objective = learningTarget(r, c.track, d.objectiveId);
    if (
      !objective ||
      (c.kind ?? "checkpoint") !== objective.kind ||
      (objective.kind !== "checkpoint" && d.depth !== 4) ||
      !c.objectiveIds.includes(d.objectiveId) ||
      d.depth !== c.depth ||
      d.depth > objective.target ||
      d.sourceScope !== objective.scope ||
      d.id !== scopeKey(d.objectiveId, d.depth) ||
      !scopeFacetsValid(d.facets)
    )
      throw Error("Invalid curriculum facet definition");
    const existing = l.scopes[d.id];
    if (existing && JSON.stringify(existing) !== JSON.stringify(d))
      throw Error(
        "A stable facet definition cannot be rewritten by a new task.",
      );
  }
  ensureFinalProgress(r, l);
  for (const d of e.problem?.scopeDefinitions ?? [])
    l.scopes[d.id] = structuredClone(d);
}
function incompleteTopics(
  r: Roadmap,
  l: LearnerLedger,
  t: Track,
  depth: number,
) {
  const finals =
    depth === 4
      ? finalRequirements(r, t).filter(
          (d) =>
            d.selected &&
            d.kind !== "environment" &&
            finalRequirementStatus(r, l, d) !== "P",
        )
      : [];
  const topics = r.tracks[t].rotation.filter(
    (name) =>
      finals.some((d) => d.kind === "transfer" && d.name === name) ||
      r.tracks[t].objectives.some(
        (o) =>
          topic(o.id) === name &&
          effectiveTarget(o, focusOf(l)) >= depth &&
          l.cells[o.id].states[depth - 1] !== "P",
      ),
  );
  if (depth === 4 && l.tracks[t].phase !== "DIAGNOSE_ALL")
    topics.push(
      ...finals.filter((d) => d.kind === "integration").map((d) => d.name),
    );
  return topics;
}
type CarryLedger = LearnerLedger & {
  careerCarryover?: { ledgerVersion: number; contract: Contract };
};
/** A pre-switch issued formal contract still valid at this ledger version. */
function carryover(l: LearnerLedger) {
  const c = (l as CarryLedger).careerCarryover;
  return c && c.ledgerVersion === l.version ? c.contract : undefined;
}
/** Role-focused tracks stop at their profile depth, unless unfinished work is deeper. */
function focusCap(l: LearnerLedger, t: Track) {
  const cap = focusMaxTier(t, focusOf(l));
  if (cap >= 4) return 4;
  const carried = carryover(l);
  return Math.min(
    4,
    Math.max(
      cap,
      ...l.attempts
        .filter(
          (a) =>
            ["in-progress", "suspended"].includes(a.status) &&
            a.contract.track === t,
        )
        .map((a) => a.contract.depth),
      carried?.track === t ? carried.depth : 0,
    ),
  );
}
/** After restoring the full profile, re-add original topics a focused lap dropped. */
export function restoreFullQueues(r: Roadmap, l: LearnerLedger) {
  const saved = l as LearnerLedger & {
    careerFullTrack?: LearnerLedger["tracks"]["PE"];
  };
  if (saved.careerFullTrack) {
    l.tracks.PE = structuredClone(saved.careerFullTrack);
    delete saved.careerFullTrack;
    return;
  }
  // Older focused saves may lack a full-profile cursor. Rebuild only PE,
  // keeping the curriculum's canonical order; Python never changed profile.
  {
    const t = "PE" as const;
    const s = l.tracks[t];
    if (s.phase === "COMPLETE" && s.cleared < 4) s.phase = "REPAIR_VERIFY";
    for (const name of incompleteTopics(r, l, t, s.tier))
      if (!s.queue.includes(name)) s.queue.push(name);
    const order = [
      ...r.tracks[t].rotation,
      ...finalRequirements(r, t)
        .filter((d) => d.kind === "integration" && d.selected)
        .map((d) => d.name),
    ];
    s.queue.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
}
/** Under a role focus a due review is scheduled only inside the profile's targets. */
function focusReviewEligible(
  r: Roadmap,
  l: LearnerLedger,
  v: { objectiveId: string; depth: number },
) {
  const track = v.objectiveId.split(":")[0] as Track;
  const o = r.tracks[track]?.objectives.find((x) => x.id === v.objectiveId);
  if (!o) return track !== "PE";
  return effectiveTarget(o, focusOf(l)) >= v.depth;
}
export function reconcileGates(r: Roadmap, l: LearnerLedger) {
  ensureFinalProgress(r, l);
  const focus = focusOf(l),
    focused = roleFocused(focus);
  // Reopening a lower checkpoint suspends the later position without erasing it.
  for (const t of ["PY", "PE"] as const) {
    const state = l.tracks[t];
    for (let d = 1; d <= state.cleared; d++)
      if (
        r.tracks[t].objectives.some(
          (o) =>
            effectiveTarget(o, focus) >= d &&
            l.cells[o.id].states[d - 1] !== "P",
        )
      ) {
        state.cleared = d - 1;
        if (state.tier > d)
          state.suspended.push({
            tier: state.tier,
            phase: state.phase,
            queue: [...state.queue],
            lap: state.lap,
          });
        state.tier = d;
        state.phase = "REPAIR_VERIFY";
        state.queue = incompleteTopics(r, l, t, d);
        break;
      }
  }
  // Reconcile both tracks twice because clearing one gate can release the other.
  for (let lap = 0; lap < 2; lap++)
    for (const t of ["PY", "PE"] as const) {
      const s = l.tracks[t],
        other = l.tracks[t === "PY" ? "PE" : "PY"];
      const cap = focusCap(l, t);
      // A role-profile completion below tier 4 is not original completion.
      if (s.phase === "COMPLETE" && s.cleared < 4 && cap === 4)
        s.phase = "REPAIR_VERIFY";
      const limit = Math.min(cap, other.cleared + 2);
      if (s.tier > limit) {
        s.suspended.push({
          tier: s.tier,
          phase: s.phase,
          queue: [...s.queue],
          lap: s.lap,
        });
        s.tier = limit;
        s.phase = "REPAIR_VERIFY";
        s.queue = incompleteTopics(r, l, t, limit);
      }
      if (s.tier === 4 && !s.queue.length && s.phase === "DIAGNOSE_ALL")
        s.phase = "REPAIR_VERIFY";
      const incomplete = incompleteTopics(r, l, t, s.tier);
      if (s.tier === 4 && incomplete.length && s.cleared === 4) {
        s.cleared = 3;
        s.phase = "REPAIR_VERIFY";
      }
      if (s.tier === 4 && incomplete.length && !s.queue.length)
        s.queue = [...incomplete];
      if (
        focused &&
        t === "PE" &&
        incomplete.length &&
        !s.queue.some((name) => incomplete.includes(name))
      )
        s.queue.push(...incomplete.filter((name) => !s.queue.includes(name)));
      if (!incomplete.length && cap < 4 && s.tier >= cap) {
        // Role-profile end for this track: never an original tier-4 claim.
        s.cleared = Math.max(s.cleared, s.tier);
        s.phase = "COMPLETE";
        s.queue = [];
      } else if (!incomplete.length) {
        s.phase = "TIER_GATE";
        if (s.tier === 4 && curriculumReadiness(r, l, t).tier4RequirementsMet) {
          s.cleared = 4;
          s.phase = "COMPLETE";
          s.queue = [];
        }
        if (s.tier < 4) {
          s.cleared = Math.max(s.cleared, s.tier);
          if (s.tier + 1 <= other.cleared + 2) {
            s.tier++;
            const resume = [...s.suspended]
              .reverse()
              .find((v) => v.tier === s.tier);
            s.phase = resume?.phase ?? "DIAGNOSE_ALL";
            s.queue = resume
              ? [...resume.queue]
              : incompleteTopics(r, l, t, s.tier);
            s.lap = resume?.lap ?? 1;
            if (resume) s.suspended = s.suspended.filter((v) => v !== resume);
          }
        }
      }
    }
  reconcileAttemptGates(l);
}
/** Apply reviewed difficulty ceilings to actual tasks without changing their work. */
export function reconcileAttemptGates(l: LearnerLedger) {
  for (const a of l.attempts)
    if (
      a.status === "in-progress" &&
      a.contract.depth > l.tracks[a.contract.track].tier
    )
      a.status = "suspended";
  if (!l.attempts.some((a) => a.status === "in-progress")) {
    const resume = l.attempts.find(
      (a) =>
        a.status === "suspended" &&
        a.contract.depth <= l.tracks[a.contract.track].tier,
    );
    if (resume) resume.status = "in-progress";
  }
}
export function eligibleLearning(
  r: Roadmap,
  l: LearnerLedger,
  at = new Date().toISOString(),
): Contract {
  checkSource(r, l);
  const pending = l.attempts.find((a) => a.status === "in-progress");
  if (pending) return structuredClone(pending.contract);
  const focus = focusOf(l),
    focused = roleFocused(focus);
  const preferred: Track = (["PY", "PE", "PE"] as const)[studyRatioPosition(l)];
  for (const track of [
    preferred,
    preferred === "PY" ? "PE" : "PY",
  ] as Track[]) {
    const s = l.tracks[track];
    const last = servedLearningAttempts(l)
      .filter((a) => a.contract.track === track)
      .at(-1);
    const today = localDate(at);
    const due =
      last?.contract.review && s.phase !== "COMPLETE"
        ? undefined
        : Object.values(l.reviews)
            .filter(
              (v) =>
                v.objectiveId.startsWith(`${track}:`) &&
                v.depth <= s.tier &&
                v.due <= today &&
                !baselineReviewSuspended(r, l, v) &&
                (!focused || focusReviewEligible(r, l, v)),
            )
            .sort((a, b) => a.due.localeCompare(b.due))[0];
    const focusedTrack = focused && track === "PE";
    const incompleteNow = focusedTrack
      ? incompleteTopics(r, l, track, s.tier)
      : [];
    const nextTopic = focusedTrack
      ? (s.queue.find((name) => incompleteNow.includes(name)) ??
        incompleteNow[0])
      : (s.queue[0] ?? incompleteTopics(r, l, track, s.tier)[0]);
    const final =
      s.tier === 4
        ? finalRequirements(r, track).find(
            (d) =>
              d.name === nextTopic &&
              d.selected &&
              d.kind !== "environment" &&
              finalRequirementStatus(r, l, d) !== "P",
          )
        : undefined;
    const ordinary = r.tracks[track].objectives.find(
      (o) =>
        topic(o.id) === nextTopic &&
        effectiveTarget(o, focus) >= s.tier &&
        l.cells[o.id].states[s.tier - 1] !== "P",
    );
    const id =
      due?.objectiveId ??
      (s.phase === "DIAGNOSE_ALL" && final?.kind === "transfer"
        ? final.id
        : (ordinary?.id ?? final?.id));
    const objective = id ? learningTarget(r, track, id) : undefined;
    if (!objective) continue;
    const depth = due?.depth ?? s.tier,
      definition = l.scopes[scopeKey(objective.id, depth)],
      progress = l.cells[objective.id] ?? l.finalProgress?.[objective.id];
    const preservedFacets = due
      ? []
      : (definition?.facets
          .filter(
            (f) =>
              progress?.facets[`D${depth}:${f.id}`]?.outcome === "independent",
          )
          .map((f) => f.id) ?? []);
    const missingFacets = definition?.facets
      .filter((f) => !preservedFacets.includes(f.id))
      .map((f) => f.id);
    return {
      kind: objective.kind,
      id: `live-${l.version}-${scopeKey(objective.id, depth)}`,
      track,
      objectiveIds: [objective.id],
      scopes: [objective.scope],
      depth,
      phase: s.phase,
      review: !!due,
      ledgerVersion: l.version,
      priorEvidence: [
        objective.refs,
        ...Object.values(progress?.facets ?? {}).flatMap((p) => p.evidenceIds),
      ],
      preservedFacets,
      missingFacets,
      historicalScope:
        objective.kind === "checkpoint"
          ? historicalScope(r, track, objective.id, depth)
          : undefined,
      scheduleNote:
        track === preferred
          ? undefined
          : `${preferred} has no runnable work within its gates; ${track} serves this visit under M3.2.`,
    };
  }
  if (["PY", "PE"].every((t) => l.tracks[t as Track].phase === "COMPLETE"))
    throw Error(
      "Curriculum gates complete; no due maintenance review. Do not generate filler.",
    );
  throw Error(
    "Both tracks are at unresolved gates; do not generate filler or harder work.",
  );
}
/**
 * A practice contract for a variety terminal on `topic` at the track's current
 * tier. It mirrors the formal contract's facet bookkeeping but is marked
 * practice: no attempt, visit or ledger evidence is ever created for it.
 */
export function practiceContract(
  r: Roadmap,
  l: LearnerLedger,
  track: Track,
  topicId: string,
): Contract | undefined {
  const s = l.tracks[track];
  if (s.tier === 4) return undefined;
  const o = r.tracks[track].objectives.find(
    (o) =>
      topic(o.id) === topicId &&
      effectiveTarget(o, focusOf(l)) >= s.tier &&
      l.cells[o.id]?.states[s.tier - 1] !== "P",
  );
  if (!o) return undefined;
  const depth = s.tier,
    definition = l.scopes[scopeKey(o.id, depth)],
    progress = l.cells[o.id];
  const preservedFacets =
    definition?.facets
      .filter(
        (f) => progress?.facets[`D${depth}:${f.id}`]?.outcome === "independent",
      )
      .map((f) => f.id) ?? [];
  return {
    kind: "checkpoint",
    id: `practice-live-${l.version}-${scopeKey(o.id, depth)}`,
    track,
    objectiveIds: [o.id],
    scopes: [o.scope],
    depth,
    phase: s.phase,
    review: false,
    ledgerVersion: l.version,
    priorEvidence: [
      o.refs,
      ...Object.values(progress?.facets ?? {}).flatMap((p) => p.evidenceIds),
    ],
    preservedFacets,
    missingFacets: definition?.facets
      .filter((f) => !preservedFacets.includes(f.id))
      .map((f) => f.id),
    historicalScope: historicalScope(r, track, o.id, depth),
    practice: true,
    scheduleNote: `Variety practice on ${topicId}; not the scheduled visit and never ledger evidence.`,
  };
}
function attemptRoot(l: LearnerLedger, a: LearningAttempt) {
  return learningAttemptRoot(l, a);
}
export function beginLearningAttempt(
  r: Roadmap,
  l: LearnerLedger,
  e: Encounter,
  at = new Date().toISOString(),
): LearningAttempt {
  checkSource(r, l);
  if (!PROVIDERS.includes(e.problem?.provenance ?? ""))
    throw Error("Development tasks cannot create real learning attempts");
  const key = encounterKey(e),
    existing = l.attempts.find((a) => a.encounter === key);
  if (existing) {
    if (existing.status === "externally-resolved") {
      externalResolutionRow(l, existing);
      return existing;
    }
    if (existing.contract.depth > l.tracks[existing.contract.track].tier)
      throw Error(
        "This unfinished task is suspended by a reopened lower gate.",
      );
    return existing;
  }
  const c = e.problem?.contract,
    scheduled = eligibleLearning(r, l, at);
  const matches = (n: Contract) =>
    !!c &&
    c.track === n.track &&
    c.depth === n.depth &&
    c.review === n.review &&
    (c.kind ?? "checkpoint") === (n.kind ?? "checkpoint") &&
    JSON.stringify(c.objectiveIds) === JSON.stringify(n.objectiveIds);
  // A question issued before a career-focus switch keeps its contract.
  const carried = carryover(l);
  const next = matches(scheduled)
    ? scheduled
    : carried && matches(carried)
      ? carried
      : undefined;
  if (!c || !next)
    throw Error("This encounter is not the scheduled learning contract.");
  if (l.attempts.some((a) => a.status === "in-progress"))
    throw Error("The unfinished visit stays bound to its original encounter.");
  const session = nextSession(r, l);
  l.sessions.find((s) => s.id === session)!.startedAt ??= at;
  const parent = openContinuation(l, next);
  const attempt: LearningAttempt = {
    id: allocate(r, l, session, "A"),
    session,
    encounter: key,
    contract: structuredClone(c),
    status: "in-progress",
    startedAt: at,
    lap: l.tracks[c.track].lap,
    parentAttempt: parent?.attemptId,
  };
  l.attempts.push(attempt);
  return attempt;
}
/** The interrupted attempt that a new attempt on this contract continues, if any. */
export function openContinuation(
  l: LearnerLedger,
  c: Pick<Contract, "objectiveIds" | "depth">,
) {
  return l.continuations.find(
    (k) =>
      k.objectiveIds.some((id) => c.objectiveIds.includes(id)) &&
      k.depth === c.depth &&
      !l.attempts.some(
        (a) =>
          a.status === "served" &&
          attemptRoot(l, a) ===
            attemptRoot(
              l,
              l.attempts.find((p) => p.id === k.attemptId)!,
            ),
      ),
  );
}
export function interruptLearningAttempt(
  l: LearnerLedger,
  e: Encounter,
  at = new Date().toISOString(),
) {
  const a = l.attempts.find(
    (a) =>
      a.encounter === encounterKey(e) &&
      ["in-progress", "suspended"].includes(a.status),
  );
  if (!a) return;
  a.status = "interrupted";
  l.continuations.push({
    attemptId: a.id,
    encounter: a.encounter,
    objectiveIds: [...a.contract.objectiveIds],
    depth: a.contract.depth,
    at,
  });
}
export function closeLearningSession(l: LearnerLedger) {
  if (!l.currentSession) return;
  const s = l.sessions.find((s) => s.id === l.currentSession);
  if (s) s.status = "closed";
  delete l.currentSession;
}
export function isDelayedReview(v: ReviewRecord, at: string, session: string) {
  if (v.sequence === session) return false;
  if (v.lastIndependentAt)
    return (
      new Date(at).getTime() - new Date(v.lastIndependentAt).getTime() >=
      86400000
    );
  if (v.lastIndependentDate)
    return (
      (new Date(localDate(at)).getTime() -
        new Date(v.lastIndependentDate).getTime()) /
        86400000 >=
      2
    );
  return false;
}
export function assistanceSources(e: Encounter) {
  const sources: Encounter["group"] = [...e.group, ...e.tutor];
  for (const h of e.history.filter(
    (h) =>
      [
        "npc-thought",
        "npc-proposal",
        "workspace-view",
        "source-view",
        "validation",
      ].includes(h.kind) &&
      h.author !== "human" &&
      h.presented !== undefined,
  )) {
    if (
      sources.some(
        (m) =>
          m.sourceRefs?.includes(h.seq) &&
          m.presented !== undefined &&
          m.presented <= h.presented!,
      )
    )
      continue;
    sources.push({
      id: `work:${encounterKey(e)}/${h.seq}`,
      author: h.author,
      kind: "npc",
      text: h.text,
      seq: h.seq,
      worldTime: h.at,
      presented: h.presented,
      provenance:
        h.kind === "source-view"
          ? "visible-private-roadmap-review"
          : h.kind === "workspace-view"
            ? "visible-shared-workspace"
            : "visible-work-log",
      sourceRefs: [h.seq],
    });
  }

  if (e.problem && e.problemPresentedSequence !== undefined)
    sources.push({
      id: `problem:${encounterKey(e)}`,
      author: "generator",
      kind: "tutor",
      text: JSON.stringify({
        prompt: e.problem.prompt,
        starter: e.problem.starter,
      }),
      seq: e.problemPresentedSequence,
      worldTime: 0,
      presented: e.problemPresentedSequence,
      provenance: "provided-task-context",
    });
  return sources;
}
function validateProposal(
  r: Roadmap,
  l: LearnerLedger,
  e: Encounter,
  a: Assessment,
) {
  const c = e.problem?.contract;
  if (
    !c ||
    a.encounter !== e.id ||
    !Array.isArray(a.findings) ||
    a.findings.length > 40 ||
    !Number.isInteger(a.sourceVersion) ||
    a.sourceVersion > l.version
  )
    throw Error("Invalid assessment identity/version");
  if (
    new Set(
      a.findings.map(
        (f) => `${f.objectiveId}/${f.depth ?? c.depth}/${f.facet}`,
      ),
    ).size !== a.findings.length ||
    new Set((a.scopeReviews ?? []).map((s) => s.id)).size !==
      (a.scopeReviews ?? []).length
  )
    throw Error("Duplicate facet or scope outcome in one assessment");
  if (
    (a.historicalMappings?.length ?? 0) > 40 ||
    new Set((a.historicalMappings ?? []).map((m) => `${m.scopeId}/${m.facet}`))
      .size !== (a.historicalMappings?.length ?? 0)
  )
    throw Error("Duplicate or excessive historical mappings");
  for (const m of a.historicalMappings ?? []) {
    if (
      !e.problem!.scopeDefinitions?.some((d) => d.id === m.scopeId) ||
      !c.objectiveIds.includes(l.scopes[m.scopeId]?.objectiveId)
    )
      throw Error("Historical mapping is outside this task's source scope");
    validateHistoricalMapping(r, l, m);
  }
  const cutoff =
    a.evidenceCutoffSequence ??
    e.history.reduce((latest, h) => Math.max(latest, h.seq), 0);
  const scopes = e.problem!.scopeDefinitions ?? [];
  for (const f of a.findings) {
    const d = f.depth ?? c.depth,
      def = l.scopes[scopeKey(f.objectiveId, d)];
    if (
      !c.objectiveIds.includes(f.objectiveId) ||
      d !== c.depth ||
      !learningTarget(r, c.track, f.objectiveId) ||
      learningTarget(r, c.track, f.objectiveId)!.target < d ||
      learningTarget(r, c.track, f.objectiveId)!.kind !==
        (c.kind ?? "checkpoint") ||
      !def ||
      !scopes.some((s) => s.id === def.id) ||
      !def.facets.some((p) => p.id === f.facet) ||
      !["independent", "assisted", "unknown", "contradicted"].includes(
        f.outcome,
      ) ||
      !f.rationale?.trim() ||
      (f.execution !== undefined &&
        !["not-run", "executed"].includes(f.execution)) ||
      !Array.isArray(f.evidence) ||
      f.evidence.some((seq) => !Number.isInteger(seq))
    )
      throw Error("Out-of-scope or malformed facet assessment");
    const evidence = e.history.filter((h) => f.evidence.includes(h.seq));
    if (
      new Set(f.evidence).size !== f.evidence.length ||
      evidence.length !== f.evidence.length ||
      evidence.some((h) => h.seq > cutoff)
    )
      throw Error("Evidence reference missing or beyond cutoff");
    if (
      f.outcome !== "unknown" &&
      (!evidence.length ||
        evidence.some(
          (h) =>
            h.author !== "human" ||
            !["edit", "reasoning", "test"].includes(h.kind) ||
            !h.text.trim(),
        ))
    )
      throw Error(
        "Only human-authored technical work can support a learning outcome",
      );
    if (
      f.execution === "executed" &&
      !e.history.some(
        (h) =>
          h.kind === "execution" &&
          e.executions?.some(
            (job) =>
              job.id === h.executionId &&
              job.receipt?.executed &&
              job.status === "finished" &&
              job.revision === h.revision &&
              job.artifactSequences.some((seq) => f.evidence.includes(seq)),
          ) &&
          h.seq <= cutoff &&
          h.refs?.some((ref) =>
            f.evidence.some(
              (seq) => ref === String(seq) || ref === `artifact:${seq}`,
            ),
          ),
      )
    )
      throw Error("No actual execution evidence exists");
    if (f.outcome === "independent") {
      if (
        l.mode === "live" &&
        evidence.some(
          (h) =>
            h.kind === "edit" &&
            (!h.delta || !(h.delta.inserted.trim() || h.delta.removed.trim())),
        )
      )
        throw Error(
          "An unchanged or unattributed supplied artifact is not independently authored code",
        );
      const latest = evidence.reduce((latest, h) => Math.max(latest, h.seq), 0);
      for (const m of assistanceSources(e).filter(
        (m) =>
          m.kind !== "human" &&
          m.kind !== "system" &&
          m.presented !== undefined &&
          m.presented <= latest,
      )) {
        const attribution = a.helpAttributions?.find(
          (h) => h.messageId === m.id,
        );
        if (
          !attribution ||
          !attribution.rationale?.trim() ||
          !Array.isArray(attribution.facets) ||
          attribution.facets.some((id) => typeof id !== "string")
        )
          throw Error("Prior help needs explicit facet attribution");
        if (
          attribution.facets.includes("*") ||
          attribution.facets.includes(f.facet) ||
          attribution.facets.includes(`${f.objectiveId}:${f.facet}`)
        )
          throw Error("A supplied key step cannot certify independent work");
      }
    }
  }
  for (const review of a.scopeReviews ?? []) {
    if (
      !scopes.some((d) => d.id === review.id) ||
      typeof review.completeCoverage !== "boolean" ||
      !review.rationale?.trim()
    )
      throw Error("Invalid scope coverage review");
    const issue = review.definitionIssue;
    if (
      issue &&
      (review.completeCoverage ||
        issue.sourceHash !== r.sourceHash ||
        typeof issue.sourceQuote !== "string" ||
        issue.sourceQuote.trim().length < 20 ||
        issue.sourceQuote.length > 2000 ||
        !r.tracks[e.problem!.contract.track].curriculum.includes(
          issue.sourceQuote,
        ) ||
        typeof issue.missingCriterion !== "string" ||
        !issue.missingCriterion.trim() ||
        issue.missingCriterion.length > 2000)
    )
      throw Error("Invalid source-bound scope definition issue");
    // The provider must not confuse an assisted/unknown learner response with
    // missing criteria and thereby erase legitimate earlier independent proof.
    if (
      !review.completeCoverage &&
      l.verifiedScopes.includes(review.id) &&
      !issue
    )
      throw Error(
        "Verified scope requires an explicit source-bound definition issue; learner assistance alone cannot withdraw its criteria",
      );
  }
  for (const help of a.helpAttributions ?? [])
    if (!assistanceSources(e).some((m) => m.id === help.messageId))
      throw Error("Unknown assistance reference");
}

/** Response arrival order cannot overwrite a judgment of newer human work. */
function supersededEvidence(
  l: LearnerLedger,
  previousIds: string[],
  incoming: LearningEvidence,
) {
  const latestSequence = (ev: LearningEvidence) =>
    ev.artifactSequences.reduce((latest, seq) => Math.max(latest, seq), 0);
  return l.evidence.some((previous) => {
    if (
      !previousIds.includes(previous.id) ||
      !["independent", "contradicted"].includes(previous.outcome)
    )
      return false;
    if (previous.encounter === incoming.encounter)
      return latestSequence(previous) > latestSequence(incoming);
    // Sequence numbers restart per encounter. Without wall times, the new
    // response cannot establish that its work happened after the stored work.
    return (
      !previous.observedAt ||
      !incoming.observedAt ||
      new Date(previous.observedAt).getTime() >
        new Date(incoming.observedAt).getTime()
    );
  });
}
export function applyLearningAssessment(
  r: Roadmap,
  l: LearnerLedger,
  e: Encounter,
  a: Assessment,
  at = new Date().toISOString(),
  provider: Provider | "test-fixture" = "study-mode",
) {
  checkSource(r, l);
  if (!PROVIDERS.includes(e.problem?.provenance ?? ""))
    throw Error("Development tasks cannot award academic evidence");
  if ((l.mode === "test") !== (provider === "test-fixture"))
    throw Error("Test and live evidence cannot mix");
  if (a.provenance !== provider)
    throw Error(
      "Assessment provider provenance does not match trusted adapter",
    );
  const signature = JSON.stringify({
    encounter: encounterKey(e),
    findings: a.findings,
    historicalMappings: a.historicalMappings,
    scopeReviews: a.scopeReviews,
    helpAttributions: a.helpAttributions,
    cutoff: a.evidenceCutoffSequence,
    visitOutcome: a.visitOutcome,
    sourceVersion: a.sourceVersion,
    ...(provider === "chatgpt-handoff" ? { provider } : {}),
  });
  const receipt = l.receipts[a.id];
  if (receipt) {
    if (receipt.signature !== signature)
      throw Error("Conflicting duplicate assessment");
    a.status = "applied";
    return receipt;
  }
  const resolved = l.attempts.find(
    (a) =>
      a.encounter === encounterKey(e) && a.status === "externally-resolved",
  );
  if (resolved) {
    externalResolutionRow(l, resolved);
    throw Error(
      "This attempt was resolved in the imported roadmap; preserve local work without another academic assessment or visit",
    );
  }
  const work = structuredClone(l);
  registerScopes(r, work, e);
  validateProposal(r, work, e, a);
  if (a.visitOutcome === "invalid")
    throw Error(
      "Task/assessment invalid; preserve work for review without a learner failure",
    );
  const technical = e.history.some(
    (h) =>
      h.author === "human" &&
      h.seq <= (a.evidenceCutoffSequence ?? Infinity) &&
      ["edit", "reasoning", "test"].includes(h.kind) &&
      h.text.trim(),
  );
  const attempt =
    work.attempts.find((v) => v.encounter === encounterKey(e)) ??
    (technical ? beginLearningAttempt(r, work, e, at) : undefined);
  if (a.findings.some((f) => f.outcome !== "unknown") && !technical)
    throw Error("No human technical attempt exists");
  if (a.historicalMappings?.length && !technical)
    throw Error(
      "Historical reconciliation needs a real human technical attempt; NPC completion cannot create one",
    );
  if (!technical && (a.visitOutcome === "usable" || a.scopeReviews?.length))
    throw Error(
      "An unanswered task cannot serve a visit or certify scope coverage",
    );
  // Provisional receipt lives only in the transaction clone until every check succeeds.
  work.receipts[a.id] = {
    signature,
    version: work.version + 1,
    evidenceIds: [],
  };
  for (const m of a.historicalMappings ?? []) {
    const { def } = validateHistoricalMapping(r, work, m);
    work.historicalReviews ??= [];
    work.historicalReviews.push({
      ...structuredClone(m),
      assessmentId: a.id,
      reviewedAt: at,
    });
    const cell = learningProgress(work, def.objectiveId),
      key = `D${def.depth}:${m.facet}`;
    const previous = cell.facets[key];
    // Actual later independent/contradictory work outranks an older source observation.
    const actual = previous?.evidenceIds.some((ref) =>
      work.evidence.some(
        (e) =>
          e.id === ref && ["independent", "contradicted"].includes(e.outcome),
      ),
    );
    const imported = previous?.evidenceIds.some((ref) =>
      importedProofValid(r, work, def.objectiveId, def.depth, m.facet, ref),
    );
    if (!actual && !imported) {
      cell.facets[key] = {
        outcome: m.outcome,
        evidenceIds: [
          ...new Set([...(previous?.evidenceIds ?? []), ...m.evidenceIds]),
        ],
        updatedAt: at,
      };
      if (
        m.outcome !== "independent" &&
        !(
          baselineCheckpointValid(r, work, def.objectiveId, def.depth) &&
          progressStatus(cell, def.depth) === "P"
        )
      )
        setProgressStatus(
          cell,
          def.depth,
          progressStatus(cell, def.depth) === "P" &&
            m.outcome === "contradicted"
            ? "R"
            : m.outcome === "unknown" && progressStatus(cell, def.depth) === "U"
              ? "U"
              : "G",
        );
    }
  }

  for (const review of a.scopeReviews ?? [])
    if (review.completeCoverage && !work.verifiedScopes.includes(review.id))
      work.verifiedScopes.push(review.id);
    else if (!review.completeCoverage) {
      work.verifiedScopes = work.verifiedScopes.filter(
        (id) => id !== review.id,
      );
      const d = work.scopes[review.id];
      const progress = learningProgress(work, d.objectiveId);
      if (
        progressStatus(progress, d.depth) === "P" &&
        !baselineCheckpointValid(r, work, d.objectiveId, d.depth)
      )
        setProgressStatus(progress, d.depth, "G");
    }
  const newEvidence: string[] = [];
  for (const finding of a.findings) {
    if (!attempt || !technical) continue;
    const depth: number = finding.depth ?? e.problem!.contract.depth;
    const cell = learningProgress(work, finding.objectiveId),
      key = `D${depth}:${finding.facet}`;
    const record: LearningEvidence = {
      id: allocate(r, work, attempt!.session, "EV"),
      attemptId: attempt!.id,
      encounter: encounterKey(e),
      objectiveId: finding.objectiveId,
      depth,
      facet: finding.facet,
      outcome: finding.outcome,
      artifactSequences: [...finding.evidence],
      helpMessageIds: (a.helpAttributions ?? [])
        .filter(
          (h) =>
            h.facets.includes("*") ||
            h.facets.includes(finding.facet) ||
            h.facets.includes(`${finding.objectiveId}:${finding.facet}`),
        )
        .map((h) => h.messageId),
      at,
      observedAt: (() => {
        const times = e.history
          .filter((h) => finding.evidence.includes(h.seq) && h.wallTime)
          .map((h) => h.wallTime!)
          .filter(
            (t) =>
              Number.isFinite(new Date(t).getTime()) &&
              new Date(t).getTime() <= new Date(at).getTime(),
          )
          .sort();
        return times.at(-1) ?? (work.mode === "test" ? at : undefined);
      })(),
      execution: finding.execution ?? "not-run",
      rationale: finding.rationale,
      provider,
    };
    work.evidence.push(record);
    newEvidence.push(record.id);
    const old = cell.facets[key];
    if (old && supersededEvidence(work, old.evidenceIds, record)) {
      // Preserve the raw receipt without allowing an older result to reopen a
      // repaired checkpoint or recertify a later contradiction.
      continue;
    }
    // Preserve a previously independent facet unless actual contradictory work is identified.
    if (
      !old ||
      old.outcome !== "independent" ||
      finding.outcome === "contradicted"
    )
      cell.facets[key] = {
        outcome: finding.outcome,
        evidenceIds: [...(old?.evidenceIds ?? []), record.id],
        updatedAt: at,
      };
    else old.evidenceIds.push(record.id);
    if (finding.outcome === "assisted" && progressStatus(cell, depth) === "U")
      setProgressStatus(cell, depth, "G");
    if (finding.outcome === "contradicted")
      setProgressStatus(
        cell,
        depth,
        progressStatus(cell, depth) === "P" ? "R" : "G",
      );
  }
  const touched = new Set(
    a.findings.map((f) =>
      scopeKey(f.objectiveId, f.depth ?? e.problem!.contract.depth),
    ),
  );
  for (const review of a.scopeReviews ?? []) touched.add(review.id);
  for (const m of a.historicalMappings ?? []) touched.add(m.scopeId);
  for (const id of touched) {
    const def = work.scopes[id],
      cell = learningProgress(work, def.objectiveId),
      was = progressStatus(cell, def.depth);
    const complete =
      work.verifiedScopes.includes(id) &&
      def.facets.every(
        (f) =>
          cell.facets[`D${def.depth}:${f.id}`]?.outcome === "independent" &&
          cell.facets[`D${def.depth}:${f.id}`].evidenceIds.some((ref) =>
            independentProofValid(
              r,
              work,
              def.objectiveId,
              def.depth,
              f.id,
              ref,
            ),
          ),
      );
    if (complete) {
      setProgressStatus(cell, def.depth, "P");
      cell.proofs[String(def.depth)] = [
        ...new Set([
          ...(cell.proofs[String(def.depth)] ?? []),
          ...def.facets.flatMap((f) =>
            cell.facets[`D${def.depth}:${f.id}`].evidenceIds.filter((ref) =>
              independentProofValid(
                r,
                work,
                def.objectiveId,
                def.depth,
                f.id,
                ref,
              ),
            ),
          ),
        ]),
      ];
      const reviewId = reviewKey(def.objectiveId, def.depth),
        review = work.reviews[reviewId];
      const delayedEvidence =
        review && attempt
          ? work.evidence.filter(
              (ev) =>
                ev.attemptId === attempt.id &&
                ev.objectiveId === def.objectiveId &&
                ev.depth === def.depth &&
                ev.outcome === "independent" &&
                ev.observedAt &&
                isDelayedReview(review, ev.observedAt, attempt.session) &&
                independentProofValid(
                  r,
                  work,
                  def.objectiveId,
                  def.depth,
                  ev.facet,
                  ev.id,
                ),
            )
          : [];
      const proofRefs = def.facets.flatMap((f) =>
        cell.facets[`D${def.depth}:${f.id}`].evidenceIds.filter((ref) =>
          independentProofValid(r, work, def.objectiveId, def.depth, f.id, ref),
        ),
      );
      const actualTimes = work.evidence
        .filter((ev) => proofRefs.includes(ev.id) && ev.observedAt)
        .map((ev) => ev.observedAt!)
        .sort();
      const sourceDates = historicalRecords(r, def.objectiveId, def.depth)
        .filter((row) => proofRefs.includes(row.id))
        .map((row) => row.date)
        .sort();
      const exactObservation = actualTimes.at(-1),
        sourceDate = sourceDates.at(-1);
      const sourceOnlyDate =
        sourceDate &&
        (!exactObservation || sourceDate > localDate(exactObservation))
          ? sourceDate
          : undefined;

      if (
        was !== "P" &&
        (!review ||
          (baselineCheckpointRefs(r, def.objectiveId, def.depth).length > 0 &&
            !baselineCheckpointValid(r, work, def.objectiveId, def.depth) &&
            review.stage === 0 &&
            review.verifiedReviews === 0))
      )
        work.reviews[reviewId] = {
          objectiveId: def.objectiveId,
          depth: def.depth,
          due: addDays(
            sourceOnlyDate ??
              (exactObservation ? localDate(exactObservation) : localDate(at)),
            3,
          ),
          stage: 0,
          lastIndependentDate: sourceOnlyDate,
          lastIndependentAt: sourceOnlyDate
            ? undefined
            : (work.evidence
                .filter(
                  (ev) =>
                    newEvidence.includes(ev.id) &&
                    ev.objectiveId === def.objectiveId &&
                    ev.outcome === "independent",
                )
                .map((ev) => ev.observedAt)
                .filter((t): t is string => !!t)
                .sort()
                .at(-1) ?? exactObservation),
          sequence: attempt?.session,
          verifiedReviews: 0,
        };
      else if (
        def.facets.every((f) =>
          delayedEvidence.some(
            (ev) =>
              ev.attemptId === attempt?.id &&
              ev.objectiveId === def.objectiveId &&
              ev.depth === def.depth &&
              ev.facet === f.id &&
              ev.outcome === "independent",
          ),
        ) &&
        delayedEvidence.some((ev) => newEvidence.includes(ev.id)) &&
        e.problem!.contract.review &&
        review &&
        attempt &&
        delayedEvidence.length
      ) {
        const previousReview = structuredClone(review);
        review.stage = Math.min(2, review.stage + 1);
        review.verifiedReviews++;
        review.lastIndependentAt = delayedEvidence
          .map((ev) => ev.observedAt)
          .filter((t): t is string => !!t)
          .sort()
          .at(-1);
        delete review.lastIndependentDate;
        review.sequence = attempt.session;
        review.due = addDays(
          localDate(review.lastIndependentAt!),
          [3, 7, 21][review.stage],
        );
        (work.retentionHistory ??= []).push({
          scopeId: reviewId,
          assessmentId: a.id,
          attemptId: attempt.id,
          at,
          evidenceIds: delayedEvidence.map((ev) => ev.id),
          before: previousReview,
          after: structuredClone(review),
        });
      }
    }
  }
  if (attempt && attempt.status !== "served" && a.visitOutcome === "usable") {
    const equivalent = work.attempts.some(
      (other) =>
        other !== attempt &&
        other.status === "served" &&
        attemptRoot(work, other) === attemptRoot(work, attempt),
    );
    attempt.status = "served";
    attempt.endedAt = at;
    if (!equivalent) {
      const c = attempt.contract,
        s = work.tracks[c.track];
      if (!c.review) {
        const visited = topic(c.objectiveIds[0]);
        if (roleFocused(focusOf(work)) && c.track === "PE") {
          // Focused breadth skips deferred topics without dropping them.
          const index = s.queue.indexOf(visited);
          if (index >= 0) s.queue.splice(index, 1);
          const required = incompleteTopics(r, work, c.track, s.tier);
          if (!s.queue.some((name) => required.includes(name))) {
            s.phase = "REPAIR_VERIFY";
            s.lap++;
            s.queue = required;
          }
        } else {
          if (s.queue[0] !== visited)
            throw Error("Visit would violate breadth order");
          s.queue.shift();
        }
        if (
          (!roleFocused(focusOf(work)) || c.track !== "PE") &&
          !s.queue.length
        ) {
          s.phase = "REPAIR_VERIFY";
          s.lap++;
          s.queue = incompleteTopics(r, work, c.track, s.tier);
        }
      }
      work.cycle++;
      const root = attemptRoot(work, attempt);
      work.continuations = work.continuations.filter(
        (c) =>
          attemptRoot(
            work,
            work.attempts.find((a) => a.id === c.attemptId)!,
          ) !== root,
      );
    }
    // A late ancestor can serve the family before its replacement is answered.
    // Retain the replacement's work, but release the already consumed visit.
    const root = attemptRoot(work, attempt);
    for (const sibling of work.attempts)
      if (
        sibling !== attempt &&
        ["in-progress", "suspended"].includes(sibling.status) &&
        attemptRoot(work, sibling) === root
      )
        sibling.status = "interrupted";
  }
  work.version++;
  reconcileGates(r, work);
  const result = { signature, version: work.version, evidenceIds: newEvidence };
  work.receipts[a.id] = result;
  Object.assign(l, work);
  a.status = "applied";
  return result;
}
