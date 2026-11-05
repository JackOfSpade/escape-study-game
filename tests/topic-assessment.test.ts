import assert from "node:assert/strict";
import test from "node:test";
import type { Contract, Encounter, Game, Roadmap } from "../src/model";
import type { RoadmapAdoptionReceipt } from "../src/roadmap-adoption-types";
import {
  recordTopicAssessments,
  latestTopicAssessment,
  topicAssessmentContext,
  validateTopicAssessments,
  type TopicAssessmentRecord,
} from "../src/topic-assessment";

function fixture() {
  const track = (name: "PY" | "PE") => ({
    tier: 1,
    phase: "DIAGNOSTIC",
    remaining: ["T01", "T02"],
    rotation: ["T01", "T02"],
    objectives: [1, 2].map((n) => ({
      id: `${name}:T0${n}.1`,
      target: 2,
      cells: ["U", "U", "—", "—"],
      route: "synthetic",
      refs: "synthetic source",
      reviewDue: null,
      scope: `Synthetic ${name} topic ${n} scope`,
    })),
    topics: { T01: `${name} first topic`, T02: `${name} other topic` },
    progress: "",
    curriculum: "Synthetic curriculum only",
  });
  const r: Roadmap = {
    documentId: "synthetic-only",
    revision: 1,
    sourceHash: "a".repeat(64),
    raw: "Synthetic source only",
    sharedProgress: "Synthetic learner context: prefers to explain tradeoffs.",
    tracks: { PY: track("PY"), PE: track("PE") },
  };
  const g = {
    id: "synthetic-run",
    encounters: {},
    study: {
      profile: "live",
      version: 0,
      cycle: 0,
      queues: { PY: ["T01", "T02"], PE: ["T01", "T02"] },
      phases: { PY: "DIAGNOSTIC", PE: "DIAGNOSTIC" },
      reviewsServed: [],
      visits: [],
      assessments: [],
      archives: [],
      learner: {
        schema: 1,
        mode: "test",
        sourceHash: r.sourceHash,
        version: 0,
        cycle: 0,
        cells: Object.fromEntries(
          Object.values(r.tracks)
            .flatMap((t) => t.objectives)
            .map((o) => [
              o.id,
              {
                states: ["U", "U", "—", "—"],
                proofs: {},
                facets: {},
                sourceRefs: o.refs,
              },
            ]),
        ),
        scopes: {},
        verifiedScopes: [],
        tracks: Object.fromEntries(
          (["PY", "PE"] as const).map((name) => [
            name,
            {
              tier: 1,
              cleared: 0,
              phase: "DIAGNOSTIC",
              queue: ["T01", "T02"],
              lap: 0,
              suspended: [],
            },
          ]),
        ),
        reviews: {},
        sessions: [],
        attempts: [],
        evidence: [],
        receipts: {},
        continuations: [],
      },
    },
  } as unknown as Game;
  const contract: Contract = {
    id: "synthetic-contract",
    track: "PY",
    objectiveIds: ["PY:T01.1"],
    scopes: ["Synthetic PY topic 1 scope"],
    depth: 1,
    phase: "DIAGNOSTIC",
    review: false,
    ledgerVersion: 1,
    priorEvidence: [],
  };
  const e: Encounter = {
    id: "synthetic-question",
    runId: g.id,
    floor: 0,
    mode: "solo",
    reward: "stairs",
    state: "in-progress",
    problem: {
      title: "Synthetic original task",
      prompt: "Explain the synthetic topic without implementation.",
      rubric: ["Explain a tradeoff"],
      starter: "",
      provenance: "study-mode",
      contract,
    },
    workspace: "",
    revision: 0,
    history: [],
    tutor: [],
    group: [],
    submissions: [],
    contributors: [],
    chatCursor: 0,
    chatOpen: false,
    recentSpeakers: [],
    npcProgress: 0,
    loot: [],
    scroll: 0,
    selection: [0, 0],
    directStudy: {
      id: "synthetic-request",
      provider: "chatgpt-handoff",
      payloadJson: "{}",
      state: "pending",
      questionFingerprint: "f".repeat(64),
      createdAt: 100,
    },
  };
  g.encounters[e.id] = e;
  return { g, r, e, contract };
}

const old = (topicId: string, depth = 1): TopicAssessmentRecord => ({
  topicId,
  depth,
  text: "An earlier cautious assessment.",
  updatedAt: "2026-10-24T12:00:00Z",
  encounter: "synthetic-prior-question",
  runId: "synthetic-prior-run",
  questionFingerprint: "e".repeat(64),
  requestId: "synthetic-prior-request",
  sourceHash: "a".repeat(64),
  startedAt: 50,
});

import { readFileSync } from "node:fs";
import { checkBridge, ensureProblem, presentProblem, send } from "../src/ai";
import { topicAssessmentTopics } from "../scripts/lib/topic-assessment.mjs";
import { createPlayableGame } from "../src/world";
import { preparePracticeRooms } from "./helpers/practice-questions";

const liveRoadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
async function terminalFixture(
  profile: "live" | "development",
  run: (
    g: any,
    e: any,
    calls: any[],
    reply: (fn: (p: any) => Promise<Response>) => void,
  ) => Promise<void>,
) {
  const original = globalThis.fetch;
  const calls: any[] = [];
  let connected = false;
  let respond = async (_p: any) =>
    Response.json({ text: "What changes?", complete: false });
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: connected ? "claude-cli" : "development",
        label: "Synthetic",
        detail: "No real AI",
        capabilities: connected ? ["tutor"] : [],
      });
    const p = JSON.parse(String(init?.body));
    calls.push(p);
    return respond(p);
  };
  try {
    await checkBridge();
    const g = createPlayableGame(717, liveRoadmap);
    preparePracticeRooms(g, liveRoadmap);
    const e = g.encounters[g.floors[0].stations[0].encounter];
    await ensureProblem(g, e, liveRoadmap);
    e.mode = "solo";
    e.owner = "human";
    g.study.profile = profile;
    connected = true;
    await checkBridge();
    await run(g, e, calls, (fn) => {
      respond = fn;
    });
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
}

test("a live terminal dialogue payload carries the topic assessment context; development does not", async () => {
  await terminalFixture("live", async (g, e, calls) => {
    await send(g, e, "tutor", "My first answer", liveRoadmap);
    const topicIds = topicAssessmentTopics(e.problem.contract);
    assert.ok(topicIds.length > 0);
    assert.equal(calls[0].payload.mode, "terminal-dialogue");
    assert.deepEqual(
      calls[0].payload.topicAssessmentContext.topicIds,
      topicIds,
    );
  });
  await terminalFixture("development", async (g, e, calls) => {
    await send(g, e, "tutor", "My first answer", liveRoadmap);
    assert.equal(calls[0].payload.mode, "terminal-dialogue");
    assert.equal(calls[0].payload.topicAssessmentContext, undefined);
  });
});

test("terminal dialogue records topic assessments only after a valid completed reply", async () => {
  await terminalFixture("live", async (g, e, calls, reply) => {
    await send(g, e, "tutor", "My first answer", liveRoadmap);
    const topicIds: string[] = topicAssessmentTopics(e.problem.contract);
    assert.equal(g.study.topicAssessments, undefined);
    const keys = g.survivors[0].keys ?? 0;
    // A completed reply with an invalid list applies nothing.
    reply(async () =>
      Response.json({
        text: "Solved.",
        complete: true,
        topicAssessments: [{ topicId: "PY:T99", text: "Unknown topic." }],
      }),
    );
    await send(g, e, "tutor", "My explanation", liveRoadmap);
    assert.notEqual(e.state, "consumed");
    assert.equal(e.submissions.length, 0);
    assert.equal(g.survivors[0].keys ?? 0, keys);
    assert.equal(g.study.topicAssessments, undefined);
    // An unfinished reply leaves assessments unchanged.
    reply(async () => Response.json({ text: "Go on.", complete: false }));
    await send(g, e, "tutor", "More detail", liveRoadmap);
    assert.equal(g.study.topicAssessments, undefined);
    // A valid completion records the new text for each topic.
    reply(async () =>
      Response.json({
        text: "Solved.",
        complete: true,
        topicAssessments: topicIds.map((topicId) => ({
          topicId,
          text: `Fresh assessment of ${topicId}`,
        })),
      }),
    );
    await send(g, e, "tutor", "Final explanation", liveRoadmap);
    assert.equal(e.state, "consumed");
    assert.equal(g.survivors[0].keys, keys + 1);
    const depth = e.problem.contract.depth;
    for (const topicId of topicIds)
      assert.equal(
        g.study.topicAssessments[`${topicId}/D${depth}`].text,
        `Fresh assessment of ${topicId}`,
      );
    assert.equal(Object.keys(g.study.topicAssessments).length, topicIds.length);
    assert.ok(calls.length >= 4);
  });
});

test("terminal dialogue completion from an older question cannot overwrite a newer assessment", async () => {
  await terminalFixture("live", async (g, e, _calls, reply) => {
    // The terminal render presents the problem; re-rendering must not move it.
    assert.equal(e.problemPresentedAt, undefined);
    presentProblem(g, e, liveRoadmap);
    const presentedAt = e.problemPresentedAt;
    assert.equal(typeof presentedAt, "number");
    await new Promise((resolve) => setTimeout(resolve, 5));
    presentProblem(g, e, liveRoadmap);
    assert.equal(e.problemPresentedAt, presentedAt);
    await send(g, e, "tutor", "My first answer", liveRoadmap);
    assert.equal(e.problemPresentedAt, presentedAt);
    const topicIds: string[] = topicAssessmentTopics(e.problem.contract);
    const depth = e.problem.contract.depth;
    recordTopicAssessments(
      g,
      e,
      topicIds.map((topicId) => ({
        topicId,
        text: `Newer question ${topicId}`,
      })),
      {
        requestId: "synthetic-newer-request",
        questionFingerprint: "d".repeat(64),
        startedAt: presentedAt + 1_000_000,
        updatedAt: "2026-10-26T12:00:00Z",
      },
    );
    reply(async () =>
      Response.json({
        text: "Solved.",
        complete: true,
        topicAssessments: topicIds.map((topicId) => ({
          topicId,
          text: `Late older ${topicId}`,
        })),
      }),
    );
    await send(g, e, "tutor", "Final explanation", liveRoadmap);
    assert.equal(e.state, "consumed");
    for (const topicId of topicIds)
      assert.equal(
        g.study.topicAssessments[`${topicId}/D${depth}`].text,
        `Newer question ${topicId}`,
      );
  });
});

test("completion refreshes only its own topic and depth, with no mastery effects", () => {
  const { g, e } = fixture();
  const other = old("PE:T01");
  const deeper = old("PY:T01", 2);
  g.study.topicAssessments = { "PE:T01/D1": other, "PY:T01/D2": deeper };
  const before = structuredClone(g.study.learner);
  const prose =
    "You probably understand the tradeoff, but the boundary case may still be a gap. That is a prediction from your latest explanation, rather than something directly tested.";
  recordTopicAssessments(g, e, [{ topicId: "PY:T01", text: prose }], {
    updatedAt: "2026-10-25T12:00:00Z",
  });
  assert.equal(g.study.topicAssessments["PY:T01/D1"].text, prose);
  assert.strictEqual(g.study.topicAssessments["PE:T01/D1"], other);
  assert.strictEqual(g.study.topicAssessments["PY:T01/D2"], deeper);
  assert.deepEqual(g.study.learner, before);
  assert.deepEqual(g.study.knowledgeGaps, undefined);
  assert.deepEqual(g.study.knowledgeEstablished, undefined);
});

test("invalid topic batches are rejected atomically and completion identity is required", () => {
  const { g, e } = fixture();
  g.study.topicAssessments = { "PY:T01/D1": old("PY:T01") };
  const before = structuredClone(g.study);
  assert.throws(() =>
    recordTopicAssessments(g, e, [
      { topicId: "PY:T01", text: "Valid first row" },
      { topicId: "PE:T02", text: "Unrelated topic must not change" },
    ]),
  );
  assert.deepEqual(g.study, before);
  assert.throws(() =>
    validateTopicAssessments(e, [{ topicId: "PY:T01", text: " " }]),
  );
  assert.throws(() =>
    validateTopicAssessments(e, [
      { topicId: "PY:T01", text: "x".repeat(16_001) },
    ]),
  );
  assert.throws(() =>
    validateTopicAssessments(e, [
      { topicId: "PY:T01", text: "text", certainty: "invented" },
    ]),
  );
  delete e.directStudy;
  assert.throws(
    () =>
      recordTopicAssessments(g, e, [{ topicId: "PY:T01", text: "Bound text" }]),
    /identity/,
  );
  assert.deepEqual(g.study, before);
});

test("duplicate receipts and late older questions cannot replace a newer assessment", () => {
  const { g, e } = fixture();
  const first = [{ topicId: "PY:T01", text: "The current assessment" }];
  recordTopicAssessments(g, e, first, { updatedAt: "2026-10-25T12:00:00Z" });
  const saved = g.study.topicAssessments!["PY:T01/D1"];
  recordTopicAssessments(g, e, first, { updatedAt: "2026-10-26T12:00:00Z" });
  assert.strictEqual(g.study.topicAssessments!["PY:T01/D1"], saved);
  recordTopicAssessments(
    g,
    e,
    [{ topicId: "PY:T01", text: "Late older impression" }],
    {
      requestId: "synthetic-older-request",
      questionFingerprint: "c".repeat(64),
      startedAt: 75,
      updatedAt: "2026-10-27T12:00:00Z",
    },
  );
  assert.strictEqual(g.study.topicAssessments!["PY:T01/D1"], saved);
  recordTopicAssessments(
    g,
    e,
    [{ topicId: "PY:T01", text: "A new question changed the picture" }],
    {
      requestId: "synthetic-next-request",
      questionFingerprint: "d".repeat(64),
      startedAt: 125,
      updatedAt: "2026-10-27T12:00:00Z",
    },
  );
  assert.match(
    g.study.topicAssessments!["PY:T01/D1"].text,
    /changed the picture/,
  );
});

test("all topics assessed by a combined question update together while legacy completion is a no-op", () => {
  const { g, e } = fixture();
  e.problem!.contract.objectiveIds.push("PE:T02.1");
  const before = structuredClone(g.study);
  recordTopicAssessments(g, e, undefined);
  recordTopicAssessments(g, e, []);
  assert.deepEqual(g.study, before);
  assert.throws(() =>
    validateTopicAssessments(e, [
      { topicId: "PY:T01", text: "Incomplete batch" },
    ]),
  );
  recordTopicAssessments(g, e, [
    { topicId: "PY:T01", text: "A tentative Python assessment" },
    { topicId: "PE:T02", text: "An independently worded product assessment" },
  ]);
  assert.deepEqual(Object.keys(g.study.topicAssessments!).sort(), [
    "PE:T02/D1",
    "PY:T01/D1",
  ]);
});

test("context includes historical conversations with original questions and attributed authors, excludes pending drafts", () => {
  const { g, r, e, contract } = fixture();
  e.chatDraft = "DO NOT TREAT UNSENT WORDS AS KNOWLEDGE";
  e.tutor.push({
    id: "pending-turn",
    author: "human",
    kind: "human",
    text: "Pending current conversation",
    seq: 1,
    worldTime: 0,
    provenance: "test-fixture",
  });
  const archived = structuredClone(e);
  archived.id = "synthetic-archive";
  archived.runId = "synthetic-previous-run";
  archived.chatDraft = "ARCHIVED UNSENT DRAFT";
  archived.directStudy!.state = "applied";
  archived.problem!.prompt = "Original historical question, preserved";
  archived.tutor = [
    {
      id: "learner-turn",
      author: "human",
      kind: "human",
      text: "I chose an id because labels can change",
      seq: 1,
      worldTime: 0,
      provenance: "chatgpt-host-model-transcript",
    },
    {
      id: "tutor-turn",
      author: "Terminal AI",
      kind: "tutor",
      text: "Assistant supplied example",
      seq: 2,
      worldTime: 0,
      provenance: "chatgpt-host-model-transcript",
    },
  ];
  archived.history = [
    {
      seq: 3,
      author: "human",
      kind: "reasoning",
      text: "My saved reasoning",
      at: 0,
      revision: 0,
    },
  ];
  g.study.archives.push(archived);
  const completed = structuredClone(archived);
  completed.id = "synthetic-complete-current";
  completed.runId = g.id;
  completed.directStudy!.appliedAt = 200;
  g.encounters[completed.id] = completed;
  const context = topicAssessmentContext(g, r, contract);
  assert.equal(context.completedConversations.items.length, 2);
  assert.deepEqual(
    context.completedConversations.items.map((entry) => entry.source).sort(),
    ["current-run", "saved-archive"],
  );
  assert.equal(
    context.completedConversations.items[0].originalQuestion.prompt,
    archived.problem!.prompt,
  );
  assert.deepEqual(
    context.completedConversations.items[0].messages.map((message) => [
      message.author,
      message.kind,
      message.provenance,
    ]),
    [
      ["human", "human", "chatgpt-host-model-transcript"],
      ["Terminal AI", "tutor", "chatgpt-host-model-transcript"],
    ],
  );
  const json = JSON.stringify(context);
  assert.match(json, /My saved reasoning/);
  assert.doesNotMatch(
    json,
    /DO NOT TREAT|ARCHIVED UNSENT|Pending current conversation/,
  );
  assert.equal(context.frozenBeforeCurrentConversation, true);
});

test("context supplies cross-topic evidence and distinguishes stale narratives and source-bound imports", () => {
  const { g, r, contract } = fixture();
  g.study.topicAssessments = {
    "PY:T01/D1": old("PY:T01"),
    "PE:T02/D1": { ...old("PE:T02"), sourceHash: "b".repeat(64) },
  };
  g.study.knowledgeGaps = [
    {
      id: "synthetic-gap",
      encounter: "synthetic/other",
      runId: "synthetic",
      track: "PE",
      objectiveIds: ["PE:T02.1"],
      depth: 1,
      facet: { id: "other-gap", description: "Cross-topic boundary gap" },
      statement: "I do not know yet",
      requestId: "synthetic-gap-request",
      provider: "test-fixture",
      at: "2026-10-25T12:00:00Z",
    },
  ];
  g.study.knowledgeEstablished = [
    {
      id: "synthetic-established",
      encounter: "synthetic/established",
      runId: "synthetic",
      track: "PE",
      objectiveIds: ["PE:T01.1"],
      depth: 1,
      facet: {
        id: "other-known",
        description: "Cross-topic identity reasoning",
      },
      status: "implied",
      requestId: "synthetic-known-request",
      provider: "test-fixture",
      at: "2026-10-25T12:00:00Z",
    },
  ];
  g.study.learner!.evidence.push({
    id: "synthetic-evidence",
    attemptId: "synthetic-attempt",
    encounter: "synthetic/complete",
    objectiveId: "PE:T02.1",
    depth: 1,
    facet: "boundary",
    outcome: "assisted",
    artifactSequences: [1],
    helpMessageIds: ["tutor-help"],
    at: "2026-10-25T12:00:00Z",
    execution: "not-run",
    rationale: "Needed help choosing a boundary",
  });
  r.tracks.PY.progress =
    "### 0.5 Assessment evidence register\n| S0001-EV01 | S0001-A01 | 2026-10-24 | T01.1 | D1 | DIAGNOSTIC | NONE | 2 | Synthetic historical observation |\n### 0.5.1 Attempt status register\n| S0001-A01 | S0001 / 2026-10-24 | T01.1 D1 task | INVALIDATED; ambiguity, not learner failure | None | Corrected later |";
  const context = topicAssessmentContext(g, r, contract);
  assert.deepEqual(context.topicIds, ["PY:T01"]);
  assert.equal(context.observations.gaps.items[0].track, "PE");
  assert.equal(context.observations.established.items[0].track, "PE");
  assert.equal(context.learner.evidence.items[0].outcome, "assisted");
  assert.equal(
    context.priorAssessments.items.find((entry) => entry.topicId === "PE:T02")!
      .matchesCurrentSource,
    false,
  );
  assert.equal(context.priorAssessments.items[0].matchesCurrentSource, true);
  assert.equal(
    context.importedContext.evidenceAndGapRows.items[0].sourceHash,
    r.sourceHash,
  );
  assert.match(
    JSON.stringify(context.importedContext.evidenceAndGapRows),
    /INVALIDATED; ambiguity, not learner failure/,
  );
  assert.match(
    context.importedContext.sharedProgress.segments[0].text,
    /prefers to explain tradeoffs/,
  );
  assert.equal(
    context.topics.items[0].curriculumScopes[0].objectiveId,
    "PY:T01.1",
  );
  assert.equal(context.learner.checkpointProgress.items.length, 4);
});

test("large context reports exact omitted rows and source character ranges", () => {
  const { g, r, e, contract } = fixture();
  r.sharedProgress = "A".repeat(20_000) + "MIDDLE" + "Z".repeat(20_000);
  const archived = structuredClone(e);
  archived.directStudy!.state = "applied";
  archived.problem!.prompt = "X".repeat(80_000);
  g.study.archives.push(archived);
  // The current snapshot is intentionally pending; this archive has a distinct identity.
  archived.id = "synthetic-huge-archive";
  const context = topicAssessmentContext(g, r, contract);
  const source = context.importedContext.sharedProgress;
  assert.equal(source.originalChars, 40_006);
  assert.equal(source.includedChars, 16_000);
  assert.equal(source.omittedChars, 24_006);
  assert.deepEqual(
    source.segments.map(({ start, end }) => [start, end]),
    [
      [0, 8000],
      [32_006, 40_006],
    ],
  );
  assert.equal(context.completedConversations.coverage.totalItems, 1);
  assert.equal(context.completedConversations.coverage.includedItems, 0);
  assert.equal(context.completedConversations.coverage.omittedItems, 1);
  assert.equal(
    context.completedConversations.coverage.includedSerializedChars,
    0,
  );
  assert.equal(
    context.completedConversations.coverage.omittedSerializedChars,
    context.completedConversations.coverage.totalSerializedChars,
  );
  assert.doesNotMatch(JSON.stringify(context), /file:\/\/|\.artifacts\//);
});

test("context uses the latest adopted roadmap's dispositions and shared learner context", () => {
  const { g, r, contract } = fixture();
  r.tracks.PY.progress =
    "| S0001-A01 | S0001 / 2026-10-24 | T01.1 D1 task | ORIGINAL DISPOSITION | None | Original |";
  const blocks = {
    SHARED_PROGRESS:
      "Updated synthetic learner context after reconciliation.\n",
    MERGE_RULES: "Synthetic unchanged merge rules.\n",
    PY_PROGRESS:
      "### 0.5.1 Attempt status register\n| S0001-A01 | S0001 / 2026-10-24 | T01.1 D1 task | INVALIDATED; corrected ambiguity | None | Latest corrected source |\n",
    PY_CURRICULUM: "Synthetic unchanged Python curriculum.\n",
    PE_PROGRESS:
      "### 0.6 Gap register\n| G0002 | T02.1 | D1 | Updated cross-topic gap |\n",
    PE_CURRICULUM: "Synthetic unchanged product curriculum.\n",
  };
  const canonical = [
    "---",
    "document_id: interview_prep_roadmap",
    "merge_schema_version: 1.0",
    "revision: 2",
    "previous_revision: 1",
    "---",
    ...Object.entries(blocks).map(
      ([name, text]) => `<!-- BEGIN ${name} -->\n${text}<!-- END ${name} -->`,
    ),
  ].join("\n");
  g.study.learner!.roadmapAdoptions = [
    {
      canonicalHash: "b".repeat(64),
      adoptedAt: "2026-10-26T12:00:00Z",
      proposal: { canonical },
    } as RoadmapAdoptionReceipt,
  ];
  const before = structuredClone(g.study);
  const context = topicAssessmentContext(g, r, contract);
  const imported = JSON.stringify(context.importedContext);
  assert.match(imported, /INVALIDATED; corrected ambiguity/);
  assert.match(imported, /Updated cross-topic gap/);
  assert.match(
    imported,
    /Updated synthetic learner context after reconciliation/,
  );
  assert.doesNotMatch(
    imported,
    /ORIGINAL DISPOSITION|prefers to explain tradeoffs/,
  );
  assert.equal(context.importedContext.revision, 2);
  assert.equal(context.importedContext.sourceHash, r.sourceHash);
  assert.equal(context.importedContext.canonicalHash, "b".repeat(64));
  assert.equal(
    context.importedContext.evidenceAndGapRows.items[0].canonicalHash,
    "b".repeat(64),
  );
  assert.deepEqual(g.study, before);
});

test("context preserves current checkpoint proofs and stable scope definitions without changing progress", () => {
  const { g, r, contract } = fixture();
  const ledger = g.study.learner!;
  ledger.cells["PY:T01.1"].states[0] = "P";
  ledger.cells["PY:T01.1"].proofs.D1 = ["synthetic-proof"];
  ledger.cells["PY:T01.1"].facets["D1:reasoning"] = {
    outcome: "independent",
    evidenceIds: ["synthetic-proof"],
    updatedAt: "2026-10-25T12:00:00Z",
  };
  ledger.scopes["PY:T01.1/D1"] = {
    id: "PY:T01.1/D1",
    objectiveId: "PY:T01.1",
    depth: 1,
    sourceScope: "Synthetic PY topic 1 scope",
    facets: [{ id: "reasoning", description: "Explain the scope's tradeoff" }],
  };
  ledger.evidence.push({
    id: "synthetic-proof",
    attemptId: "synthetic-complete-attempt",
    encounter: "synthetic/complete",
    objectiveId: "PY:T01.1",
    depth: 1,
    facet: "reasoning",
    outcome: "independent",
    artifactSequences: [1],
    helpMessageIds: [],
    at: "2026-10-25T12:00:00Z",
    execution: "not-run",
    rationale: "Explained the tradeoff independently",
  });
  const before = structuredClone(g.study);
  const context = topicAssessmentContext(g, r, contract);
  const topic = context.topics.items[0];
  assert.equal(topic.passed, 1);
  assert.equal(topic.checkpoints[0].status, "verified");
  assert.equal(
    topic.checkpoints[0].evidence[0].rationale,
    "Explained the tradeoff independently",
  );
  assert.deepEqual(topic.curriculumScopes[0].currentCell!.proofs.D1, [
    "synthetic-proof",
  ]);
  assert.deepEqual(topic.curriculumScopes[0].scopeDefinitions, [
    ledger.scopes["PY:T01.1/D1"],
  ]);
  assert.deepEqual(g.study, before);
});

test("latest topic assessment follows question order across depths and ignores a late older completion", () => {
  const { g, e } = fixture();
  recordTopicAssessments(
    g,
    e,
    [{ topicId: "PY:T01", text: "Foundation view" }],
    {
      updatedAt: "2026-10-25T12:00:00Z",
    },
  );
  const deeper = structuredClone(e);
  deeper.problem!.contract.depth = 2;
  deeper.directStudy!.createdAt = 200;
  deeper.directStudy!.id = "synthetic-newer-deeper-question";
  deeper.directStudy!.questionFingerprint = "d".repeat(64);
  recordTopicAssessments(
    g,
    deeper,
    [{ topicId: "PY:T01", text: "Updated whole-topic view from depth two" }],
    {
      updatedAt: "2026-10-25T12:10:00Z",
    },
  );
  const late = structuredClone(e);
  late.problem!.contract.depth = 3;
  late.directStudy!.createdAt = 50;
  late.directStudy!.id = "synthetic-old-late-question";
  late.directStudy!.questionFingerprint = "c".repeat(64);
  recordTopicAssessments(
    g,
    late,
    [{ topicId: "PY:T01", text: "An older impression arriving later" }],
    {
      updatedAt: "2026-10-26T12:00:00Z",
    },
  );
  const before = structuredClone(g.study);
  const latest = latestTopicAssessment(g.study, "PY:T01");
  assert.equal(latest?.depth, 2);
  assert.equal(latest?.text, "Updated whole-topic view from depth two");
  assert.deepEqual(g.study, before);
  assert.equal(latestTopicAssessment(g.study, "PE:T01"), undefined);
});

test("latest assessment prefers current-source narratives, falls back to saved source, and ignores corrupt rows", () => {
  const { g, r } = fixture();
  const foundation = old("PY:T01");
  const newerSource = {
    ...old("PY:T01", 2),
    sourceHash: "b".repeat(64),
    startedAt: 200,
  };
  const unknownTime = {
    ...old("PY:T01", 3),
    startedAt: undefined,
    updatedAt: "2026-10-25T12:00:00Z",
  };
  g.study.topicAssessments = {
    "PY:T01/D1": foundation,
    "PY:T01/D2": newerSource,
    "PY:T01/D3": unknownTime,
  };
  assert.strictEqual(
    latestTopicAssessment(g.study, "PY:T01"),
    unknownTime,
    "Legacy records order by saved update time when question time is unavailable",
  );
  assert.strictEqual(
    latestTopicAssessment(g.study, "PY:T01", newerSource.sourceHash),
    newerSource,
  );
  assert.strictEqual(
    latestTopicAssessment(g.study, "PY:T01", "c".repeat(64)),
    unknownTime,
  );
  delete g.study.topicAssessments["PY:T01/D3"];
  assert.strictEqual(
    latestTopicAssessment(g.study, "PY:T01", r.sourceHash),
    foundation,
  );
  Object.assign(g.study.topicAssessments, {
    "PY:T01/D3": {
      ...old("PY:T01", 3),
      text: { unsafe: true },
      startedAt: 300,
    },
    "PY:T01/D4": {
      ...old("PY:T01", 4),
      updatedAt: "invalid date",
      startedAt: 400,
    },
    "PY:T01/D999": { ...old("PY:T01", 999), startedAt: 999 },
    "PY:T02/D1": { ...old("PY:T01"), startedAt: 500 },
    unknown: null,
  });
  assert.strictEqual(latestTopicAssessment(g.study, "PY:T01"), newerSource);
  const context = topicAssessmentContext(g, r, {
    id: "synthetic",
    track: "PY",
    objectiveIds: ["PY:T01.1"],
    scopes: [],
    depth: 1,
    phase: "DIAGNOSTIC",
    review: false,
    ledgerVersion: 0,
    priorEvidence: [],
  });
  assert.equal(context.priorAssessments.items.length, 2);
  (g.study as { topicAssessments?: unknown }).topicAssessments = "broken cache";
  assert.equal(latestTopicAssessment(g.study, "PY:T01"), undefined);
});
