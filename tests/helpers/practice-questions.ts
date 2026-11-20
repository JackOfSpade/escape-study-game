import { eligible } from "../../src/curriculum";
import { openGaps } from "../../src/knowledge-probe";
import {
  type Contract,
  type StudyRecord,
  type Roadmap,
  type Problem,
} from "../../src/model";
/**
 * Test fixture only: synthetic questions for records that never reach Claude.
 * The app itself has no local questions; every real question comes from Claude.
 */
/** A small seeded generator, so a fixture question is the same on every run. */
function rand(g: StudyRecord & { rng?: number }) {
  let t = (g.rng = ((g.rng ?? 1) + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
/** Gaps the learner declared on this question's own objective, so the extra line is never off-topic. */
function gapLine(g: StudyRecord, contract: Contract) {
  const gaps = openGaps(g)
    .filter(
      (r) =>
        r.track === contract.track &&
        r.objectiveIds.some((id) => contract.objectiveIds.includes(id)),
    )
    .slice(-5)
    .map((r) => r.facet.description);
  return gaps.length
    ? `\n\nYou flagged this as a gap earlier, so cover it too: ${gaps.join("; ")}.`
    : "";
}
export function devProblem(
  g: StudyRecord & { rng?: number },
  r: Roadmap,
  contract: Contract = eligible(r, g.study),
): Problem {
  const n = 3 + Math.floor(rand(g) * 6),
    values = Array.from({ length: n }, () => Math.floor(rand(g) * 8)),
    threshold = 2 + Math.floor(rand(g) * 4);
  if (contract.track === "PY" && contract.objectiveIds[0] === "PY:T05.2") {
    const size = 2 + Math.floor(rand(g) * Math.min(3, n - 1)),
      sums = values
        .slice(0, n - size + 1)
        .map((_, i) => values.slice(i, i + size).reduce((a, b) => a + b, 0));
    return {
      title: "Signal window / prediction",
      // Learner-facing text only: the scheduled scope stays in the contract.
      prompt: `An intake monitor reads ${JSON.stringify(values)}. A window of ${size} consecutive readings slides one position at a time.\n\nPredict the largest window total. Explain what changes and what stays the same each time the window slides, and name one edge case worth checking. No code is needed.${gapLine(g, contract)}`,
      rubric: [
        "Correct predicted total",
        "Explain update/state and a relevant boundary",
      ],
      starter: "",
      provenance: "development",
      validation: { kind: "trace", answer: Math.max(...sums) },
      contract,
    };
  }
  if (contract.track === "PE") {
    return {
      title: "Product review",
      prompt: `Review this small product change and name one risk worth checking.${gapLine(g, contract)}`,
      rubric: ["Name one relevant risk", "Explain how to check it"],
      starter: "",
      provenance: "development",
      contract,
    };
  }
  return {
    title: "Signal contract / trace",
    prompt: `Read this small Python trace:\n\n\`\`\`python\nvalues = ${JSON.stringify(values)}\ncount = 0\nfor value in values:\n    if value > ${threshold}:\n        count += 1\n\`\`\`\n\nPredict the final value of count. Explain what count means partway through, after the loop has seen only the first few values, and name one edge case worth checking. No code is needed.${gapLine(g, contract)}`,
    rubric: [
      "Predict the correct final count",
      "Explain what count means partway through the loop",
      "Name one relevant edge case worth checking",
    ],
    starter: "",
    provenance: "development",
    validation:
      contract.track === "PY"
        ? { kind: "trace", answer: values.filter((v) => v > threshold).length }
        : undefined,
    contract,
  };
}
/** Give every unasked question of a development record a synthetic problem. */
export function preparePracticeRooms(g: StudyRecord, roadmap: Roadmap) {
  if (g.study.profile !== "development") return;
  for (const e of Object.values(g.encounters)) {
    if (e.problem || e.state === "consumed") continue;
    const contract = eligible(roadmap, g.study);
    e.problem = devProblem(
      Object.assign({ rng: g.seq + e.id.length }, g),
      roadmap,
      contract,
    );
    if (!e.workspace && e.revision === 0) e.workspace = e.problem.starter;
    e.state = "in-progress";
  }
}
