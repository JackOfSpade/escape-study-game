import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, ensureProblem, presentProblem, submit } from "../src/ai";
import { eligible } from "../src/curriculum";
import { claimStation, complete, releaseStation, step } from "../src/engine";
import type { Problem, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(7, r),
    e = g.encounters["f0-room0"],
    f = g.floors[0],
    ss = f.stations.filter((s) => s.encounter === e.id),
    a = g.survivors[1];
  g.status = "playing";
  g.surge.anchor = 10000;
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.zombies = [];
  g.survivors = [g.survivors[0], a];
  f.furniture = [];
  f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  Object.assign(a, {
    x: ss[1].x,
    y: ss[1].y,
    station: ss[1].id,
    intent: e.id,
    activity: "studying",
    role: "analyst",
    social: 0.3,
    thought: 0,
    seen: ss.map((s) => s.id),
  });
  e.npcProgress = 1.1;
  e.contributors = [a.id];
  e.state = "in-progress";
  return { g, e, a, ss };
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
test("reading or awaiting a shared question cannot be consumed by abstract NPC progress, including after leaving and reload", async () => {
  const { g, e, ss } = fixture();
  Object.assign(g.survivors[0], { x: ss[0].x, y: ss[0].y });
  assert.ok(claimStation(g, g.survivors[0], ss[0].id));
  await ensureProblem(g, e, r);
  presentProblem(g, e);
  const prompt = JSON.stringify(e.problem),
    study = JSON.stringify(g.study);
  assert.equal(
    e.history.some((h) => h.author === "human" && h.kind === "edit"),
    false,
  );
  step(g, 1 / 30);
  assert.equal(e.state, "in-progress");
  releaseStation(g.survivors[0]);
  const restored = recover(decode(encode(g)));
  step(restored, 1 / 30);
  assert.equal(restored.encounters[e.id].state, "in-progress");
  assert.equal(JSON.stringify(restored.encounters[e.id].problem), prompt);
  assert.equal(JSON.stringify(g.study), study);
});
test("legacy displayed questions and private/public human questions also require real completion work", () => {
  for (const interaction of ["displayed", "private", "public"]) {
    const { g, e } = fixture();
    e.problem = problem(eligible(r, g.study));
    if (interaction === "displayed") e.problemPresentedSequence = 10;
    else
      e[interaction === "private" ? "tutor" : "group"].push({
        id: "legacy-human-question",
        kind: "human",
        author: "human",
        text: "How do I reason about this?",
        seq: 10,
        worldTime: 0,
        provenance: "live-human",
      });
    step(g, 1 / 30);
    assert.equal(e.state, "in-progress", interaction);
  }
});
test("an unobserved NPC academic simulation still completes and rewards an already-qualified defender without an exam", () => {
  const { g, e, a } = fixture();
  e.contributors.push("human");
  e.history.push({
    seq: ++g.seq,
    author: "human",
    kind: "defense",
    text: "Previously qualified physical defender fixture",
    revision: 0,
    at: 0,
  });
  step(g, 1 / 30);
  assert.equal(e.state, "consumed");
  assert.ok(a.access.includes(0));
  assert.ok(g.survivors[0].access.includes(0));
  assert.equal(e.problem, undefined);
  assert.equal(g.study.visits.length, 0);
  assert.equal(g.study.learner!.evidence.length, 0);
});
test("a delayed generation cannot resurrect a consumed lock or register a new academic scope", async () => {
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
    complete(g, e.id, "already-accepted", e.contributors, "Fixture completion");
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
      const pending = submit(g, e, r);
      while (!finish) await tick();
      complete(
        g,
        e.id,
        "winning-completion",
        e.contributors,
        "Fixture accepted outcome",
      );
      const accepted = {
        workspace: e.workspace,
        revision: e.revision,
        history: e.history.filter((h) => h.kind === "completion").length,
      };
      finish(
        failure
          ? Response.json({ error: "offline" }, { status: 503 })
          : Response.json({
              complete: true,
              feedback: "late",
              qualified: ["human"],
            }),
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
      assert.notEqual(e.submissions.at(-1)!.status, "pending");
    } finally {
      await restore();
    }
  }
});

test("in-flight question generation defers abstract completion while ordinary simulation continues", async () => {
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
    const time = g.time;
    step(g, 1 / 30);
    assert.ok(g.time > time);
    assert.equal(e.state, "in-progress");
    assert.equal(e.problem, undefined);
    finish(Response.json(problem(payload.contract)));
    await pending;
    assert.equal(
      (e.problem as Problem | undefined)?.title,
      "Synthetic delayed question",
    );
    assert.equal(e.state, "in-progress");
    assert.equal(g.study.learner!.evidence.length, 0);
  } finally {
    await restore();
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

test("accepting a captured submission freezes its revision and later duplicate errors or successes cannot invalidate it", async () => {
  const { edit } = await import("../src/ai");
  for (const failure of [true, false]) {
    const { g, e, a } = fixture();
    g.study.profile = "live";
    e.problem = problem(eligible(r, g.study));
    edit(g, e, "Captured actual revision", 0);
    const captured = e.workspace,
      revision = e.revision;
    let finish!: (r: Response) => void;
    const restore = await bridge(
      async () => new Promise((resolve) => (finish = resolve)),
    );
    try {
      const pending = submit(g, e, r);
      while (!finish) await tick();
      const s = e.submissions.at(-1)!;
      edit(g, e, "Newer unsubmitted draft", e.revision);
      complete(g, e.id, s.id, [a.id], "First accepted outcome");
      finish(
        failure
          ? Response.json({ error: "late outage" }, { status: 503 })
          : Response.json({
              complete: true,
              feedback: "Different late feedback",
              qualified: [],
            }),
      );
      await pending;
      assert.equal(e.state, "consumed");
      assert.equal(e.workspace, captured);
      assert.equal(e.revision, revision);
      assert.equal(
        e.history.find((h) => h.kind === "completion")!.revision,
        revision,
      );
      assert.equal(s.status, "complete");
      assert.equal(s.feedback, "First accepted outcome");
      assert.equal(e.history.filter((h) => h.kind === "completion").length, 1);
    } finally {
      await restore();
    }
  }
});
