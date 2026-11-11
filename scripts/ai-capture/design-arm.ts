/**
 * Run the real level-design pipeline end to end at one Claude model+effort
 * arm, one seed at a time.
 *
 * The version 3 quality pipeline feeds each stage from the last (concepts →
 * selection → structure → reviews → content batches), so replaying single
 * stages cannot measure a setting fairly. This runner therefore drives
 * `prepareDesignedRun` with a `send` that replaces only the transport, forces
 * every `design-run` stage through one profile, and appends one judge-shaped
 * row per seed to `<out>/results.jsonl`. A crash or an interruption resumes by
 * skipping the seed/setting/rep rows already recorded.
 *
 *   node --import tsx scripts/ai-capture/design-arm.ts \
 *     --setting sonnet:medium --seeds 11,12,13 [--name design-2026-11-11] \
 *     [--rep 0] [--out dir] [--ephemeral]
 */
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { createClaudeGateway, taskProfile } from "../claude-gateway.mjs";
import {
  assertSafeOut,
  defaultOut,
  parseArgs,
  parseSetting,
  parseSettings,
  readLadderRows,
  // @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
} from "../ai-ladder.mjs";
import { privateDirectory } from "../lib/private-fs.mjs";
import type { Roadmap } from "../../src/model";
import { newDesignDraft, prepareDesignedRun } from "../../src/run-designer";
import { finalizeDesignedRun, previewDesignedRun } from "../../src/world";

/** The one row a CLI invocation writes before its retry or correction. */
export interface UsageRow {
  v?: number;
  attempt?: number | null;
  at?: string;
  operation?: string;
  phase?: string | null;
  alias?: string | null;
  effort?: string | null;
  model?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  firstTextMs?: number | null;
  outcome?: string;
}

export interface DesignGateway {
  run(
    operation: string,
    payload: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}
export interface DesignGatewayOptions {
  profileFor: (operation: string, payload: any) => any;
  sessionNamespace: string;
  usageLog: (row: UsageRow) => void;
}
export type DesignGatewayFactory = (
  options: DesignGatewayOptions,
) => DesignGateway;

/** The judge reads `results.jsonl`, which the ladder also writes. */
export interface DesignRow {
  v: 1;
  at: string;
  caseId: string;
  operation: "design-run";
  setting: string;
  rep: number;
  outcome: string;
  answers: unknown[];
  stages: number;
  attempts: number;
  corrections: number;
  costUsd: number | null;
  durationMs: number | null;
  firstTextMs: number | null;
  model: string[];
}

export const designCaseId = (seed: number) => `design-seed-${seed}`;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const total = (values: unknown[]) => {
  const known = values.filter(isNumber);
  return known.length ? known.reduce((sum, value) => sum + value, 0) : null;
};
/** First 200 characters: a row stays readable and bounded even on a long error. */
const failedOutcome = (error: unknown) =>
  `failed: ${String((error as { message?: string })?.message ?? error).slice(
    0,
    200,
  )}`;

/** Builds the judge-compatible row from one pipeline run. A run that threw has
 * no answer, but keeps whatever usage rows the gateway already recorded. */
export function designRow({
  at,
  seed,
  setting,
  rep = 0,
  answers = [],
  usage = [],
  error,
}: {
  at: string;
  seed: number;
  setting: string;
  rep?: number;
  answers?: unknown[];
  usage?: UsageRow[];
  error?: unknown;
}): DesignRow {
  const rows = Array.isArray(usage) ? usage : [];
  const models = rows
    .map((row) => row?.model)
    .filter((model): model is string => typeof model === "string" && !!model);
  return {
    v: 1,
    at,
    caseId: designCaseId(seed),
    operation: "design-run",
    setting,
    rep,
    outcome:
      error === undefined || error === null ? "valid" : failedOutcome(error),
    answers: Array.isArray(answers) ? answers : [],
    stages: rows.length,
    attempts: rows.length,
    corrections: rows.filter((row) => row?.attempt === 1).length,
    costUsd: total(rows.map((row) => row?.costUsd)),
    durationMs: total(rows.map((row) => row?.durationMs)),
    firstTextMs: total(rows.slice(0, 1).map((row) => row?.firstTextMs)),
    model: [...new Set(models)],
  };
}

const roadmap: Roadmap = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../public/curriculum.json", import.meta.url)),
    "utf8",
  ),
);

export const CASES_FILE = "cases-design.json";

export interface DesignCase {
  id: string;
  operation: "design-run";
  payload: { seed: number; note: string };
}

/** The judge needs a case per seed; ids merge so a resumed run never loses one. */
export function writeDesignCases(out: string, seeds: number[]) {
  const file = join(out, CASES_FILE);
  let existing: DesignCase[] = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) existing = parsed;
    } catch {
      existing = [];
    }
  }
  const byId = new Map<string, DesignCase>(
    existing.map((entry) => [String(entry?.id), entry]),
  );
  for (const seed of seeds)
    byId.set(designCaseId(seed), {
      id: designCaseId(seed),
      operation: "design-run",
      payload: { seed, note: "full pipeline" },
    });
  writeFileSync(file, `${JSON.stringify([...byId.values()], null, 2)}\n`, {
    mode: 0o600,
  });
}

export interface DesignArmInput {
  /** `model:effort`; every stage of the arm uses exactly this setting. */
  setting: string;
  seed: number;
  rep?: number;
  out: string;
  /** Tests keep their output under the temporary directory. */
  ephemeral?: boolean;
  gatewayFactory?: DesignGatewayFactory;
  now?: () => number;
  signal?: AbortSignal;
  log?: (text: string) => void;
}

/** One seed, one setting: a fresh gateway, the real pipeline, one row. */
export async function runDesignArm({
  setting: requested,
  seed,
  rep = 0,
  out,
  ephemeral = false,
  gatewayFactory = createClaudeGateway as unknown as DesignGatewayFactory,
  now = Date.now,
  signal = new AbortController().signal,
  log = () => {},
}: DesignArmInput): Promise<{ skipped: boolean; row: DesignRow }> {
  // "production" keeps each stage's real profile (medium, high for content
  // batches), so the reference arm matches what players get.
  const production = requested === "production";
  const { model, effort, setting } = production
    ? { model: "", effort: "", setting: "production" }
    : parseSetting(requested);
  assertSafeOut(out, { ephemeral });
  privateDirectory(out);
  writeDesignCases(out, [seed]);
  const resultsFile = join(out, "results.jsonl");
  const done = readLadderRows(out).find(
    (row: any) =>
      row?.caseId === designCaseId(seed) &&
      row?.setting === setting &&
      row?.rep === rep,
  );
  if (done) {
    log(
      `${designCaseId(seed)} ${setting} rep ${rep} already recorded; skipped`,
    );
    return { skipped: true, row: done as DesignRow };
  }
  const usage: UsageRow[] = [];
  const stamp = new Date(now()).toISOString();
  const gateway = gatewayFactory({
    // taskProfile keeps the production timeout; only model and effort change.
    profileFor: (operation, payload) =>
      production
        ? taskProfile(operation, payload)
        : { ...taskProfile(operation, payload), model, effort },
    sessionNamespace: `${setting}:${seed}:${rep}:${stamp}`,
    usageLog: (row) => usage.push(row),
  });
  const draft = newDesignDraft(
    `design-arm-${seed}-${rep}-${stamp}`,
    seed,
    [],
    [],
  );
  const answers: unknown[] = [];
  let failure: unknown;
  log(`${designCaseId(seed)} ${setting} rep ${rep} starting`);
  try {
    const result = await prepareDesignedRun(draft, {
      signal,
      capture: () => {},
      // Version 3 installs its candidate through preview/finalize instead.
      build: () => {
        throw Error("The version 3 pipeline finalises through finalize");
      },
      preview: (previewSeed, structure) =>
        previewDesignedRun(previewSeed, roadmap, undefined, structure),
      finalize: finalizeDesignedRun,
      send: (request, _current, callSignal) =>
        gateway.run("design-run", request, { signal: callSignal }),
    });
    answers.push(result.saved.design);
  } catch (error) {
    if (signal.aborted) throw error;
    failure = error;
  }
  const row = designRow({
    at: new Date(now()).toISOString(),
    seed,
    setting,
    rep,
    answers,
    usage,
    error: failure,
  });
  appendFileSync(resultsFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
  log(`${row.caseId} ${setting} rep ${rep}: ${row.outcome}`);
  return { skipped: false, row };
}

export function parseSeeds(value: unknown): number[] {
  const list = (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .map((entry) => Number(entry));
  if (!list.length)
    throw Error("Pass at least one seed, e.g. --seeds 11,12,13");
  for (const seed of list)
    if (!Number.isInteger(seed) || seed < 1)
      throw Error(`Seeds must be positive integers (got ${seed})`);
  return [...new Set(list)];
}

export interface DesignSeedsInput extends Omit<
  DesignArmInput,
  "setting" | "seed"
> {
  settings: string | string[];
  seeds: unknown;
}

/** Seeds run one at a time: every design is a long, dependent conversation. */
export async function runDesignSeeds({
  settings,
  seeds,
  out,
  ephemeral = false,
  ...rest
}: DesignSeedsInput) {
  const list = Array.isArray(settings) ? settings : String(settings).split(",");
  const chosen = [
    ...(list.includes("production") ? [{ setting: "production" }] : []),
    ...(list.some((s: string) => s !== "production")
      ? parseSettings(list.filter((s: string) => s !== "production"))
      : []),
  ];
  const wanted = parseSeeds(seeds);
  assertSafeOut(out, { ephemeral });
  privateDirectory(out);
  writeDesignCases(out, wanted);
  const rows: { skipped: boolean; row: DesignRow }[] = [];
  for (const seed of wanted)
    for (const setting of chosen) {
      const arm = await runDesignArm({
        ...rest,
        setting: setting.setting,
        seed,
        out,
        ephemeral,
      });
      if (!arm.skipped) rows.push(arm);
    }
  return rows;
}

async function main(argv: string[]) {
  const args = parseArgs(argv);
  if (!args.setting)
    throw Error(
      "Pass --setting <model:effort> (comma-separate settings for several arms)",
    );
  const name = args.name ?? `design-${new Date().toISOString().slice(0, 10)}`;
  const out = args.out ?? defaultOut(name);
  const rep = args.rep === undefined ? 0 : Number(args.rep);
  if (!Number.isInteger(rep) || rep < 0)
    throw Error(`--rep must be a non-negative integer (got ${args.rep})`);
  const rows = await runDesignSeeds({
    settings: args.setting,
    seeds: args.seeds,
    out,
    rep,
    ephemeral: !!args.ephemeral,
    log: (text) => console.log(text),
  });
  const valid = rows.filter(({ row }) => row.outcome === "valid").length;
  console.log(
    `${valid}/${rows.length} new designs valid; results in ${join(out, "results.jsonl")}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).catch((error) => {
    console.error(error?.message ?? error);
    process.exitCode = 1;
  });
