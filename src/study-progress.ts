import { effectiveTarget, studyFocus } from "./career-profile";
import type { KnowledgeGapRecord } from "./knowledge-probe";
import type { LearningEvidence } from "./learning-model";
import type { Roadmap, StudyState, Track } from "./model";

type StudyCheckpointStatus =
  "verified" | "gap" | "unassessed" | "partial" | "recheck";

interface StudyCheckpoint {
  id: string;
  /** The curriculum wording; no generated claim about the learner's ability. */
  scope: string;
  label: string;
  status: StudyCheckpointStatus;
  /** Current-depth terminal observations, separate from formal credit. */
  gaps: { id: string; description: string; statement: string }[];
  /** Saved assessment facts supporting the current facet outcomes, if any. */
  evidence: {
    id: string;
    facet: string;
    outcome: string;
    rationale: string;
    at: string;
  }[];
  sourceRefs: string;
}

/** Shared requirements for the compact progress summary and the detailed workspace map. */
function trackRequirements(
  r: Roadmap,
  s: StudyState,
  track: Track,
  tierOverride?: number,
) {
  const live = s.profile === "live";
  const state = live ? s.learner?.tracks[track] : undefined;
  // A review can display its issued depth without changing the track's tier.
  const tier = tierOverride ?? state?.tier ?? r.tracks[track].tier;
  const objectives = r.tracks[track].objectives.filter(
    (o) => effectiveTarget(o, studyFocus(s)) >= tier,
  );
  return { live, state, tier, objectives };
}

/** The progress summary needs counts, not a reconstruction of every facet and evidence row. */
export function studyTrackSummary(r: Roadmap, s: StudyState, track: Track) {
  const { live, state, tier, objectives } = trackRequirements(r, s, track);
  return {
    tier,
    passed: objectives.filter(
      (o) =>
        (live
          ? s.learner?.cells[o.id]?.states[tier - 1]
          : o.cells[tier - 1]) === "P",
    ).length,
    total: objectives.length,
    queue: state?.queue ?? s.queues[track],
  };
}

/** Current-tier requirements only; practice observes imported credit, never adds it. */
export function studyTrackProgress(
  r: Roadmap,
  s: StudyState,
  track: Track,
  tierOverride?: number,
) {
  const { live, state, tier, objectives } = trackRequirements(
    r,
    s,
    track,
    tierOverride,
  );
  // Scan retained history once per view, rather than once per checkpoint.
  // These indexes are local so edits, withdrawals and profile changes are
  // reflected immediately without maintaining another saved/cache version.
  const gapsByObjective = new Map<string, KnowledgeGapRecord[]>();
  for (const gap of s.knowledgeGaps ?? []) {
    if (gap.resolved || gap.track !== track || gap.depth !== tier) continue;
    for (const id of new Set(gap.objectiveIds)) {
      const rows = gapsByObjective.get(id) ?? [];
      rows.push(gap);
      gapsByObjective.set(id, rows);
    }
  }
  const evidenceByObjective = new Map<string, LearningEvidence[]>();
  for (const entry of live ? (s.learner?.evidence ?? []) : []) {
    if (entry.depth !== tier) continue;
    const rows = evidenceByObjective.get(entry.objectiveId) ?? [];
    rows.push(entry);
    evidenceByObjective.set(entry.objectiveId, rows);
  }
  const checkpoints: StudyCheckpoint[] = objectives.map((o) => {
    const cell = live ? s.learner?.cells[o.id] : undefined;
    const status = live ? cell?.states[tier - 1] : o.cells[tier - 1];
    const facetPrefix = `D${tier}:`;
    const facets = new Map(
      Object.entries(cell?.facets ?? {})
        .filter(([key]) => key.startsWith(facetPrefix))
        .map(([key, facet]) => [key.slice(facetPrefix.length), facet]),
    );
    const gaps = (gapsByObjective.get(o.id) ?? []).map((gap) => ({
      id: gap.id,
      description: gap.facet.description,
      statement: gap.statement,
    }));
    const contradicted = [...facets].some(
      ([, facet]) => facet.outcome === "contradicted",
    );
    const partial = [...facets].some(([, facet]) =>
      ["independent", "assisted"].includes(facet.outcome),
    );
    const evidence = (evidenceByObjective.get(o.id) ?? [])
      .filter((e) => {
        const facet = facets.get(e.facet);
        return facet?.outcome === e.outcome && facet.evidenceIds.includes(e.id);
      })
      .map(({ id, facet, outcome, rationale, at }) => ({
        id,
        facet,
        outcome,
        rationale,
        at,
      }));
    return {
      id: o.id,
      scope: o.scope,
      label: o.scope,
      // A probe observation never grants or withdraws verified curriculum
      // credit. Retain an open observation alongside P until assessment.
      status:
        status === "P"
          ? "verified"
          : status === "R"
            ? "recheck"
            : gaps.length || contradicted
              ? "gap"
              : status === "G" || partial
                ? "partial"
                : "unassessed",
      gaps,
      evidence,
      sourceRefs: live ? (cell?.sourceRefs ?? o.refs) : o.refs,
    };
  });
  const checkpointsByTopic = new Map<string, StudyCheckpoint[]>();
  for (const checkpoint of checkpoints) {
    const id = checkpoint.id.split(":")[1].split(".")[0];
    const members = checkpointsByTopic.get(id) ?? [];
    members.push(checkpoint);
    checkpointsByTopic.set(id, members);
  }
  const topics = [...checkpointsByTopic].map(([id, members]) => ({
    id,
    name: r.tracks[track].topics[id] ?? id,
    passed: members.filter((o) => o.status === "verified").length,
    total: members.length,
    checkpoints: members,
  }));
  return {
    tier,
    passed: checkpoints.filter((o) => o.status === "verified").length,
    total: objectives.length,
    topics,
    queue: state?.queue ?? s.queues[track],
  };
}
