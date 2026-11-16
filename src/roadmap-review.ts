import { sha256 } from "./digest";
import type { Roadmap, Track } from "./model";
import { parseRoadmapDocument } from "./roadmap-document";
import { inspectMergedDocument } from "./roadmap-structure";

export interface RoadmapReview {
  resume?: {
    ratioPosition?: number;
    tracks: Record<
      Track,
      {
        tier: number;
        phase: string;
        lap: number;
        cleared: number;
        remaining: string[];
      }
    >;
    retentionRecords: number;
    suspendedQueues: number;
  };
  sourceHash: string;
  localHash: string;
  candidateHash: string;
  candidateRevision: number;
  ancestry: "identical" | "direct-descendant" | "sibling" | "unproven";
  issues: { severity: "invalid" | "review"; detail: string }[];
  changes: {
    key: string;
    before?: string;
    incoming?: string;
    local?: string;
    conflict: boolean;
  }[];
}
/** Review only. No text from an uploaded file executes or updates learning state.
 * Ancestry establishes byte lineage, never semantic validity or academic credit. */
export async function reviewRoadmap(
  r: Roadmap,
  local: string,
  candidate: string,
): Promise<RoadmapReview> {
  const [sourceHash, localHash, candidateHash] = await Promise.all([
    sha256(r.raw),
    sha256(local),
    sha256(candidate),
  ]);
  if (sourceHash !== r.sourceHash)
    throw Error("Bundled source integrity failure");
  const report: RoadmapReview = {
    sourceHash,
    localHash,
    candidateHash,
    candidateRevision: 0,
    ancestry: "unproven",
    issues: [],
    changes: [],
  };
  try {
    const base = inspectMergedDocument(r.raw),
      current = inspectMergedDocument(local),
      incoming = inspectMergedDocument(candidate);
    report.candidateRevision = incoming.revision;
    const saved = await parseRoadmapDocument(candidate, r);
    report.resume = {
      ratioPosition: saved.resume?.ratioPosition,
      tracks: Object.fromEntries(
        (["PY", "PE"] as const).map((t) => [
          t,
          {
            tier: saved.tracks[t].tier,
            phase: saved.tracks[t].phase,
            lap: saved.tracks[t].lap!,
            cleared: saved.tracks[t].cleared!,
            remaining: [...saved.tracks[t].remaining],
          },
        ]),
      ) as NonNullable<RoadmapReview["resume"]>["tracks"],
      retentionRecords: Object.keys(saved.resume?.reviews ?? {}).length,
      suspendedQueues: (["PY", "PE"] as const).reduce(
        (n, t) => n + (saved.tracks[t].suspended?.length ?? 0),
        0,
      ),
    };
    for (const detail of saved.resume?.issues ?? [])
      report.issues.push({ severity: "review", detail });
    // parseRoadmapDocument has already verified the protected digests and
    // that the protected blocks equal the bundled source's.
    if (candidateHash === localHash) report.ancestry = "identical";
    else if (
      incoming.field("parent_file_sha256") === localHash &&
      incoming.previous === current.revision &&
      incoming.revision === current.revision + 1
    )
      report.ancestry = "direct-descendant";
    else if (
      localHash !== sourceHash &&
      incoming.field("parent_file_sha256") === sourceHash &&
      incoming.previous === base.revision &&
      incoming.revision === base.revision + 1
    )
      report.ancestry = "sibling";
    if (report.ancestry === "unproven")
      report.issues.push({
        severity: "review",
        detail:
          "Complete parent is not the current saved file or a verified direct sibling. Supply the missing parent chain; revision numbers alone do not establish ancestry.",
      });
    if (candidateHash !== localHash && incoming.revision <= current.revision)
      report.issues.push({
        severity: "review",
        detail:
          "Incoming revision is older than, or collides with, the current saved revision.",
      });
    const keys = new Set([
      ...base.rows.keys(),
      ...current.rows.keys(),
      ...incoming.rows.keys(),
    ]);
    for (const key of keys) {
      const before = base.rows.get(key),
        localRow = current.rows.get(key),
        next = incoming.rows.get(key);
      if (next === before && localRow === before) continue;
      const conflict =
        localRow !== before && next !== before && next !== localRow;
      report.changes.push({
        key,
        before,
        incoming: next,
        local: localRow,
        conflict,
      });
      if (before && next !== before && /\/0\.5(?:\.1)? /.test(key))
        report.issues.push({
          severity: "review",
          detail: `Historical evidence or attempt row changed or removed: ${key}`,
        });
    }
    const conflicts = report.changes.filter((c) => c.conflict).length;
    if (conflicts)
      report.issues.push({
        severity: "review",
        detail: `${conflicts} progress row conflict(s) require explicit reconciliation; neither branch wins automatically.`,
      });
    report.issues.push({
      severity: "review",
      detail:
        "Preview only: scheduler, evidence semantics, reserved identifiers and gates still require reconciliation before adoption. No learning state has changed.",
    });
  } catch (err) {
    report.issues.push({
      severity: "invalid",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  return report;
}
