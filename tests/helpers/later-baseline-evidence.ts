// Controlled grades exercise actual scheduler/ledger APIs; never real learner proof.
import {
  applyLearningAssessment,
  beginLearningAttempt,
  eligibleLearning,
  registerScopes,
} from "../../src/learner";
import type { StudyRecord } from "../../src/model";
import { createRecord } from "./record";
import { baselineFixture, roadmap as r } from "./baseline-correction";
export const laterAt = "2026-10-17T16:00:00Z",
  laterId = "PY:T05.2",
  laterScope = `${laterId}/D1`;
export function gradeScheduled(
  g: StudyRecord,
  outcome: "independent" | "contradicted" | "assisted",
  at: string,
  n: number,
  observedAt: string | null = at,
) {
  const l = g.study.learner!,
    c = eligibleLearning(r, l, at),
    e = structuredClone(g.encounters["question-0"]);
  e.id = `synthetic-later-observation-${n}`;
  e.problem = {
    title: "Synthetic actual later observation",
    prompt: "Controlled later observation only",
    starter: "",
    rubric: [],
    provenance: "study-mode",
    contract: c,
    scopeDefinitions: c.objectiveIds.map((id, i) =>
      structuredClone(
        l.scopes[`${id}/D${c.depth}`] ?? {
          id: `${id}/D${c.depth}`,
          objectiveId: id,
          depth: c.depth,
          sourceScope: c.scopes[i],
          facets: [
            {
              id: "source-0",
              description: `Synthetic source-defined facet 0: ${c.scopes[i]}`,
            },
          ],
        },
      ),
    ),
  };
  e.workspace = "Exact private artifact retained through older-score audit";
  e.history = [
    {
      seq: 1,
      author: "human",
      kind: "reasoning",
      text: "Synthetic later observed reasoning for controlled native-grade fixture",
      at: 0,
      revision: 0,
      wallTime: observedAt ?? undefined,
    },
  ];
  g.encounters[e.id] = e;
  registerScopes(r, l, e);
  beginLearningAttempt(r, l, e, at);
  applyLearningAssessment(
    r,
    l,
    e,
    {
      id: `synthetic-later-${outcome}-${n}`,
      encounter: e.id,
      provenance: "study-mode",
      sourceVersion: l.version,
      status: "pending",
      evidenceCutoffSequence: 1,
      visitOutcome: "usable",
      scopeReviews: e.problem.scopeDefinitions!.map((d) => ({
        id: d.id,
        completeCoverage: true,
        rationale: "Synthetic full source scope",
      })),
      findings: e.problem.scopeDefinitions!.flatMap((d) =>
        d.facets.map((f) => ({
          objectiveId: d.objectiveId,
          depth: d.depth,
          facet: f.id,
          outcome,
          evidence: [1],
          completeCheckpointScope: false,
          rationale: "Synthetic actual later observation",
        })),
      ),
    },
    at,
    "study-mode",
  );
  return { e, c };
}
export async function laterBaselineFixture(
  outcome: "independent" | "contradicted" | "assisted",
) {
  const g = createRecord(73, r);
  g.study.profile = "live";
  const { e, c } = gradeScheduled(g, outcome, laterAt, 0);
  const expected =
    outcome === "independent"
      ? ("P" as const)
      : outcome === "contradicted"
        ? ("R" as const)
        : ("G" as const);
  const fixture = await baselineFixture(g, laterId, expected);
  return { g, e, c, expected, fixture };
}
