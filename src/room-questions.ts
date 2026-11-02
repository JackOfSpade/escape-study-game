import { fnv1a } from "./hash";
import type { Encounter, Game, Problem, Roadmap } from "./model";
import { devProblem } from "./practice-problem";
import { recordSpawn, spawnContract } from "./topic-spawn";
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
/** Local practice requires no AI connection. Live questions are generated on request. */
export function preparePracticeRooms(g: Game, roadmap: Roadmap) {
  if (g.study.profile !== "development") return;
  for (const e of Object.values(g.encounters)) {
    if (!e.questionRoom || e.problem || e.state === "consumed") continue;
    try {
      // Room questions have their own seeded stream; spawning and NPC decisions
      // must not change merely because a question was prepared.
      const rng = fnv1a(e.questionRoom, g.seed);
      // Rooms rotate topics: the formal visit stays reachable while other
      // rooms practise cooled topics, gaps first, for variety and recall.
      const contract = spawnContract(roadmap, g.study);
      assignRoomProblem(g, e, devProblem({ ...g, rng }, roadmap, contract));
      recordSpawn(g.study, contract, e.questionRoom, g.time);
    } catch {
      // A curriculum gate can have no eligible next task. Do not invent one.
      return;
    }
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
