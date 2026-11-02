// New scoped diagnostic; the completed earlier approvals do not authorize release.
import { fileURLToPath } from "node:url";
import { createOptionalProbe, runProbeCLI } from "./smoke-chatgpt-optional.mjs";
export const SEMANTIC_PLAN_HASH =
  "e191858f460fc46e11e6c74e219c80854f45b0827027a824c7be1c9d4497fb8b";
const expectedNames = [
  "changed-assumptions-generation",
  "incompatible-proof-assessment",
  "less-skilled-speaker",
  "defensible-scan",
  "defensible-index",
  "project-history-attribution",
];
// Format/identity only; manual semantic review is required for every raw answer.
export function semanticBoundaryCheck(task, answer) {
  try {
    if (!answer || typeof answer !== "object") return false;
    const p = task.payload;
    if (task.operation === "generate")
      return (
        JSON.stringify(answer.contract) === JSON.stringify(p.contract) &&
        JSON.stringify(answer.scopeDefinitions) ===
          JSON.stringify(Object.values(p.existingScopeDefinitions)) &&
        typeof answer.title === "string" &&
        typeof answer.prompt === "string" &&
        !!answer.prompt.trim() &&
        answer.starter === "" &&
        !answer.runtime &&
        Array.isArray(answer.rubric) &&
        answer.rubric.every((r) => typeof r === "string")
      );
    if (task.operation === "group")
      return (
        answer.requestId === p.requestId &&
        answer.sourceRevision === p.sourceRevision &&
        Array.isArray(answer.messages) &&
        answer.messages.length === 1 &&
        answer.messages.every(
          (m) =>
            p.speakers.some((s) => s.id === m.author) &&
            ["question", "proposal", "observation"].includes(m.kind) &&
            typeof m.text === "string" &&
            !!m.text.trim() &&
            !m.patch &&
            !m.claims?.length &&
            Array.isArray(m.refs) &&
            m.refs.length > 0 &&
            m.refs.every((ref) => p.events.some((e) => e.seq === ref)),
        )
      );
    const d = p.scopeDefinitions[0];
    return (
      ["usable", "unresolved", "invalid"].includes(answer.visitOutcome) &&
      Array.isArray(answer.scopeReviews) &&
      answer.scopeReviews.every((s) => s.id === d.id) &&
      Array.isArray(answer.helpAttributions) &&
      !answer.historicalMappings?.length &&
      Array.isArray(answer.findings) &&
      answer.findings.length > 0 &&
      new Set(answer.findings.map((f) => f.facet)).size ===
        answer.findings.length &&
      answer.findings.every(
        (f) =>
          f.objectiveId === d.objectiveId &&
          f.depth === 1 &&
          d.facets.some((facet) => facet.id === f.facet) &&
          ["independent", "assisted", "unknown", "contradicted"].includes(
            f.outcome,
          ) &&
          f.execution === "not-run" &&
          !f.completeCheckpointScope &&
          typeof f.rationale === "string" &&
          Array.isArray(f.evidence) &&
          f.evidence.every((seq) => seq === 2),
      )
    );
  } catch {
    return false;
  }
}
export const semanticProbeConfig = {
  expectedHash: SEMANTIC_PLAN_HASH,
  expectedNames,
  evaluate: semanticBoundaryCheck,
  deriveValidation: false,
  prefixName: "semantic-boundary-smoke",
};
export const createSemanticProbe = (io) =>
  createOptionalProbe({ ...io, ...semanticProbeConfig });
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  runProbeCLI({
    planName: "chatgpt-semantic-boundaries-plan",
    privateName: "semantic-boundaries-smoke",
    reportName: "chatgpt-semantic-boundaries-probe",
    approvalFlag: "--approved-six",
    config: semanticProbeConfig,
  }).catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
