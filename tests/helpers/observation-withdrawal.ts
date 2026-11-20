// Synthetic source-bound reviews only. No actual human results are corrected.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { finalRequirements } from "../../src/final-requirements";
import type { Roadmap } from "../../src/model";
import {
  adoptReconciledRoadmap,
  reconcileRoadmap,
} from "../../src/roadmap-adoption";
import type {
  RoadmapReconciliation,
  RoadmapReconciliationPayload,
} from "../../src/roadmap-adoption-types";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../../src/roadmap-identifiers";
import { inspectMergedDocument } from "../../src/roadmap-structure";
import { createRecord } from "./record";
export const r: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
export const final = finalRequirements(r, "PY").find((d) => d.id === "PY:T01")!;
export const excerpt =
  "Synthetic independently observed changed-context reasoning, without supplied choices; full source-defined facet was reviewed.";
const originalTask =
  "| S0007-A98 | S0007 / 2026-10-16 | T01 changed-context assessment | PARTIAL; task remains open despite its qualifying scope evidence | S0007-EV98 | Synthetic source-issued task; no app visit |";
export const evidence =
  "| S0007-EV98 | S0007-A98 | 2026-10-16 | T01 | D4 changed-context reasoning | TRANSFER | NONE | 3 | " +
  excerpt +
  " |";
function revision(raw: string, hash: string, n: number) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${hash}`);
}
function proposal(p: RoadmapReconciliationPayload): RoadmapReconciliation {
  return {
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: p.candidate,
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions: [],
    rationale: "Synthetic source-backed review only, not real learning",
  };
}
function finalRow(raw: string, status: string, refs?: string) {
  const key = [...inspectMergedDocument(raw).rows.keys()].find(
    (k) =>
      k.startsWith("PY_PROGRESS/0.7 Topic transfer and retention/") &&
      k.endsWith("/T01"),
  )!;
  const row = inspectMergedDocument(raw).rows.get(key)!,
    c = row
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  c[1] = status;
  c[2] =
    refs ??
    "S0007-EV98" + (raw.includes("| S0007-EV99 |") ? ", S0007-EV99" : "");
  const start = raw.indexOf("<!-- BEGIN PY_PROGRESS -->"),
    end = raw.indexOf("<!-- END PY_PROGRESS -->");
  return (
    raw.slice(0, start) +
    raw.slice(start, end).replace(row, `| ${c.join(" | ")} |`) +
    raw.slice(end)
  );
}
export async function setup(
  partial = false,
  gap = false,
  outcome: "independent" | "assisted" | "contradicted" = "independent",
  alternate = false,
  priorIndependent = false,
  initialStatus?: string,
) {
  const g = createRecord(7, r);
  g.study.profile = "live";
  let raw = revision(r.raw, r.sourceHash, 10),
    at = raw.indexOf(
      "### 0.5.1 Attempt status register",
      raw.indexOf("<!-- BEGIN PY_PROGRESS -->"),
    );
  const primary =
    outcome === "assisted"
      ? evidence.replace("| TRANSFER | NONE |", "| GUIDED | HINT |")
      : outcome === "contradicted"
        ? evidence.replace("| 3 |", "| 1 |")
        : evidence;
  const extra = (alternate ? primary : evidence)
    .replaceAll("98", "99")
    .replace("| 3 |", gap ? "| 1 |" : "| 3 |");
  raw =
    raw.slice(0, at) +
    (priorIndependent ? evidence.replaceAll("98", "97") + "\n" : "") +
    primary +
    "\n" +
    (partial ? extra + "\n" : "") +
    "\n" +
    raw.slice(at);
  at = raw.indexOf("### 0.6 Facet gaps", at);
  raw =
    raw.slice(0, at) +
    (priorIndependent ? originalTask.replaceAll("98", "97") + "\n" : "") +
    originalTask +
    "\n" +
    (partial ? originalTask.replaceAll("98", "99") + "\n" : "") +
    "\n" +
    raw.slice(at);
  raw = projectIdentifierCounters(
    finalRow(
      raw,
      initialStatus ?? (gap || outcome !== "independent" ? "G" : "P"),
    ),
    readIdentifierCounters(raw, false).counters,
  );
  await reconcileRoadmap(g, r, raw, async (p) => {
    const out = proposal(p),
      facets = [
        { id: "primary", description: "Synthetic complete source scope facet" },
      ];
    if (partial)
      facets.push({
        id: "secondary",
        description: "Separate synthetic retained scope facet",
      });
    out.definitions = [
      {
        id: "PY:T01/T4",
        objectiveId: "PY:T01",
        depth: 4,
        sourceScope: final.scope,
        facets,
      },
    ];
    out.mappings = facets.map((f, i) => ({
      scopeId: "PY:T01/T4",
      facet: f.id,
      outcome:
        i === 0 || alternate ? outcome : gap ? "contradicted" : "independent",
      evidenceIds:
        alternate && i === 0
          ? ["S0007-EV98", "S0007-EV99"]
          : [`S0007-EV${98 + i}`],
      sourceExcerpts:
        alternate && i === 0
          ? { "S0007-EV98": excerpt, "S0007-EV99": excerpt }
          : { [`S0007-EV${98 + i}`]: excerpt },
      rationale: "Synthetic exact-source independent facet mapping",
    }));
    out.completeScopes = gap || outcome !== "independent" ? [] : ["PY:T01/T4"];
    return out;
  });
  const job = g.study.roadmapReconciliations!.at(-1)!;
  assert.equal(job.state, "ready", job.error);
  await adoptReconciledRoadmap(g, r, job.id);
  return g;
}
export async function withdraw(
  g: ReturnType<typeof createRecord>,
  status = "U",
  recycle = false,
  restoreEarlier = false,
  invalidate = true,
) {
  const local = g.study.roadmapExport!;
  let raw = revision(local.content, local.hash, local.revision + 1).replace(
    originalTask,
    originalTask.replace(
      "PARTIAL; task remains open despite its qualifying scope evidence",
      "INVALIDATED; ambiguous supplied task is withdrawn without learner failure",
    ),
  );
  if (!invalidate)
    raw = revision(local.content, local.hash, local.revision + 1);
  raw = finalRow(raw, status, restoreEarlier ? "S0007-EV97" : undefined);
  await reconcileRoadmap(g, r, raw, async (p) => {
    const out = proposal(p),
      localRows = inspectMergedDocument(p.local).rows;
    out.attemptUpdates = [
      {
        track: "PY",
        attemptId: "S0007-A98",
        rationale:
          "Source-recorded invalidation of supplied task, not a new contradiction or learner failure",
      },
    ];
    out.decisions = [...inspectMergedDocument(p.candidate).rows]
      .filter(([key, row]) => localRows.has(key) && localRows.get(key) !== row)
      .map(([key]) => ({
        key,
        choice: "incoming",
        rationale:
          "Use exact incoming disposition/status and retain the original observations and audit",
      }));
    if (recycle)
      out.mappings = [
        {
          scopeId: "PY:T01/T4",
          facet: "primary",
          outcome: "independent",
          evidenceIds: ["S0007-EV98"],
          sourceExcerpts: { "S0007-EV98": excerpt },
          rationale: "Synthetic invalid recycled proof",
        },
      ];
    if (!invalidate) out.attemptUpdates = [];
    if (restoreEarlier) {
      out.mappings = [
        {
          scopeId: "PY:T01/T4",
          facet: "primary",
          outcome: "independent",
          evidenceIds: ["S0007-EV97"],
          sourceExcerpts: { "S0007-EV97": excerpt },
          rationale:
            "Explicit full-scope source review restores earlier valid independent work after invalidating the intervening contradiction",
        },
      ];
      out.completeScopes = ["PY:T01/T4"];
    }
    return out;
  });
  return g.study.roadmapReconciliations!.at(-1)!;
}
