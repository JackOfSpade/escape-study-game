import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LOG = ".local/bridge-service/claude-usage.jsonl";
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);
const mean = (values) =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
const sum = (values) => values.reduce((total, value) => total + value, 0);
/** Nearest-rank percentile: the smallest value at or above p% of the sample. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)];
}
const turnOf = (row) =>
  row.conversationTurn === 1
    ? "first"
    : row.conversationTurn > 1
      ? "reply"
      : "";

/** Reads the JSONL logs, skipping and counting lines that are not rows. */
export function readUsageRows(paths) {
  const rows = [];
  let malformed = 0;
  const files = [];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    files.push(path);
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        malformed++;
        continue;
      }
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        malformed++;
        continue;
      }
      rows.push(row);
    }
  }
  return { rows, malformed, files };
}

/** Groups measured calls so model and effort choices can be made from data. */
export function summarizeUsage(rows) {
  const groups = new Map();
  for (const row of rows) {
    const attempt =
      Number.isInteger(row.attempt) && row.attempt > 0 ? row.attempt : 0;
    const alias = row.alias ?? null;
    const phase = row.phase ?? null;
    const model = row.model ?? null;
    const turn = turnOf(row);
    const key = [row.operation, phase, turn, alias, row.effort, model].join(
      "\u0000",
    );
    if (!groups.has(key))
      groups.set(key, {
        operation: row.operation ?? null,
        phase,
        turn,
        alias,
        effort: row.effort ?? null,
        model,
        rows: [],
        firstTry: 0,
        firstTryAccepted: 0,
        correctionTurns: 0,
        failures: {},
      });
    const group = groups.get(key);
    group.rows.push(row);
    if (attempt === 0) {
      group.firstTry++;
      if (row.outcome === "accepted") group.firstTryAccepted++;
    }
    if (attempt > 0) group.correctionTurns++;
    if (row.outcome !== "accepted")
      group.failures[row.outcome ?? "unknown"] =
        (group.failures[row.outcome ?? "unknown"] ?? 0) + 1;
  }
  const summary = [];
  for (const group of groups.values()) {
    const costs = group.rows.map((row) => row.costUsd).filter(isNumber);
    const inputs = group.rows.map((row) => row.inputTokens).filter(isNumber);
    const outputs = group.rows.map((row) => row.outputTokens).filter(isNumber);
    const durations = group.rows.map((row) => row.durationMs).filter(isNumber);
    const firstTexts = group.rows
      .map((row) => row.firstTextMs)
      .filter(isNumber);
    summary.push({
      operation: group.operation,
      phase: group.phase,
      turn: group.turn,
      alias: group.alias,
      effort: group.effort,
      model: group.model,
      calls: group.rows.length,
      firstTryAcceptRate:
        group.firstTry === 0 ? null : group.firstTryAccepted / group.firstTry,
      correctionTurns: group.correctionTurns,
      failures: group.failures,
      totalCostUsd: costs.length ? sum(costs) : null,
      meanCostUsd: mean(costs),
      meanInputTokens: mean(inputs),
      meanOutputTokens: mean(outputs),
      p50DurationMs: percentile(durations, 50),
      p95DurationMs: percentile(durations, 95),
      p95FirstTextMs: percentile(firstTexts, 95),
    });
  }
  summary.sort(
    (a, b) =>
      String(a.operation).localeCompare(String(b.operation)) ||
      String(a.phase ?? "").localeCompare(String(b.phase ?? "")) ||
      String(a.turn).localeCompare(String(b.turn)) ||
      String(a.alias ?? "").localeCompare(String(b.alias ?? "")) ||
      String(a.effort ?? "").localeCompare(String(b.effort ?? "")) ||
      String(a.model ?? "").localeCompare(String(b.model ?? "")),
  );
  return { calls: rows.length, groups: summary.length, summary };
}

const formatNumber = (value, digits = 0) =>
  !isNumber(value)
    ? "-"
    : digits
      ? value.toFixed(digits)
      : String(Math.round(value));
const HEADER = [
  "operation",
  "phase",
  "turn",
  "alias:effort",
  "model",
  "calls",
  "first%",
  "corr",
  "failures",
  "total$",
  "mean$",
  "in",
  "out",
  "p50ms",
  "p95ms",
  "p95first",
];

/** An aligned table: one line per operation, phase, turn, alias:effort, model. */
export function formatUsageReport({
  summary,
  calls,
  malformed = 0,
  files = [],
}) {
  const cells = summary.map((group) => [
    group.operation ?? "-",
    group.phase ?? "-",
    group.turn || "-",
    `${group.alias ?? "-"}:${group.effort ?? "-"}`,
    group.model ?? "-",
    String(group.calls),
    group.firstTryAcceptRate === null
      ? "-"
      : `${Math.round(group.firstTryAcceptRate * 100)}%`,
    String(group.correctionTurns),
    Object.entries(group.failures)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([outcome, count]) => `${outcome}:${count}`)
      .join(" ") || "-",
    formatNumber(group.totalCostUsd, 4),
    formatNumber(group.meanCostUsd, 4),
    formatNumber(group.meanInputTokens),
    formatNumber(group.meanOutputTokens),
    formatNumber(group.p50DurationMs),
    formatNumber(group.p95DurationMs),
    formatNumber(group.p95FirstTextMs),
  ]);
  const table = [HEADER, ...cells];
  const widths = HEADER.map((_, column) =>
    Math.max(...table.map((row) => row[column].length)),
  );
  const render = (row) =>
    row
      .map((cell, column) =>
        column < 5
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join("  ")
      .trimEnd();
  return [
    ...table.map(render),
    "",
    `${calls} calls across ${summary.length} group(s) in ${files.length} file(s); ${malformed} malformed line(s)`,
  ].join("\n");
}

function defaultPaths() {
  const main = resolve(DEFAULT_LOG);
  return existsSync(`${main}.1`) ? [`${main}.1`, main] : [main];
}

function main(argv) {
  const paths = argv.filter((arg) => !arg.startsWith("--"));
  const { rows, malformed, files } = readUsageRows(
    paths.length ? paths.map((path) => resolve(path)) : defaultPaths(),
  );
  const report = summarizeUsage(rows);
  if (argv.includes("--json"))
    console.log(JSON.stringify({ ...report, malformed, files }, null, 2));
  else console.log(formatUsageReport({ ...report, malformed, files }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main(process.argv.slice(2));
