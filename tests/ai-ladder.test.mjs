import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  cheapestFirst,
  parseSetting,
  readCases,
  readLadderRows,
  runLadder,
  summarizeLadder,
  unsafeOutReason,
} from "../scripts/ai-ladder.mjs";
import { taskProfile } from "../scripts/claude-gateway.mjs";

const store = () => mkdtempSync(join(tmpdir(), "ai-ladder-"));
const cases = [
  { id: "a", operation: "complete", payload: {} },
  { id: "b", operation: "assess", payload: {} },
];

/** A gateway double: no CLI, real rows through the arm's usage sink. */
function scriptedFactory({ fail = () => null } = {}) {
  const arms = [];
  const factory = (options) => {
    const arm = { options, runs: [] };
    arms.push(arm);
    return {
      run: async (operation, payload) => {
        arm.runs.push({ operation, payload });
        const profile = options.profileFor(operation, payload);
        const base = {
          operation,
          attempt: 0,
          outcome: "accepted",
          costUsd: profile.model === "haiku" ? 0.25 : 0.5,
          durationMs: 100,
          firstTextMs: 40,
          model: `claude-${profile.model}-5-5`,
          alias: profile.model,
          effort: profile.effort,
        };
        const scripted = fail(operation, payload, profile);
        if (scripted === "invalid") {
          options.usageLog({ ...base, outcome: "rejected" });
          options.usageLog({ ...base, attempt: 1, outcome: "rejected" });
          const error = Error("bad answer");
          error.code = "CLAUDE_INVALID_ANSWER";
          throw error;
        }
        if (scripted === "usage-limit") {
          options.usageLog({ ...base, costUsd: null, outcome: "usage-limit" });
          const error = Error("limit reached");
          error.code = "CLAUDE_USAGE_LIMIT";
          throw error;
        }
        options.usageLog(base);
        return { ok: true, model: profile.model, effort: profile.effort };
      },
    };
  };
  return { factory, arms };
}

test("settings production cannot run are refused before any arm starts", async () => {
  const out = join(store(), "run");
  let called = 0;
  const gatewayFactory = () => {
    called++;
    throw Error("no arm should start");
  };
  await assert.rejects(
    runLadder({
      cases,
      settings: ["opus:max"],
      out,
      ephemeral: true,
      gatewayFactory,
    }),
    /effort must be low, medium, high or xhigh \(got "max"\)/,
  );
  await assert.rejects(
    runLadder({
      cases,
      settings: ["fable:high"],
      out,
      ephemeral: true,
      gatewayFactory,
    }),
    /model must be haiku, sonnet or opus \(got "fable"\)/,
  );
  assert.equal(called, 0);
  assert.deepEqual(parseSetting("sonnet:xhigh"), {
    model: "sonnet",
    effort: "xhigh",
    setting: "sonnet:xhigh",
  });
});

test("each case and setting gets a fresh gateway and one measured row", async () => {
  const { factory, arms } = scriptedFactory({
    fail: (operation) => (operation === "assess" ? "invalid" : null),
  });
  const out = join(store(), "run");
  const result = await runLadder({
    cases,
    settings: ["haiku:low", "sonnet:high"],
    out,
    ephemeral: true,
    parallel: 1,
    runId: "run-1",
    gatewayFactory: factory,
  });
  assert.equal(arms.length, 4);
  assert.deepEqual(
    arms.map((arm) => arm.options.sessionNamespace),
    [
      "run-1:haiku:low:0",
      "run-1:sonnet:high:0",
      "run-1:haiku:low:0",
      "run-1:sonnet:high:0",
    ],
  );
  assert.equal(
    new Set(arms.map((arm) => arm.options.sessionNamespace)).size,
    2,
  );
  const override = arms[0].options.profileFor("complete", {});
  assert.equal(override.model, "haiku");
  assert.equal(override.effort, "low");
  assert.equal(override.timeoutMs, taskProfile("complete", {}).timeoutMs);
  assert.equal(result.rows.length, 4);
  const rows = readLadderRows(out);
  assert.equal(rows.length, 4);
  const pick = (caseId, setting) =>
    rows.find((row) => row.caseId === caseId && row.setting === setting);
  const a = pick("a", "haiku:low");
  assert.equal(a.v, 1);
  assert.equal(a.runId, "run-1");
  assert.equal(a.operation, "complete");
  assert.equal(a.rep, 0);
  assert.equal(a.outcome, "valid");
  assert.deepEqual(a.answers, [{ ok: true, model: "haiku", effort: "low" }]);
  assert.equal(a.attempts, 1);
  assert.equal(a.corrections, 0);
  assert.equal(a.costUsd, 0.25);
  assert.equal(a.durationMs, 100);
  assert.equal(a.firstTextMs, 40);
  assert.deepEqual(a.model, ["claude-haiku-5-5"]);
  const b = pick("b", "sonnet:high");
  assert.equal(b.outcome, "invalid");
  assert.deepEqual(b.answers, []);
  assert.equal(b.attempts, 2);
  assert.equal(b.corrections, 1);
  assert.equal(b.costUsd, 0.5 + 0.5);
  assert.equal(b.durationMs, 200);
  assert.deepEqual(b.model, ["claude-sonnet-5-5"]);
});

test("a second run resumes by skipping every finished row", async () => {
  const out = join(store(), "run");
  const settings = ["haiku:low", "sonnet:high"];
  const first = await runLadder({
    cases,
    settings,
    out,
    ephemeral: true,
    parallel: 1,
    runId: "run-1",
    gatewayFactory: scriptedFactory().factory,
  });
  assert.equal(first.rows.length, 4);
  let calls = 0;
  const base = scriptedFactory().factory;
  const second = await runLadder({
    cases,
    settings,
    out,
    ephemeral: true,
    parallel: 1,
    runId: "run-2",
    gatewayFactory: (options) => {
      calls++;
      return base(options);
    },
  });
  assert.equal(second.rows.length, 0);
  assert.equal(calls, 0);
  assert.equal(readLadderRows(out).length, 4);
});

test("a design conversation replays its payloads in order, one namespace", async () => {
  const { factory, arms } = scriptedFactory();
  const out = join(store(), "run");
  const sequence = [
    { generationId: "g1", requestId: "r1" },
    { generationId: "g1", requestId: "r2" },
  ];
  const result = await runLadder({
    cases: [{ id: "design", operation: "design-run", sequence }],
    settings: ["haiku:low"],
    out,
    ephemeral: true,
    runId: "run-d",
    gatewayFactory: factory,
  });
  assert.equal(arms.length, 1);
  assert.deepEqual(
    arms[0].runs.map((run) => run.payload.requestId),
    ["r1", "r2"],
  );
  assert.equal(arms[0].options.sessionNamespace, "run-d:haiku:low:0");
  const row = readLadderRows(out)[0];
  assert.equal(result.rows.length, 1);
  assert.equal(row.caseId, "design");
  assert.equal(row.operation, "design-run");
  assert.equal(row.outcome, "valid");
  assert.equal(row.answers.length, 2);
  assert.equal(row.attempts, 2);
});

test("a usage limit stops the whole run after writing its row", async () => {
  const { factory, arms } = scriptedFactory({
    fail: (_operation, payload) => (payload.limit ? "usage-limit" : null),
  });
  const out = join(store(), "run");
  const messages = [];
  const result = await runLadder({
    cases: [
      { id: "limit", operation: "complete", payload: { limit: true } },
      { id: "later", operation: "complete", payload: {} },
    ],
    settings: ["haiku:low"],
    out,
    ephemeral: true,
    parallel: 1,
    runId: "run-u",
    gatewayFactory: factory,
    log: (message) => messages.push(message),
  });
  const rows = readLadderRows(out);
  assert.equal(rows.length, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(rows[0].caseId, "limit");
  assert.equal(rows[0].outcome, "usage-limit");
  assert.equal(rows[0].costUsd, null);
  assert.equal(arms.length, 1);
  assert.equal(messages.length, 1);
  assert.match(
    messages[0],
    /^Usage limit reached on limit \(haiku:low\); stopping\./,
  );
});

test("a temporary output directory is refused unless the run is ephemeral", async () => {
  const target = join(tmpdir(), `ai-ladder-refuse-${process.pid}`);
  assert.match(unsafeOutReason(target), /temporary directory/);
  assert.match(unsafeOutReason("/var/data/scratchpad/run"), /scratchpad/);
  assert.equal(
    unsafeOutReason(
      "/Users/example/Library/Application Support/zombie-escape-study-game/ai-test-runs/compare",
    ),
    null,
  );
  await assert.rejects(
    runLadder({ cases: [], settings: ["haiku:low"], out: target }),
    /Refusing output directory/,
  );
  const allowed = await runLadder({
    cases: [],
    settings: ["haiku:low"],
    out: target,
    ephemeral: true,
    gatewayFactory: () => {
      throw Error("no arm should start");
    },
  });
  assert.equal(allowed.rows.length, 0);
  assert.equal(readLadderRows(target).length, 0);
});

test("the summary reports exact reliability, cost and speed figures", () => {
  const rows = [
    {
      operation: "tutor",
      setting: "haiku:low",
      outcome: "valid",
      corrections: 0,
      costUsd: 0.2,
      durationMs: 100,
      firstTextMs: 10,
    },
    {
      operation: "tutor",
      setting: "haiku:low",
      outcome: "invalid",
      corrections: 1,
      costUsd: 0.6,
      durationMs: 300,
      firstTextMs: 30,
    },
    {
      operation: "tutor",
      setting: "opus:xhigh",
      outcome: "valid",
      corrections: 0,
      costUsd: 2,
      durationMs: 500,
      firstTextMs: null,
    },
  ];
  const summary = summarizeLadder(rows);
  assert.equal(summary.length, 2);
  assert.deepEqual(summary[0], {
    operation: "tutor",
    setting: "haiku:low",
    n: 2,
    validRate: 0.5,
    firstTryRate: 0.5,
    meanCostUsd: (0.2 + 0.6) / 2,
    p50DurationMs: 100,
    p95DurationMs: 300,
    p95FirstTextMs: 30,
  });
  assert.deepEqual(summary[1], {
    operation: "tutor",
    setting: "opus:xhigh",
    n: 1,
    validRate: 1,
    firstTryRate: 1,
    meanCostUsd: 2,
    p50DurationMs: 500,
    p95DurationMs: 500,
    p95FirstTextMs: null,
  });
  assert.deepEqual(cheapestFirst(summary), [
    { operation: "tutor", settings: ["haiku:low", "opus:xhigh"] },
  ]);
});

test("a replay-sample directory becomes cases and one design sequence", () => {
  const directory = store();
  const complete = join(directory, "complete");
  const design = join(directory, "design-run");
  mkdirSync(complete, { recursive: true });
  mkdirSync(design, { recursive: true });
  const sample = (operation, payload) =>
    JSON.stringify({
      v: 1,
      at: "2025-01-01T00:00:00.000Z",
      operation,
      payload,
    });
  writeFileSync(
    join(complete, "2025-01-01T00-00-00.000Z-aaaa1111.json"),
    sample("complete", { note: "one" }),
  );
  writeFileSync(
    join(design, "2025-01-01T00-00-01.000Z-bbbb2222.json"),
    sample("design-run", { generationId: "g1", requestId: "first" }),
  );
  writeFileSync(
    join(design, "2025-01-01T00-00-02.000Z-cccc3333.json"),
    sample("design-run", { generationId: "g1", requestId: "second" }),
  );
  const found = readCases(directory);
  assert.equal(found.length, 2);
  assert.deepEqual(found[0], {
    id: "2025-01-01T00-00-00.000Z-aaaa1111",
    operation: "complete",
    payload: { note: "one" },
  });
  assert.deepEqual(found[1], {
    id: "design-run:g1",
    operation: "design-run",
    sequence: [
      { generationId: "g1", requestId: "first" },
      { generationId: "g1", requestId: "second" },
    ],
  });
  assert.equal(readdirSync(directory).sort().join(","), "complete,design-run");
});

test("arms run in parallel only up to the requested limit", async () => {
  let active = 0,
    peak = 0;
  const factory = (options) => ({
    run: async (operation, payload) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      const profile = options.profileFor(operation, payload);
      options.usageLog({
        attempt: 0,
        model: `claude-${profile.model}-5-5`,
        costUsd: 0.1,
        durationMs: 5,
        firstTextMs: 1,
      });
      active--;
      return { ok: true };
    },
  });
  const out = join(store(), "run");
  await runLadder({
    cases,
    settings: ["haiku:low", "sonnet:high"],
    out,
    ephemeral: true,
    parallel: 2,
    runId: "run-p",
    gatewayFactory: factory,
  });
  assert.equal(peak, 2);
  assert.equal(readLadderRows(out).length, 4);
});

test("only narrows the ladder to the named operations", async () => {
  const { factory } = scriptedFactory();
  const out = join(store(), "run");
  await runLadder({
    cases,
    settings: ["haiku:low"],
    out,
    ephemeral: true,
    only: "assess",
    runId: "run-o",
    gatewayFactory: factory,
  });
  const rows = readLadderRows(out);
  assert.deepEqual(
    rows.map((row) => [row.caseId, row.operation]),
    [["b", "assess"]],
  );
});
