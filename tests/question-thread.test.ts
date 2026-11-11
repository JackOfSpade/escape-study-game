import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { preparePracticeRooms } from "./helpers/practice-questions";
import {
  checkBridge,
  presentProblem,
  retryTutorRequest,
  send,
} from "../src/ai";
import { solveEstimate } from "../src/field-pacing";
import type { Encounter, Game, Problem, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import {
  assessmentDeferred,
  bindThread,
  carriedUnanswered,
  carriedVisits,
  isActiveVisit,
  openThread,
  resendableRequest,
  segmentPayload,
} from "../src/question-thread";
import { unfinishedEarlierVisits } from "../src/room-questions";
import { retainRunLearning } from "../src/run-learning";
import { createPlayableGame } from "../src/world";
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

test("field pacing uses the current part's estimate, not the whole question's", () => {
  const p = plan({
    contract: { objectiveIds: ["X"], depth: 2 },
  } as unknown as Problem);
  assert.equal(solveEstimate(p), 600);
});

async function fixture(
  run: (
    g: Game,
    stations: Encounter[],
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
    const g = createPlayableGame(717, r);
    preparePracticeRooms(g, r);
    const stations = g.floors
      .flatMap((f) => f.stations)
      .map((s) => g.encounters[s.encounter])
      .filter((e, i, all) => e && all.indexOf(e) === i)
      .slice(0, 3);
    for (const e of stations) {
      e.mode = "solo";
      e.owner = "human";
    }
    stations[0].problem = plan(stations[0].problem!);
    connected = true;
    await checkBridge();
    await run(g, stations, (fn) => (respond = fn), calls);
  } finally {
    connected = false;
    await checkBridge();
    globalThis.fetch = original;
  }
}

test("a segmented question continues at the next terminal with its history, one key per part", async () =>
  fixture(async (g, [first, second], reply, calls) => {
    const keys = g.survivors[0].keys ?? 0;
    presentProblem(g, first, r);
    const t = openThread(g)!;
    assert.ok(t, "showing the question starts its thread");
    assert.deepEqual(first.thread, { id: t.id, segment: 0 });
    assert.ok(assessmentDeferred(g, first));
    await send(g, first, "tutor", "The total is 12", r);
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
    await send(g, first, "tutor", "The boundary is the last index", r);
    assert.equal(first.state, "consumed");
    assert.equal(g.survivors[0].keys, keys + 1);
    assert.equal(t.segment, 1);
    assert.equal(t.visits[0].completed, true);
    assert.equal(t.visits[0].keyGranted, true);
    // A second delivery of the same reply cannot grant another key.
    await retryTutorRequest(g, first, first.tutorRequests!.at(-1)!.id, r);
    assert.equal(g.survivors[0].keys, keys + 1);
    assert.equal(t.segment, 1);

    assert.equal(bindThread(g, second), true);
    assert.deepEqual(second.problem, first.problem);
    assert.deepEqual(second.thread, { id: t.id, segment: 1 });
    assert.ok(isActiveVisit(g, second));
    assert.equal(carriedVisits(g, second)[0].messages.length, 4);
    assert.equal(unfinishedEarlierVisits(g, second).runs, 0);
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
    await send(g, second, "tutor", "Use < instead of <=", r);
    assert.equal(second.state, "consumed");
    assert.equal(g.survivors[0].keys, keys + 2);
    assert.ok(t.finishedAt, "the last part finishes the thread");
    assert.equal(openThread(g), undefined);
    assert.equal(assessmentDeferred(g, first), false);
  }));

test("only the terminal opened last can finish the current part", async () =>
  fixture(async (g, [first, second], reply) => {
    const keys = g.survivors[0].keys ?? 0;
    presentProblem(g, first, r);
    await send(g, first, "tutor", "Started here", r);
    assert.equal(bindThread(g, second), true);
    reply(async () => Response.json({ text: "Solved", complete: true }));
    await send(g, first, "tutor", "Answer at the old terminal", r);
    assert.notEqual(first.state, "consumed");
    assert.equal(g.survivors[0].keys ?? 0, keys);
    // Opening the first terminal again moves the question back there.
    assert.equal(bindThread(g, first), true);
    assert.ok(isActiveVisit(g, first));
    assert.equal(isActiveVisit(g, second), false);
  }));

test("a reply cut off by a reload is resent once as the same request, with no lost or doubled turn", async () =>
  fixture(async (g, [first], reply, calls) => {
    presentProblem(g, first, r);
    reply(async () =>
      Response.json({ error: "Relay restarted" }, { status: 503 }),
    );
    await send(g, first, "tutor", "My answer before the crash", r);
    const loaded = recover(decode(encode(g)));
    const resumed = loaded.encounters[first.id];
    assert.equal(openThread(loaded)?.id, openThread(g)?.id);
    assert.equal(bindThread(loaded, resumed), true);
    const job = resendableRequest(resumed)!;
    assert.ok(job, "the interrupted turn is resendable");
    job.resent = true;
    reply(async () => Response.json({ text: "Go on.", complete: false }));
    await retryTutorRequest(loaded, resumed, job.id, r);
    assert.deepEqual(calls.at(-1).payload, calls.at(-2).payload);
    assert.equal(
      resumed.tutor.filter((m) => m.kind === "human").length,
      1,
      "the learner's message is not duplicated",
    );
    assert.equal(resumed.tutor.filter((m) => m.kind === "tutor").length, 1);
    assert.equal(resendableRequest(resumed), undefined);
  }));

test("after death the part keeps its chat and progress into the next run, without a second key", async () =>
  fixture(async (g, [first], reply) => {
    presentProblem(g, first, r);
    await send(g, first, "tutor", "First thought", r);
    reply(async () =>
      Response.json({ error: "Relay restarted" }, { status: 503 }),
    );
    await send(g, first, "tutor", "Unanswered thought", r);
    g.status = "dead";
    g.survivors[0].alive = false;
    retainRunLearning(g, true);
    const study = recover(decode(encode(g))).study;
    const next = createPlayableGame(718, r, study);
    preparePracticeRooms(next, r);
    const terminal = next.encounters[next.floors[0].stations[0].encounter];
    terminal.mode = "solo";
    terminal.owner = "human";
    const t = openThread(next)!;
    assert.equal(t.segment, 0);
    assert.equal(bindThread(next, terminal), true);
    const carried = carriedVisits(next, terminal);
    assert.equal(carried.length, 1);
    assert.deepEqual(
      carried[0].messages.filter((m) => m.kind === "human").map((m) => m.text),
      ["First thought", "Unanswered thought"],
    );
    assert.equal(segmentPayload(next, terminal)!.carriedConversation.length, 3);
    assert.equal(carriedUnanswered(next, terminal), "Unanswered thought");
    assert.deepEqual(terminal.problem, first.problem);
  }));

test("a part finished after death counts as done but grants no key", async () =>
  fixture(async (g, [first], reply) => {
    const keys = g.survivors[0].keys ?? 0;
    presentProblem(g, first, r);
    g.status = "dead";
    g.survivors[0].alive = false;
    reply(async () => Response.json({ text: "Part done", complete: true }));
    await send(g, first, "tutor", "Answer after dying", r);
    const t = g.study.thread!;
    assert.equal(t.segment, 1);
    assert.equal(t.visits[0].completed, true);
    assert.equal(t.visits[0].keyGranted, false);
    assert.equal(g.survivors[0].keys ?? 0, keys);
  }));

test("a terminal holding another started question is not taken over", async () =>
  fixture(async (g, [first, second]) => {
    presentProblem(g, first, r);
    second.problemPresentedSequence = 1;
    assert.equal(bindThread(g, second), false);
    assert.equal(second.thread, undefined);
  }));
