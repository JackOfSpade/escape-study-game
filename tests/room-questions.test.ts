import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkBridge, ensureProblem } from "../src/ai";
import { createPlayableGame } from "../src/world";
import { type Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import { initialStudy } from "../src/curriculum";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import {
  npcThinkingRate,
  npcReasoningAvailable,
  taskSkill,
} from "../src/npc-cognition";
const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
test("all stations in each room share the exact question, with independent solo answers and completion", async () => {
  const g = createPlayableGame(42, roadmap);
  const rooms = new Map<string, (typeof g.floors)[0]["stations"]>();
  for (const f of g.floors)
    for (const s of f.stations) {
      const room = /^(f\d+-room\d+)/.exec(s.id)![1];
      rooms.set(room, [...(rooms.get(room) ?? []), s]);
    }
  for (const stations of rooms.values()) {
    const encounters = stations.map((s) => g.encounters[s.encounter]);
    await Promise.all(encounters.map((e) => ensureProblem(g, e, roadmap)));
    assert.ok(encounters[0].problem);
    for (const e of encounters)
      assert.deepEqual(e.problem, encounters[0].problem);
    assert.equal(new Set(encounters.map((e) => e.id)).size, encounters.length);
    encounters[0].workspace = "Private draft";
    encounters[0].state = "consumed";
    assert.equal(encounters[1].workspace, "");
    assert.notEqual(encounters[1].state, "consumed");
    const npc = g.survivors[1];
    assert.equal(taskSkill(npc, encounters[0]), taskSkill(npc, encounters[1]));
  }
  const restored = decode(encode(g));
  assert.deepEqual(restored.encounters, g.encounters);
});

test("normal GameTest AI shares room difficulty while retaining individual work rhythms", () => {
  const s = emptyScenario();
  Object.assign(s, {
    template: "building",
    layout: "forward",
    rules: "force-fields",
    simulation: "game",
    maxTicks: 30,
  });
  s.checks = [
    {
      name: "Human remains alive",
      mode: "always",
      query: { type: "property", id: "human", field: "alive" },
      op: "eq",
      expected: true,
    },
  ];
  const runner = new TestRunner(s, roadmap),
    g = runner.game;
  g.survivors = g.survivors.slice(0, 3);
  Object.assign(g.survivors[0], { x: 39, y: 26 });
  const stations = g.floors[0].stations
    .filter((st) => g.encounters[st.encounter].questionRoom === "f0-room0")
    .slice(0, 2);
  const [a, b] = g.survivors.slice(1);
  b.technical = structuredClone(a.technical);
  for (const [i, npc] of [a, b].entries())
    Object.assign(npc, {
      ...stations[i],
      id: npc.id,
      floor: 0,
      intent: stations[i].encounter,
      station: stations[i].id,
      activity: "studying",
      role: "analyst",
      risk: 0.9,
      social: 0.3,
      thought: 0,
      milestone: 0,
      seen: stations.map((st) => st.id),
    });
  const question = g.encounters[stations[0].encounter];
  const otherQuestion = g.encounters[stations[1].encounter];
  // Station choice must not change the difficulty or rhythm of the same
  // person's work on the same room question.
  assert.equal(npcThinkingRate(a, question), npcThinkingRate(a, otherQuestion));
  const expectedA = (npcThinkingRate(a, question) * 1.2) / 30,
    expectedB = (npcThinkingRate(b, otherQuestion) * 1.2) / 30;
  runner.advance(1);
  assert.ok(Math.abs(a.thought - expectedA) < 1e-9);
  assert.ok(Math.abs(b.thought - expectedB) < 1e-9);
  assert.equal(runner.run().status, "passed");
  assert.ok(a.thought > 0);
  assert.ok(b.thought > 0);
  assert.ok(
    Math.abs(a.thought - b.thought) > 1e-4,
    "Equal expertise must still allow individual pacing",
  );
  const harder = structuredClone(question);
  harder.problem!.contract.depth = 3;
  assert.ok(npcThinkingRate(a, harder) < npcThinkingRate(a, question));
  delete harder.problem;
  assert.equal(npcThinkingRate(a, harder), 0);
  assert.equal(npcReasoningAvailable(harder, a), false);
});

test("concurrent live room requests generate once, and retry after reload keeps the original packet", async () => {
  const original = globalThis.fetch;
  let fail = true;
  const packets: any[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url) === "/api/status")
      return Response.json({
        mode: "claude-cli",
        label: "Synthetic",
        detail: "No external AI",
        capabilities: ["generate"],
      });
    const body = JSON.parse(String(init?.body));
    packets.push(body);
    await new Promise((resolve) => setTimeout(resolve, 2));
    if (fail)
      return Response.json(
        { error: "Synthetic interruption" },
        { status: 503 },
      );
    return Response.json({
      title: "One room question",
      estimatedSolveSeconds: 600,
      prompt: "Explain the synthetic boundary",
      starter: "",
      rubric: ["Reasoning"],
      contract: body.payload.contract,
    });
  };
  try {
    await checkBridge();
    const g = createPlayableGame(42, roadmap, initialStudy(roadmap, "live"));
    const stations = g.floors[0].stations.filter(
      (st) => g.encounters[st.encounter].questionRoom === "f0-room0",
    );
    const [a, b] = stations.map((st) => g.encounters[st.encounter]);
    await Promise.all([
      ensureProblem(g, a, roadmap),
      ensureProblem(g, b, roadmap),
    ]);
    assert.equal(packets.length, 1);
    assert.ok(a.pendingGeneration);
    assert.equal(b.problem, undefined);
    const restored = decode(encode(g));
    fail = false;
    await Promise.all([
      ensureProblem(restored, restored.encounters[b.id], roadmap),
      ensureProblem(restored, restored.encounters[a.id], roadmap),
    ]);
    assert.equal(packets.length, 2);
    assert.deepEqual(packets[1], packets[0]);
    for (const st of stations)
      assert.deepEqual(
        restored.encounters[st.encounter].problem,
        restored.encounters[a.id].problem,
      );
    assert.equal(restored.encounters[a.id].problem!.title, "One room question");
    assert.equal(restored.fieldPacing!.floors[0].estimatedSolveSeconds, 600);
    assert.ok(
      restored.floors[0].furniture.find((o) => o.field?.publicEntry)!.maxHp >
        g.floors[0].furniture.find((o) => o.field?.publicEntry)!.maxHp,
    );
    assert.equal(
      Object.keys(restored.encounters).filter(
        (id) => restored.encounters[id].problem,
      ).length,
      stations.length,
    );
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "Offline",
        detail: "Fixture ended",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
  }
});
