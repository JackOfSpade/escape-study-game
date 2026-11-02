import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { autonomousNpcWork, checkBridge } from "../src/ai";
import { eligible } from "../src/curriculum";
import {
  assistanceSources,
  initialLearner,
  reconcileGates,
} from "../src/learner";
import type { Roadmap } from "../src/model";
import { recordNpcWork } from "../src/npc-cognition";
import {
  materializeNpcWork,
  type WorkPayload,
} from "../src/npc-materialization";
import { decode, encode, recover } from "../src/persistence";
import { sha256 } from "../src/roadmap-export";
import { presentSharedWorkspace } from "../src/workspace-exposure";
import { applyAutonomousProposal } from "../src/workspace-proposals";
import { createGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
function fixture() {
  const g = createGame(7, r),
    e = g.encounters["f0-room0"],
    ss = g.floors[0].stations.filter((s) => s.encounter === e.id),
    a = g.survivors[1],
    h = g.survivors[0];
  g.status = "playing";
  g.study.profile = "live";
  g.zombies = [];
  g.nextSpawn = Number.MAX_SAFE_INTEGER;
  g.survivors = [h, a];
  g.floors[0].furniture = [];
  g.floors[0].tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  Object.assign(a, {
    x: ss[1].x,
    y: ss[1].y,
    station: ss[1].id,
    intent: e.id,
    activity: "studying",
    milestone: 1,
  });
  Object.assign(h, { x: ss[0].x, y: ss[0].y, station: undefined });
  e.state = "in-progress";
  e.humanEngaged = true;
  e.workspace = e.workspaceBase = "abc";
  e.problem = {
    title: "Synthetic autonomy fixture",
    prompt: "Boundary reasoning",
    starter: "abc",
    rubric: ["fixture"],
    provenance: "study-mode",
    contract: eligible(r, g.study),
  };
  recordNpcWork(g, e, a, false);
  return { g, e, a, h, ss };
}
function reply(p: WorkPayload) {
  return {
    requestId: p.requestId,
    sourceRevision: p.sourceRevision,
    notes: p.work.map((w) => ({
      workId: w.id,
      author: w.actor,
      text: "Tentative boundary candidate.",
      refs: [w.seq],
      patch: { prefix: 1, removed: "b", inserted: "BOUNDARY" },
      readyToSubmit: true,
    })),
  };
}
async function prepare(f: ReturnType<typeof fixture>) {
  await materializeNpcWork(f.g, f.e, async (p) => reply(p), false, {
    background: true,
    allowAutonomous: true,
  });
  assert.equal(f.e.proposals?.length, 1);
  return f.e.proposals![0];
}
test("autonomous edits are attributed, unexposed until the current workspace is displayed, and deduplicated on reload", async () => {
  const f = fixture(),
    p = await prepare(f),
    study = JSON.stringify(f.g.study);
  applyAutonomousProposal(f.g, f.e, p.id);
  assert.equal(f.e.workspace, "aBOUNDARYc");
  assert.equal(f.e.history.at(-1)?.author, f.a.id);
  assert.equal(assistanceSources(f.e).length, 0);
  presentSharedWorkspace(f.g, f.e);
  assert.equal(assistanceSources(f.e).length, 0);
  f.h.station = f.ss[0].id;
  presentSharedWorkspace(f.g, f.e);
  const sources = assistanceSources(f.e);
  assert.equal(sources.length, 1);
  assert.ok(sources[0].text.includes("aBOUNDARYc"));
  assert.equal(JSON.stringify(f.g.study), study);
  const saved = recover(decode(encode(f.g))),
    e = saved.encounters[f.e.id];
  saved.survivors[0].station = f.ss[0].id;
  presentSharedWorkspace(saved, e);
  assert.equal(e.history.filter((h) => h.kind === "workspace-view").length, 1);
});
test("active human, changed source, absent author and unapproved candidates reject atomically", async () => {
  for (const scenario of [
    "human",
    "stale",
    "dead",
    "unseated",
    "solo",
    "pending",
    "unapproved",
    "wrongrun",
    "question",
  ]) {
    const f = fixture(),
      p = await prepare(f);
    if (scenario === "human") f.h.station = f.ss[0].id;
    if (scenario === "stale") f.e.workspace += "changed";
    if (scenario === "dead") f.a.alive = false;
    if (scenario === "unseated") f.a.station = undefined;
    if (scenario === "solo") f.e.mode = "solo";
    if (scenario === "pending")
      f.e.submissions.push({
        id: "pending",
        revision: 0,
        author: "human",
        content: "abc",
        status: "pending",
        feedback: "",
        seq: 0,
      });
    if (scenario === "unapproved")
      f.e.materializations![0].autonomyAllowed = false;
    if (scenario === "wrongrun") f.e.runId = "other";
    if (scenario === "question") f.e.problem!.prompt = "changed question";
    const before = JSON.stringify(f.g);
    assert.throws(
      () => applyAutonomousProposal(f.g, f.e, p.id),
      Error,
      scenario,
    );
    assert.equal(JSON.stringify(f.g), before, scenario);
  }
});
test("provider readiness cannot activate autonomy without client opt-in", async () => {
  const f = fixture();
  f.h.station = f.ss[0].id;
  await materializeNpcWork(f.g, f.e, async (p) => reply(p));
  assert.equal(f.e.materializations![0].state, "failed");
  assert.equal(f.e.proposals?.length ?? 0, 0);
});
test("background NPC completion uses public history, preserves authorship and earns no human evidence or study visits", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  let completions = 0,
    requests = 0,
    captured: any;
  f.e.tutor.push({
    id: "secret",
    author: "human",
    kind: "human",
    text: "PRIVATE_SECRET",
    seq: ++f.g.seq,
    worldTime: 0,
    provenance: "live-human",
  });
  f.e.history.push({
    seq: f.g.seq,
    author: "human",
    kind: "chat",
    text: "PRIVATE_SECRET",
    at: 0,
    revision: 0,
  });
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic",
        detail: "Not genuine native verification",
        capabilities: ["materialize-work", "autonomous-work"],
      });
    const body = JSON.parse(String(init?.body));
    requests++;
    if (body.operation === "materialize-work")
      return Response.json(reply(body.payload));
    assert.equal(body.operation, "complete");
    completions++;
    captured = body.payload;
    return Response.json({
      complete: true,
      feedback: "Synthetic acceptance",
      qualified: [f.a.id],
    });
  };
  try {
    await checkBridge();
    await autonomousNpcWork(f.g, r);
    assert.equal(f.e.workspace, "abc");
    await autonomousNpcWork(f.g, r);
    assert.equal(completions, 1);
    assert.equal(f.e.state, "consumed");
    assert.equal(f.e.submissions[0].author, f.a.id);
    assert.ok(!JSON.stringify(captured).includes("PRIVATE_SECRET"));
    assert.equal(f.g.study.visits.length, 0);
    assert.equal(f.g.study.learner!.evidence.length, 0);
    assert.equal(f.g.study.assessments.length, 0);
    assert.ok(f.a.access.includes(0));
    assert.ok(!f.h.access.includes(0));
    assert.equal(f.e.group.length, 0);
    assert.equal(
      assistanceSources(f.e).filter((s) => s.kind === "npc").length,
      0,
    );
    assert.equal(autonomousNpcWork(f.g, r), undefined);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Fixture ended",
        detail: "",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});
test("failed captured autonomous submission is retained without automatic retry", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic",
        detail: "Fixture",
        capabilities: ["materialize-work", "autonomous-work"],
      });
    const b = JSON.parse(String(init?.body));
    if (b.operation === "materialize-work")
      return Response.json(reply(b.payload));
    calls++;
    throw Error("offline");
  };
  try {
    await checkBridge();
    await autonomousNpcWork(f.g, r);
    await autonomousNpcWork(f.g, r);
    assert.equal(f.e.submissions[0].status, "error");
    for (let i = 0; i < 5; i++) await autonomousNpcWork(f.g, r);
    assert.equal(calls, 1);
    assert.equal(f.e.submissions.length, 1);
    assert.equal(f.g.study.visits.length, 0);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Fixture ended",
        detail: "",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});
test("NPC executable submissions carry only NPC edit references and actual captured runner receipts", async () => {
  const f = fixture(),
    original = globalThis.fetch,
    l = initialLearner(r, "test");
  for (const o of r.tracks.PY.objectives) l.cells[o.id].states[0] = "P";
  l.reviews = {};
  reconcileGates(r, l);
  f.g.study.learner = l;
  f.e.problem!.contract = eligible(r, f.g.study);
  f.e.problem!.runtime = { language: "python" };
  assert.equal(f.e.problem!.contract.depth, 2);
  let captured: any;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic",
        detail: "Not native verification",
        capabilities: ["materialize-work", "autonomous-work"],
      });
    const body = JSON.parse(String(init?.body));
    if (String(input) === "/api/execute")
      return Response.json({
        id: "synthetic-npc-receipt",
        language: "python",
        executed: true,
        status: "completed",
        codeHash: await sha256(body.code),
        imageId: `sha256:${"0".repeat(64)}`,
        stdout: "fixture output",
        stderr: "",
        exitCode: 0,
      });
    if (body.operation === "materialize-work")
      return Response.json(reply(body.payload));
    captured = body.payload;
    return Response.json({
      complete: true,
      feedback: "Synthetic only",
      qualified: [f.a.id],
    });
  };
  try {
    await checkBridge();
    await autonomousNpcWork(f.g, r);
    await autonomousNpcWork(f.g, r);
    const j = f.e.executions![0];
    assert.equal(j.author, f.a.id);
    assert.ok(j.artifactSequences.length);
    assert.ok(
      j.artifactSequences.every(
        (seq) => f.e.history.find((h) => h.seq === seq)?.author === f.a.id,
      ),
    );
    assert.equal(captured.executions[0].receipt.stdout, "fixture output");
    assert.equal(f.g.study.visits.length, 0);
    assert.equal(l.evidence.length, 0);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Fixture ended",
        detail: "",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});
test("first presentation captures a deletion repair without replaying hidden intermediate drafts", async () => {
  const f = fixture(),
    p = await prepare(f);
  applyAutonomousProposal(f.g, f.e, p.id);
  // A second real NPC edit removes its earlier tentative insertion before return.
  const old = f.e.workspace;
  f.e.workspace = "ac";
  f.e.revision++;
  f.e.history.push({
    seq: ++f.g.seq,
    author: f.a.id,
    kind: "edit",
    text: "Removed tentative insertion",
    delta: { prefix: 1, removed: "BOUNDARY", inserted: "" },
    at: 0,
    revision: f.e.revision,
  });
  f.h.station = f.ss[0].id;
  presentSharedWorkspace(f.g, f.e);
  const shown = f.e.history.filter((h) => h.kind === "workspace-view");
  assert.equal(shown.length, 1);
  assert.ok(shown[0].text.endsWith("\nac"));
  assert.ok(!shown[0].text.includes(old));
  assert.equal(shown[0].presented, shown[0].seq);
  assert.ok(shown[0].seq > p.artifactSequence);
  assert.equal(assistanceSources(f.e).length, 1);
});
test("NPC needs-work feedback becomes assistance only on presentation and permits fresh bounded reasoning", async () => {
  const f = fixture(),
    original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic",
        detail: "Fixture",
        capabilities: ["materialize-work", "autonomous-work"],
      });
    const b = JSON.parse(String(init?.body));
    return Response.json(
      b.operation === "materialize-work"
        ? reply(b.payload)
        : {
            complete: false,
            feedback: "Reconsider the boundary case",
            qualified: [],
          },
    );
  };
  try {
    await checkBridge();
    await autonomousNpcWork(f.g, r);
    await autonomousNpcWork(f.g, r);
    assert.equal(f.e.state, "in-progress");
    assert.equal(f.e.submissions[0].status, "needs-work");
    const h = f.e.history.find((h) => h.kind === "validation")!;
    assert.ok(h.text.includes("not a runtime receipt"));
    assert.equal(assistanceSources(f.e).length, 0);
    const { presentWorkLog } = await import("../src/ai");
    presentWorkLog(f.g, f.e);
    assert.ok(
      assistanceSources(f.e).some((s) =>
        s.text.includes("Reconsider the boundary case"),
      ),
    );
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Fixture ended",
        detail: "",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});

test("unattended candidates saved by a retired provider are never sent to the Claude CLI", async () => {
  const original = globalThis.fetch;
  try {
    for (const captured of ["study-mode", "chatgpt-handoff"] as const) {
      const f = fixture();
      await materializeNpcWork(f.g, f.e, async (p) => reply(p), false, {
        background: true,
        allowAutonomous: true,
        provider: captured,
      });
      assert.equal(f.e.proposals![0].provider, captured);
      let requests = 0;
      globalThis.fetch = async (url) => {
        if (url === "/api/status")
          return Response.json({
            mode: "claude-cli",
            label: "Synthetic provider switch",
            detail: "",
            capabilities: ["autonomous-work", "materialize-work"],
          });
        requests++;
        throw Error(
          "A different provider must never receive the old candidate",
        );
      };
      await checkBridge();
      f.g.settings.handoffAutonomous = true;
      assert.equal(autonomousNpcWork(f.g, r), undefined);
      assert.equal(f.e.workspace, "abc");
      assert.equal(f.e.submissions.length, 0);
      assert.equal(requests, 0);
    }
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "fixture ended",
        detail: "",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});
