#!/usr/bin/env node
/** Size and redundancy metrics for generated questions, so the Minimum
 * evidence principle is measured instead of judged by eye. Pure and offline:
 * it reads ladder results.jsonl files and never calls the gateway. */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const FENCE = /^\s*(```|~~~)/;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+\S/;
const EACH = /\b(?:for each|for every|each one|each of|every one|per item)\b/i;
const WHY =
  /\b(?:why|reason|explain|justify|consequence|expose|exposes|hurt|hurts)\b/i;
const WINDOW = 12;
const METRICS = [
  "sharedWords",
  "sharedChars",
  "codeLines",
  "bulletLines",
  "partCount",
  "sharedShare",
  "rubricLines",
  "rubricLineWordsMax",
  "facetCount",
  "estimatedSolveSeconds",
];

const words = (text) => text.split(/\s+/).filter(Boolean).length;
const isNumber = (value) => typeof value === "number" && Number.isFinite(value);

/** Splits markdown into the lines outside fences and the lines inside them. */
function splitFences(text) {
  const prose = [],
    code = [];
  let inside = false;
  for (const line of String(text ?? "").split("\n")) {
    if (FENCE.test(line)) {
      inside = !inside;
      continue;
    }
    (inside ? code : prose).push(line);
  }
  return { prose, code };
}

/** True when "for each ..." sits within a few words of a reason-asking word. */
function hasPerItemJustification(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const at = (pattern) =>
    tokens.flatMap((_, i) => {
      // Join enough tokens to hold the longest multi-word phrase.
      return pattern.test(tokens.slice(i, i + 2).join(" ")) ? [i] : [];
    });
  const eachAt = at(EACH);
  const whyAt = tokens.flatMap((t, i) => (WHY.test(t) ? [i] : []));
  return eachAt.some((e) => whyAt.some((w) => Math.abs(w - e) <= WINDOW));
}

/** Plain numbers and flags describing one generated problem. */
export function questionMetrics(problem) {
  const { prose, code } = splitFences(problem?.prompt);
  const shared = prose.join("\n").trim();
  const parts = Array.isArray(problem?.parts)
    ? problem.parts.filter((part) => typeof part === "string")
    : [];
  const partWords = parts.map((part) => words(part));
  const sharedWords = words(shared);
  const total = sharedWords + partWords.reduce((sum, n) => sum + n, 0);
  const rubric = Array.isArray(problem?.rubric)
    ? problem.rubric.map(String)
    : problem?.rubric
      ? [String(problem.rubric)]
      : [];
  const facetCount = (problem?.scopeDefinitions ?? []).reduce(
    (sum, scope) =>
      sum + (Array.isArray(scope?.facets) ? scope.facets.length : 0),
    0,
  );
  const prose2 = [
    shared,
    ...parts.map((part) => splitFences(part).prose.join("\n")),
  ];
  return {
    sharedWords,
    sharedChars: shared.length,
    codeLines: code.filter((line) => line.trim()).length,
    bulletLines: prose.filter((line) => BULLET.test(line)).length,
    partCount: parts.length,
    partWords,
    sharedShare: total ? sharedWords / total : 0,
    rubricLines: rubric
      .flatMap((entry) => entry.split("\n"))
      .filter((line) => line.trim()).length,
    // A long line usually joins several requirements, and each one the ask
    // does not name is a requirement the learner cannot see.
    rubricLineWordsMax: Math.max(
      0,
      ...rubric
        .flatMap((entry) => entry.split("\n"))
        .map((line) => words(line)),
    ),
    facetCount,
    perItemJustification: prose2.some(hasPerItemJustification),
    estimatedSolveSeconds: isNumber(problem?.estimatedSolveSeconds)
      ? problem.estimatedSolveSeconds
      : null,
  };
}

/** Nearest-rank percentile over the measured values, or null when none. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/** Per-metric median, p90 and max over metric rows, plus how many rows ask
 * for a reason item by item. */
export function summarize(rows) {
  const out = { count: rows.length };
  for (const key of METRICS) {
    const values = rows.map((row) => row[key]).filter(isNumber);
    out[key] = {
      median: percentile(values, 50),
      p90: percentile(values, 90),
      max: values.length ? Math.max(...values) : null,
    };
  }
  out.perItemJustificationShare = rows.length
    ? rows.filter((row) => row.perItemJustification).length / rows.length
    : 0;
  return out;
}

const looksLikeProblem = (value) =>
  value && typeof value === "object" && typeof value.prompt === "string";

/** The generated problem in one parsed line: the line itself, or the first
 * answer of a ladder row whose operation is generate. Null otherwise. */
export function problemOf(row) {
  if (!row || typeof row !== "object") return null;
  if (row.operation === undefined) return looksLikeProblem(row) ? row : null;
  if (row.operation !== "generate") return null;
  const answer = Array.isArray(row.answers) ? row.answers.at(-1) : undefined;
  const nested = answer?.problem ?? answer;
  return looksLikeProblem(nested) ? nested : null;
}

/** Metrics for every generate reply in a results.jsonl file's text. */
export function rowsFromJsonl(text) {
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const problem = problemOf(parsed);
    if (problem) rows.push(questionMetrics(problem));
  }
  return rows;
}

const fmt = (value) =>
  value === null
    ? "-"
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(2);

/** A small aligned table: one line per metric. */
export function formatSummary(summary) {
  const head = ["metric", "median", "p90", "max"];
  const lines = METRICS.map((key) => [
    key,
    ...["median", "p90", "max"].map((stat) => fmt(summary[key][stat])),
  ]);
  const widths = head.map((_, i) =>
    Math.max(head[i].length, ...lines.map((line) => line[i].length)),
  );
  const row = (cells) =>
    cells
      .map((cell, i) => cell.padStart(i ? widths[i] : 0).padEnd(widths[i]))
      .join("  ");
  return [
    row(head),
    ...lines.map(row),
    `perItemJustification: ${(summary.perItemJustificationShare * 100).toFixed(0)}% of rows`,
  ].join("\n");
}

function main(files) {
  if (!files.length) {
    console.error(
      "Usage: node scripts/ai-capture/question-metrics.mjs <file.jsonl> [more files]",
    );
    process.exit(1);
  }
  for (const file of files) {
    const rows = rowsFromJsonl(readFileSync(file, "utf8"));
    console.log(`\n${basename(file)}: ${rows.length} generate reply(ies)`);
    if (rows.length) console.log(formatSummary(summarize(rows)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
