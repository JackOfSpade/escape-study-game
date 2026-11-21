import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JUDGE_SYSTEM,
  candidateFirst,
  createClaudeCompleter,
  fieldAgreement,
  judgeLadder,
  judgeMessages,
  judgesOf,
  mixedJudgeWarning,
  kneeReport,
  latestJudgments,
  mapJudgment,
  parseJudgeSettingArg,
  parseJudgeReply,
  readJudgments,
  summarizeJudgments,
} from "../scripts/ai-judge.mjs";

const realpathOf = (path) => realpathSync(path);
const tempOut = () => mkdtempSync(join(tmpdir(), "ai-judge-test-"));
const CASES = [
  { id: "case-a", operation: "generate", payload: { focus: "binary search" } },
];
const ladderRow = (overrides = {}) => ({
  v: 1,
  at: "2026-01-01T00:00:00.000Z",
  runId: "ladder-1",
  caseId: "case-a",
  operation: "generate",
  setting: "haiku:low",
  rep: 0,
  outcome: "valid",
  answers: [{ title: "R", estimatedSolveSeconds: 120 }],
  attempts: 1,
  corrections: 0,
  costUsd: 0.01,
  durationMs: 100,
  firstTextMs: 50,
  model: ["claude-haiku"],
  ...overrides,
});
const writeRows = (out, rows) =>
  writeFileSync(
    join(out, "results.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
  );
const fakeCompleter = (reply) => {
  const calls = [];
  const completer = async (request) => {
    calls.push(request);
    return typeof reply === "function" ? reply(request, calls.length) : reply;
  };
  completer.calls = calls;
  return completer;
};
const answerBlocks = (content) => {
  const aStart = content.indexOf("Answer A:\n");
  const bStart = content.indexOf("Answer B:\n");
  return {
    a: content.slice(aStart + 10, content.indexOf("\n\n", aStart)).trim(),
    b: content.slice(bStart + 10, content.indexOf("\n\n", bStart)).trim(),
  };
};

test("blind order is deterministic and differs between rows", () => {
  assert.equal(candidateFirst("case-a", "haiku:low", 0), false);
  assert.equal(candidateFirst("case-a", "haiku:low", 1), true);
  assert.equal(candidateFirst("case-b", "sonnet:high", 0), false);
  assert.equal(candidateFirst("case-a", "opus:low", 0), true);
  for (const key of ["case-a|haiku:low|0", "case-a|opus:low|1"])
    assert.equal(
      candidateFirst(...key.split("|")),
      candidateFirst(...key.split("|")),
    );
  const orders = [0, 1, 2, 3].map((rep) =>
    candidateFirst("case-a", "haiku:low", rep),
  );
  assert.deepEqual([...new Set(orders)].sort(), [false, true]);
});

test("agreement counts scalar fields and one level of nesting exactly", () => {
  const reference = {
    a: 1,
    b: "x",
    c: true,
    d: null,
    nested: { e: 2, f: { deep: 1 } },
    list: [1, 2],
  };
  const candidate = { a: 1, b: "y", c: true, nested: { e: 2 } };
  // a, b, c, d, nested.e -> three equal of five scalar fields.
  assert.equal(fieldAgreement(reference, candidate), 0.6);
  assert.equal(fieldAgreement(reference, reference), 1);
  assert.equal(fieldAgreement({}, { a: 1 }), 1);
  assert.equal(fieldAgreement({ a: 1 }, {}), 0);
});

test("judge replies parse the first JSON object and map to a perspective", () => {
  assert.deepEqual(
    parseJudgeReply('prefix {"scoreA": 8, "scoreB": 4, "better": "A"} suffix'),
    { scoreA: 8, scoreB: 4, better: "A", reason: "" },
  );
  assert.equal(parseJudgeReply("no json here"), null);
  assert.equal(
    parseJudgeReply('{"scoreA": 0, "scoreB": 4, "better": "A"}'),
    null,
  );
  assert.equal(
    parseJudgeReply('{"scoreA": 4, "scoreB": 4, "better": "maybe"}'),
    null,
  );
  const parsed = { scoreA: 9, scoreB: 3, better: "A" };
  assert.deepEqual(mapJudgment(parsed, true), {
    candidateScore: 9,
    referenceScore: 3,
    verdict: "win",
  });
  assert.deepEqual(mapJudgment(parsed, false), {
    candidateScore: 3,
    referenceScore: 9,
    verdict: "loss",
  });
  assert.deepEqual(mapJudgment({ ...parsed, better: "tie" }, false), {
    candidateScore: 3,
    referenceScore: 9,
    verdict: "tie",
  });
});
test("invalid rows are recorded without calling the judge", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const reference = { setting: "sonnet:high", rep: 0 };
  writeRows(out, [
    ladderRow({
      setting: "sonnet:high",
      rep: 0,
      answers: [{ title: "R", estimatedSolveSeconds: 180 }],
    }),
    ladderRow({
      setting: "sonnet:high",
      rep: 1,
      answers: [{ title: "C", estimatedSolveSeconds: 180 }],
    }),
    ladderRow({
      setting: "haiku:low",
      rep: 0,
      outcome: "invalid",
      answers: [],
    }),
    ladderRow({
      setting: "haiku:low",
      rep: 1,
      answers: [{ title: "C", estimatedSolveSeconds: 90 }],
    }),
  ]);
  const completer = fakeCompleter({
    text: '{"scoreA": 5, "scoreB": 5, "better": "tie", "reason": "same"}',
    costUsd: 0.001,
  });
  const result = await judgeLadder({
    out,
    cases: CASES,
    reference,
    completer,
    parallel: 2,
  });
  assert.equal(completer.calls.length, 2);
  assert.equal(result.judgments.length, 3);
  assert.equal(readJudgments(out).length, 3);
  const invalid = readJudgments(out).find(
    (entry) => entry.setting === "haiku:low" && entry.rep === 0,
  );
  assert.equal(invalid.verdict, "invalid");
  assert.equal(invalid.candidateScore, 0);
  assert.equal(invalid.referenceScore, null);
  assert.equal(invalid.judgeCostUsd, 0);
  assert.equal(invalid.delta, null);
  // The reference row itself is never judged.
  assert.equal(
    readJudgments(out).some(
      (entry) => entry.setting === "sonnet:high" && entry.rep === 0,
    ),
    false,
  );
  assert.equal(
    JUDGE_SYSTEM,
    "You are a strict, impartial evaluator of AI outputs for a study workspace. Judge only against the task instructions. Ignore length and style unless the instructions require them. Reply with one JSON object only.",
  );
  const request = completer.calls[0];
  assert.equal(request.route, "deepseek-flash");
  assert.equal(request.caller, "study-ai-judge");
  assert.equal(request.tag, "judge");
  assert.equal(typeof request.maxTokens, "number");
  assert.equal(request.messages[0].content, JUDGE_SYSTEM);
});

test("the candidate's blind slot is reflected in the prompt and the verdict", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const referenceAnswer = { title: "R", estimatedSolveSeconds: 180 };
  const candidateAnswer = { title: "R", estimatedSolveSeconds: 120 };
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0, answers: [referenceAnswer] }),
    ladderRow({ setting: "haiku:low", rep: 1, answers: [candidateAnswer] }),
  ]);
  const completer = fakeCompleter({
    text: '{"scoreA": 9, "scoreB": 3, "better": "A", "reason": "tighter"}',
    costUsd: 0.002,
  });
  await judgeLadder({
    out,
    cases: CASES,
    reference: { setting: "sonnet:high", rep: 0 },
    completer,
  });
  // haiku:low|1 hashes to candidate-first, so Answer A is the candidate.
  const blocks = answerBlocks(completer.calls[0].messages[1].content);
  assert.equal(blocks.a, JSON.stringify(candidateAnswer));
  assert.equal(blocks.b, JSON.stringify(referenceAnswer));
  const [judgment] = readJudgments(out);
  assert.equal(judgment.verdict, "win");
  assert.equal(judgment.candidateScore, 9);
  assert.equal(judgment.referenceScore, 3);
  assert.equal(judgment.delta, 6);
  assert.equal(judgment.agreement, 0.5);
  assert.equal(judgment.judgeCostUsd, 0.002);
  assert.equal(judgment.reason, "tighter");
});

test("reference-first order flips scores to the candidate's perspective", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  const referenceAnswer = { title: "R", estimatedSolveSeconds: 180 };
  const candidateAnswer = { title: "R", estimatedSolveSeconds: 240 };
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0, answers: [referenceAnswer] }),
    ladderRow({ setting: "haiku:low", rep: 0, answers: [candidateAnswer] }),
  ]);
  const completer = fakeCompleter({
    text: '{"scoreA": 9, "scoreB": 3, "better": "A"}',
    costUsd: 0.002,
  });
  await judgeLadder({
    out,
    cases: CASES,
    reference: { setting: "sonnet:high", rep: 0 },
    completer,
  });
  // haiku:low|0 hashes to reference-first, so Answer B is the candidate.
  const blocks = answerBlocks(completer.calls[0].messages[1].content);
  assert.equal(blocks.a, JSON.stringify(referenceAnswer));
  assert.equal(blocks.b, JSON.stringify(candidateAnswer));
  const [judgment] = readJudgments(out);
  assert.equal(judgment.verdict, "loss");
  assert.equal(judgment.candidateScore, 3);
  assert.equal(judgment.referenceScore, 9);
  assert.equal(judgment.delta, -6);
  assert.equal(judgment.agreement, 0.5);
});

test("a malformed judge reply is retried exactly once", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0 }),
    ladderRow({ setting: "haiku:low", rep: 0 }),
  ]);
  const completer = fakeCompleter((request, call) => ({
    text:
      call === 1
        ? "Sorry, I cannot score these."
        : '{"scoreA": 6, "scoreB": 8, "better": "B"}',
    costUsd: 0.001,
  }));
  await judgeLadder({
    out,
    cases: CASES,
    reference: { setting: "sonnet:high", rep: 0 },
    completer,
  });
  assert.equal(completer.calls.length, 2);
  const [judgment] = readJudgments(out);
  assert.equal(judgment.verdict, "win");
  assert.equal(judgment.candidateScore, 8);
  assert.equal(judgment.referenceScore, 6);
  assert.equal(judgment.judgeCostUsd, 0.002);
});

test("a judge that never answers is recorded as a judge error", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0 }),
    ladderRow({ setting: "haiku:low", rep: 0 }),
  ]);
  const completer = fakeCompleter({ text: "still not json", costUsd: 0.001 });
  await judgeLadder({
    out,
    cases: CASES,
    reference: { setting: "sonnet:high", rep: 0 },
    completer,
  });
  assert.equal(completer.calls.length, 2);
  const [judgment] = readJudgments(out);
  assert.equal(judgment.verdict, "judge-error");
  assert.equal(judgment.candidateScore, null);
  assert.equal(judgment.referenceScore, null);
  assert.equal(judgment.delta, null);
  assert.equal(judgment.judgeCostUsd, 0.002);
  assert.equal(typeof judgment.reason, "string");
  assert.ok(judgment.reason.length > 0);
});

test("rerunning resumes by skipping already judged rows", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0 }),
    ladderRow({ setting: "sonnet:high", rep: 1 }),
    ladderRow({ setting: "haiku:low", rep: 0 }),
    ladderRow({ setting: "haiku:low", rep: 1 }),
  ]);
  const reference = { setting: "sonnet:high", rep: 0 };
  const first = fakeCompleter({
    text: '{"scoreA": 5, "scoreB": 5, "better": "tie"}',
    costUsd: 0.001,
  });
  const initial = await judgeLadder({
    out,
    cases: CASES,
    reference,
    completer: first,
    parallel: 2,
  });
  assert.equal(first.calls.length, 3);
  assert.equal(initial.judgments.length, 3);
  const second = fakeCompleter(() => {
    throw Error("resume must not call the judge");
  });
  const resumed = await judgeLadder({
    out,
    cases: CASES,
    reference,
    completer: second,
  });
  assert.equal(second.calls.length, 0);
  assert.equal(resumed.judgments.length, 0);
  assert.equal(resumed.skipped, 3);
  assert.equal(readJudgments(out).length, 3);
});

test("a resumed run retries judge errors and the newer row supersedes them", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0 }),
    ladderRow({ setting: "haiku:low", rep: 0 }),
  ]);
  const reference = { setting: "sonnet:high", rep: 0 };
  await judgeLadder({
    out,
    cases: CASES,
    reference,
    completer: fakeCompleter(() => {
      throw Error("usage limit reached");
    }),
  });
  assert.equal(readJudgments(out)[0].verdict, "judge-error");
  const retry = fakeCompleter({
    text: '{"scoreA": 6, "scoreB": 8, "better": "B"}',
    costUsd: 0.001,
  });
  const resumed = await judgeLadder({
    out,
    cases: CASES,
    reference,
    completer: retry,
  });
  assert.equal(retry.calls.length, 1);
  assert.equal(resumed.skipped, 0);
  assert.equal(resumed.judgments.length, 1);
  const all = readJudgments(out);
  assert.equal(all.length, 2);
  const latest = latestJudgments(all);
  assert.equal(latest.length, 1);
  assert.notEqual(latest[0].verdict, "judge-error");
  const [line] = summarizeJudgments(all, [
    ladderRow({ setting: "sonnet:high", rep: 0 }),
    ladderRow({ setting: "haiku:low", rep: 0 }),
  ]).filter((entry) => entry.setting === "haiku:low");
  assert.equal(line.n, 1);
  assert.equal(line.errors, 0);
  const third = fakeCompleter(() => {
    throw Error("a judged row must not be judged again");
  });
  const again = await judgeLadder({
    out,
    cases: CASES,
    reference,
    completer: third,
  });
  assert.equal(third.calls.length, 0);
  assert.equal(again.skipped, 1);
});

test("--judge-setting must be a strict <model>:<effort> and never max", () => {
  assert.deepEqual(parseJudgeSettingArg("opus:high"), {
    model: "opus",
    effort: "high",
    setting: "opus:high",
  });
  assert.equal(parseJudgeSettingArg().setting, "opus:high");
  assert.equal(parseJudgeSettingArg("sonnet:medium").setting, "sonnet:medium");
  for (const bad of [
    "opus",
    "sonnet",
    "opus:high:extra",
    "opus:",
    ":high",
    "gpt:high",
  ])
    assert.throws(() => parseJudgeSettingArg(bad), /Invalid setting/, bad);
  assert.throws(
    () => parseJudgeSettingArg("opus:max"),
    /"max" is never allowed/,
  );
});

const summaryRows = [
  ladderRow({ setting: "cheap", rep: 0, costUsd: 0.01 }),
  ladderRow({ setting: "cheap", rep: 0, costUsd: 0.01, caseId: "case-b" }),
  ladderRow({ setting: "ref", rep: 0, costUsd: 0.02 }),
  ladderRow({ setting: "ref", rep: 1, costUsd: 0.04 }),
  ladderRow({ setting: "dear", rep: 0, costUsd: 0.03 }),
  ladderRow({
    setting: "dear",
    rep: 0,
    costUsd: 0.03,
    caseId: "case-b",
    outcome: "invalid",
  }),
];
const judgmentRow = (overrides = {}) => ({
  v: 1,
  caseId: "case-a",
  operation: "generate",
  setting: "cheap",
  rep: 0,
  verdict: "win",
  candidateScore: 8,
  referenceScore: 6,
  delta: 2,
  agreement: 0.5,
  judgeCostUsd: 0.001,
  reason: "ok",
  ...overrides,
});
const summaryJudgments = [
  judgmentRow(),
  judgmentRow({
    caseId: "case-b",
    verdict: "loss",
    candidateScore: 4,
    referenceScore: 8,
    delta: -4,
    agreement: 1,
  }),
  judgmentRow({
    setting: "ref",
    rep: 1,
    verdict: "tie",
    candidateScore: 7,
    referenceScore: 7,
    delta: 0,
    agreement: 0.75,
  }),
  judgmentRow({
    setting: "dear",
    verdict: "invalid",
    candidateScore: 0,
    referenceScore: null,
    delta: null,
    agreement: null,
    judgeCostUsd: 0,
  }),
  judgmentRow({
    setting: "dear",
    caseId: "case-b",
    candidateScore: 9,
    referenceScore: 6,
    delta: 3,
    agreement: 1,
  }),
];

test("summarizeJudgments reports deltas, verdicts, agreement, validity and cost", () => {
  const summary = summarizeJudgments(summaryJudgments, summaryRows, {
    reference: { setting: "ref", rep: 0 },
  });
  assert.deepEqual(
    summary.map((entry) => `${entry.setting}|${entry.rep}|${entry.noiseFloor}`),
    ["cheap|0|false", "dear|0|false", "ref|0|false", "ref|1|true"],
  );
  const cheap = summary[0];
  assert.equal(cheap.n, 2);
  assert.equal(cheap.meanDelta, -1);
  assert.equal(cheap.wins, 1);
  assert.equal(cheap.ties, 0);
  assert.equal(cheap.losses, 1);
  assert.equal(cheap.meanAgreement, 0.75);
  assert.equal(cheap.validRate, 1);
  assert.equal(cheap.meanCostUsd, 0.01);
  const dear = summary[1];
  // The invalid row counts as 0 - the operation's mean reference score 6.75.
  assert.equal(dear.n, 2);
  assert.equal(dear.meanDelta, -1.875);
  assert.equal(dear.wins, 1);
  assert.equal(dear.losses, 0);
  assert.equal(dear.meanAgreement, 1);
  assert.equal(dear.validRate, 0.5);
  assert.equal(dear.meanCostUsd, 0.03);
  const referenceLine = summary[2];
  assert.equal(referenceLine.n, 0);
  assert.equal(referenceLine.meanDelta, null);
  assert.equal(referenceLine.validRate, 1);
  assert.equal(referenceLine.noiseFloor, false);
  const floor = summary[3];
  assert.equal(floor.n, 1);
  assert.equal(floor.meanDelta, 0);
  assert.equal(floor.ties, 1);
  assert.equal(floor.meanAgreement, 0.75);
  assert.equal(floor.meanCostUsd, 0.04);
  assert.equal(floor.noiseFloor, true);
});

const kneeSummary = [
  {
    operation: "generate",
    setting: "dear",
    rep: 0,
    meanCostUsd: 0.04,
    meanDelta: 1.65,
    validRate: 0.99,
    noiseFloor: false,
  },
  {
    operation: "generate",
    setting: "ref",
    rep: 1,
    meanCostUsd: 0.08,
    meanDelta: 0.05,
    validRate: 0.96,
    noiseFloor: true,
  },
  {
    operation: "generate",
    setting: "cheap",
    rep: 0,
    meanCostUsd: 0.01,
    meanDelta: 0.5,
    validRate: 0.95,
    noiseFloor: false,
  },
  {
    operation: "generate",
    setting: "mid",
    rep: 0,
    meanCostUsd: 0.02,
    meanDelta: 1.6,
    validRate: 0.95,
    noiseFloor: false,
  },
];

test("kneeReport orders by cost and flags the first flat knee", () => {
  const [report] = kneeReport(kneeSummary);
  assert.equal(report.operation, "generate");
  assert.deepEqual(
    report.settings.map((entry) => entry.setting),
    ["cheap", "mid", "dear", "ref"],
  );
  // The noise floor line's own delta bounds what counts as an improvement.
  assert.equal(report.noiseFloorDelta, 0.05);
  assert.equal(report.referenceValidRate, 0.96);
  assert.equal(report.knee, "mid");
  assert.equal(report.needsMore, false);
  const [reordered] = kneeReport(kneeSummary, {
    costOrder: ["ref", "dear", "mid", "cheap"],
  });
  assert.deepEqual(
    reordered.settings.map((entry) => entry.setting),
    ["ref", "dear", "mid", "cheap"],
  );
});

test("kneeReport asks for more arms when fewer than two dearer settings exist", () => {
  const report = kneeReport([
    {
      operation: "generate",
      setting: "cheap",
      rep: 0,
      meanCostUsd: 0.01,
      meanDelta: 1,
      validRate: 1,
      noiseFloor: true,
    },
    {
      operation: "generate",
      setting: "dear",
      rep: 0,
      meanCostUsd: 0.02,
      meanDelta: 1.1,
      validRate: 1,
      noiseFloor: false,
    },
  ]);
  assert.equal(report.length, 1);
  assert.equal(report[0].needsMore, true);
  assert.equal(report[0].knee, null);
  assert.equal(report[0].noiseFloorDelta, 1);
  assert.equal(report[0].settings.length, 2);
});

// A stand-in for the Claude CLI: records its argv, cwd and stdin, then prints
// whatever CLI-shaped result STUB_REPLY holds (or sleeps, or exits non-zero).
const STUB = `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => {
  writeFileSync(process.env.STUB_RECORD, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    stdin: input,
    apiKey: process.env.ANTHROPIC_API_KEY ?? null,
  }));
  const mode = process.env.STUB_MODE ?? "ok";
  if (mode === "sleep") return setTimeout(() => {}, 60000);
  if (mode === "fail") {
    process.stderr.write("boom from stub");
    process.exit(3);
  }
  process.stdout.write(process.env.STUB_REPLY);
});
`;
const cliResult = (overrides = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: '{"scoreA": 7, "scoreB": 4, "better": "A", "reason": "closer"}',
  total_cost_usd: 0.0421,
  modelUsage: { "claude-opus-4-7": { costUSD: 0.0421 } },
  ...overrides,
});
const stubCli = (t, { mode = "ok", reply = cliResult() } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ai-judge-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "claude-stub");
  writeFileSync(bin, STUB);
  chmodSync(bin, 0o755);
  const recordFile = join(dir, "record.json");
  const env = {
    PATH: process.env.PATH,
    STUB_RECORD: recordFile,
    STUB_MODE: mode,
    STUB_REPLY: typeof reply === "string" ? reply : JSON.stringify(reply),
    ANTHROPIC_API_KEY: "sk-test-not-real",
  };
  return {
    bin,
    env,
    record: () => JSON.parse(readFileSync(recordFile, "utf8")),
  };
};
const flagValue = (argv, flag) => argv[argv.indexOf(flag) + 1];

test("the Claude judge runs one locked-down CLI call and parses the result", async (t) => {
  const stub = stubCli(t);
  const neutral = mkdtempSync(join(tmpdir(), "ai-judge-cwd-"));
  t.after(() => rmSync(neutral, { recursive: true, force: true }));
  const completer = createClaudeCompleter({
    bin: stub.bin,
    env: stub.env,
    cwd: neutral,
  });
  assert.equal(completer.judge, "claude:opus:high");
  const messages = judgeMessages({
    instructions: "Write one question.",
    payload: { focus: "heaps", big: "x".repeat(5000) },
    answerA: { title: "A" },
    answerB: { title: "B" },
  });
  const reply = await completer({
    route: "deepseek-flash",
    caller: "study-ai-judge",
    tag: "judge",
    maxTokens: 32000,
    messages,
  });
  assert.deepEqual(reply, {
    text: '{"scoreA": 7, "scoreB": 4, "better": "A", "reason": "closer"}',
    costUsd: 0.0421,
  });
  const { argv, stdin, cwd, apiKey } = stub.record();
  assert.equal(argv[0], "-p");
  for (const flag of [
    "--no-session-persistence",
    "--strict-mcp-config",
    "--disable-slash-commands",
  ])
    assert.ok(argv.includes(flag), flag);
  assert.equal(flagValue(argv, "--tools"), "");
  assert.equal(flagValue(argv, "--setting-sources"), "");
  assert.equal(flagValue(argv, "--output-format"), "json");
  assert.equal(flagValue(argv, "--model"), "opus");
  assert.equal(flagValue(argv, "--effort"), "high");
  assert.equal(flagValue(argv, "--system-prompt"), JUDGE_SYSTEM);
  // The large user content goes through stdin, never argv.
  assert.equal(stdin, messages[1].content);
  assert.equal(
    argv.some((value) => value.includes("x".repeat(100))),
    false,
  );
  assert.equal(realpathOf(cwd), realpathOf(neutral));
  // An API key in the environment would bill it instead of the login.
  assert.equal(apiKey, null);
});

test("the Claude judge honours a lower setting and refuses max or unknown models", async (t) => {
  const stub = stubCli(t, {
    reply: cliResult({ modelUsage: { "claude-sonnet-4-6": {} } }),
  });
  const completer = createClaudeCompleter({
    bin: stub.bin,
    env: stub.env,
    model: "sonnet",
    effort: "xhigh",
  });
  assert.equal(completer.judge, "claude:sonnet:xhigh");
  await completer({ messages: judgeMessages({ instructions: "x" }) });
  const { argv } = stub.record();
  assert.equal(flagValue(argv, "--model"), "sonnet");
  assert.equal(flagValue(argv, "--effort"), "xhigh");
  assert.throws(() => createClaudeCompleter({ effort: "max" }), /max/);
  assert.throws(() => createClaudeCompleter({ model: "fable" }), /model/);
  assert.throws(
    () => createClaudeCompleter({ model: "claude-opus-4-7" }),
    /Invalid setting/,
  );
});

test("the Claude judge reports CLI failures clearly", async (t) => {
  const messages = judgeMessages({ instructions: "x" });
  const run = (options, completerOptions = {}) => {
    const stub = stubCli(t, options);
    return createClaudeCompleter({
      bin: stub.bin,
      env: stub.env,
      ...completerOptions,
    })({ messages });
  };
  await assert.rejects(
    run({ mode: "fail" }),
    /claude exited 3: boom from stub/,
  );
  await assert.rejects(
    run({
      reply: cliResult({
        is_error: true,
        subtype: "error_during_execution",
        result: "usage limit",
      }),
    }),
    /claude failed: error_during_execution usage limit/,
  );
  await assert.rejects(
    run({ reply: cliResult({ result: "   " }) }),
    /empty reply/,
  );
  await assert.rejects(run({ reply: "not json" }), /no JSON result/);
  await assert.rejects(
    run({ reply: cliResult({ modelUsage: { "claude-haiku-4-5": {} } }) }),
    /instead of opus/,
  );
  await assert.rejects(
    run({ mode: "sleep" }, { timeoutMs: 300 }),
    /timed out after 300ms/,
  );
});

test("every judgment row names its judge and the report warns on a mix", async (t) => {
  const out = tempOut();
  t.after(() => rmSync(out, { recursive: true, force: true }));
  writeRows(out, [
    ladderRow({ setting: "sonnet:high", rep: 0 }),
    ladderRow({ setting: "sonnet:high", rep: 1 }),
    ladderRow({
      setting: "haiku:low",
      rep: 0,
      outcome: "invalid",
      answers: [],
    }),
  ]);
  const stub = stubCli(t);
  const result = await judgeLadder({
    out,
    cases: CASES,
    reference: { setting: "sonnet:high", rep: 0 },
    completer: createClaudeCompleter({ bin: stub.bin, env: stub.env }),
  });
  assert.equal(result.judge, "claude:opus:high");
  const rows = readJudgments(out);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.judge),
    ["claude:opus:high", "claude:opus:high"],
  );
  const judged = rows.find((row) => row.verdict !== "invalid");
  assert.equal(judged.judgeCostUsd, 0.0421);
  assert.deepEqual(judgesOf(rows), ["claude:opus:high"]);
  assert.equal(mixedJudgeWarning(rows), null);
  const mixed = [...rows, { ...rows[0], judge: "offload:deepseek-flash" }, {}];
  assert.deepEqual(judgesOf(mixed), [
    "claude:opus:high",
    "offload:deepseek-flash",
    "unrecorded",
  ]);
  assert.match(mixedJudgeWarning(mixed), /^Warning: .*mixes 3 judges/);
});
