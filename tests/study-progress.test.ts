import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { activateCareerFocus } from "../src/career-profile";
import { initialStudy } from "../src/curriculum";
import type { KnowledgeGapRecord } from "../src/knowledge-probe";
import type { LearningEvidence } from "../src/learning-model";
import type { Roadmap, StudyState } from "../src/model";
import { studyTrackProgress } from "../src/study-progress";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

const checkpoint = (s: StudyState, id = "PE:T10.2", tier?: number) =>
  studyTrackProgress(r, s, "PE", tier)
    .topics.flatMap((topic) => topic.checkpoints)
    .find((entry) => entry.id === id)!;

function gap(
  id: string,
  depth = 1,
  objectiveId = "PE:T10.2",
): KnowledgeGapRecord {
  return {
    id,
    encounter: "synthetic/gap",
    runId: "synthetic",
    track: "PE",
    objectiveIds: [objectiveId],
    depth,
    facet: { id, description: `Recorded gap ${id}` },
    statement: "I do not know this yet.",
    requestId: "synthetic-request",
    provider: "test-fixture",
    at: "2026-10-25T12:00:00Z",
  };
}

test("active profile counts both numerator and denominator within the current tier", () => {
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  assert.deepEqual(
    [
      studyTrackProgress(r, s, "PE").passed,
      studyTrackProgress(r, s, "PE").total,
    ],
    [5, 51],
  );
  assert.equal(studyTrackProgress(r, s, "PY").total, 80);
  s.learner!.tracks.PE.tier = 2;
  assert.equal(studyTrackProgress(r, s, "PE").passed, 0);
  s.learner!.cells["PE:T10.1"].states[1] = "P";
  assert.equal(studyTrackProgress(r, s, "PE").passed, 1);
  activateCareerFocus(r, s, "full");
  assert.equal(studyTrackProgress(r, s, "PE").total, 112);
  assert.equal(
    studyTrackProgress(r, s, "PE").topics.reduce(
      (total, topic) => total + topic.checkpoints.length,
      0,
    ),
    112,
  );
});

test("completed topic checkpoints stay visible after the queue moves", () => {
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  s.learner!.tracks.PE.queue = ["T10"];
  const milestone = () =>
    studyTrackProgress(r, s, "PE").topics.find((topic) => topic.id === "T10")!;
  assert.deepEqual([milestone().passed, milestone().total], [1, 2]);
  s.learner!.cells["PE:T10.2"].states[0] = "P";
  assert.deepEqual([milestone().passed, milestone().total], [2, 2]);
  assert.equal(studyTrackProgress(r, s, "PE").passed, 6);
  s.learner!.tracks.PE.queue = ["T05"];
  assert.equal(milestone().checkpoints.length, 2);
  assert.ok(
    milestone().checkpoints.every((entry) => entry.status === "verified"),
  );
});

test("practice keeps imported credit and uses the imported track tier", () => {
  const clone = structuredClone(r);
  const s = initialStudy(clone);
  activateCareerFocus(clone, s);
  // Practice cannot turn synthetic live-cell changes into verified credit.
  s.learner!.cells["PE:T10.2"].states[0] = "P";
  assert.equal(studyTrackProgress(clone, s, "PE").passed, 5);
  assert.notEqual(checkpoint(s).status, "verified");
  clone.tracks.PE.tier = 2;
  clone.tracks.PE.objectives.find((o) => o.id === "PE:T10.2")!.cells[1] = "P";
  s.learner!.tracks.PE.tier = 3;
  const progress = studyTrackProgress(clone, s, "PE");
  assert.equal(progress.tier, 2);
  assert.equal(progress.passed, 1);
});

test("unknown checkpoints are distinct from unresolved gaps at the displayed depth", () => {
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  s.learner!.cells["PE:T10.2"].states[0] = "U";
  s.knowledgeGaps = [
    gap("other-depth", 2),
    gap("other-objective", 1, "PE:T05.1"),
  ];
  assert.equal(checkpoint(s).status, "unassessed");
  assert.deepEqual(checkpoint(s).gaps, []);
  s.knowledgeGaps.push(gap("current-depth"));
  assert.equal(checkpoint(s).status, "gap");
  assert.deepEqual(
    checkpoint(s).gaps.map((entry) => entry.id),
    ["current-depth"],
  );
  assert.equal(checkpoint(s, "PE:T10.2", 2).status, "gap");
  assert.deepEqual(
    checkpoint(s, "PE:T10.2", 2).gaps.map((entry) => entry.id),
    ["other-depth"],
  );
  assert.equal(
    s.learner!.tracks.PE.tier,
    1,
    "review view must not advance the tier",
  );
});

test("resolved probe gaps disappear without creating mastery or an invented assessment", () => {
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  s.learner!.cells["PE:T10.2"].states[0] = "U";
  s.knowledgeGaps = [gap("resolved")];
  s.knowledgeGaps[0].resolved = {
    at: "2026-10-25T13:00:00Z",
    encounter: "synthetic/repair",
    requestId: "repair-request",
    status: "demonstrated",
  };
  const result = checkpoint(s);
  assert.equal(result.status, "unassessed");
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.evidence, []);
});

test("partial work is not a declared gap and saved assessment evidence is depth scoped", () => {
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  const cell = s.learner!.cells["PE:T10.2"];
  cell.states[0] = "G";
  cell.facets["D1:boundaries"] = {
    outcome: "assisted",
    evidenceIds: ["saved-evidence"],
    updatedAt: "2026-10-25T12:00:00Z",
  };
  const evidence: LearningEvidence = {
    id: "saved-evidence",
    objectiveId: "PE:T10.2",
    attemptId: "synthetic-attempt",
    encounter: "synthetic/assessment",
    depth: 1,
    facet: "boundaries",
    outcome: "assisted",
    rationale: "The answer used the supplied boundary explanation.",
    artifactSequences: [1],
    helpMessageIds: ["help-1"],
    at: "2026-10-25T12:00:00Z",
    execution: "not-run",
  };
  s.learner!.evidence = [
    evidence,
    { ...evidence, id: "other-depth", depth: 2 },
  ];
  assert.equal(checkpoint(s).status, "partial");
  assert.deepEqual(checkpoint(s).gaps, []);
  assert.deepEqual(
    checkpoint(s).evidence.map((entry) => entry.rationale),
    [evidence.rationale],
  );
  s.learner!.evidence.push({ ...evidence, facet: "unrelated-facet" });
  assert.equal(
    checkpoint(s).evidence.length,
    1,
    "an evidence reference cannot attribute a different facet's finding",
  );
  cell.facets["D1:boundaries"].outcome = "contradicted";
  assert.equal(checkpoint(s).status, "gap");
  assert.deepEqual(
    checkpoint(s).evidence,
    [],
    "superseded outcomes are not current findings",
  );
  cell.states[0] = "R";
  assert.equal(checkpoint(s).status, "recheck");
});

test("terminal observations never silently withdraw previously verified credit", () => {
  const s = initialStudy(r, "live");
  activateCareerFocus(r, s);
  s.knowledgeGaps = [gap("later-gap", 1, "PE:T10.1")];
  const result = checkpoint(s, "PE:T10.1");
  assert.equal(result.status, "verified");
  assert.equal(result.gaps.length, 1);
  assert.equal(studyTrackProgress(r, s, "PE").passed, 5);
});

test("compact progress summaries match the detailed map across profiles, depths and evidence", async () => {
  const { studyTrackSummary } = await import("../src/study-progress");
  for (const profile of ["live", "development"] as const) {
    const s = initialStudy(r, profile);
    for (const focus of ["full", "career"] as const) {
      // Use the default career profile or explicitly select the full curriculum.
      if (focus === "full") activateCareerFocus(r, s, "full");
      else activateCareerFocus(r, s);
      for (const track of ["PY", "PE"] as const) {
        for (const tier of [1, 2, 3, 4]) {
          s.learner!.tracks[track].tier = tier;
          const detail = studyTrackProgress(r, s, track);
          assert.deepEqual(studyTrackSummary(r, s, track), {
            tier: detail.tier,
            passed: detail.passed,
            total: detail.total,
            queue: detail.queue,
          });
        }
      }
    }
  }
});
