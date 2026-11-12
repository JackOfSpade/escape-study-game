import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChainRows,
  summarizeChains,
} from "../scripts/ai-capture/downstream-chains.mjs";
import { judgeLadder } from "../scripts/ai-judge.mjs";

const SCRIPT = fileURLToPath(
  new URL("../scripts/ai-capture/downstream-chains.mjs", import.meta.url),
);
const tempDir = () => mkdtempSync(join(tmpdir(), "downstream-chains-test-"));

const row = ({
  caseId,
  operation,
  setting,
  rep = 0,
  outcome = "valid",
  answer,
  costUsd,
  durationMs,
  model = [],
}) => ({
  v: 1,
  at: "2026-01-01T00:00:00.000Z",
  runId: "fixture",
  caseId,
  operation,
  setting,
  rep,
  outcome,
  answers: answer === undefined ? [] : [answer],
  costUsd,
  durationMs,
  model,
});

const questions = {
  "case-a": { title: "A", prompt: "Explain alpha" },
  "case-b": { title: "B", prompt: "Explain beta" },
};
const generateRows = (setting) => [
  row({
    caseId: "case-a",
    operation: "generate",
    setting,
    answer: questions["case-a"],
    costUsd: 10,
    durationMs: 100,
    model: ["claude-gen"],
  }),
  row({
    caseId: "case-b",
    operation: "generate",
    setting,
    answer: questions["case-b"],
    costUsd: 10,
    durationMs: 100,
    model: ["claude-gen"],
  }),
];
const downstreamRows = (operation, setting) => [
  row({
    caseId: `${operation}-from-case-a`,
    operation,
    setting,
    answer: `${operation} alpha`,
    costUsd: operation === "tutor" ? 2 : 3,
    durationMs: operation === "tutor" ? 40 : 60,
    model: [`claude-${operation}`],
  }),
  row({
    caseId: `${operation}-from-case-b`,
    operation,
    setting,
    answer: `${operation} beta`,
    costUsd: operation === "tutor" ? 2 : 3,
    durationMs: operation === "tutor" ? 40 : 60,
    model: [`claude-${operation}`],
  }),
];
const fixtureGenerate = [
  ...generateRows("haiku:low"),
  ...generateRows("sonnet:high"),
];
const fixtureArms = ["haiku:low", "sonnet:high"].map((setting) => ({
  setting,
  tutor: downstreamRows("tutor", setting),
  assess: downstreamRows("assess", setting),
}));
const writeRows = (file, rows) =>
  writeFileSync(
    file,
    rows.length
      ? `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      : "",
  );

test("one chain row per generate case per arm joins all three answers", () => {
  const rows = buildChainRows({
    generate: fixtureGenerate,
    arms: fixtureArms,
    now: () => Date.parse("2026-02-01T00:00:00.000Z"),
  });
  assert.equal(rows.length, 4);
  assert.deepEqual(
    rows.map((entry) => [entry.setting, entry.caseId]),
    [
      ["haiku:low", "case-a"],
      ["haiku:low", "case-b"],
      ["sonnet:high", "case-a"],
      ["sonnet:high", "case-b"],
    ],
  );
  for (const entry of rows) {
    assert.equal(entry.v, 1);
    assert.equal(entry.operation, "generate");
    assert.equal(entry.rep, 0);
    assert.equal(entry.outcome, "valid");
    assert.equal(entry.at, "2026-02-01T00:00:00.000Z");
    assert.equal(entry.runId, "downstream-chains-2026-02-01T00-00-00-000Z");
    const suffix = entry.caseId === "case-a" ? "alpha" : "beta";
    assert.deepEqual(entry.answers, [
      {
        question: questions[entry.caseId],
        tutorReply: `tutor ${suffix}`,
        assessment: `assess ${suffix}`,
      },
    ]);
    assert.equal(entry.costUsd, 15);
    assert.equal(entry.durationMs, 200);
    assert.deepEqual(entry.model, [
      "claude-gen",
      "claude-tutor",
      "claude-assess",
    ]);
  }
  assert.deepEqual(summarizeChains(rows, fixtureArms), [
    { setting: "haiku:low", total: 2, complete: 2, invalid: 0 },
    { setting: "sonnet:high", total: 2, complete: 2, invalid: 0 },
  ]);
});

test("rep 0 is preferred and any valid rep can stand in", () => {
  const setting = "sonnet:high";
  const tutor = [
    row({
      caseId: "tutor-from-case-a",
      operation: "tutor",
      setting,
      rep: 0,
      answer: "rep zero",
    }),
    row({
      caseId: "tutor-from-case-a",
      operation: "tutor",
      setting,
      rep: 1,
      answer: "rep one",
    }),
    row({
      caseId: "tutor-from-case-b",
      operation: "tutor",
      setting,
      rep: 0,
      outcome: "invalid",
    }),
    row({
      caseId: "tutor-from-case-b",
      operation: "tutor",
      setting,
      rep: 2,
      answer: "rep two",
      costUsd: 2,
      durationMs: 40,
    }),
  ];
  const assess = [
    row({
      caseId: "assess-from-case-a",
      operation: "assess",
      setting,
      rep: 0,
      answer: "assessed alpha",
    }),
  ];
  const rows = buildChainRows({
    generate: generateRows(setting),
    arms: [{ setting, tutor, assess }],
    now: () => 0,
  });
  const alpha = rows.find((entry) => entry.caseId === "case-a");
  assert.equal(alpha.outcome, "valid");
  assert.equal(alpha.answers[0].tutorReply, "rep zero");
  const beta = rows.find((entry) => entry.caseId === "case-b");
  // The valid rep 2 stands in, but there is no assess piece for case-b.
  assert.equal(beta.outcome, "invalid");
  assert.deepEqual(beta.answers, []);
  assert.equal(beta.costUsd, 12);
  assert.equal(beta.durationMs, 140);
});

test("an invalid or missing generate row makes the whole chain invalid", () => {
  const setting = "haiku:low";
  const generate = [
    ...generateRows(setting).filter((entry) => entry.caseId === "case-a"),
    row({
      caseId: "case-b",
      operation: "generate",
      setting,
      outcome: "timeout",
      costUsd: 1,
    }),
  ];
  const arms = [
    {
      setting,
      tutor: downstreamRows("tutor", setting),
      assess: downstreamRows("assess", setting),
    },
    {
      setting: "opus:low",
      tutor: [],
      assess: [],
    },
  ];
  const rows = buildChainRows({
    generate,
    arms,
    generateRep: 0,
    now: () => 0,
  });
  assert.deepEqual(
    rows.map((entry) => [entry.setting, entry.caseId, entry.outcome]),
    [
      ["haiku:low", "case-a", "valid"],
      ["haiku:low", "case-b", "invalid"],
      ["opus:low", "case-a", "invalid"],
      ["opus:low", "case-b", "invalid"],
    ],
  );
  for (const entry of rows.filter((candidate) => candidate.caseId === "b"))
    assert.deepEqual(entry.answers, []);
  // A generate row at another rep is not the requested arm row.
  const otherRep = buildChainRows({
    generate: [generate[0]],
    arms: [arms[0]],
    generateRep: 3,
    now: () => 0,
  });
  assert.equal(otherRep[0].outcome, "invalid");
  assert.throws(
    () => buildChainRows({ generate, arms, generateRep: -1 }),
    /non-negative integer/,
  );
});

test("the CLI writes results.jsonl that ai-judge reads and judges", async (t) => {
  const dir = tempDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const generateFile = join(dir, "generate.jsonl");
  writeRows(generateFile, fixtureGenerate);
  const armArgs = fixtureArms.map((arm) => {
    const name = arm.setting.replace(":", "-");
    const tutorFile = join(dir, `${name}-tutor.jsonl`);
    const assessFile = join(dir, `${name}-assess.jsonl`);
    writeRows(tutorFile, arm.tutor);
    writeRows(
      assessFile,
      // One broken chain: haiku:low has no assess row for case-b.
      arm.setting === "haiku:low"
        ? arm.assess.filter((entry) => entry.caseId === "assess-from-case-a")
        : arm.assess,
    );
    return ["--arm", `${arm.setting}=${tutorFile},${assessFile}`];
  });
  const out = join(dir, "chains");
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT,
      "--generate",
      generateFile,
      ...armArgs.flat(),
      "--generate-rep",
      "0",
      "--out",
      out,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^haiku:low: 2 chain\(s\), 1 complete, 1 invalid$/m,
  );
  assert.match(
    result.stdout,
    /^sonnet:high: 2 chain\(s\), 2 complete, 0 invalid$/m,
  );
  assert.equal(statSync(out).mode & 0o777, 0o700);
  const resultsFile = join(out, "results.jsonl");
  assert.equal(statSync(resultsFile).mode & 0o777, 0o600);
  const parsed = readFileSync(resultsFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(parsed.length, 4);
  const broken = parsed.find(
    (entry) => entry.setting === "haiku:low" && entry.caseId === "case-b",
  );
  assert.equal(broken.outcome, "invalid");
  assert.deepEqual(broken.answers, []);

  const cases = [
    {
      id: "case-a",
      operation: "generate",
      payload: { objectiveIds: ["PY:loops"], depth: 1 },
    },
    {
      id: "case-b",
      operation: "generate",
      payload: { objectiveIds: ["PY:lists"], depth: 2 },
    },
  ];
  const calls = [];
  const judged = await judgeLadder({
    out,
    cases,
    reference: { setting: "sonnet:high", rep: 0 },
    parallel: 2,
    completer: async (request) => {
      calls.push(request);
      return {
        text: '{"scoreA": 6, "scoreB": 6, "better": "tie", "reason": "same"}',
        costUsd: 0,
      };
    },
  });
  assert.equal(judged.judgments.length, 2);
  assert.equal(
    judged.judgments.filter((job) => job.verdict === "tie").length,
    1,
  );
  assert.equal(
    judged.judgments.filter((job) => job.verdict === "invalid").length,
    1,
  );
  assert.equal(calls.length, 1);
  const content = calls[0].messages[1].content;
  assert.equal(
    content.split("Payload:\n")[1].split("\n\nAnswer A:")[0],
    JSON.stringify(cases[0].payload),
  );
  const chain = parsed.find(
    (entry) => entry.setting === "haiku:low" && entry.caseId === "case-a",
  ).answers[0];
  const shown = [
    content.split("Answer A:\n")[1].split("\n\n")[0],
    content.split("Answer B:\n")[1].split("\n\n")[0],
  ];
  assert.ok(shown.includes(JSON.stringify(chain)));
});
