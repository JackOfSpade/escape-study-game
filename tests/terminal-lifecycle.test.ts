import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, completeQuestion, ensureProblem, send } from "../src/ai";
import { eligible } from "../src/curriculum";
import type { Problem, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(7, r),
    e = g.encounters["question-0"];
  e.state = "in-progress";
  e.contributors = ["human"];
  return { g, e };
}
function problem(contract: Problem["contract"]): Problem {
  return {
    title: "Synthetic delayed question",
    prompt: "Synthetic lifecycle fixture",
    starter: "Retained starter",
    rubric: ["fixture"],
    provenance: "claude-cli",
    contract,
    scopeDefinitions: contract.objectiveIds.map((id, i) => ({
      id: `${id}/D${contract.depth}`,
      objectiveId: id,
      depth: contract.depth,
      sourceScope: contract.scopes[i],
      facets: [{ id: "scope", description: "Synthetic scope" }],
    })),
  };
}
async function bridge(handler: (body: any) => Promise<Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) =>
    String(input) === "/api/status"
      ? Response.json({
          mode: "claude-cli",
          label: "Synthetic lifecycle bridge",
          detail: "Not native verification",
          capabilities: [],
        })
      : handler(JSON.parse(String(init?.body)));
  await checkBridge();
  return async () => {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Development fallback",
        detail: "Fixture ended",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
test("a delayed generation cannot resurrect a completed question or register a new academic scope", async () => {
  const { g, e } = fixture();
  g.study.profile = "live";
  let finish!: (v: Response) => void, payload: any;
  const restore = await bridge(async (body) => {
    payload = body.payload;
    return new Promise((resolve) => (finish = resolve));
  });
  try {
    const pending = ensureProblem(g, e, r);
    while (!finish) await tick();
    completeQuestion(g, e, "already-accepted", "Fixture completion");
    const learner = JSON.stringify(g.study.learner);
    finish(Response.json(problem(payload.contract)));
    await pending;
    assert.equal(e.state, "consumed");
    assert.equal(e.accepted, "already-accepted");
    assert.equal(e.problem, undefined);
    assert.equal(JSON.stringify(g.study.learner), learner);
  } finally {
    await restore();
  }
});
test("an older generation response cannot replace or clear a newer request", async () => {
  const { g, e } = fixture();
  g.study.profile = "live";
  const queued: { payload: any; finish: (r: Response) => void }[] = [];
  const restore = await bridge(
    async (body) =>
      new Promise((resolve) =>
        queued.push({ payload: body.payload, finish: resolve }),
      ),
  );
  try {
    const first = ensureProblem(g, e, r);
    while (queued.length < 1) await tick();
    delete e.generation;
    delete e.pendingGeneration;
    const second = ensureProblem(g, e, r);
    while (queued.length < 2) await tick();
    assert.notEqual(queued[0].payload.requestId, queued[1].payload.requestId);
    const current = e.generation;
    queued[0].finish(Response.json(problem(queued[0].payload.contract)));
    await first;
    assert.equal(e.problem, undefined);
    assert.equal(e.generation, current);
    queued[1].finish(Response.json(problem(queued[1].payload.contract)));
    await second;
    assert.equal(
      (e.problem as Problem | undefined)?.title,
      "Synthetic delayed question",
    );
    assert.equal(e.generation, undefined);
  } finally {
    await restore();
  }
});
test("native generation retries its exact saved packet after an outage and reload", async () => {
  const { g, e } = fixture();
  g.study.profile = "live";
  const packets: any[] = [];
  const restore = await bridge(async (body) => {
    packets.push(body);
    return packets.length === 1
      ? Response.json({ error: "Synthetic outage" }, { status: 503 })
      : Response.json(problem(body.payload.contract));
  });
  try {
    await ensureProblem(g, e, r);
    assert.equal(e.problem, undefined);
    assert.ok(e.pendingGeneration);
    const restored = recover(decode(encode(g)));
    // A save made under the retired chat cannot be retried over this connection.
    const saved = restored.encounters[e.id].pendingGeneration!;
    saved.provider = "chatgpt-handoff";
    await ensureProblem(restored, restored.encounters[e.id], r);
    assert.equal(packets.length, 1);
    assert.match(
      restored.encounters[e.id].error!,
      /original generation provider/,
    );
    saved.provider = "claude-cli";
    await ensureProblem(restored, restored.encounters[e.id], r);
    assert.deepEqual(packets[1], packets[0]);
    assert.equal(
      restored.encounters[e.id].problem?.title,
      "Synthetic delayed question",
    );
  } finally {
    await restore();
  }
});
test("late completion errors and successes cannot reopen or rewrite another accepted completion", async () => {
  for (const failure of [true, false]) {
    const { g, e } = fixture();
    g.study.profile = "live";
    e.problem = problem(eligible(r, g.study));
    let finish!: (r: Response) => void;
    const restore = await bridge(
      async () => new Promise((resolve) => (finish = resolve)),
    );
    try {
      const pending = send(g, e, "Fixture answer", r);
      while (!finish) await tick();
      completeQuestion(g, e, "winning-completion", "Fixture accepted outcome");
      const accepted = {
        workspace: e.workspace,
        revision: e.revision,
        history: e.history.filter((h) => h.kind === "completion").length,
      };
      finish(
        failure
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json({ text: "late", complete: true }),
      );
      await pending;
      assert.equal(e.state, "consumed");
      assert.equal(e.accepted, "winning-completion");
      assert.equal(e.workspace, accepted.workspace);
      assert.equal(e.revision, accepted.revision);
      assert.equal(
        e.history.filter((h) => h.kind === "completion").length,
        accepted.history,
      );
      assert.equal(e.submissions.length, 0);
    } finally {
      await restore();
    }
  }
});

test("a received native question retains its scope registration if connection status changes while the request is in flight", async () => {
  const { g, e } = fixture();
  g.study.profile = "live";
  let finish!: (r: Response) => void, payload: any;
  const restore = await bridge(async (body) => {
    payload = body.payload;
    return new Promise((resolve) => (finish = resolve));
  });
  try {
    const pending = ensureProblem(g, e, r);
    while (!finish) await tick();
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Disconnected fixture",
        detail: "Synthetic outage",
        capabilities: [],
      });
    await checkBridge();
    finish(Response.json(problem(payload.contract)));
    await pending;
    assert.equal(e.problem?.provenance, "claude-cli");
    assert.ok(g.study.learner!.scopes[e.problem!.scopeDefinitions![0].id]);
    assert.equal(g.study.learner!.evidence.length, 0);
  } finally {
    await restore();
  }
});

test("a generation response from a replaced study profile cannot install a question or scope in the new profile", async () => {
  const { g, e } = fixture();
  g.study.profile = "live";
  let finish!: (r: Response) => void, payload: any;
  const restore = await bridge(async (body) => {
    payload = body.payload;
    return new Promise((resolve) => (finish = resolve));
  });
  try {
    const pending = ensureProblem(g, e, r);
    while (!finish) await tick();
    g.study.profile = "development";
    const snapshot = JSON.stringify(g.study);
    finish(Response.json(problem(payload.contract)));
    await pending;
    assert.equal(e.problem, undefined);
    assert.equal(e.generation, undefined);
    assert.equal(JSON.stringify(g.study), snapshot);
  } finally {
    await restore();
  }
});

test("accepting a captured submission freezes its revision against a newer draft", async () => {
  const { edit } = await import("../src/ai");
  const { g, e } = fixture();
  g.study.profile = "live";
  e.problem = problem(eligible(r, g.study));
  edit(g, e, "Captured actual revision", 0);
  const captured = e.workspace,
    revision = e.revision;
  e.submissions.push({
    id: "captured-answer",
    revision,
    author: "human",
    content: captured,
    seq: ++g.seq,
    status: "pending",
    feedback: "",
  });
  edit(g, e, "Newer unsubmitted draft", e.revision);
  completeQuestion(g, e, "captured-answer", "First accepted outcome");
  assert.equal(e.state, "consumed");
  assert.equal(e.workspace, captured);
  assert.equal(e.revision, revision);
  assert.equal(
    e.history.find((h) => h.kind === "completion")!.revision,
    revision,
  );
  assert.equal(e.submissions[0].status, "complete");
  assert.equal(e.submissions[0].feedback, "First accepted outcome");
  assert.equal(e.history.filter((h) => h.kind === "completion").length, 1);
});
