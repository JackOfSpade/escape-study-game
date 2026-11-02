import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  checkBridge,
  ensureProblem,
  prepareNextQuestion,
  releaseRetiredChatRequests,
} from "../src/ai";
import { initialStudy } from "../src/curriculum";
import type { Contract, Problem, Roadmap } from "../src/model";
import { createPlayableGame } from "../src/world";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const problem = (contract: Contract, estimatedSolveSeconds = 900): Problem => ({
  title: "Prepared question",
  prompt: "Synthetic prepared question",
  starter: "",
  rubric: ["fixture"],
  provenance: "claude-cli",
  contract,
  estimatedSolveSeconds,
  scopeDefinitions: contract.objectiveIds.map((id, i) => ({
    id: `${id}/D${contract.depth}`,
    objectiveId: id,
    depth: contract.depth,
    sourceScope: contract.scopes[i],
    facets: [{ id: "scope", description: "Synthetic scope" }],
  })),
});
async function bridge(handler: (payload: any) => Promise<Response> | Response) {
  const original = globalThis.fetch;
  const calls: any[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Fake CLI",
        detail: "Fixture",
        capabilities: [],
      });
    const body = JSON.parse(String(init?.body));
    calls.push(body.payload);
    return handler(body.payload);
  };
  await checkBridge();
  return {
    calls,
    restore: async () => {
      globalThis.fetch = async () =>
        Response.json({
          mode: "development",
          label: "Development fallback",
          detail: "Fixture ended",
          capabilities: [],
        });
      await checkBridge();
      globalThis.fetch = original;
    },
  };
}
function world() {
  const g = createPlayableGame(42, r, initialStudy(r, "live"));
  g.status = "playing";
  const rooms = Object.values(g.encounters).filter((e) => e.questionRoom);
  const hall = rooms.find((e) => e.questionRoom === "f0-room2")!;
  const other = rooms.find((e) => e.questionRoom === "f1-room0")!;
  return { g, hall, other };
}
const settle = async (g: any) => {
  for (let i = 0; i < 20 && !g.study.preparedQuestion; i++)
    await new Promise((done) => setImmediate(done));
};
const untouched = (g: any) =>
  JSON.stringify([
    g.study.topicSpawn,
    g.study.learner?.scopes,
    g.fieldPacing,
    g.floors.flatMap((f: any) =>
      f.furniture.filter((o: any) => o.field).map((o: any) => o.maxHp),
    ),
  ]);

test("an unused prepared question touches no schedule, scope or door health", async () => {
  const { g, hall } = world();
  const fake = await bridge((p) => Response.json(problem(p.contract)));
  try {
    prepareNextQuestion(g, r);
    const before = untouched(g);
    await settle(g);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].encounterId, "prepared");
    assert.ok(g.study.preparedQuestion);
    assert.equal(untouched(g), before);
    assert.equal(hall.problem, undefined, "no room has it, so NPCs stay idle");
    prepareNextQuestion(g, r);
    assert.equal(fake.calls.length, 1, "only one is kept ready");
  } finally {
    await fake.restore();
  }
});

test("whichever room opens first gets it, with no second call, and pacing applies then", async () => {
  const { g, other } = world();
  const fake = await bridge((p) => Response.json(problem(p.contract)));
  try {
    prepareNextQuestion(g, r);
    await settle(g);
    const before = untouched(g);
    await ensureProblem(g, other, r);
    assert.equal(fake.calls.length, 1, "no second generation");
    assert.equal(other.problem?.title, "Prepared question");
    assert.equal(g.study.preparedQuestion, undefined);
    assert.notEqual(
      untouched(g),
      before,
      "spawn and pacing are recorded at issue",
    );
  } finally {
    await fake.restore();
  }
});

test("arriving during preparation joins that call instead of paying twice", async () => {
  const { g, hall } = world();
  let finish!: (r: Response) => void;
  const fake = await bridge(
    (p) =>
      new Promise((resolve) => {
        finish = () => resolve(Response.json(problem(p.contract)));
      }),
  );
  try {
    prepareNextQuestion(g, r);
    const opening = ensureProblem(g, hall, r);
    await new Promise((done) => setImmediate(done));
    finish(new Response());
    await opening;
    assert.equal(fake.calls.length, 1);
    assert.equal(hall.problem?.title, "Prepared question");
  } finally {
    await fake.restore();
  }
});

test("a question the schedule has moved past is dropped for a fresh one", async () => {
  const { g, hall } = world();
  const fake = await bridge((p) => Response.json(problem(p.contract)));
  try {
    prepareNextQuestion(g, r);
    await settle(g);
    const prepared = g.study.preparedQuestion!;
    prepared.contract = {
      ...prepared.contract,
      practice: false,
      objectiveIds: ["moved-on"],
    };
    await ensureProblem(g, hall, r);
    assert.equal(fake.calls.length, 2, "regenerated");
    assert.notEqual(hall.problem?.contract.objectiveIds[0], "moved-on");
  } finally {
    await fake.restore();
  }
});

test("preparation waits for the last assessment, so it knows the new gaps", async () => {
  const { g } = world();
  const fake = await bridge((p) => Response.json(problem(p.contract)));
  try {
    g.study.assessments.push({ status: "pending" } as never);
    prepareNextQuestion(g, r);
    assert.equal(fake.calls.length, 0);
    g.study.assessments.pop();
    prepareNextQuestion(g, r);
    await settle(g);
    assert.equal(fake.calls.length, 1);
  } finally {
    await fake.restore();
  }
});

test("a failed preparation is silent and a terminal still generates", async () => {
  const { g, hall } = world();
  let fail = true;
  const fake = await bridge((p) =>
    fail
      ? Response.json({ error: "down" }, { status: 502 })
      : Response.json(problem(p.contract)),
  );
  try {
    prepareNextQuestion(g, r);
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(g.study.preparedQuestion, undefined);
    prepareNextQuestion(g, r);
    await new Promise((done) => setTimeout(done, 20));
    assert.equal(
      fake.calls.length,
      1,
      "backs off instead of retrying each tick",
    );
    fail = false;
    await ensureProblem(g, hall, r);
    assert.equal(hall.error, undefined);
    assert.ok(hall.problem);
  } finally {
    await fake.restore();
  }
});

test("work waiting on the retired ChatGPT chat is freed for the game's terminal", async () => {
  const { g, hall, other } = world();
  const fake = await bridge((p) => Response.json(problem(p.contract)));
  try {
    hall.pendingGeneration = {
      provider: "chatgpt-handoff",
      requestId: "old",
      payload: {},
    };
    other.directStudy = {
      provider: "chatgpt-handoff",
      state: "pending",
    } as never;
    other.tutorRequests = [
      { provider: "chatgpt-handoff", state: "pending" },
    ] as never;
    other.submissions = [
      { status: "pending", completionRequest: { provider: "chatgpt-handoff" } },
    ] as never;
    releaseRetiredChatRequests(g);
    assert.equal(hall.pendingGeneration, undefined);
    assert.equal(other.directStudy, undefined);
    assert.equal((other.tutorRequests as any)[0].state, "superseded");
    assert.equal(other.submissions[0].status, "error");
    await ensureProblem(g, hall, r);
    assert.ok(hall.problem, "the terminal can generate again");
  } finally {
    await fake.restore();
  }
});
