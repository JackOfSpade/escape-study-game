// Controlled source corrections and grades; never real learner results.
import assert from "node:assert/strict";
import { closeLearningSession, eligibleLearning } from "../../src/learner";
import type { ReviewRecord } from "../../src/learning-model";
import type { StudyRecord } from "../../src/model";
import type {
  RoadmapReconciliation,
  RoadmapReconciliationPayload,
} from "../../src/roadmap-adoption-types";
import { prepareRoadmapExport } from "../../src/roadmap-export";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../../src/roadmap-identifiers";
import { inspectMergedDocument } from "../../src/roadmap-structure";
import { createGame } from "./record";
import { roadmap as r } from "./baseline-correction";
import { gradeScheduled, laterId, laterScope } from "./later-baseline-evidence";
export { laterId, laterScope, r };
export function recordTargetReview(g: StudyRecord, at: string) {
  closeLearningSession(g.study.learner!);
  for (let n = 0; n < 100; n++) {
    const l = g.study.learner!,
      c = eligibleLearning(r, l, at);
    const target =
      c.objectiveIds.includes(laterId) && c.depth === 1 && c.review;
    const result = gradeScheduled(
      g,
      "independent",
      at,
      Object.keys(g.encounters).length,
    );
    if (target) return result;
  }
  throw Error("Fixture never scheduled the target review");
}
export function retentionFixture(count = 2) {
  const g = createGame(73, r);
  g.study.profile = "live";
  const times = [
    "2026-10-17T16:00:00Z",
    "2026-10-26T16:00:00Z",
    "2026-11-20T16:00:00Z",
  ];
  for (let n = 0; n < count; n++) recordTargetReview(g, times[n]);
  const events = g.study.learner!.retentionHistory!.filter(
    (e) => e.scopeId === laterScope,
  );
  assert.equal(events.length, count);
  return { g, events };
}
export async function retentionCorrection(
  g: StudyRecord,
  tasks: string[],
  expected: ReviewRecord,
) {
  const l = g.study.learner!;
  const local = await prepareRoadmapExport(r, l, g.study.roadmapExport);
  g.study.roadmapExport = local;
  const copy = structuredClone(l);
  copy.version++;
  copy.reviews[laterScope] = structuredClone(expected);
  let raw = (await prepareRoadmapExport(r, copy, local)).content;
  const rows = inspectMergedDocument(raw).rows;
  for (const task of tasks) {
    const found = [...rows].find(
      ([key]) =>
        key.startsWith("PY_PROGRESS/0.5.1 Attempt status register/") &&
        key.endsWith("/" + task),
    );
    assert.ok(found);
    const row = found[1],
      c = row
        .split("|")
        .slice(1, -1)
        .map((s) => s.trim());
    c[3] =
      "INVALIDATED; synthetic source correction withdraws this review only";
    raw = raw.replace(row, `| ${c.join(" | ")} |`);
  }
  const decisionId = `DEC${String(readIdentifierCounters(raw, false).counters.nextDecision).padStart(4, "0")}`;
  const excerpt =
    "Synthetic source review found supplied reasoning in these delayed checks; withdraw only their retention credit and preserve original observations and all unaffected reviews.";
  const decision = `| ${decisionId} | 2026-11-21 / synthetic source audit | ASSESSMENT_CORRECTION | ${tasks.map((id) => `PY:${id}`).join(", ")} | ${excerpt} | Preserve raw evidence and exact historical transactions | ACTIVE |`;
  const at = raw.indexOf("### S0.4 Merged session history");
  raw = raw.slice(0, at).trimEnd() + "\n" + decision + "\n\n" + raw.slice(at);
  raw = projectIdentifierCounters(
    raw,
    readIdentifierCounters(raw, false).counters,
  );
  function proposal(p: RoadmapReconciliationPayload): RoadmapReconciliation {
    const localRows = inspectMergedDocument(p.local).rows;
    return {
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: p.candidate,
      definitions: [],
      mappings: [],
      completeScopes: [],
      retentionUpdates: [
        {
          scopeId: laterScope,
          rationale:
            "Recompute delayed-review dates/counts from exact retained valid transactions",
        },
      ],
      attemptUpdates: tasks.map((attemptId) => ({
        track: "PY",
        attemptId,
        rationale:
          "Explicit source-authorized withdrawal of the recorded delayed review",
        correctionDecision: { id: decisionId, excerpt },
      })),
      decisions: [...inspectMergedDocument(p.candidate).rows]
        .filter(
          ([key, row]) => localRows.has(key) && localRows.get(key) !== row,
        )
        .map(([key]) => ({
          key,
          choice: "incoming",
          rationale:
            "Select exact reviewed incoming schedule and source-authorized task withdrawal",
        })),
      rationale:
        "Controlled retention correction; no new observation, failure or study visit",
    };
  }
  return { raw, proposal, local };
}
