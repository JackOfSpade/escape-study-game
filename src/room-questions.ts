import type { Encounter, Game, Problem } from "./model";
import { adoptQuestionPacing } from "./field-pacing";

export function roomEncounters(g: Game, e: Encounter) {
  return e.questionRoom
    ? Object.values(g.encounters).filter(
        (peer) =>
          peer.floor === e.floor && peer.questionRoom === e.questionRoom,
      )
    : [e];
}
/** Copy only the prompt contract. Never share mutable drafts, tutor history or completion. */
export function assignRoomProblem(
  g: Game,
  source: Encounter,
  problem: Problem,
) {
  adoptQuestionPacing(g, source.floor, problem);
  for (const e of roomEncounters(g, source)) {
    if (e.problem || e.state === "consumed") continue;
    e.problem = structuredClone(problem);
    delete e.error;
    if (!e.workspace && e.revision === 0) e.workspace = problem.starter;
    e.state = "in-progress";
  }
}
/**
 * Earlier runs in which the human started this terminal's scheduled question
 * and never completed it. A new run never resumes a lock, so the question is
 * asked again from the start; facets established in those conversations are
 * carried in study state (`knowledgeEstablished`) and not probed again.
 */
export function unfinishedEarlierVisits(
  g: Game,
  e: Encounter,
): { runs: number; established: number } {
  const c = e.problem?.contract;
  if (!c || c.practice || e.state === "consumed")
    return { runs: 0, established: 0 };
  const earlier = g.study.archives.filter((a) => {
    const prior = a.problem?.contract;
    return (
      (a.runId ?? "legacy") !== g.id &&
      a.state !== "consumed" &&
      !!prior &&
      !prior.practice &&
      prior.track === c.track &&
      prior.depth === c.depth &&
      JSON.stringify(prior.objectiveIds) === JSON.stringify(c.objectiveIds) &&
      a.tutor.some((m) => m.kind === "human")
    );
  });
  const refs = new Set(earlier.map((a) => `${a.runId ?? "legacy"}/${a.id}`));
  return {
    runs: new Set(earlier.map((a) => a.runId ?? "legacy")).size,
    established: (g.study.knowledgeEstablished ?? []).filter((r) =>
      refs.has(r.encounter),
    ).length,
  };
}
