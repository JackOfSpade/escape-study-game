/** Critic cases from real generator output: each production npc-chatter line
 * once as written and once with a planted defect, so a critic's catch rate and
 * false-alarm rate can be scored without a judge. Usage:
 *   node scripts/ai-capture/build-review-cases.mjs <ladder results.jsonl> <chatter cases.json> <out.json> [setting] */
import { readFileSync, writeFileSync } from "node:fs";
import {
  buildNpcDialogueReview,
  parseNpcDialogueDraft,
} from "../lib/npc-dialogue-policy.mjs";

const [resultsFile, casesFile, outFile, setting = "haiku:high"] =
  process.argv.slice(2);
const cases = new Map(
  JSON.parse(readFileSync(casesFile, "utf8")).map((c) => [c.id, c]),
);
const rows = readFileSync(resultsFile, "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter(
    (r) =>
      r.operation === "npc-chatter" &&
      r.setting === setting &&
      r.rep === 0 &&
      r.outcome === "valid",
  );
// Each defect is one a careful critic must catch from the context alone.
const DEFECTS = [
  (t) =>
    `${t} The pharmacy on Delancey still has insulin, I checked yesterday.`,
  (t) => `${t} Three of them are right behind you, don't turn around.`,
  () => "Anyway, did anyone ever fix the coffee machine on the fourth floor?",
  (t) => `${t} We already have the roof key, so the rest is easy.`,
];
const out = [];
let n = 0;
for (const row of rows) {
  const context = cases.get(row.caseId)?.payload;
  const answer = row.answers.at(-1);
  if (!context || answer?.decision !== "speak") continue;
  const draft = parseNpcDialogueDraft(context, answer);
  if (!draft) continue;
  const defectText = DEFECTS[n % DEFECTS.length](draft.text).slice(0, 180);
  for (const [label, candidate] of [
    ["clean", draft],
    ["defect", { ...draft, text: defectText }],
  ]) {
    const payload = await buildNpcDialogueReview(context, candidate, 0);
    out.push({
      id: `review-${label}-${++n}`,
      operation: "npc-chatter-review",
      label,
      payload,
    });
  }
}
writeFileSync(outFile, JSON.stringify(out));
console.log(
  `${out.length} critic cases (${out.filter((c) => c.label === "defect").length} with a planted defect)`,
);
