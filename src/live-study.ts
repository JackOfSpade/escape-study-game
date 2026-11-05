import { activateCareerFocus } from "./career-profile";
import { initialLearner } from "./learner";
import { initialStudy } from "./curriculum";
import type { Game, Roadmap } from "./model";

/**
 * Questions only come from Claude, so a run saved on the old practice profile
 * moves to the live one. Everything the learner earned carries over: the ledger,
 * evidence, assessments, knowledge gaps and archives. Only the practice
 * scheduler's own queue and visits restart, and practice questions that were
 * never finished are dropped so Claude asks them afresh.
 */
export function moveToLiveStudy(g: Game, r: Roadmap) {
  if (g.study.profile === "live") return false;
  const old = g.study;
  const scheduler = initialStudy(r, "live");
  const next: Game["study"] = {
    ...old,
    profile: "live",
    learner: old.learner ?? initialLearner(r),
    cycle: scheduler.cycle,
    cycleOffset: scheduler.cycleOffset,
    queues: scheduler.queues,
    phases: scheduler.phases,
    reviewsServed: [],
    visits: [],
  };
  delete next.pending;
  delete next.preparedQuestion;
  activateCareerFocus(r, next, old.careerFocus ?? "product-feature-owner");
  g.study = next;
  for (const e of Object.values(g.encounters)) {
    if (e.problem?.provenance !== "development" || e.state === "consumed")
      continue;
    for (const key of [
      "problem",
      "error",
      "owner",
      "accepted",
      "probe",
      "problemPresentedSequence",
      "problemPresentedAt",
      "workspaceBase",
      "chatDraft",
      "humanEngaged",
      "npcWork",
      "executions",
      "proposals",
      "materializations",
      "catchups",
      "tutorRequests",
      "groupRequests",
      "simulatedOutcome",
      "outcomeInspection",
    ] as const)
      delete e[key];
    e.state = "available";
    e.workspace = "";
    e.revision = 0;
    e.history = [];
    e.group = [];
    e.tutor = [];
    e.submissions = [];
    e.contributors = [];
    e.npcProgress = 0;
    e.chatCursor = 0;
  }
  return true;
}
