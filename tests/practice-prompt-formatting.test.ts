import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { markdownToHtml } from "../src/markdown";
import type { Contract, Problem, Roadmap } from "../src/model";
import { decode, encode, recover } from "../src/persistence";
import { upgradeSavedPracticePrompt } from "../src/practice-problem";
import { aiPracticeQuestions } from "../src/product-practice-ai";
import { deliveryQuestions } from "../src/product-practice-delivery";
import { foundationQuestions } from "../src/product-practice-foundations";
import { createGame } from "../src/world";

const CODE_LIKE = /^\s+\S|[{;]\s*$|^<\/?[a-zA-Z]|=>\s*[{(]?\s*$/;
const banks = {
  ...aiPracticeQuestions,
  ...deliveryQuestions,
  ...foundationQuestions,
};

test("static practice questions keep code lines inside code blocks", () => {
  const stray: string[] = [];
  for (const [id, { prompt }] of Object.entries(banks)) {
    let fenced = false;
    for (const line of prompt.split("\n")) {
      if (line.startsWith("```")) fenced = !fenced;
      else if (!fenced && CODE_LIKE.test(line)) stray.push(`${id}: ${line}`);
    }
    assert.equal(fenced, false, `${id} has an unterminated code block`);
  }
  assert.deepEqual(stray, []);
});

test("code blocks render verbatim, so markdown syntax in code stays literal", () => {
  const html = markdownToHtml(foundationQuestions["PE:T04.3"].prompt);
  assert.match(html, /<pre><code>async function loadProfile/);
  assert.match(html, /\n {2}try \{\n {4}const res/);
});

const saved = (
  prompt: string,
  contract: Partial<Contract>,
  provenance = "development",
) =>
  ({
    title: "t",
    prompt,
    rubric: [],
    starter: "",
    provenance,
    contract,
  }) as unknown as Problem;
const trace =
  "values = [1,2,5]\ncount = 0\nfor value in values:\n    if value > 4:\n        count += 1";

test("a saved trace question gains a code block and keeps its later text", () => {
  const problem = saved(
    `Read this small Python trace:\n\n${trace}\n\nPredict it.\n\nYou flagged this as a gap earlier, so cover it too: x.`,
    { track: "PY", objectiveIds: ["PY:T01.1"] },
  );
  upgradeSavedPracticePrompt(problem);
  assert.equal(
    problem.prompt,
    `Read this small Python trace:\n\n\`\`\`python\n${trace}\n\`\`\`\n\nPredict it.\n\nYou flagged this as a gap earlier, so cover it too: x.`,
  );
  const once = problem.prompt;
  upgradeSavedPracticePrompt(problem);
  assert.equal(problem.prompt, once);
});

test("saved bank questions upgrade only when the wording is unchanged", () => {
  const contract = {
    track: "PE",
    depth: 2,
    objectiveIds: ["PE:T08.2"],
  } as Contract;
  const current = foundationQuestions["PE:T08.2"].prompt;
  const old = current.replace(/`/g, "");
  const problem = saved(old, contract);
  upgradeSavedPracticePrompt(problem);
  assert.equal(problem.prompt, current);

  const edited = saved(`${old} Extra.`, contract);
  upgradeSavedPracticePrompt(edited);
  assert.equal(edited.prompt, `${old} Extra.`);

  const unknown = saved(old, { ...contract, objectiveIds: ["PE:missing"] });
  upgradeSavedPracticePrompt(unknown);
  assert.equal(unknown.prompt, old);
});

test("AI-written questions are never rewritten", () => {
  const prompt = `Read this small Python trace:\n\n${trace}\n\nPredict it.`;
  const problem = saved(
    prompt,
    { track: "PY", objectiveIds: [] },
    "claude-cli",
  );
  upgradeSavedPracticePrompt(problem);
  assert.equal(problem.prompt, prompt);
});

test("loading a save upgrades a question issued before code blocks", () => {
  const r = JSON.parse(
      readFileSync("public/curriculum.json", "utf8"),
    ) as Roadmap,
    g = createGame(725, r),
    e = g.encounters["f0-room0"];
  e.problem = saved(
    `Read this small Python trace:\n\n${trace}\n\nPredict it.`,
    {
      track: "PY",
      objectiveIds: [],
    },
  );
  const restored = recover(decode(encode(g))).encounters[e.id];
  assert.match(restored.problem!.prompt, /```python\nvalues = \[1,2,5\]/);
});
