// Synthetic questions exercise formal lifecycle, never genuine Study Mode quality.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { completeQuestion, presentProblem } from "../src/ai";
import { eligible, initialStudy } from "../src/curriculum";
import {
  applyLearningAssessment,
  encounterKey,
  interruptLearningAttempt,
  registerScopes,
} from "../src/learner";
import type { Assessment, Encounter, StudyRecord, Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { prepareRoadmapExport } from "../src/roadmap-export";
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function question(g: StudyRecord, e: Encounter) {
  const c = eligible(r, g.study);
  e.problem = {
    title: "Synthetic unanswered assessment",
    prompt: "PRIVATE_QUESTION_MUST_STAY_OUT_OF_ROADMAP",
    starter: "Supplied starter",
    rubric: [],
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: c.objectiveIds.map((id, i) => ({
      id: `${id}/D${c.depth}`,
      objectiveId: id,
      depth: c.depth,
      sourceScope: c.scopes[i],
      facets: [{ id: "scope", description: "Synthetic scope" }],
    })),
  };
  e.workspace = e.problem.starter;
  e.state = "in-progress";
  registerScopes(r, g.study.learner!, e);
}
function fixture() {
  const g = createGame(33, r, initialStudy(r, "live")),
    e = g.encounters["question-0"];
  g.study.learner!.reviews = {};
  question(g, e);
  return { g, e, l: g.study.learner! };
}
test("presentation issues exactly one pending task, generation and reinspection do not issue or serve it", async () => {
  const { g, e, l } = fixture();
  const cycle = l.cycle,
    tracks = JSON.stringify(l.tracks);
  assert.equal(l.attempts.length, 0);
  assert.equal(l.currentSession, undefined);
  presentProblem(g, e, r);
  assert.equal(l.attempts.length, 1);
  assert.equal(l.attempts[0].status, "in-progress");
  assert.equal(l.attempts[0].encounter, encounterKey(e));
  assert.equal(l.evidence.length, 0);
  assert.equal(l.cycle, cycle);
  assert.equal(JSON.stringify(l.tracks), tracks);
  const saved = JSON.stringify(g.study),
    history = JSON.stringify(e.history);
  presentProblem(g, e, r);
  assert.equal(JSON.stringify(g.study), saved);
  assert.equal(JSON.stringify(e.history), history);
  const restored = decode(encode(g));
  presentProblem(restored, restored.encounters[e.id], r);
  assert.equal(JSON.stringify(restored.study), saved);
  const exported = await prepareRoadmapExport(r, l);
  assert.match(
    exported.content,
    new RegExp(`\\| ${l.attempts[0].id} \\|[^\\n]*PENDING`),
  );
  assert.ok(
    !exported.content.includes("PRIVATE_QUESTION_MUST_STAY_OUT_OF_ROADMAP"),
  );
});
test("unanswered issued work survives interruption and reload and is superseded only by actual fresh linked issuance", async () => {
  const { g, e, l } = fixture();
  presentProblem(g, e, r);
  const id = l.attempts[0].id,
    cycle = l.cycle;
  interruptLearningAttempt(l, e);
  assert.equal(l.attempts[0].status, "interrupted");
  assert.equal(l.continuations.length, 1);
  const before = await prepareRoadmapExport(r, l);
  assert.match(
    before.content,
    new RegExp(`\\| ${id} \\|[^\\n]*PENDING; INTERRUPTED`),
  );
  interruptLearningAttempt(l, e);
  interruptLearningAttempt(l, e);
  assert.equal(l.continuations.length, 1);
  const restored = decode(encode(g)),
    next = restored.encounters["question-1"];
  question(restored, next);
  assert.equal(
    restored.study.learner!.attempts.length,
    1,
    "unobserved generation is not replacement issuance",
  );
  presentProblem(restored, next, r);
  const child = restored.study.learner!.attempts[1];
  assert.equal(child.parentAttempt, id);
  assert.notEqual(child.encounter, l.attempts[0].encounter);
  assert.equal(restored.study.learner!.cycle, cycle);
  assert.equal(restored.study.learner!.evidence.length, 0);
  const after = await prepareRoadmapExport(r, restored.study.learner!);
  assert.match(
    after.content,
    new RegExp(`\\| ${id} \\|[^\\n]*SUPERSEDED[^\\n]*${child.id}`),
  );
});
test("unknown assessment of an issued task cannot count a visit, create evidence, or use later work", () => {
  const { g, e, l } = fixture();
  presentProblem(g, e, r);
  const cycle = l.cycle,
    c = e.problem!.contract;
  const a: Assessment = {
    id: "synthetic-unanswered",
    encounter: e.id,
    sourceVersion: l.version,
    provenance: "study-mode",
    status: "pending",
    evidenceCutoffSequence: g.seq,
    visitOutcome: "unresolved",
    findings: [
      {
        objectiveId: c.objectiveIds[0],
        depth: c.depth,
        facet: "scope",
        outcome: "unknown",
        completeCheckpointScope: false,
        evidence: [],
        rationale: "No human technical answer",
      },
    ],
  };
  const baseline = JSON.stringify(l);
  assert.throws(
    () => applyLearningAssessment(r, l, e, { ...a, visitOutcome: "usable" }),
    /unanswered/,
  );
  assert.equal(JSON.stringify(l), baseline);
  e.history.push({
    seq: g.seq + 1,
    author: "human",
    kind: "reasoning",
    text: "Later actual reasoning",
    at: 1,
    revision: 0,
  });
  assert.throws(
    () => applyLearningAssessment(r, l, e, { ...a, visitOutcome: "usable" }),
    /unanswered/,
  );
  e.history.pop();
  applyLearningAssessment(r, l, e, a);
  assert.equal(l.cycle, cycle);
  assert.equal(l.evidence.length, 0);
  assert.equal(l.attempts[0].status, "in-progress");
});
test("completing a question detaches its unanswered study from the consumed record", () => {
  const { g, e, l } = fixture();
  presentProblem(g, e, r);
  const cycle = l.cycle;
  assert.ok(completeQuestion(g, e, "actual-work", "Synthetic completed work"));
  assert.equal(l.attempts[0].status, "interrupted");
  assert.equal(l.cycle, cycle);
  assert.equal(l.evidence.length, 0);
  presentProblem(g, e, r);
  assert.equal(l.attempts.length, 1);
  const next = g.encounters["question-1"];
  question(g, next);
  presentProblem(g, next, r);
  assert.equal(l.attempts[1].parentAttempt, l.attempts[0].id);
});
test("unscheduled work stays outside formal issuance; development remains practice", () => {
  const { g, e, l } = fixture(),
    other = g.encounters["question-1"];
  question(g, other);
  other.problem!.contract.track =
    other.problem!.contract.track === "PY" ? "PE" : "PY";
  presentProblem(g, other, r);
  assert.equal(l.attempts.length, 0);
  assert.match(other.error!, /scheduled/);
  g.study.profile = "development";
  presentProblem(g, e, r);
  assert.equal(l.attempts.length, 0);
  const unseen = g.encounters["question-2"];
  question(g, unseen);
  completeQuestion(g, unseen, "unobserved", "Synthetic reward");
  presentProblem(g, unseen, r);
  assert.equal(l.attempts.length, 0);
});
