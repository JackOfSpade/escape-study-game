import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  formatUsageReport,
  readUsageRows,
  summarizeUsage,
} from "../scripts/ai-usage-report.mjs";

const base = {
  v: 1,
  at: "2026-01-01T00:00:00.000Z",
  operation: "tutor",
  phase: null,
  conversationTurn: 1,
  alias: "sonnet",
  effort: "medium",
  model: "claude-sonnet-5-5",
  inputTokens: null,
  outputTokens: null,
  numTurns: 1,
  apiDurationMs: null,
  firstTextMs: null,
};
const row = (extra) => ({ ...base, ...extra });

const ROWS = [
  row({
    attempt: 0,
    outcome: "accepted",
    durationMs: 100,
    costUsd: 0.25,
    inputTokens: 1000,
    outputTokens: 100,
    firstTextMs: 20,
  }),
  row({
    attempt: 0,
    outcome: "rejected",
    durationMs: 200,
    costUsd: 0.75,
    inputTokens: 2000,
    outputTokens: 200,
  }),
  row({
    attempt: 1,
    outcome: "accepted",
    durationMs: 300,
    costUsd: null,
    outputTokens: 300,
    firstTextMs: 40,
  }),
  row({
    conversationTurn: 2,
    attempt: 0,
    outcome: "accepted",
    durationMs: 400,
    costUsd: 0.5,
    inputTokens: 400,
    outputTokens: 40,
  }),
  row({
    operation: "generate",
    phase: "content-batch",
    conversationTurn: null,
    attempt: 0,
    outcome: "usage-limit",
    durationMs: 500,
    costUsd: null,
    inputTokens: null,
    outputTokens: null,
    alias: "opus",
    effort: "xhigh",
    model: null,
  }),
];

test("usage groups measure accept rate, cost, tokens and latency", () => {
  const report = summarizeUsage(ROWS);
  assert.equal(report.calls, 5);
  assert.equal(report.groups, 3);
  const first = report.summary.find(
    (group) => group.operation === "tutor" && group.turn === "first",
  );
  assert.deepEqual(first, {
    operation: "tutor",
    phase: null,
    turn: "first",
    alias: "sonnet",
    effort: "medium",
    model: "claude-sonnet-5-5",
    calls: 3,
    firstTryAcceptRate: 0.5,
    correctionTurns: 1,
    failures: { rejected: 1 },
    totalCostUsd: 1,
    meanCostUsd: 0.5,
    meanInputTokens: 1500,
    meanOutputTokens: 200,
    p50DurationMs: 200,
    p95DurationMs: 300,
    p95FirstTextMs: 40,
  });
  const reply = report.summary.find(
    (group) => group.operation === "tutor" && group.turn === "reply",
  );
  assert.equal(reply.calls, 1);
  assert.equal(reply.firstTryAcceptRate, 1);
  assert.equal(reply.correctionTurns, 0);
  assert.deepEqual(reply.failures, {});
  assert.equal(reply.totalCostUsd, 0.5);
  assert.equal(reply.meanCostUsd, 0.5);
  assert.equal(reply.meanInputTokens, 400);
  assert.equal(reply.meanOutputTokens, 40);
  assert.equal(reply.p50DurationMs, 400);
  assert.equal(reply.p95DurationMs, 400);
  assert.equal(reply.p95FirstTextMs, null);
  const failed = report.summary.find((group) => group.operation === "generate");
  assert.equal(failed.phase, "content-batch");
  assert.equal(failed.turn, "");
  assert.equal(failed.effort, "xhigh");
  assert.equal(failed.model, null);
  assert.equal(failed.firstTryAcceptRate, 0);
  assert.deepEqual(failed.failures, { "usage-limit": 1 });
  assert.equal(failed.totalCostUsd, null);
  assert.equal(failed.meanCostUsd, null);
  assert.equal(failed.meanInputTokens, null);
  assert.equal(failed.p50DurationMs, 500);
});

test("rows with no numbers are never counted as zero cost", () => {
  const report = summarizeUsage([
    row({ attempt: 0, outcome: "accepted", costUsd: null, durationMs: null }),
  ]);
  assert.equal(report.summary[0].calls, 1);
  assert.equal(report.summary[0].totalCostUsd, null);
  assert.equal(report.summary[0].meanCostUsd, null);
  assert.equal(report.summary[0].p50DurationMs, null);
  assert.equal(report.summary[0].p95DurationMs, null);
});

test("the file reader skips malformed lines and counts them", () => {
  const directory = mkdtempSync(join(tmpdir(), "ai-usage-"));
  const file = join(directory, "claude-usage.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify(row({ attempt: 0, outcome: "accepted", durationMs: 10 })),
      "not json at all",
      "",
      JSON.stringify(["an array is not a row"]),
      JSON.stringify(row({ attempt: 1, outcome: "rejected", durationMs: 20 })),
      '{"truncated":',
      "",
    ].join("\n"),
  );
  const read = readUsageRows([file, join(directory, "absent.jsonl")]);
  assert.equal(read.rows.length, 2);
  assert.equal(read.malformed, 3);
  assert.deepEqual(read.files, [file]);
  assert.deepEqual(
    read.rows.map((entry) => entry.outcome),
    ["accepted", "rejected"],
  );
});

test("the plain-text report is an aligned table with a totals line", () => {
  const report = summarizeUsage([ROWS[3]]);
  const text = formatUsageReport({
    ...report,
    malformed: 1,
    files: ["claude-usage.jsonl"],
  }).split("\n");
  assert.match(text[0], /^operation\s+phase\s+turn\s+alias:effort\s+model/);
  assert.match(
    text[1],
    /^tutor\s+-\s+reply\s+sonnet:medium\s+claude-sonnet-5-5/,
  );
  assert.equal(
    text.at(-1),
    "1 calls across 1 group(s) in 1 file(s); 1 malformed line(s)",
  );
});
