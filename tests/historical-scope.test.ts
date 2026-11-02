import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkBridge, ensureProblem } from "../src/ai";
import { historicalScope } from "../src/historical-scope";
import { eligibleLearning, initialLearner } from "../src/learner";
import type { Roadmap } from "../src/model";
import { createGame } from "../src/world";

const r = JSON.parse(readFileSync("public/curriculum.json", "utf8")) as Roadmap;

test("source scope preserves narrow independent and assisted history without minting proofs", () => {
  const l = initialLearner(r, "test");
  l.reviews = {};
  l.tracks.PY.queue = ["T07"];
  l.cells["PY:T07.1"].states[0] = "P"; // Synthetic schedule, not learner evidence.
  const before = JSON.stringify(l);
  const c = eligibleLearning(r, l);
  assert.equal(c.objectiveIds[0], "PY:T07.2");
  assert.equal(c.historicalScope?.sourceHash, r.sourceHash);
  const gap = c.historicalScope!.gaps.find((g) => g.id === "G0018")!;
  assert.match(gap.preserved, /independently establishes pre-rewire ordering/);
  assert.match(gap.missing, /boundary/);
  assert.match(gap.nextCheck, /do not repeat/);
  assert.ok(
    c.historicalScope!.evidenceRows.some((row) => row.includes("S0006-EV17")),
  );
  assert.equal(JSON.stringify(l), before);
  const assisted = historicalScope(r, "PE", "PE:T05.2", 1);
  assert.ok(
    assisted.evidenceRows.some(
      (row) => row.includes("HINT") && row.includes("was supplied before"),
    ),
  );
});

test("source gaps are depth and track specific, including deferred D2 work", () => {
  const d1 = historicalScope(r, "PY", "PY:T01.1", 1);
  const d2 = historicalScope(r, "PY", "PY:T01.1", 2);
  assert.deepEqual(
    d1.gaps.map((g) => g.id),
    ["G0001"],
  );
  assert.deepEqual(
    d2.gaps.map((g) => g.id),
    ["G0007"],
  );
  assert.match(d2.gaps[0].revisit, /does not block Tier 1/);
  assert.ok(
    !historicalScope(r, "PE", "PE:T01.1", 1).evidenceRows.some((row) =>
      row.includes("S0001-EV01"),
    ),
  );
  assert.deepEqual(historicalScope(r, "PY", "PY:T01.10", 1).evidenceRows, []);
});

test("generated questions cannot replace scheduler review/version or strip historical constraints", async () => {
  const originalFetch = globalThis.fetch;
  let alteration: "strip" | "review" | "version" = "strip";
  const response = (body: unknown) => new Response(JSON.stringify(body));
  globalThis.fetch = async (input, init) => {
    if (String(input) === "/api/status")
      return response({
        mode: "claude-cli",
        label: "Synthetic boundary fixture",
        capabilities: [],
        detail: "Not native Study Mode.",
      });
    const { contract } = JSON.parse(String(init?.body)).payload;
    if (alteration === "review") contract.review = !contract.review;
    if (alteration === "version") contract.ledgerVersion++;
    delete contract.historicalScope;
    contract.priorEvidence = [];
    return response({
      title: "Fixture",
      prompt: "Fixture",
      starter: "",
      rubric: [],
      contract,
    });
  };
  try {
    await checkBridge();
    for (const mode of ["strip", "review", "version"] as const) {
      alteration = mode;
      const g = createGame(1, r);
      g.study.profile = "live";
      g.study.learner = initialLearner(r, "test");
      const e = g.encounters["f0-room0"];
      await ensureProblem(g, e, r);
      if (mode === "strip") {
        assert.ok(e.problem?.contract.historicalScope);
        assert.ok(e.problem!.contract.priorEvidence.length);
      } else {
        assert.equal(e.problem, undefined);
        assert.match(e.error!, /Stale or altered/);
      }
      assert.equal(g.study.learner.evidence.length, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
