#!/usr/bin/env node
/** Blind pairwise judge for ladder results: every arm's answers are scored
 * against one reference arm, and the reference arm's repeat run measures the
 * noise floor a difference has to beat to mean anything. */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  defaultOut,
  parseArgs,
  readCases,
  readLadderRows,
} from "./ai-ladder.mjs";
import { taskInstructions } from "./lib/ai-contracts.mjs";

export const JUDGE_SYSTEM =
  "You are a strict, impartial evaluator of AI outputs for a study game. Judge only against the task instructions. Ignore length and style unless the instructions require them. Reply with one JSON object only.";

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) => {
  const known = values.filter(isNumber);
  return known.length
    ? known.reduce((total, value) => total + value, 0) / known.length
    : null;
};
const judgmentKey = (row) =>
  `${row.caseId}\u0000${row.setting}\u0000${row.rep}`;
const lastAnswer = (row) =>
  Array.isArray(row?.answers) && row.answers.length
    ? row.answers[row.answers.length - 1]
    : null;

/** FNV-1a over the row identity: stable across runs and machines. */
export function stableHash(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < String(text).length; index++) {
    hash ^= String(text).charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** True when the candidate is shown first; a deterministic coin per row. */
export function candidateFirst(caseId, setting, rep) {
  return (stableHash(`${caseId}|${setting}|${rep}`) & 1) === 0;
}

/** The first balanced JSON object in the text, or null. */
export function firstJsonObject(text) {
  const source = String(text ?? "");
  for (
    let start = source.indexOf("{");
    start !== -1;
    start = source.indexOf("{", start + 1)
  ) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < source.length; index++) {
      const char = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(source.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

const isScalar = (value) =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

/** Top-level scalar fields, plus one level of `a.b` inside plain objects. */
export function scalarFields(answer) {
  const fields = new Map();
  if (!answer || typeof answer !== "object" || Array.isArray(answer))
    return fields;
  for (const [key, value] of Object.entries(answer)) {
    if (isScalar(value)) fields.set(key, value);
    else if (value && typeof value === "object" && !Array.isArray(value))
      for (const [inner, innerValue] of Object.entries(value))
        if (isScalar(innerValue)) fields.set(`${key}.${inner}`, innerValue);
  }
  return fields;
}

/** Fraction of the reference's scalar fields whose values match exactly. */
export function fieldAgreement(referenceAnswer, candidateAnswer) {
  const reference = scalarFields(referenceAnswer);
  if (!reference.size) return 1;
  const candidate = scalarFields(candidateAnswer);
  let equal = 0;
  for (const [key, value] of reference)
    if (candidate.has(key) && candidate.get(key) === value) equal++;
  return equal / reference.size;
}

const truncate = (text, limit) => {
  const source = String(text ?? "");
  const max = Math.max(0, Math.floor(Number(limit) || 0));
  return source.length <= max
    ? source
    : `${source.slice(0, max)}\n[payload truncated after ${max} characters]`;
};

/** The exact judge conversation for one blind pair. */
export function judgeMessages({
  instructions,
  payload,
  answerA,
  answerB,
  maxPayloadChars = 60000,
}) {
  const user = [
    String(instructions ?? ""),
    "",
    "Payload:",
    truncate(JSON.stringify(payload ?? null), maxPayloadChars),
    "",
    "Answer A:",
    JSON.stringify(answerA ?? null),
    "",
    "Answer B:",
    JSON.stringify(answerB ?? null),
    "",
    'Judge only against the task instructions. Score each answer from 1 to 10 for how well it serves them. Reply with one JSON object only: {"scoreA": <1-10>, "scoreB": <1-10>, "better": "A"|"B"|"tie", "reason": "<= 40 words"}',
  ].join("\n");
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: user },
  ];
}

const scoreOf = (value) => {
  const score = typeof value === "string" ? Number(value) : value;
  return isNumber(score) && score >= 1 && score <= 10 ? score : null;
};

/** `{scoreA, scoreB, better, reason}` from a judge reply, or null if malformed. */
export function parseJudgeReply(text) {
  const reply = firstJsonObject(text);
  if (!reply || typeof reply !== "object") return null;
  const scoreA = scoreOf(reply.scoreA);
  const scoreB = scoreOf(reply.scoreB);
  const better = String(reply.better ?? "")
    .trim()
    .toLowerCase();
  if (scoreA === null || scoreB === null) return null;
  if (!["a", "b", "tie"].includes(better)) return null;
  return {
    scoreA,
    scoreB,
    better: better === "tie" ? "tie" : better.toUpperCase(),
    reason: typeof reply.reason === "string" ? reply.reason.trim() : "",
  };
}

/** Map a blind reply back to the candidate's perspective. */
export function mapJudgment(parsed, candidateWasA) {
  const candidateScore = candidateWasA ? parsed.scoreA : parsed.scoreB;
  const referenceScore = candidateWasA ? parsed.scoreB : parsed.scoreA;
  const verdict =
    parsed.better === "tie"
      ? "tie"
      : (parsed.better === "A") === candidateWasA
        ? "win"
        : "loss";
  return { candidateScore, referenceScore, verdict };
}

/** Reads `<out>/judgments.jsonl`, skipping unreadable lines. */
export function readJudgments(out) {
  const file = join(out, "judgments.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const judgment = JSON.parse(line);
        return judgment && typeof judgment === "object" ? [judgment] : [];
      } catch {
        return [];
      }
    });
}

/** The reference arm: the setting a ladder ran twice, its first run. */
export function resolveReference(rows, reference) {
  const list = Array.isArray(rows) ? rows : [];
  if (reference && typeof reference.setting === "string" && reference.setting) {
    const rep = Number.isInteger(reference.rep) ? reference.rep : 1;
    return { setting: reference.setting, rep };
  }
  const repeated = list.filter((row) => row.rep === 2);
  const pool = repeated.length ? repeated : list;
  const counts = new Map();
  for (const row of pool)
    counts.set(row.setting, (counts.get(row.setting) ?? 0) + 1);
  const setting =
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? null;
  if (!setting) return { setting: null, rep: 1 };
  const reps = list
    .filter((row) => row.setting === setting)
    .map((row) => row.rep);
  return { setting, rep: reps.includes(1) ? 1 : Math.min(...reps) };
}

// DeepSeek reasoning tokens count toward this cap, so leave room beyond the reply.
const JUDGE_MAX_TOKENS = 32000;

/** One `offload complete` call: one JSON line in, one JSON line out. */
export function createOffloadCompleter({
  bin = process.env.OFFLOAD_BIN ?? "offload",
  timeoutMs = 180000,
  env = process.env,
} = {}) {
  return (request) =>
    new Promise((resolve, reject) => {
      const child = spawn(bin, ["complete"], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error(`offload timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(Error(`could not spawn ${bin}: ${error.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(
            Error(`${bin} exited ${code}: ${(stderr || stdout).slice(0, 400)}`),
          );
          return;
        }
        const line = stdout
          .split("\n")
          .map((part) => part.trim())
          .find((part) => part.startsWith("{"));
        if (!line) {
          reject(
            Error(`offload printed no JSON reply: ${stdout.slice(0, 400)}`),
          );
          return;
        }
        let reply;
        try {
          reply = JSON.parse(line);
        } catch (error) {
          reject(Error(`offload printed invalid JSON: ${error.message}`));
          return;
        }
        if (!reply?.ok) {
          reject(
            Error(
              `offload failed: ${reply?.error?.code ?? "unknown"} ${
                reply?.error?.message ?? ""
              }`.trim(),
            ),
          );
          return;
        }
        const text = String(reply.text ?? "").trim();
        if (!text) {
          reject(Error("offload returned an empty reply"));
          return;
        }
        resolve({
          text,
          costUsd: isNumber(reply.costUsd) ? reply.costUsd : null,
        });
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
}

const replyText = (reply) =>
  typeof reply === "string" ? reply : String(reply?.text ?? "");
const replyCost = (reply) =>
  typeof reply === "object" && isNumber(reply?.costUsd) ? reply.costUsd : null;

/** Asks once, retries one malformed reply, then gives up with null. */
async function askJudge(completer, messages) {
  let cost = null;
  let text = "";
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const reply = await completer({
        route: "deepseek-flash",
        caller: "zombie-ai-judge",
        tag: "judge",
        maxTokens: JUDGE_MAX_TOKENS,
        messages,
      });
      cost = (cost ?? 0) + (replyCost(reply) ?? 0);
      text = replyText(reply);
      const parsed = parseJudgeReply(text);
      if (parsed) return { parsed, costUsd: cost };
      lastError = "judge reply was not the requested JSON";
    } catch (error) {
      lastError = error?.message ?? String(error);
    }
  }
  return { parsed: null, costUsd: cost, error: lastError, text };
}

const payloadOf = (entry) => {
  if (!entry) return null;
  if (Array.isArray(entry.sequence))
    return entry.sequence.length
      ? entry.sequence[entry.sequence.length - 1]
      : null;
  return entry.payload ?? null;
};

const instructionsOf = (entry, operation, payload) => {
  const target = entry?.operation ?? operation;
  try {
    return taskInstructions(target, payload);
  } catch {
    return `Follow the task instructions for the ${target} operation.`;
  }
};

/** Judges every non-reference valid row against the reference row, blindly. */
export async function judgeLadder({
  out,
  cases,
  reference,
  completer = createOffloadCompleter(),
  parallel = 4,
  maxPayloadChars = 60000,
  only,
} = {}) {
  if (typeof out !== "string" || !out.trim())
    throw Error("An output directory is required");
  // `only` limits judging to some operations, so each can use its own reference.
  const wanted = only?.length ? new Set(only) : undefined;
  const rows = readLadderRows(out).filter(
    (row) => !wanted || wanted.has(row.operation),
  );
  const judgmentsFile = join(out, "judgments.jsonl");
  const caseMap = new Map();
  for (const entry of Array.isArray(cases) ? cases : [])
    if (entry && typeof entry.id === "string") caseMap.set(entry.id, entry);
  const resolved = resolveReference(rows, reference);
  const referenceRows = new Map();
  for (const row of rows)
    if (row.setting === resolved.setting && row.rep === resolved.rep)
      referenceRows.set(row.caseId, row);
  const done = new Set(readJudgments(out).map(judgmentKey));
  const jobs = [];
  let skipped = 0;
  for (const row of rows) {
    if (row.setting === resolved.setting && row.rep === resolved.rep) continue;
    const referenceRow = referenceRows.get(row.caseId);
    if (!referenceRow) continue;
    if (done.has(judgmentKey(row))) {
      skipped++;
      continue;
    }
    jobs.push({ row, referenceRow });
  }
  const judgments = [];
  const record = (judgment) => {
    appendFileSync(judgmentsFile, `${JSON.stringify(judgment)}\n`, {
      mode: 0o600,
    });
    judgments.push(judgment);
  };
  const judgePair = async ({ row, referenceRow }) => {
    const base = {
      v: 1,
      caseId: row.caseId,
      operation: row.operation,
      setting: row.setting,
      rep: row.rep,
    };
    const referenceAnswer = lastAnswer(referenceRow);
    if (row.outcome !== "valid")
      return {
        ...base,
        verdict: "invalid",
        candidateScore: 0,
        referenceScore: null,
        delta: null,
        agreement: fieldAgreement(referenceAnswer, lastAnswer(row)),
        judgeCostUsd: 0,
        reason: `candidate outcome ${row.outcome ?? "error"}`,
      };
    const entry = caseMap.get(row.caseId);
    const payload = payloadOf(entry);
    const instructions = instructionsOf(entry, row.operation, payload);
    const candidateAnswer = lastAnswer(row);
    const candidateWasA = candidateFirst(row.caseId, row.setting, row.rep);
    const messages = judgeMessages({
      instructions,
      payload,
      answerA: candidateWasA ? candidateAnswer : referenceAnswer,
      answerB: candidateWasA ? referenceAnswer : candidateAnswer,
      maxPayloadChars,
    });
    const reply = await askJudge(completer, messages);
    if (!reply.parsed)
      return {
        ...base,
        verdict: "judge-error",
        candidateScore: null,
        referenceScore: null,
        delta: null,
        agreement: fieldAgreement(referenceAnswer, candidateAnswer),
        judgeCostUsd: reply.costUsd,
        reason: String(reply.error ?? "judge reply was not usable").slice(
          0,
          200,
        ),
      };
    const mapped = mapJudgment(reply.parsed, candidateWasA);
    return {
      ...base,
      verdict: mapped.verdict,
      candidateScore: mapped.candidateScore,
      referenceScore: mapped.referenceScore,
      delta: mapped.candidateScore - mapped.referenceScore,
      agreement: fieldAgreement(referenceAnswer, candidateAnswer),
      judgeCostUsd: reply.costUsd,
      reason: reply.parsed.reason,
    };
  };
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      record(await judgePair(job));
    }
  };
  const limit = Math.max(1, Math.floor(Number(parallel)) || 1);
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, () => worker()),
  );
  return {
    out,
    judgmentsFile,
    reference: resolved,
    judgments,
    skipped,
    pending: jobs.length,
  };
}

const noiseFloorEntry = (summary, reference) => {
  const lines = summary.filter((entry) => entry.setting === reference.setting);
  if (!lines.length) return null;
  const repeated = lines.find((entry) => entry.rep === 2);
  if (repeated) return repeated;
  const others = lines.filter((entry) => entry.rep !== reference.rep);
  if (others.length) return others.sort((a, b) => b.rep - a.rep)[0];
  return lines[0];
};

/** Per operation × setting × rep quality, agreement, validity and cost. */
export function summarizeJudgments(judgments, rows, { reference } = {}) {
  const rowList = Array.isArray(rows) ? rows : [];
  const list = Array.isArray(judgments) ? judgments : [];
  const resolved = resolveReference(rowList, reference);
  const referenceMeans = new Map();
  for (const judgment of list) {
    const values = referenceMeans.get(judgment.operation) ?? [];
    if (isNumber(judgment.referenceScore)) values.push(judgment.referenceScore);
    referenceMeans.set(judgment.operation, values);
  }
  const groups = new Map();
  const groupOf = (operation, setting, rep) => {
    const key = `${operation}\u0000${setting}\u0000${rep}`;
    let group = groups.get(key);
    if (!group) {
      group = { operation, setting, rep, judgments: [], rows: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const row of rowList)
    groupOf(row.operation, row.setting, row.rep).rows.push(row);
  for (const judgment of list)
    groupOf(judgment.operation, judgment.setting, judgment.rep).judgments.push(
      judgment,
    );
  const summary = [...groups.values()].map((group) => {
    const referenceMean = mean(referenceMeans.get(group.operation) ?? []);
    const deltas = group.judgments.map((judgment) => {
      if (isNumber(judgment.delta)) return judgment.delta;
      if (judgment.verdict === "invalid" && isNumber(referenceMean))
        return 0 - referenceMean;
      return null;
    });
    const costs = group.rows.map((row) => row.costUsd);
    return {
      operation: group.operation,
      setting: group.setting,
      rep: group.rep,
      n: group.judgments.length,
      meanDelta: mean(deltas),
      wins: group.judgments.filter((entry) => entry.verdict === "win").length,
      ties: group.judgments.filter((entry) => entry.verdict === "tie").length,
      losses: group.judgments.filter((entry) => entry.verdict === "loss")
        .length,
      errors: group.judgments.filter((entry) => entry.verdict === "judge-error")
        .length,
      meanAgreement: mean(group.judgments.map((entry) => entry.agreement)),
      validRate: group.rows.length
        ? group.rows.filter((row) => row.outcome === "valid").length /
          group.rows.length
        : null,
      meanCostUsd: mean(costs),
      noiseFloor: false,
    };
  });
  const floor = noiseFloorEntry(summary, resolved);
  if (floor) floor.noiseFloor = true;
  return summary.sort(
    (a, b) =>
      a.operation.localeCompare(b.operation) ||
      a.setting.localeCompare(b.setting) ||
      a.rep - b.rep,
  );
}

/** Where extra spend stops buying measurable quality: the knee per operation. */
export function kneeReport(summary, { costOrder } = {}) {
  const entries = Array.isArray(summary) ? summary : [];
  const order = Array.isArray(costOrder) ? costOrder : null;
  const orderIndex = new Map(
    (order ?? []).map((setting, index) => [setting, index]),
  );
  const operations = [
    ...new Set(entries.map((entry) => entry.operation)),
  ].sort();
  return operations.map((operation) => {
    const lines = entries.filter((entry) => entry.operation === operation);
    const bySetting = new Map();
    for (const line of lines) {
      const bucket = bySetting.get(line.setting) ?? [];
      bucket.push(line);
      bySetting.set(line.setting, bucket);
    }
    const settings = [...bySetting.entries()]
      .map(([setting, bucket]) => ({
        setting,
        meanCostUsd: mean(bucket.map((line) => line.meanCostUsd)),
        meanDelta: mean(bucket.map((line) => line.meanDelta)),
        validRate: mean(bucket.map((line) => line.validRate)),
        noiseFloor: bucket.some((line) => line.noiseFloor),
      }))
      .sort((a, b) => {
        if (order) {
          const left = orderIndex.get(a.setting) ?? Infinity;
          const right = orderIndex.get(b.setting) ?? Infinity;
          if (left !== right) return left - right;
        }
        const left = isNumber(a.meanCostUsd) ? a.meanCostUsd : Infinity;
        const right = isNumber(b.meanCostUsd) ? b.meanCostUsd : Infinity;
        if (left !== right) return left - right;
        return a.setting.localeCompare(b.setting);
      });
    const floor = settings.find((entry) => entry.noiseFloor) ?? null;
    const noiseFloorDelta =
      floor && isNumber(floor.meanDelta) ? Math.abs(floor.meanDelta) : null;
    const referenceValidRate = floor ? floor.validRate : null;
    let knee = null;
    if (settings.length >= 3) {
      for (let index = 0; index + 2 < settings.length; index++) {
        const base = settings[index];
        const next = settings[index + 1];
        const after = settings[index + 2];
        if (
          !isNumber(noiseFloorDelta) ||
          !isNumber(base.meanDelta) ||
          !isNumber(next.meanDelta) ||
          !isNumber(after.meanDelta) ||
          !isNumber(base.validRate) ||
          !isNumber(referenceValidRate)
        )
          continue;
        const flat =
          next.meanDelta - base.meanDelta <= noiseFloorDelta &&
          after.meanDelta - base.meanDelta <= noiseFloorDelta;
        if (flat && base.validRate >= referenceValidRate - 0.1) {
          knee = base.setting;
          break;
        }
      }
    }
    return {
      operation,
      noiseFloorDelta,
      referenceValidRate,
      knee,
      needsMore: settings.length < 3,
      settings,
    };
  });
}

const percent = (value) =>
  isNumber(value) ? `${Math.round(value * 100)}%` : "-";
const money = (value) => (isNumber(value) ? value.toFixed(4) : "-");
const number = (value) => (isNumber(value) ? String(value) : "-");
const table = (rows) => {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => row[column].length)),
  );
  return rows
    .map((row) =>
      row.map((value, column) => value.padEnd(widths[column])).join("  "),
    )
    .join("\n");
};

export function formatJudgmentSummary(summary) {
  const rows = [
    [
      "operation",
      "setting",
      "rep",
      "n",
      "delta",
      "w/t/l",
      "agree",
      "valid",
      "mean$",
      "",
    ],
    ...summary.map((entry) => [
      entry.operation,
      entry.setting,
      String(entry.rep),
      String(entry.n),
      number(entry.meanDelta),
      `${entry.wins}/${entry.ties}/${entry.losses}`,
      percent(entry.meanAgreement),
      percent(entry.validRate),
      money(entry.meanCostUsd),
      entry.noiseFloor ? "noise-floor" : "",
    ]),
  ];
  return table(rows);
}

export function formatKneeReport(report) {
  const rows = [
    ["operation", "knee", "noise|d|", "setting", "mean$", "delta", "valid", ""],
  ];
  for (const entry of report) {
    for (const setting of entry.settings)
      rows.push([
        entry.operation,
        entry.knee ?? "-",
        number(entry.noiseFloorDelta),
        setting.setting,
        money(setting.meanCostUsd),
        number(setting.meanDelta),
        percent(setting.validRate),
        setting.noiseFloor ? "noise-floor" : "",
      ]);
    if (entry.needsMore)
      rows.push([entry.operation, "needs more arms", "", "", "", "", "", ""]);
  }
  return table(rows);
}

async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (!["run", "report"].includes(command))
    throw Error(
      "Usage: ai-judge.mjs run --name <ladder name> | --out <dir> --cases <file|dir> [--parallel N] | report --name <name> | --out <dir> [--json]",
    );
  if (!args.name && !args.out) throw Error("Pass --name <name> or --out <dir>");
  const out = args.out ?? defaultOut(args.name);
  const reference = args.reference
    ? {
        setting: args.reference,
        rep:
          args["reference-rep"] === undefined
            ? 1
            : Number(args["reference-rep"]),
      }
    : undefined;
  if (command === "run") {
    const result = await judgeLadder({
      out,
      cases: readCases(args.cases),
      reference,
      parallel: args.parallel === undefined ? 4 : Number(args.parallel),
      only: args.only ? String(args.only).split(",") : undefined,
    });
    console.log(
      `${result.judgments.length} new judgment(s) in ${result.judgmentsFile} (reference ${result.reference.setting} rep ${result.reference.rep}); ${result.skipped} already judged`,
    );
  }
  const summary = summarizeJudgments(readJudgments(out), readLadderRows(out), {
    reference,
  });
  const knee = kneeReport(summary);
  if (args.json) {
    console.log(JSON.stringify({ out, summary, knee }, null, 2));
    return;
  }
  if (!summary.length)
    console.log(`No judgments in ${join(out, "judgments.jsonl")}`);
  else {
    console.log(formatJudgmentSummary(summary));
    console.log("");
    console.log(formatKneeReport(knee));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
