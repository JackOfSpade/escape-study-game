#!/usr/bin/env node
/**
 * Joins one generate → tutor → assess chain per generate arm, so the blind
 * judge can compare whole downstream chains between generate settings.
 *
 * node scripts/ai-capture/downstream-chains.mjs \
 *   --generate <generate results.jsonl> \
 *   --arm <generateSetting>=<tutor results.jsonl>,<assess results.jsonl> \
 *   [--arm ...] [--generate-rep 0] --out <dir>
 *
 * Pass the original generate cases JSON to ai-judge as --cases: it carries
 * the generate payload each chain answered, so two arms' chains for the same
 * case are judged against the same context, blind.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Sum of the known numbers, or null when there is none. */
const sumKnown = (values) => {
  const known = values.filter(isNumber);
  return known.length ? known.reduce((total, value) => total + value, 0) : null;
};

/** The last answer of a valid row, or undefined when the piece is missing. */
export function lastAnswer(row) {
  if (
    !row ||
    row.outcome !== "valid" ||
    !Array.isArray(row.answers) ||
    !row.answers.length
  )
    return undefined;
  const answer = row.answers[row.answers.length - 1];
  return answer === undefined || answer === null ? undefined : answer;
}

/** Distinct generate case ids in first-seen order. */
export function generateCaseIds(rows) {
  const ids = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.operation !== "generate") continue;
    if (typeof row.caseId !== "string" || !row.caseId) continue;
    if (seen.has(row.caseId)) continue;
    seen.add(row.caseId);
    ids.push(row.caseId);
  }
  return ids;
}

const repOrder = (left, right) => {
  const a = isNumber(left?.rep) ? left.rep : Infinity;
  const b = isNumber(right?.rep) ? right.rep : Infinity;
  return a === b ? 0 : a - b;
};

/**
 * The best row for one downstream piece: a valid row at the lowest rep
 * (rep 0 wins), else the lowest-rep row we have, else null.
 */
function pickRow(rows, caseId, operation) {
  const matches = (Array.isArray(rows) ? rows : []).filter(
    (row) =>
      row &&
      row.caseId === caseId &&
      (row.operation === undefined || row.operation === operation),
  );
  const valid = matches.filter((row) => lastAnswer(row) !== undefined);
  const pool = valid.length ? valid : matches;
  return pool.slice().sort(repOrder)[0] ?? null;
}

const unionModels = (rows) => [
  ...new Set(
    rows.flatMap((row) =>
      Array.isArray(row?.model)
        ? row.model.filter(
            (model) => typeof model === "string" && model.length > 0,
          )
        : [],
    ),
  ),
];

/**
 * One ladder-shaped judge row per generate case per arm. A chain with any
 * missing or invalid piece is `invalid` with no answers, so the judge can
 * record the failure without comparing half a chain.
 *
 * arms: [{ setting, tutor: LadderRow[], assess: LadderRow[] }]
 */
export function buildChainRows({
  generate,
  arms,
  generateRep = 0,
  now = Date.now,
  runId,
} = {}) {
  if (!Number.isInteger(generateRep) || generateRep < 0)
    throw Error("generateRep must be a non-negative integer");
  const generateRows = Array.isArray(generate) ? generate : [];
  const armList = Array.isArray(arms) ? arms : [];
  if (!armList.length) throw Error("At least one arm is required");
  const caseIds = generateCaseIds(generateRows);
  const at = new Date(now()).toISOString();
  const ladderId = runId ?? `downstream-chains-${at.replace(/[:.]/g, "-")}`;
  const rows = [];
  for (const arm of armList) {
    if (!arm || typeof arm.setting !== "string" || !arm.setting)
      throw Error("Every arm needs a setting");
    for (const caseId of caseIds) {
      const generateRow =
        generateRows.find(
          (row) =>
            row &&
            row.operation === "generate" &&
            row.caseId === caseId &&
            row.setting === arm.setting &&
            row.rep === generateRep,
        ) ?? null;
      const tutorRow = pickRow(arm.tutor, `tutor-from-${caseId}`, "tutor");
      const assessRow = pickRow(arm.assess, `assess-from-${caseId}`, "assess");
      const question = lastAnswer(generateRow);
      const tutorReply = lastAnswer(tutorRow);
      const assessment = lastAnswer(assessRow);
      const complete =
        question !== undefined &&
        tutorReply !== undefined &&
        assessment !== undefined;
      const pieces = [generateRow, tutorRow, assessRow].filter(Boolean);
      rows.push({
        v: 1,
        at,
        runId: ladderId,
        caseId,
        operation: "generate",
        setting: arm.setting,
        rep: 0,
        outcome: complete ? "valid" : "invalid",
        answers: complete ? [{ question, tutorReply, assessment }] : [],
        costUsd: sumKnown(pieces.map((row) => row.costUsd)),
        durationMs: sumKnown(pieces.map((row) => row.durationMs)),
        model: unionModels(pieces),
      });
    }
  }
  return rows;
}

/** Chains per setting, complete vs invalid, in first-seen arm order. */
export function summarizeChains(rows, arms = []) {
  const groups = new Map();
  const groupOf = (setting) => {
    let group = groups.get(setting);
    if (!group) {
      group = { setting, total: 0, complete: 0, invalid: 0 };
      groups.set(setting, group);
    }
    return group;
  };
  for (const arm of Array.isArray(arms) ? arms : [])
    if (arm && typeof arm.setting === "string") groupOf(arm.setting);
  for (const row of Array.isArray(rows) ? rows : []) {
    const group = groupOf(row.setting);
    group.total++;
    if (row.outcome === "valid") group.complete++;
    else group.invalid++;
  }
  return [...groups.values()];
}

function readRows(file) {
  const target = resolve(file);
  if (!existsSync(target)) throw Error(`Missing ${file}`);
  const rows = [];
  for (const [index, line] of readFileSync(target, "utf8")
    .split("\n")
    .entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw Error(`${file}:${index + 1} is not valid JSONL`);
    }
  }
  return rows;
}

/** Write `<out>/results.jsonl` (0600) under an owner-only directory (0700). */
export function writeChainRows(out, rows) {
  if (typeof out !== "string" || !out.trim())
    throw Error("An output directory is required");
  const target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const file = join(target, "results.jsonl");
  writeFileSync(
    file,
    rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "",
    { mode: 0o600 },
  );
  chmodSync(file, 0o600);
  return file;
}

function parseArm(value) {
  const split = String(value ?? "").indexOf("=");
  const setting = split === -1 ? "" : String(value).slice(0, split).trim();
  const files =
    split === -1
      ? []
      : String(value)
          .slice(split + 1)
          .split(",")
          .map((file) => file.trim());
  if (!setting || files.length !== 2 || files.some((file) => !file))
    throw Error(
      `Invalid --arm "${value}": expected <generateSetting>=<tutor results.jsonl>,<assess results.jsonl>`,
    );
  return { setting, tutorFile: files[0], assessFile: files[1] };
}

function parseArgs(argv) {
  const args = { arms: [], generateRep: 0 };
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) throw Error(`Unexpected argument "${token}"`);
    const split = token.indexOf("=");
    const name = split === -1 ? token.slice(2) : token.slice(2, split);
    const value = split === -1 ? argv[++index] : token.slice(split + 1);
    if (value === undefined) throw Error(`--${name} needs a value`);
    if (name === "arm") args.arms.push(parseArm(value));
    else if (name === "generate") args.generate = value;
    else if (name === "out") args.out = value;
    else if (name === "generate-rep") args.generateRep = Number(value);
    else throw Error(`Unknown option --${name}`);
  }
  const settings = args.arms.map((arm) => arm.setting);
  const duplicate = settings.find(
    (setting, index) => settings.indexOf(setting) !== index,
  );
  if (duplicate) throw Error(`Duplicate --arm setting "${duplicate}"`);
  if (!Number.isInteger(args.generateRep) || args.generateRep < 0)
    throw Error("--generate-rep must be a non-negative integer");
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (!args.generate) throw Error("--generate <results.jsonl> is required");
  if (!args.arms.length)
    throw Error(
      "At least one --arm <generateSetting>=<tutor results.jsonl>,<assess results.jsonl> is required",
    );
  if (!args.out) throw Error("--out <dir> is required");
  const arms = args.arms.map(({ setting, tutorFile, assessFile }) => ({
    setting,
    tutor: readRows(tutorFile),
    assess: readRows(assessFile),
  }));
  const rows = buildChainRows({
    generate: readRows(args.generate),
    arms,
    generateRep: args.generateRep,
  });
  const file = writeChainRows(args.out, rows);
  for (const line of summarizeChains(rows, arms))
    console.log(
      `${line.setting}: ${line.total} chain(s), ${line.complete} complete, ${line.invalid} invalid`,
    );
  console.log(`Wrote ${rows.length} chain row(s) to ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
