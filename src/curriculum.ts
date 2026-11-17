import { ASSESSMENT_HELP_GUIDANCE } from "../scripts/lib/study-question-policy.mjs";
import { adoptedSourceText } from "./imported-proof";
import { effectiveTarget, roleFocused, studyFocus } from "./career-profile";
import {
  assistanceSources,
  beginLearningAttempt,
  eligibleLearning,
  encounterKey,
  initialLearner,
  localDate,
} from "./learner";
import type { LearnerLedger } from "./learning-model";
import { servedLearningAttempts, studyRatioPosition } from "./learning-model";
import {
  type Assessment,
  type Contract,
  type Encounter,
  type Roadmap,
  type StudyState,
  type Track,
} from "./model";
import { workspaceAt } from "./workspace-history";
export function syncLearningView(s: StudyState) {
  if (s.profile !== "live" || !s.learner) return;
  const l = s.learner;
  s.version = l.version;
  s.cycle = l.cycle;
  s.cycleOffset = l.cycleOffset ?? 0;
  s.studyTurnPosition = l.studyTurnPosition;
  s.queues = { PY: [...l.tracks.PY.queue], PE: [...l.tracks.PE.queue] };
  s.phases = { PY: l.tracks.PY.phase, PE: l.tracks.PE.phase };
  s.session = l.currentSession;
  s.visits = servedLearningAttempts(l).map((a) => ({
    id: a.id,
    contract: a.contract,
    encounter: a.encounter,
    at: a.endedAt ?? a.startedAt,
  }));
}
export function initialStudy(
  r: Roadmap,
  profile: "development" | "live" = "development",
): StudyState {
  return {
    profile,
    learner: initialLearner(r),
    version: 0,
    cycle: 0,
    cycleOffset: r.resume?.ratioPosition ?? 0,
    queues: { PY: [...r.tracks.PY.remaining], PE: [...r.tracks.PE.remaining] },
    phases: { PY: r.tracks.PY.phase, PE: r.tracks.PE.phase },
    reviewsServed: [],
    visits: [],
    assessments: [],
    archives: [],
  };
}
export function eligible(
  r: Roadmap,
  s: StudyState,
  today = localDate(),
): Contract {
  if (s.profile === "live") {
    s.learner ??= initialLearner(r);
    return eligibleLearning(r, s.learner, `${today}T16:00:00Z`);
  }
  if (s.pending) return structuredClone(s.pending.contract);
  const track: Track = (["PY", "PE", "PE"] as const)[studyRatioPosition(s)],
    t = r.tracks[track];
  // One bounded review on a track turn, followed by breadth work before another review.
  const last = s.visits.filter((v) => v.contract.track === track).at(-1);
  // A role focus (explicitly activated) filters development work the same way
  // as the live scheduler; undefined/full keeps the original behavior.
  const focus = studyFocus(s),
    focused = roleFocused(focus),
    required = (o: (typeof t.objectives)[number]) =>
      !focused || effectiveTarget(o, focus) >= 1;
  const due = last?.contract.review
    ? undefined
    : t.objectives
        .filter(
          (o) =>
            o.reviewDue &&
            o.reviewDue <= today &&
            !s.reviewsServed.includes(o.id) &&
            required(o),
        )
        .sort((a, b) => a.reviewDue!.localeCompare(b.reviewDue!))[0];
  const open = (name: string) =>
    t.objectives.some(
      (o) =>
        o.id.startsWith(`${track}:${name}.`) &&
        o.cells[0] !== "P" &&
        required(o),
    );
  const topic = focused
    ? (s.queues[track].find(open) ??
      t.rotation.find(open) ??
      s.queues[track][0] ??
      t.rotation[0])
    : (s.queues[track][0] ?? t.rotation[0]);
  const objects = due
    ? [due]
    : t.objectives.filter(
        (o) =>
          o.id.startsWith(`${track}:${topic}.`) &&
          o.cells[0] !== "P" &&
          required(o),
      );
  const selected = objects.slice(0, 1);
  return {
    id: `contract-${s.version}-${track}-${selected[0]?.id}`,
    track,
    objectiveIds: selected.map((o) => o.id),
    scopes: selected.map((o) => o.scope),
    depth: 1,
    phase: s.phases[track],
    review: !!due,
    ledgerVersion: s.version,
    priorEvidence: selected.map((o) => o.refs),
  };
}
export function beginVisit(r: Roadmap, s: StudyState, e: Encounter) {
  // A variety practice terminal is never the scheduled visit.
  if (e.problem?.contract.practice) return;
  if (s.profile === "live") {
    s.learner ??= initialLearner(r);
    beginLearningAttempt(r, s.learner, e);
    syncLearningView(s);
    return;
  }
  const key = encounterKey(e);
  if (s.visits.some((v) => v.encounter === key)) return;
  const c = e.problem?.contract;
  if (!c) throw Error("No issued problem");
  const next = eligible(r, s);
  if (
    JSON.stringify(c.objectiveIds) !== JSON.stringify(next.objectiveIds) ||
    c.track !== next.track
  )
    throw Error("Encounter is not the scheduled study visit.");
  if (s.pending && s.pending.encounter !== key)
    throw Error(
      "Unfinished study visit remains bound to its original terminal.",
    );
  s.session ??= "DEVELOPMENT";
  s.pending = { encounter: key, contract: c };
}
/** Called only for a newly completed human question, before visit bookkeeping.
 * Saved off-track tasks remain valid, but cannot consume an owed track turn.
 * Once initialized, this position is independent of delayed academic assessments.
 * Legacy saves start at their existing visit-based position without replaying history.
 */
export function countStudyTurn(s: StudyState, e: Encounter) {
  const c = e.problem?.contract;
  if (!c || e.studyTurnRecorded) return;
  const ledger = s.profile === "live" ? s.learner : s;
  if (!ledger) return;
  e.studyTurnRecorded = true;
  const position = studyRatioPosition(ledger);
  ledger.studyTurnPosition =
    c.track === (["PY", "PE", "PE"] as const)[position]
      ? (position + 1) % 3
      : position;
  if (s.profile === "live") syncLearningView(s);
}
export function finishVisit(
  r: Roadmap,
  s: StudyState,
  e: Encounter,
  at = new Date().toISOString(),
) {
  if (s.profile === "live") return; // Live study records its visits in the learner ledger.
  const key = encounterKey(e);
  if (!s.pending || s.pending.encounter !== key) return;
  const c = s.pending.contract;
  if (s.visits.some((v) => v.encounter === key)) return;
  s.visits.push({
    id: `${s.session}-VISIT-${String(s.visits.length + 1).padStart(3, "0")}`,
    contract: c,
    encounter: key,
    at,
  });
  if (c.review) s.reviewsServed.push(...c.objectiveIds);
  else {
    s.queues[c.track].shift();
    if (!s.queues[c.track].length) {
      s.phases[c.track] = "REPAIR_VERIFY";
      s.queues[c.track] = [...r.tracks[c.track].rotation];
    }
  }
  s.cycle++;
  s.version++;
  delete s.pending;
}
export function validateAssessment(r: Roadmap, e: Encounter, a: Assessment) {
  if (a.encounter !== e.id || !e.problem || a.findings.length > 40)
    throw Error("Invalid assessment identity");
  for (const f of a.findings) {
    if (
      !e.problem.contract.objectiveIds.includes(f.objectiveId) ||
      !r.tracks[e.problem.contract.track].objectives.some(
        (o) => o.id === f.objectiveId,
      )
    )
      throw Error("Unknown or out-of-scope objective");
    if (
      !f.facet ||
      !["independent", "assisted", "unknown"].includes(f.outcome) ||
      !f.rationale
    )
      throw Error("Malformed facet");
    const evidence = e.history.filter((h) => f.evidence.includes(h.seq)),
      latestEvidence = evidence.reduce(
        (latest, h) => Math.max(latest, h.seq),
        -Infinity,
      );
    if (
      f.outcome === "independent" &&
      (!evidence.length ||
        evidence.some(
          (h) =>
            h.author !== "human" ||
            !["edit", "reasoning", "test"].includes(h.kind),
        ))
    )
      throw Error(
        "Independent evidence must be human-authored technical artifacts",
      );
    // Any earlier supplied solution is conservatively unresolved until a facet-aware reviewer checks dependencies.
    if (
      f.outcome === "independent" &&
      [...(e.group ?? []), ...e.tutor].some(
        (m) =>
          m.kind !== "human" &&
          m.kind !== "system" &&
          m.presented !== undefined &&
          m.presented < latestEvidence,
      )
    )
      throw Error("Prior help requires explicit dependency review");
  }
  return true;
}
export function evidencePacket(
  e: Encounter,
  r: Roadmap,
  cutoff = Infinity,
  l?: LearnerLedger,
  // Assessments retain historical artifact-based IDs. Their original event
  // boundary may also include a submission event just after the last artifact.
  acceptedCutoff = cutoff,
) {
  return {
    encounter: e.id,
    assessmentPolicy:
      "A displayed assessment may already have a formal attempt ID without any human answer. Issuance, reading and assistant work do not serve an academic visit or establish mastery. Judge only human technical artifacts at or before the captured cutoff. Without such artifacts return unresolved and unknown findings, without scope reviews or historical mappings. A usable visit requires actual human technical work.",
    problem: e.problem,
    accepted: e.submissions.find(
      (s) => s.id === e.accepted && s.seq <= acceptedCutoff,
    ),
    workspace: workspaceAt(e, cutoff),
    workspaceBase: e.workspaceBase ?? e.problem?.starter ?? "",
    evidenceCutoffSequence:
      cutoff === Infinity
        ? e.history.reduce((latest, h) => Math.max(latest, h.seq), 0)
        : cutoff,
    history: e.history.filter(
      (h) =>
        h.seq <= cutoff &&
        (!["chat", "tutor", "npc-proposal"].includes(h.kind) ||
          (h.presented !== undefined && h.presented <= cutoff)),
    ),
    group: (e.group ?? []).filter(
      (m) => m.presented !== undefined && m.presented <= cutoff,
    ),
    tutor: e.tutor.filter(
      (m) => m.presented !== undefined && m.presented <= cutoff,
    ),
    prior: e.problem?.contract.priorEvidence,
    historicalSourceContext: e.problem
      ? r.tracks[e.problem.contract.track].progress
      : undefined,
    importedSourceContext:
      l && e.problem
        ? {
            canonicalHash: l.roadmapAdoptions?.at(-1)?.canonicalHash,
            adoptedAt: l.roadmapAdoptions?.at(-1)?.adoptedAt,
            progress: adoptedSourceText(l)
              ?.split(`<!-- BEGIN ${e.problem.contract.track}_PROGRESS -->`)[1]
              ?.split(`<!-- END ${e.problem.contract.track}_PROGRESS -->`)[0],
          }
        : undefined,
    sourceHash: r.sourceHash,
    externalAttemptContext: (() => {
      const resolution = l?.attempts.find(
        (a) => a.encounter === encounterKey(e),
      )?.externalResolution;
      return resolution
        ? {
            ...resolution,
            instruction:
              "This formal attempt was resolved in an imported roadmap. Review actual new human work after humanCutoff, and any earlier technical artifacts absent from assessedHumanSequences. Do not present source-covered artifacts as a new demonstration. Keep assistance attribution and original source evidence. Findings are retained for fresh scoped verification, without a duplicate primary visit or automatic certification of the closed task.",
          }
        : undefined;
    })(),
    assessmentCriteria: e.problem
      ? r.tracks[e.problem.contract.track].curriculum
      : undefined,
    assistanceSources: assistanceSources(e).filter(
      (m) => m.presented !== undefined && m.presented <= cutoff,
    ),
    scopePolicy:
      "Every earlier visible nonhuman assistance source requires a helpAttributions entry with its exact messageId and a rationale, even when unrelated or rejected. Use facets:[] when it supplied no used key step; never omit the source or count rejected assistant embellishment as human authorship. Full checkpoint passes require independent complete-scope evidence. Assistant work and supplied solutions never prove personal mastery. No execution claimed without actual runner output. scopeReviews.completeCoverage reviews whether the registered facet criteria fully cover the curriculum objective at the stated depth; it does NOT describe whether the current learner response is independent, correct or complete. Report those outcomes in findings. An assisted/unknown/incorrect response does not by itself make valid criteria incomplete. Withdrawing an already verified definition requires definitionIssue:{sourceHash,sourceQuote,missingCriterion}, with this exact sourceHash, an exact 20–2000-character quote from assessmentCriteria and a concrete missing criterion. Do not invent a definition issue to express a learner gap. " +
      ASSESSMENT_HELP_GUIDANCE,
  };
}
