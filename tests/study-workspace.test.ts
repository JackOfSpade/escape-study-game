import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkBridge,
  completeQuestion,
  ensureProblem,
  regenerateQuestion,
} from "../src/ai";
import {
  beginVisit,
  countStudyTurn,
  eligible,
  initialStudy,
} from "../src/curriculum";
import {
  applyLearningAssessment,
  encounterKey,
  initialLearner,
} from "../src/learner";
import type { Assessment, Encounter, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createRecord } from "./helpers/record";
import { devProblem, preparePracticeRooms } from "./helpers/practice-questions";
import {
  enterStudyWorkspace,
  nextWorkspaceQuestion,
  workspaceQuestion,
  workspaceAssessment,
  workspaceSelectedQuestion,
  workspaceProgressHtml,
} from "../src/study-workspace";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

test("entering the study workspace marks it enabled once and keeps what the save held", () => {
  const g = createRecord(121, r);
  g.studyWorkspace = { enabled: false, encounter: "question-0" };
  enterStudyWorkspace(g);
  assert.deepEqual(g.studyWorkspace, {
    enabled: true,
    encounter: "question-0",
  });
  enterStudyWorkspace(g);
  const saved = recover(decode(encode(g)));
  assert.deepEqual(saved.studyWorkspace, g.studyWorkspace);
});

test("standalone questions use the formal scheduler and complete once", async () => {
  const g = createRecord(122, r);
  preparePracticeRooms(g, r);
  const contract = eligible(r, g.study);
  enterStudyWorkspace(g);
  const e = nextWorkspaceQuestion(g, r);
  assert.equal(nextWorkspaceQuestion(g, r), e);
  assert.equal(e.studyOnly, true);
  // No local stand-in: an unconnected record gets no question, only an error.
  await ensureProblem(g, e, r);
  assert.equal(e.problem, undefined);
  assert.ok(e.error);
  e.problem = devProblem({ ...g, rng: g.seq ^ g.study.version }, r, contract);
  e.workspace = e.problem.starter;
  delete e.error;
  assert.deepEqual(e.problem?.contract, contract);
  const ledger = structuredClone(g.study.learner);
  assert.equal(
    completeQuestion(g, e, "synthetic-completion", "Synthetic outcome"),
    true,
  );
  assert.equal(completeQuestion(g, e, "duplicate", "Duplicate"), false);
  assert.deepEqual(g.study.learner, ledger);
  assert.match(e.history.at(-1)!.text, /Study question completed/);
});

test("workspace reuses an issued question and ignores work owned by someone else", () => {
  const g = createRecord(123, r);
  preparePracticeRooms(g, r);
  const foreign = Object.values(g.encounters)[0];
  foreign.owner = "someone-else";
  foreign.pendingGeneration = { requestId: "foreign-only", payload: {} };
  enterStudyWorkspace(g);
  const e = nextWorkspaceQuestion(g, r);
  assert.notEqual(e, foreign);
  e.state = "consumed";
  const issued = Object.values(g.encounters)[1];
  issued.problemPresentedSequence = 17;
  const count = Object.keys(g.encounters).length;
  assert.equal(workspaceQuestion(g), issued);
  assert.equal(nextWorkspaceQuestion(g, r), issued);
  assert.equal(workspaceSelectedQuestion(g), issued);
  assert.equal(Object.keys(g.encounters).length, count);
  // Retained unfinished work from an earlier record is history, not a question
  // the workspace may reopen or silently reinterpret as a pending visit.
  issued.state = "consumed";
  const archived = structuredClone(issued);
  archived.runId = "older-run";
  archived.state = "in-progress";
  archived.pendingGeneration = { requestId: "old-generation", payload: {} };
  g.study.archives.push(archived);
  assert.equal(workspaceQuestion(g), undefined);
  assert.notEqual(nextWorkspaceQuestion(g, r), archived);
});

test("workspace keeps the selected human question when other displayed tasks precede it", () => {
  const g = createRecord(127, r);
  preparePracticeRooms(g, r);
  enterStudyWorkspace(g);
  const [earlier, selected] = Object.values(g.encounters);
  earlier.problemPresentedSequence = 1;
  selected.problemPresentedSequence = 2;
  g.studyWorkspace!.encounter = encounterKey(selected);
  assert.equal(workspaceSelectedQuestion(g), selected);
  assert.equal(workspaceQuestion(g), selected);
  assert.equal(nextWorkspaceQuestion(g, r), selected);
});

test("consumed generation and displayed work owned by someone else cannot block a new study question", () => {
  const g = createRecord(128, r);
  preparePracticeRooms(g, r);
  enterStudyWorkspace(g);
  const consumed = nextWorkspaceQuestion(g, r);
  consumed.state = "consumed";
  consumed.pendingGeneration = { requestId: "stale-generation", payload: {} };
  const foreign = Object.values(g.encounters).find((e) => !e.studyOnly)!;
  foreign.owner = "someone-else";
  foreign.problemPresentedSequence = 1;
  assert.equal(workspaceQuestion(g), undefined);
  const next = nextWorkspaceQuestion(g, r);
  assert.notEqual(next, consumed);
  assert.notEqual(next, foreign);
});

test("live study-only generation receives the exact formal contract", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic",
        detail: "No live model",
        capabilities: ["generate"],
      });
    const packet = JSON.parse(String(init?.body));
    assert.equal(packet.operation, "generate");
    sent.push(packet.payload);
    const c = packet.payload.contract;
    return Response.json({
      title: "Synthetic scheduled question",
      prompt: "Explain the supplied mechanism.",
      starter: "",
      rubric: ["Explain the mechanism"],
      contract: c,
      scopeDefinitions: [
        {
          id: `${c.objectiveIds[0]}/D${c.depth}`,
          objectiveId: c.objectiveIds[0],
          depth: c.depth,
          sourceScope: c.scopes[0],
          facets: [{ id: "mechanism", description: "Explain the mechanism" }],
        },
      ],
      estimatedSolveSeconds: 300,
    });
  };
  try {
    await checkBridge();
    const g = createRecord(126, r, initialStudy(r, "live"));
    enterStudyWorkspace(g);
    const formal = eligible(r, g.study);
    const e = nextWorkspaceQuestion(g, r);
    await ensureProblem(g, e, r);
    assert.equal(sent.length, 1);
    // The wire copy omits undefined fields; validation restores the trusted
    // original contract rather than adopting a provider-supplied scope.
    assert.deepEqual(sent[0].contract, JSON.parse(JSON.stringify(formal)));
    assert.deepEqual(e.problem?.contract, formal);
    assert.equal(e.problem?.provenance, "claude-cli");
  } finally {
    globalThis.fetch = original;
    await checkBridge();
  }
});

test("next live question waits for its source-bound progress review, while unrelated historical reviews do not block it", () => {
  const g = createRecord(124, r, initialStudy(r, "live"));
  enterStudyWorkspace(g);
  const e = nextWorkspaceQuestion(g, r);
  e.state = "consumed";
  g.study.assessments.push({
    id: "synthetic",
    encounter: e.id,
    sourceVersion: 0,
    findings: [],
    status: "pending",
    provenance: "synthetic",
  });
  assert.throws(
    () => nextWorkspaceQuestion(g, r),
    /reviewing your previous learning result/,
  );
  g.study.assessments[0].status = "review-required";
  assert.equal(workspaceAssessment(g)?.status, "review-required");
  assert.throws(() => nextWorkspaceQuestion(g, r), /reviewing/);
  g.study.assessments[0].status = "applied";
  g.study.assessments.push({
    ...g.study.assessments[0],
    id: "historical",
    encounter: "another-question",
    status: "review-required",
  });
  assert.notEqual(nextWorkspaceQuestion(g, r), e);
});

test("workspace reviews stay bound to their record when question IDs are reused", () => {
  const g = createRecord(129, r, initialStudy(r, "live"));
  enterStudyWorkspace(g);
  const current = nextWorkspaceQuestion(g, r);
  current.state = "consumed";
  const archived = structuredClone(current);
  archived.runId = "previous-run";
  g.study.archives.push(archived);
  const oldReview = {
    id: `assessment-${encounterKey(archived)}-1`,
    encounter: archived.id,
    sourceVersion: 0,
    findings: [],
    status: "review-required" as const,
    provenance: "synthetic",
  };
  const currentReview = {
    ...oldReview,
    id: `assessment-${encounterKey(current)}-2`,
    status: "applied" as const,
  };
  g.study.assessments.push(oldReview, currentReview, {
    ...oldReview,
    id: "ambiguous-legacy-review",
  });
  assert.equal(workspaceAssessment(g), currentReview);
  g.studyWorkspace!.encounter = encounterKey(archived);
  assert.equal(workspaceAssessment(g), oldReview);
  assert.throws(() => nextWorkspaceQuestion(g, r), /reviewing/);
});

test("a completed unresolved visit becomes a linked continuation without blocking the owed track", () => {
  const g = createRecord(131, r, initialStudy(r, "live"));
  g.study.learner!.reviews = {};
  g.study.learner!.studyTurnPosition = 0;
  enterStudyWorkspace(g);

  const issue = () => {
    const e = nextWorkspaceQuestion(g, r);
    const contract = eligible(r, g.study);
    e.problem = {
      title: "Synthetic standalone question",
      prompt: "Explain the supplied mechanism.",
      starter: "",
      rubric: ["Explain the mechanism"],
      provenance: "study-mode",
      contract,
      scopeDefinitions: [
        {
          id: `${contract.objectiveIds[0]}/D${contract.depth}`,
          objectiveId: contract.objectiveIds[0],
          depth: contract.depth,
          sourceScope: contract.scopes[0],
          facets: [{ id: "mechanism", description: "Explain the mechanism" }],
        },
      ],
    };
    e.history.push({
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Synthetic learner reasoning retained for assessment.",
      at: 0,
      revision: 0,
    });
    beginVisit(r, g.study, e);
    return e;
  };
  const finish = (e: Encounter, visitOutcome: "unresolved" | "usable") => {
    e.state = "consumed";
    e.directStudy = {
      id: `synthetic-${e.id}`,
      createdAt: 1,
      provider: "chatgpt-handoff",
      payloadJson: JSON.stringify({ frozenQuestion: e.problem }),
      questionFingerprint: "synthetic-fingerprint",
      state: "applied",
    };
    countStudyTurn(g.study, e);
    const assessment: Assessment = {
      id: `assessment-${encounterKey(e)}-1`,
      encounter: e.id,
      sourceVersion: g.study.learner!.version,
      evidenceCutoffSequence: 1,
      findings: [],
      status: "pending",
      provenance: "study-mode",
      visitOutcome,
    };
    g.study.assessments.push(assessment);
    applyLearningAssessment(r, g.study.learner!, e, assessment);
    return assessment;
  };

  const original = issue();
  assert.equal(original.problem!.contract.track, "PY");
  finish(original, "unresolved");
  const before = structuredClone(original);
  const parentId = g.study.learner!.attempts[0].id;
  assert.equal(g.study.learner!.attempts[0].status, "in-progress");
  delete g.studyWorkspace!.encounter; // Restored view selection is optional.
  const firstPE = issue();
  assert.equal(g.study.learner!.attempts[0].status, "interrupted");
  assert.equal(firstPE.problem!.contract.track, "PE");
  assert.deepEqual(
    original,
    before,
    "the old question and transcript are immutable",
  );
  assert.equal(firstPE.workspace, "");
  assert.equal(g.study.learner!.cycle, 0);
  finish(firstPE, "usable");
  const secondPE = issue();
  assert.equal(secondPE.problem!.contract.track, "PE");
  finish(secondPE, "usable");
  const followup = issue();
  assert.deepEqual(
    followup.problem!.contract.objectiveIds,
    original.problem!.contract.objectiveIds,
  );
  assert.equal(g.study.learner!.attempts.at(-1)!.parentAttempt, parentId);
  const result = finish(followup, "usable");
  assert.equal(g.study.learner!.cycle, 3);
  assert.deepEqual(g.study.learner!.continuations, []);
  applyLearningAssessment(r, g.study.learner!, followup, result);
  assert.equal(g.study.learner!.cycle, 3, "retry cannot serve the visit twice");
  assert.deepEqual(original, before);
});

test("skill map stays stable across an unissued question and escapes learner-facing content", () => {
  const g = createRecord(125, r);
  preparePracticeRooms(g, r);
  const before = workspaceProgressHtml(g, r);
  enterStudyWorkspace(g);
  nextWorkspaceQuestion(g, r);
  assert.equal(workspaceProgressHtml(g, r), before);
  const clone = structuredClone(r);
  const c = eligible(clone, g.study);
  const topic = c.objectiveIds[0].split(":")[1].split(".")[0];
  clone.tracks[c.track].topics[topic] = '<script>alert("x")</script>';
  const html = workspaceProgressHtml(g, clone);
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /study-current-topic|study-review-notes/);
});

test("regenerating a workspace question keeps its topic and leaves progress untouched", () => {
  const g = createRecord(124, r);
  g.study.learner ??= initialLearner(r);
  const contract = eligible(r, g.study);
  enterStudyWorkspace(g);
  const e = nextWorkspaceQuestion(g, r);
  assert.equal(regenerateQuestion(g, e, r), false); // Nothing to replace yet.
  e.problem = devProblem({ ...g, rng: g.seq ^ g.study.version }, r, contract);
  e.state = "in-progress";
  e.workspace = "draft";
  e.revision = 3;
  e.chatDraft = "half typed";
  e.tutor.push({
    id: "m1",
    author: "You",
    kind: "human",
    text: "an answer",
    seq: 1,
    worldTime: 0,
    provenance: "human",
  });
  const other = { encounter: "another", id: "keep" };
  g.study.knowledgeGaps = [
    { encounter: encounterKey(e), id: "drop" },
    other,
  ] as never;
  const ledger = structuredClone(g.study.learner);
  const assessments = structuredClone(g.study.assessments);
  // Verified counts only: the "current question" marker rightly changes
  // while the replacement is being written.
  const counts = () =>
    workspaceProgressHtml(g, r).match(/data-(passed|status)="[^"]*"/g);
  const map = counts();
  assert.equal(regenerateQuestion(g, e, r), true);
  assert.equal(e.problem, undefined);
  assert.deepEqual(e.tutor, []);
  assert.equal(e.workspace, "");
  assert.equal(e.revision, 0);
  assert.equal(e.chatDraft, undefined);
  assert.equal(e.state, "available");
  // The saved request pins the same contract, so the same topic is asked.
  assert.deepEqual(e.pendingGeneration?.payload.contract, contract);
  assert.deepEqual(g.study.knowledgeGaps, [other]);
  assert.deepEqual(g.study.learner, ledger);
  assert.deepEqual(g.study.assessments, assessments);
  assert.deepEqual(counts(), map);
  // Still the selected question: no second task is allocated.
  assert.equal(nextWorkspaceQuestion(g, r), e);
  e.state = "consumed";
  assert.equal(regenerateQuestion(g, e, r), false);
});
