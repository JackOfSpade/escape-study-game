#!/usr/bin/env node
/**
 * Score captured `reconcile-roadmap` replies with the game's own validators.
 *
 * A model's saved reply is not trusted: the edit list it wrote is replayed
 * through `reconcileRoadmap` on a fresh game built from the same case, exactly
 * as the client would retry it. The job therefore validates the proposed file
 * the way production does, and the score says whether the proposal would have
 * been adopted (`adoptable`), refused by a validator (`rejected`), or whether
 * the model declined to propose anything (`keep-local`). No network or model
 * call is made.
 *
 *   node --import tsx scripts/ai-capture/score-roadmap-replies.ts \
 *     --results results.jsonl --cases reconcile-roadmap-adopt.json [--json]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Roadmap } from "../../src/model";
import { reconcileRoadmap } from "../../src/roadmap-adoption";
import { createGame } from "../../src/world";
import {
  loadRoadmap,
  RECONCILE_OPERATION,
  type RoadmapCase,
} from "./build-roadmap-cases";

/** Must match `KEEP_LOCAL` in scripts/lib/roadmap-edits.mjs. */
const KEEP_LOCAL = "keep-local";

export type ReplyClassification = "adoptable" | "rejected" | "keep-local";

export type ScoredRoadmapReply = {
  caseId: string;
  setting: string;
  rep: number | null;
  classification: ReplyClassification;
  /** First 200 characters of the validator error, for rejected replies. */
  error?: string;
};

export type SettingScore = {
  setting: string;
  adoptable: number;
  rejected: number;
  keepLocal: number;
  total: number;
  adoptableRate: number;
};

export type RoadmapScore = {
  rows: ScoredRoadmapReply[];
  settings: SettingScore[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** The last answer of a valid ladder row, or undefined when there is none. */
function lastAnswer(row: Record<string, unknown>) {
  const answers = row.answers;
  if (!Array.isArray(answers) || !answers.length) return undefined;
  const answer = answers[answers.length - 1];
  return isRecord(answer) ? answer : undefined;
}

/**
 * Replay one reply through the real validator on a fresh game. The answer's
 * binding hashes are replaced with the fresh payload's values, so the reply is
 * graded on its content rather than on a stale snapshot.
 */
export async function classifyRoadmapReply({
  item,
  answer,
  roadmap,
}: {
  item: RoadmapCase;
  answer: Record<string, unknown>;
  roadmap: Roadmap;
}): Promise<{ classification: ReplyClassification; error?: string }> {
  if (answer.outcome === KEEP_LOCAL) return { classification: "keep-local" };
  // A fresh copy and a fresh game keep one replay out of the next; the saved
  // reply is graded on its content, never on a stale snapshot.
  const isolated = JSON.parse(JSON.stringify(roadmap)) as Roadmap;
  const g = createGame(7, isolated);
  g.study.profile = "live";
  let replayed = false;
  await reconcileRoadmap(
    g,
    isolated,
    item.payload.candidate,
    async (payload) => {
      replayed = true;
      if (payload.local !== item.payload.local)
        throw Error(
          "the captured case was not built from this roadmap snapshot; cannot replay its edits",
        );
      return {
        ...answer,
        requestId: payload.requestId,
        localHash: payload.localHash,
        candidateHash: payload.candidateHash,
      };
    },
  );
  if (!replayed)
    throw Error(
      `reconcileRoadmap refused to replay ${item.id}: ${String(g.study.roadmapReconciliations?.at(-1)?.error ?? "no request")}`,
    );
  const job = g.study.roadmapReconciliations?.at(-1);
  if (!job) throw Error("reconcileRoadmap recorded no job for the reply");
  if (job.state === "ready") return { classification: "adoptable" };
  return {
    classification: "rejected",
    error: String(job.error ?? `job state ${job.state}`).slice(0, 200),
  };
}

function summarize(rows: ScoredRoadmapReply[]): SettingScore[] {
  const groups = new Map<string, ScoredRoadmapReply[]>();
  for (const row of rows) {
    const list = groups.get(row.setting) ?? [];
    list.push(row);
    groups.set(row.setting, list);
  }
  return [...groups.entries()]
    .map(([setting, list]) => {
      const adoptable = list.filter(
        (row) => row.classification === "adoptable",
      ).length;
      return {
        setting,
        adoptable,
        rejected: list.filter((row) => row.classification === "rejected")
          .length,
        keepLocal: list.filter((row) => row.classification === "keep-local")
          .length,
        total: list.length,
        adoptableRate: adoptable / list.length,
      };
    })
    .sort((a, b) => a.setting.localeCompare(b.setting));
}

/** Score every valid `reconcile-roadmap` row against its captured case. */
export async function scoreRoadmapReplies({
  rows,
  cases,
  roadmap,
}: {
  rows: readonly unknown[];
  cases: readonly RoadmapCase[];
  roadmap?: Roadmap;
}): Promise<RoadmapScore> {
  const byId = new Map(cases.map((item) => [item.id, item]));
  const base = roadmap ?? loadRoadmap();
  const scored: ScoredRoadmapReply[] = [];
  for (const raw of rows) {
    if (!isRecord(raw)) continue;
    if (raw.operation !== RECONCILE_OPERATION || raw.outcome !== "valid")
      continue;
    const answer = lastAnswer(raw);
    if (!answer) continue;
    const caseId = String(raw.caseId ?? "");
    const item = byId.get(caseId);
    if (!item)
      throw Error(`No case ${JSON.stringify(caseId)} in this case file`);
    const { classification, error } = await classifyRoadmapReply({
      item,
      answer,
      roadmap: base,
    });
    scored.push({
      caseId,
      setting: String(raw.setting ?? "(unknown)"),
      rep: typeof raw.rep === "number" ? raw.rep : null,
      classification,
      ...(error === undefined ? {} : { error }),
    });
  }
  return { rows: scored, settings: summarize(scored) };
}

const percent = (value: number) =>
  Number.isFinite(value) ? `${Math.round(value * 100)}%` : "-";

export function formatRoadmapScore(score: RoadmapScore): string {
  const headers = [
    "setting",
    "adoptable",
    "rejected",
    "keep-local",
    "total",
    "adopt%",
  ];
  const table = [
    headers,
    ...score.settings.map((entry) => [
      entry.setting,
      String(entry.adoptable),
      String(entry.rejected),
      String(entry.keepLocal),
      String(entry.total),
      percent(entry.adoptableRate),
    ]),
  ];
  const widths = headers.map((_, index) =>
    Math.max(...table.map((line) => line[index].length)),
  );
  const formatted = table
    .map((line) =>
      line.map((cell, index) => cell.padEnd(widths[index])).join("  "),
    )
    .join("\n");
  const detail = score.rows
    .map(
      (row) =>
        `  ${row.setting} ${row.caseId} rep=${row.rep ?? "-"} -> ${row.classification}${row.error ? `: ${row.error}` : ""}`,
    )
    .join("\n");
  return detail ? `${formatted}\n\n${detail}` : formatted;
}

/** Read a JSONL ladder results file, skipping blank or unreadable lines. */
export function readResultRows(file: string): Record<string, unknown>[] {
  return readFileSync(resolve(file), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        const parsed: unknown = JSON.parse(line);
        return isRecord(parsed) ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export function readCaseFile(file: string): RoadmapCase[] {
  const parsed: unknown = JSON.parse(readFileSync(resolve(file), "utf8"));
  if (!Array.isArray(parsed)) throw Error(`${file} must hold a case array`);
  return parsed as RoadmapCase[];
}

function argument(name: string) {
  const at = process.argv.indexOf(name);
  if (at === -1) return undefined;
  const value = process.argv[at + 1];
  if (!value) throw Error(`${name} needs a value`);
  return value;
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const results = argument("--results"),
    cases = argument("--cases");
  if (!results || !cases)
    throw Error(
      "Usage: score-roadmap-replies.ts --results <results.jsonl> --cases <cases.json> [--json]",
    );
  scoreRoadmapReplies({
    rows: readResultRows(results),
    cases: readCaseFile(cases),
  }).then(
    (score) => {
      if (process.argv.includes("--json"))
        console.log(JSON.stringify(score, null, 2));
      else console.log(formatRoadmapScore(score));
    },
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
