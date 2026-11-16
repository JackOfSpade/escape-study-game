import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preparePracticeRooms } from "./helpers/practice-questions";
import { checkBridge, send } from "../src/ai";
import type { Encounter, StudyRecord, Problem, Roadmap } from "../src/model";
import {
  assessmentDeferred,
  carriedVisits,
  isActiveVisit,
  openThread,
  segmentPayload,
} from "../src/question-thread";
import { createGame } from "./helpers/record";
import {
  SEGMENT_POLICY,
  validateQuestionSegments,
} from "../scripts/lib/question-segments.mjs";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

/** A long question planned as two parts of rubric and facets. */
function plan(base: Problem): Problem {
  return {
    ...structuredClone(base),
    rubric: ["Predicts the total", "Names the boundary", "Proposes the fix"],
    scopeDefinitions: [
      {
        id: "scope-1",
        objectiveId: base.contract.objectiveIds[0],
        depth: base.contract.depth,
        sourceScope: "Synthetic scope",
        facets: [
          { id: "total", description: "Predicted total" },
          { id: "boundary", description: "Boundary" },
          { id: "fix", description: "Fix" },
        ],
      },
    ] as Problem["scopeDefinitions"],
    estimatedSolveSeconds: 1200,
    segments: [
      {
        goal: "Trace the loop and predict the total.",
        rubricItems: [0, 1],
        facets: ["total", "boundary"],
        estimatedSolveSeconds: 600,
      },
      {
        goal: "Propose and justify a fix.",
        rubricItems: [2],
        facets: ["fix"],
        estimatedSolveSeconds: 600,
      },
    ],
  };
}

test("segment plans: whole questions stay short, long ones are split with exact rubric coverage", () => {
  const base = { rubric: ["a"], scopeDefinitions: [] };
  assert.doesNotThrow(() =>
    validateQuestionSegments({ ...base, estimatedSolveSeconds: 900 }),
  );
  assert.throws(
    () => validateQuestionSegments({ ...base, estimatedSolveSeconds: 901 }),
    /requires segments/,
  );
  const good = plan({
    contract: { objectiveIds: ["X"], depth: 2 },
  } as unknown as Problem);
  assert.doesNotThrow(() => validateQuestionSegments(good));
  const broken = (patch: (p: Problem) => void) => {
    const p = structuredClone(good);
    patch(p);
    return () => validateQuestionSegments(p);
  };
  assert.throws(
    broken((p) => (p.estimatedSolveSeconds = 800)),
    /shorter questions stay whole/,
  );
  assert.throws(
    broken((p) => (p.segments![1].rubricItems = [1, 2])),
    /more than one segment/,
  );
  assert.throws(
    broken((p) => (p.segments![1].rubricItems = [])),
    /at least one rubric index/,
  );
  assert.throws(
    broken((p) => (p.segments![0].rubricItems = [0])),
    /exactly one segment/,
  );
  assert.throws(
    broken((p) => (p.segments![1].facets = ["invented"])),
    /facet ids/,
  );
  assert.throws(
    broken((p) => (p.segments![0].estimatedSolveSeconds = 120)),
    /360 to 900/,
  );
  assert.throws(
    broken((p) => (p.segments![1].goal = p.segments![0].goal)),
    /repeats/,
  );
  assert.throws(
    broken((p) => (p.estimatedSolveSeconds = 2400)),
    /add up/,
  );
  assert.throws(
    broken((p) => (p.segments = [p.segments![0]])),
    /2 to 6/,
  );
  assert.equal(SEGMENT_POLICY.targetSeconds, 600);
});

test("the gateway contract rejects a long unsplit question and accepts a valid plan", async () => {
  // The gateway contract module ships without type declarations.
  const contracts = "../scripts/lib/ai-contracts.mjs";
  const { validateAnswer } = await import(contracts);
  const contract = { track: "PY", objectiveIds: ["X"], depth: 2 };
  const job = (answer: unknown) => () =>
    validateAnswer({ operation: "generate", payload: { contract } }, answer);
  const answer = {
    ...plan({ contract } as unknown as Problem),
    title: "T",
    prompt: "P",
    starter: "",
    contract,
  };
  assert.doesNotThrow(job(answer));
  const { segments: _dropped, ...unsplit } = answer;
  assert.throws(job(unsplit), /requires segments/);
  assert.throws(
    () =>
      validateAnswer(
        { operation: "tutor", payload: { mode: "terminal-dialogue" } },
        { text: "ok", complete: true, segmentSummary: 7 },
      ),
    /segmentSummary/,
  );
});

async function fixture(
  run: (
    g: StudyRecord,
    parts: Encounter[],
    reply: (fn: (p: any) => Promise<Response>) => void,
    calls: any[],
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
    const g = createGame(717, r);
    preparePracticeRooms(g, r);
    const parts = [g.encounters["question-0"], g.encounters["question-1"]];
    for (const e of parts) e.owner = "human";
    parts[0].problem = plan(parts[0].problem!);
    // A save from the game can hold a question already continued across
    // parts: the thread lives in study state, each part in its own record.
    const key = (e: Encounter) => `${e.runId}/${e.id}`;
    g.study.thread = {
      id: "thread-synthetic",
      problem: structuredClone(parts[0].problem!),
      segment: 0,
      visits: [{ encounter: key(parts[0]), runId: g.id, segment: 0, at: 1 }],
      active: key(parts[0]),
      startedAt: "2026-01-01T00:00:00.000Z",
    };
    parts[0].thread = { id: "thread-synthetic", segment: 0 };
    connected = true;
    await checkBridge();
    await run(g, parts, (fn) => (respond = fn), calls);
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
}

test("a saved segmented question finishes its current part and carries its history to the next", async () =>
  fixture(async (g, [first, second], reply, calls) => {
    const t = openThread(g)!;
    assert.ok(assessmentDeferred(g, first));
    await send(g, first, "The total is 12", r);
    assert.equal(calls.at(-1).payload.segment.index, 0);
    assert.equal(calls.at(-1).payload.segment.count, 2);
    assert.deepEqual(calls.at(-1).payload.segment.rubric, [
      "Predicts the total",
      "Names the boundary",
    ]);
    reply(async () =>
      Response.json({
        text: "Part one done.",
        complete: true,
        segmentSummary: "Predicted the total and found the boundary.",
      }),
    );
    await send(g, first, "The boundary is the last index", r);
    assert.equal(first.state, "consumed");
    assert.equal(t.segment, 1);
    assert.equal(t.visits[0].completed, true);
    // The next part continues the same question in another record.
    second.problem = structuredClone(first.problem);
    second.thread = { id: t.id, segment: 1 };
    t.active = `${second.runId}/${second.id}`;
    t.visits.push({
      encounter: t.active,
      runId: g.id,
      segment: 1,
      at: 2,
    });
    assert.ok(isActiveVisit(g, second));
    assert.equal(carriedVisits(g, second)[0].messages.length, 4);
    const block = segmentPayload(g, second)!;
    assert.equal(block.goal, "Propose and justify a fix.");
    assert.deepEqual(block.earlier, [
      {
        index: 0,
        goal: "Trace the loop and predict the total.",
        summary: "Predicted the total and found the boundary.",
      },
    ]);
    reply(async () => Response.json({ text: "All done.", complete: true }));
    await send(g, second, "Use < instead of <=", r);
    assert.equal(second.state, "consumed");
    assert.ok(t.finishedAt, "the last part finishes the thread");
    assert.equal(openThread(g), undefined);
    assert.equal(assessmentDeferred(g, first), false);
  }));

test("only the part opened last can finish the current one", async () =>
  fixture(async (g, [first, second], reply) => {
    const t = openThread(g)!;
    await send(g, first, "Started here", r);
    second.problem = structuredClone(first.problem);
    second.thread = { id: t.id, segment: 0 };
    t.active = `${second.runId}/${second.id}`;
    reply(async () => Response.json({ text: "Solved", complete: true }));
    await send(g, first, "Answer in the older part", r);
    assert.notEqual(first.state, "consumed");
    assert.equal(t.segment, 0);
    assert.equal(isActiveVisit(g, first), false);
    assert.ok(isActiveVisit(g, second));
  }));
