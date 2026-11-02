import { PROVIDERS } from "./model";
import {
  facetMappingShapeValid,
  type FacetProof,
  type LearnerLedger,
} from "./learning-model";
import type { Roadmap, Track } from "./model";
import { observationInvalidated } from "./observation-validity";
import type {
  ImportedFacetMapping,
  RoadmapAdoptionReceipt,
} from "./roadmap-adoption-types";
import { receiptRows } from "./roadmap-structure";
/** Manual merged roadmaps may bind final evidence in the authoritative final
 * register instead of repeating a synthetic D4 label in the observation title.
 * An explicit conflicting depth is never overridden by that cross-reference. */
function finalRegisterDepth(
  receipt: RoadmapAdoptionReceipt,
  definition: LearnerLedger["scopes"][string],
  ref: string,
) {
  if (
    definition.depth !== 4 ||
    !/^(PY|PE):[TI]\d{2}$/.test(definition.objectiveId) ||
    definition.id !== `${definition.objectiveId}/T4`
  )
    return undefined;
  const [track, id] = definition.objectiveId.split(":"),
    integration = id.startsWith("I");
  const heading = integration
    ? "0.8 Integration coverage"
    : "0.7 Topic transfer and retention";
  const row = [...receiptRows(receipt)].find(
    ([key]) =>
      key.startsWith(`${track}_PROGRESS/${heading}/`) && key.endsWith(`/${id}`),
  )?.[1];
  const c = row
    ?.split("|")
    .slice(1, -1)
    .map((c) => c.trim());
  if (
    !c ||
    (integration ? c[1] !== "ACTIVE" : !["U", "G", "P", "R"].includes(c[1]))
  )
    return undefined;
  const refs: string[] =
    c[integration ? 3 : 2].match(/\bS\d{4}-EV\d{2,}\b/g) ?? [];
  return refs.includes(ref) ? 4 : undefined;
}

export function importedMappingValid(
  r: Roadmap,
  l: LearnerLedger,
  v: RoadmapAdoptionReceipt,
  m: ImportedFacetMapping,
) {
  const d = l.scopes[m.scopeId];
  if (
    v.sourceHash !== r.sourceHash ||
    !PROVIDERS.includes(v.provenance) ||
    v.id !== v.proposal.requestId ||
    !d ||
    !facetMappingShapeValid(d, m)
  )
    throw Error("Invalid imported facet mapping");
  const track = d.objectiveId.split(":")[0],
    id = d.objectiveId.split(":")[1];
  for (const ref of m.evidenceIds) {
    if (!/^S\d{4}-EV\d{2,}$/.test(ref))
      throw Error(
        "Imported proof requires a canonical source evidence identifier",
      );
    const found = [...receiptRows(v)].find(
      ([key]) =>
        key.startsWith(`${track}_PROGRESS/0.5 Assessment evidence register/`) &&
        key.endsWith(`/${ref}`),
    );
    if (!found) throw Error("Imported proof has no exact source evidence row");
    const c = found[1]
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim()),
      excerpt = m.sourceExcerpts?.[ref];
    const scoped = (
        (c[3].match(/\b[TXI]\d{2}(?:\.\d+)?\b/g) ?? []) as string[]
      ).includes(id),
      explicitDepth = /\bD([1-4])\b/.exec(c[4]),
      depth = explicitDepth
        ? Number(explicitDepth[1])
        : d.depth === 4 && c[4].includes("Tier 4 final requirement")
          ? 4
          : finalRegisterDepth(v, d, ref);
    if (
      !scoped ||
      depth !== d.depth ||
      typeof excerpt !== "string" ||
      excerpt.length < 12 ||
      excerpt.length > 3000 ||
      !c[8]?.includes(excerpt)
    )
      throw Error("Imported evidence scope or exact excerpt does not match");
    if (m.outcome === "unknown") continue;
    const attempt = [...receiptRows(v)]
      .find(
        ([key]) =>
          key.startsWith(`${track}_PROGRESS/0.5.1 Attempt status register/`) &&
          key.endsWith(`/${c[1]}`),
      )?.[1]
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
    if (!attempt || /^INVALIDATED\b/.test(attempt[3]))
      throw Error(
        "Imported observation requires an issued, non-invalidated source attempt",
      );
    const game = c[5] === `GAME_AI_ASSESSED_${m.outcome.toUpperCase()}`;
    if (
      c[5].startsWith("GAME_AI_ASSESSED_") &&
      (!game || /\/ ([^:]+):/.exec(c[4])?.[1] !== m.facet)
    )
      throw Error(
        "Imported game evidence outcome or named facet does not match",
      );
    const numeric = /^[0-3](?:$|\s)/.test(c[7]) ? Number(c[7][0]) : undefined;
    if (
      !game &&
      !["DIAGNOSTIC", "INDEPENDENT", "TRANSFER", "REVIEW", "GUIDED"].includes(
        c[5],
      )
    )
      throw Error(
        "Reported or unscored exposure cannot establish imported observation",
      );
    if (numeric === undefined) throw Error("Imported observation is unscored");
    if (m.outcome === "independent") {
      const unassisted =
        ["NONE", "NEUTRAL_CLARIFICATION", "NONE FOR THIS FACET"].includes(
          c[6],
        ) &&
        numeric >= 2 &&
        c[5] !== "GUIDED";
      const mixed =
        numeric >= 2 &&
        c[5] !== "GUIDED" &&
        c[6] === "MIXED" &&
        excerpt.length >= 24 &&
        /\bindependently\b/i.test(excerpt);
      if (!unassisted && !mixed)
        throw Error(
          "Assisted source work cannot become independent imported proof",
        );
    }
    if (m.outcome === "contradicted" && numeric >= 2)
      throw Error(
        "Successful source evidence cannot be relabeled as a contradiction",
      );
  }
  return true;
}
export function importedProofValid(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  depth: number,
  facet: string,
  ref: string,
  outcome: FacetProof["outcome"] = "independent",
) {
  if (observationInvalidated(r, l, id, ref)) return false;
  const scopeId = `${id}/${/^(PY|PE):(?:[TX]\d{2}|I\d{2})$/.test(id) ? "T4" : `D${depth}`}`;
  for (const receipt of [...(l.roadmapAdoptions ?? [])].reverse())
    for (const mapping of receipt.proposal.mappings) {
      if (
        mapping.scopeId !== scopeId ||
        mapping.facet !== facet ||
        mapping.outcome !== outcome ||
        !mapping.evidenceIds.includes(ref)
      )
        continue;
      try {
        return importedMappingValid(r, l, receipt, mapping);
      } catch {
        return false;
      }
    }
  return false;
}
export const adoptedSourceText = (l?: LearnerLedger) =>
  l?.roadmapAdoptions?.at(-1)?.proposal.canonical;
export const adoptedTrackProgress = (
  l: LearnerLedger | undefined,
  track: Track,
) =>
  adoptedSourceText(l)
    ?.split(`<!-- BEGIN ${track}_PROGRESS -->`)[1]
    ?.split(`<!-- END ${track}_PROGRESS -->`)[0];
export const trackProgressContext = (
  l: LearnerLedger | undefined,
  r: Roadmap,
  track: Track,
) => adoptedTrackProgress(l, track) ?? r.tracks[track].progress;
export function importedEnvironmentStatus(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  scope: string,
) {
  let status: "U" | "G" | "P" = "U";
  for (const receipt of l.roadmapAdoptions ?? [])
    for (const m of receipt.proposal.environment ?? []) {
      if (m.envId !== id) continue;
      const found = [...receiptRows(receipt)].find(
        ([key]) =>
          key.startsWith(
            "PE_PROGRESS/0.8.1 Environment-backed verification/",
          ) && key.endsWith(`/${id.split(":")[1]}`),
      );
      const c = found?.[1]
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      if (
        receipt.sourceHash !== r.sourceHash ||
        !PROVIDERS.includes(receipt.provenance) ||
        !c ||
        `${c[1]}; related scope ${c[2]}` !== scope ||
        c[3] !== m.status ||
        !["U", "G", "P"].includes(m.status) ||
        !m.rationale?.trim() ||
        !Array.isArray(m.evidenceIds) ||
        (m.status !== "U" &&
          (!m.evidenceIds.length ||
            m.evidenceIds.some((ref) => !c[4].split(/[\s,;]+/).includes(ref)) ||
            c[5] === "—"))
      )
        throw Error("Unsupported imported practical environment status");
      if (m.status === "P" || (m.status === "G" && status !== "P"))
        status = m.status;
    }
  return status;
}
/** Only references from source rows already checked by the adoption validator. */
export function importedEnvironmentEvidence(
  r: Roadmap,
  l: LearnerLedger,
  id: string,
  scope: string,
) {
  importedEnvironmentStatus(r, l, id, scope);
  const refs: string[] = [],
    notes: string[] = [];
  for (const receipt of l.roadmapAdoptions ?? [])
    for (const mapping of receipt.proposal.environment ?? []) {
      if (mapping.envId !== id || mapping.status === "U") continue;
      const row = [...receiptRows(receipt)].find(
        ([key]) =>
          key.startsWith(
            "PE_PROGRESS/0.8.1 Environment-backed verification/",
          ) && key.endsWith(`/${id.split(":")[1]}`),
      )![1];
      const c = row
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      refs.push(...mapping.evidenceIds);
      notes.push(c[5]);
    }
  return { refs: [...new Set(refs)], notes: [...new Set(notes)] };
}
