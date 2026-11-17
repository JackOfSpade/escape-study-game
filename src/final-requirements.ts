import { environmentStatus } from "./environment-status";
import { independentProofValid } from "./historical-proof";
import { importedEnvironmentEvidence } from "./imported-proof";
import type { CellState, LearnerLedger } from "./learning-model";
import { scopeKey } from "./learning-model";
import type { Roadmap, Track } from "./model";
import { baselineCheckpointValid } from "./observation-validity";
import { CELL_SEPARATOR } from "./table-row";

export interface FinalRequirement {
  id: string;
  track: Track;
  kind: "transfer" | "integration" | "environment";
  name: string;
  selected: boolean;
  status: CellState;
  scope: string;
  sourceRefs: string;
  remaining: string;
}

function section(progress: string, heading: string) {
  const marker = `### ${heading}\n`;
  const start = progress.indexOf(marker);
  if (start < 0)
    throw Error(`Missing authoritative progress section ${heading}`);
  return progress.slice(start + marker.length).split("\n### ")[0];
}
function rows(text: string, pattern: RegExp) {
  return text
    .split("\n")
    .filter((line) => pattern.test(line))
    .map((line) =>
      line
        .split(CELL_SEPARATOR)
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
}
function state(value: string): CellState {
  if (!["U", "G", "P", "R", "—"].includes(value))
    throw Error(`Unsupported final requirement status: ${value}`);
  return value as CellState;
}

/** Definitions and imported statuses only. This function never awards evidence. */
export function finalRequirements(
  r: Roadmap,
  track: Track,
): FinalRequirement[] {
  const { progress, curriculum, objectives } = r.tracks[track];
  const definitions: FinalRequirement[] = [];
  for (const c of rows(
    section(progress, "0.7 Topic transfer and retention"),
    /^\| [TX]\d{2} \|/,
  )) {
    // Selected extensions explicitly use their own D4 objectives, not extra transfers.
    if (c[1].startsWith("—")) continue;
    const members = objectives.filter((o) =>
      o.id.startsWith(`${track}:${c[0]}.`),
    );
    if (!members.length)
      throw Error(`Transfer has no active topic: ${track}:${c[0]}`);
    definitions.push({
      id: `${track}:${c[0]}`,
      track,
      kind: "transfer",
      name: c[0],
      selected: true,
      status: state(c[1]),
      sourceRefs: c[2],
      scope: `Independent meaningfully changed-context transfer of ${r.tracks[track].topics[c[0]] ?? c[0]}. Test the topic's central reasoning, changed assumptions and validity boundaries. Existing objective targets: ${members.map((o) => `${o.id}: ${o.scope}`).join(" ")}`,
      remaining:
        c[1] === "P"
          ? "See qualifying source evidence; retention remains separate"
          : "A qualifying independent changed-context transfer remains unresolved",
    });
  }
  const activeCore = [
    ...new Set(
      objectives
        .map((o) => o.id.split(":")[1].split(".")[0])
        .filter((id) => id.startsWith("T")),
    ),
  ];
  if (activeCore.some((name) => !definitions.some((d) => d.name === name)))
    throw Error(`Missing active topic transfer in ${track}`);
  for (const c of rows(
    section(progress, "0.8 Integration coverage"),
    /^\| I\d{2} \|/,
  )) {
    if (!["ACTIVE", "NOT_SELECTED"].includes(c[1]))
      throw Error(`Invalid integration selection: ${c[0]}`);
    const def = rows(curriculum, new RegExp(`^\\| ${c[0]} \\|`));
    if (def.length !== 1 || def[0].length < 4)
      throw Error(`Missing unique integration definition ${track}:${c[0]}`);
    definitions.push({
      id: `${track}:${c[0]}`,
      track,
      kind: "integration",
      name: c[0],
      selected: c[1] === "ACTIVE",
      status: state(c[2]),
      sourceRefs: c[3],
      scope: def[0].slice(1).join(" | "),
      remaining: c[4],
    });
  }
  if (track === "PE") {
    for (const c of rows(
      section(progress, "0.8.1 Environment-backed verification"),
      /^\| ENV\d{2} \|/,
    )) {
      definitions.push({
        id: `${track}:${c[0]}`,
        track,
        kind: "environment",
        name: c[0],
        selected: true,
        status: state(c[3]),
        sourceRefs: c[4],
        scope: `${c[1]}; related scope ${c[2]}`,
        remaining: c[5],
      });
    }
  }
  if (new Set(definitions.map((d) => d.id)).size !== definitions.length)
    throw Error("Duplicate final requirement identifier");
  return definitions;
}

const count = (statuses: CellState[]) => ({
  passed: statuses.filter((s) => s === "P").length,
  total: statuses.length,
});

export function learningTarget(r: Roadmap, track: Track, id: string) {
  const objective = r.tracks[track].objectives.find((o) => o.id === id);
  if (objective) return { ...objective, kind: "checkpoint" as const };
  const d = finalRequirements(r, track).find(
    (d) => d.id === id && d.selected && d.kind !== "environment",
  );
  return d
    ? {
        id: d.id,
        target: 4,
        scope: d.scope,
        refs: d.sourceRefs,
        kind: d.kind as "transfer" | "integration",
      }
    : undefined;
}

export function ensureFinalProgress(r: Roadmap, l: LearnerLedger) {
  l.finalProgress ??= {};
  for (const track of ["PY", "PE"] as const)
    for (const d of finalRequirements(r, track))
      if (d.selected && d.kind !== "environment")
        l.finalProgress[d.id] ??= {
          kind: d.kind,
          status: d.status,
          facets: {},
          proofs: {},
          sourceRefs: d.sourceRefs,
        };
}

export function finalRequirementStatus(
  r: Roadmap,
  l: LearnerLedger,
  d: FinalRequirement,
): CellState {
  if (d.kind === "environment") return environmentStatus(r, l, d);
  const p = l.finalProgress?.[d.id];
  if (!p) return d.status;
  if (p.kind !== d.kind || p.sourceRefs !== d.sourceRefs)
    throw Error(`Changed final requirement source ${d.id}`);
  if (p.status !== "P" || d.status === "P") return p.status;
  const key = scopeKey(d.id, 4),
    def = l.scopes[key];
  return def?.sourceScope === d.scope &&
    def.objectiveId === d.id &&
    def.id === key &&
    def.depth === 4 &&
    def.facets.length > 0 &&
    l.verifiedScopes.includes(key) &&
    def.facets.every((f) => {
      const proof = p.facets[`D4:${f.id}`];
      return (
        proof?.outcome === "independent" &&
        proof.evidenceIds.some((ref) =>
          independentProofValid(r, l, d.id, 4, f.id, ref),
        )
      );
    })
    ? "P"
    : "U";
}

function supportedCheckpoint(
  r: Roadmap,
  l: LearnerLedger,
  track: Track,
  id: string,
  depth: number,
  requireNewProof = false,
) {
  const o = r.tracks[track].objectives.find((o) => o.id === id),
    cell = l.cells[id];
  if (!o || !cell || cell.states[depth - 1] !== "P") return false;
  if (!requireNewProof && baselineCheckpointValid(r, l, id, depth)) return true;
  const key = `${id}/D${depth}`,
    def = l.scopes[key];
  return (
    !!def &&
    def.id === key &&
    def.depth === depth &&
    def.objectiveId === id &&
    def.sourceScope === o.scope &&
    def.facets.length > 0 &&
    l.verifiedScopes.includes(key) &&
    def.facets.every((f) => {
      const proof = cell.facets[`D${depth}:${f.id}`];
      return (
        proof?.outcome === "independent" &&
        proof.evidenceIds.some((ref) =>
          independentProofValid(r, l, id, depth, f.id, ref),
        )
      );
    })
  );
}

export function curriculumReadiness(
  r: Roadmap,
  l: LearnerLedger,
  track: Track,
) {
  if (l.sourceHash !== r.sourceHash)
    throw Error("Readiness source mismatch; explicit migration required");
  const requirements = finalRequirements(r, track).map((d) => {
    const status = finalRequirementStatus(r, l, d);
    const def = l.scopes[scopeKey(d.id, 4)],
      progress = l.finalProgress?.[d.id];
    const missing = def?.facets
      .filter((f) => progress?.facets[`D4:${f.id}`]?.outcome !== "independent")
      .map((f) => `${f.id}: ${f.description}`);
    return {
      ...d,
      sourceRefs:
        d.kind === "environment"
          ? [
              d.sourceRefs,
              ...importedEnvironmentEvidence(r, l, d.id, d.scope).refs,
              ...(l.environmentEvidence ?? [])
                .filter((v) => v.payload.definition.id === d.id)
                .map((v) => v.id),
            ]
              .filter((s) => s && s !== "—")
              .join(", ") || "—"
          : d.sourceRefs,
      status,
      remaining:
        d.kind === "environment"
          ? status === "P"
            ? "Full environment scope observed in reviewed learner work; not independent academic proof"
            : "Environment scope remains partly or wholly unobserved; never a tier gate"
          : status === "P"
            ? "Complete independent source scope; delayed retention remains separate"
            : missing?.length
              ? missing.join("; ")
              : d.remaining,
    };
  });
  const objectives = r.tracks[track].objectives;
  const checkpoints = count(
    objectives.flatMap((o) =>
      Array.from({ length: o.target }, (_, i) =>
        supportedCheckpoint(r, l, track, o.id, i + 1) ? "P" : "U",
      ),
    ),
  );
  const category = (kind: FinalRequirement["kind"]) =>
    count(
      requirements
        .filter((d) => d.kind === kind && d.selected)
        .map((d) => d.status),
    );
  const transfers = category("transfer"),
    integrations = category("integration"),
    environment = category("environment");
  const unresolvedMaterialGaps = rows(
    section(
      r.tracks[track].progress,
      "0.6 Facet gaps, unknowns, and dependencies",
    ),
    /^\| G\d+ \|/,
  )
    .filter((c) => {
      // A truncated row has no status cell: it stays unresolved.
      if (c[6]?.startsWith("CLOSED")) return false;
      const m = /^([TX]\d{2}\.\d+) \/ D([1-4])$/.exec(c[1]);
      if (!m) return true; // Unknown material scope cannot be silently certified.
      const id = `${track}:${m[1]}`,
        depth = +m[2];
      // A new complete checkpoint proof reconciles only its own depth-specific gap.
      return !supportedCheckpoint(r, l, track, id, depth, true);
    })
    .map((c) => `${track}:${c[0]}`);
  const curriculumTargetsMet =
    checkpoints.passed === checkpoints.total &&
    transfers.passed === transfers.total &&
    !unresolvedMaterialGaps.length;
  const interviewPracticeVerified =
    integrations.total > 0 && integrations.passed === integrations.total;
  return {
    track,
    sourceHash: r.sourceHash,
    checkpoints,
    transfers,
    integrations,
    environment,
    unresolvedMaterialGaps,
    requirements,
    curriculumTargetsMet,
    interviewPracticeVerified,
    // ENV observations and delayed retention are intentionally absent from this gate.
    tier4RequirementsMet: curriculumTargetsMet && interviewPracticeVerified,
    trackedEnvironmentObserved:
      environment.total > 0 && environment.passed === environment.total,
    retention: {
      verified: Object.values(l.reviews).filter(
        (v) => v.objectiveId.startsWith(`${track}:`) && v.verifiedReviews > 0,
      ).length,
      tracked: Object.values(l.reviews).filter((v) =>
        v.objectiveId.startsWith(`${track}:`),
      ).length,
    },
  };
}
