import { facetProofValid, independentProofValid } from "./historical-proof";
import { historicalScope } from "./historical-scope";
import { reviewSignature, type LearnerLedger } from "./learning-model";
import type { Roadmap } from "./model";
import {
  baselineCheckpointRefs,
  baselineCheckpointValid,
  observationInvalidated,
} from "./observation-validity";
import type { RoadmapReconciliation } from "./roadmap-adoption-types";
import { CELL_SEPARATOR } from "./table-row";

/** A terminal audit alone cannot retract a trusted original checkpoint.
 * Require explicit whole-scope review of its complete attributed history. */
export function reviewBaselineCorrections(
  r: Roadmap,
  before: LearnerLedger,
  work: LearnerLedger,
  p: RoadmapReconciliation,
  parsed: Roadmap,
  retentionReviewed = new Set<string>(),
) {
  const affected = new Set<string>();
  for (const track of ["PY", "PE"] as const)
    for (const o of r.tracks[track].objectives)
      for (let depth = 1; depth <= o.target; depth++) {
        const id = `${o.id}/D${depth}`,
          support = baselineCheckpointRefs(r, o.id, depth);
        if (!support.length || baselineCheckpointValid(r, work, o.id, depth))
          continue;
        const review = before.reviews[id],
          nextReview = parsed.resume?.reviews
            ? parsed.resume.reviews[id]
            : review;
        if (
          !retentionReviewed.has(id) &&
          (reviewSignature(review) !== reviewSignature(nextReview) ||
            (depth === 1 &&
              review &&
              parsed.tracks[track].objectives.find((item) => item.id === o.id)
                ?.reviewDue !== review.due))
        )
          throw Error(
            "Baseline withdrawal must retain exact retention dates, stage and verified-review counts",
          );
        if (!baselineCheckpointValid(r, before, o.id, depth)) continue;
        const history = historicalScope(r, track, o.id, depth),
          mappings = p.mappings.filter((m) => m.scopeId === id),
          definition = p.definitions.find((d) => d.id === id);
        if (
          !definition ||
          !p.completeScopes.includes(id) ||
          !definition.facets.every((f) =>
            mappings.some((m) => m.facet === f.id),
          )
        )
          throw Error(
            "Original baseline correction requires an explicit complete historical-scope review with every facet mapped",
          );
        const rows = history.evidenceRows.map((row) =>
          row
            .split(CELL_SEPARATOR)
            .slice(1, -1)
            .map((c) => c.trim()),
        );
        if (!support.every((ref) => rows.some((c) => c[0] === ref)))
          throw Error(
            "Baseline support must have exact historical scope records",
          );
        for (const c of rows) {
          const invalid = observationInvalidated(r, work, o.id, c[0]);
          const references = mappings.filter((m) =>
            m.evidenceIds.includes(c[0]),
          );
          if (
            !references.length ||
            (invalid && references.some((m) => m.outcome !== "unknown")) ||
            (!invalid &&
              ["DIAGNOSTIC", "GUIDED"].includes(c[5]) &&
              /^[0-3]$/.test(c[7]) &&
              !references.some((m) => m.outcome !== "unknown"))
          )
            throw Error(
              "Baseline correction must review every historical observation and preserve unaffected observed knowledge or gaps",
            );
          if (
            invalid &&
            !observationInvalidated(r, before, o.id, c[0]) &&
            !p.attemptUpdates?.some(
              (u) =>
                u.track === track &&
                u.attemptId === c[1] &&
                u.correctionDecision,
            )
          )
            throw Error(
              "Original baseline withdrawal needs exact source correction authority",
            );
        }
        affected.add(id);
      }
  return affected;
}

/** Withdrawing an older score cannot rewrite a later observed result. The
 * current facts and retention schedule survive even after baseline trust ends. */
export function preserveLaterBaselineEvidence(
  r: Roadmap,
  before: LearnerLedger,
  work: LearnerLedger,
  parsed: Roadmap,
  affected: Set<string>,
  retentionReviewed = new Set<string>(),
) {
  for (const id of affected) {
    const d = work.scopes[id],
      previous = before.cells[d.objectiveId],
      current = work.cells[d.objectiveId];
    const priorDefinition = before.scopes[id];
    for (const f of priorDefinition?.facets ?? []) {
      const old = previous.facets[`D${d.depth}:${f.id}`];
      if (!old || old.outcome === "unknown") continue;
      const valid = old.evidenceIds.filter(
        (ref) =>
          facetProofValid(
            r,
            before,
            d.objectiveId,
            d.depth,
            f.id,
            ref,
            old.outcome,
          ) &&
          facetProofValid(
            r,
            work,
            d.objectiveId,
            d.depth,
            f.id,
            ref,
            old.outcome,
          ),
      );
      if (!valid.length) continue;
      const next = current.facets[`D${d.depth}:${f.id}`];
      if (
        next?.outcome !== old.outcome ||
        !valid.every((ref) => next.evidenceIds.includes(ref))
      )
        throw Error(
          "Baseline correction must preserve unaffected observed facets and their current evidence",
        );
    }
    const complete =
      work.verifiedScopes.includes(id) &&
      d.facets.every((f) => {
        const proof = current.facets[`D${d.depth}:${f.id}`];
        return (
          proof?.outcome === "independent" &&
          proof.evidenceIds.some((ref) =>
            independentProofValid(r, work, d.objectiveId, d.depth, f.id, ref),
          )
        );
      });
    const currentFailure = previous.states[d.depth - 1] === "R";
    const negative = d.facets.some((f) => {
      const proof = current.facets[`D${d.depth}:${f.id}`];
      return (
        proof?.outcome === "contradicted" &&
        proof.evidenceIds.some(
          (ref) =>
            facetProofValid(
              r,
              before,
              d.objectiveId,
              d.depth,
              f.id,
              ref,
              "contradicted",
            ) &&
            facetProofValid(
              r,
              work,
              d.objectiveId,
              d.depth,
              f.id,
              ref,
              "contradicted",
            ),
        )
      );
    });
    if (currentFailure && !negative)
      throw Error(
        "Baseline correction with an unqualified later material contradiction requires dedicated negative-evidence reassessment",
      );
    const review = before.reviews[id];
    if (
      review &&
      (review.stage > 0 || review.verifiedReviews > 0) &&
      !complete &&
      !currentFailure &&
      !retentionReviewed.has(id)
    )
      throw Error(
        "Baseline correction with unqualified later verified retention requires dedicated retention reassessment",
      );
    const next = parsed.tracks[
      d.objectiveId.startsWith("PY:") ? "PY" : "PE"
    ].objectives.find((o) => o.id === d.objectiveId)!.cells[d.depth - 1];
    if (
      (currentFailure && next !== "R") ||
      (!currentFailure && complete && next !== "P")
    )
      throw Error(
        "Baseline correction must preserve the current independently supported pass or later material contradiction",
      );
  }
}
