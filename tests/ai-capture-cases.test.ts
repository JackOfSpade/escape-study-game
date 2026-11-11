import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { buildPrompt } from "../scripts/claude-gateway.mjs";
import {
  buildCases,
  OPERATIONS,
  type CaptureCase,
} from "../scripts/ai-capture/build-cases";

const ENV_WORDS: Record<string, string[]> = {
  "PE:ENV01": ["keyboard", "screen-reader", "focus", "rendered"],
  "PE:ENV02": ["profil", "metric", "LCP", "INP"],
  "PE:ENV03": ["repository", "reproduced", "bug", "branch"],
  "PE:ENV04": ["built", "localhost", "component", "feature"],
  "PE:ENV05": ["AI coding", "diff", "steered", "verified"],
  "PE:ENV06": ["tests", "end-to-end", "repository", "executed"],
};

function environmentEvidence(c: CaptureCase) {
  const payload = c.payload as {
    definition: { id: string };
    observation: { learnerStatement: string };
  };
  const statement = payload.observation.learnerStatement,
    words = ENV_WORDS[payload.definition.id] ?? [];
  return { statement, aligned: words.some((word) => statement.includes(word)) };
}

test("buildCases produces distinct, prompt-compatible ladder cases offline", async () => {
  const perOp = 4,
    book = await buildCases({ perOp });
  assert.deepEqual(Object.keys(book).sort(), [...OPERATIONS].sort());
  for (const operation of OPERATIONS) {
    const cases = book[operation];
    assert.equal(cases.length, perOp, `${operation} case count`);
    assert.equal(
      new Set(cases.map((c) => c.id)).size,
      perOp,
      `${operation} unique ids`,
    );
    assert.equal(
      new Set(cases.map((c) => JSON.stringify(c.payload))).size,
      perOp,
      `${operation} distinct payloads`,
    );
    cases.forEach((c, index) => {
      assert.equal(c.operation, operation);
      assert.equal(c.id, `${operation}-${index + 1}`);
      assert.equal(typeof c.payload, "object");
      const prompt = buildPrompt(operation, c.payload);
      assert.equal(typeof prompt.system, "string", `${c.id} prompt system`);
      assert.equal(typeof prompt.user, "string", `${c.id} prompt user`);
      assert.ok(prompt.system.length > 0, `${c.id} prompt is not empty`);
      assert.ok(prompt.user.length > 0, `${c.id} prompt carries the payload`);
    });
  }
  const chatter = book["npc-chatter"];
  assert.ok(
    chatter.some(
      (c) =>
        ((c.payload.conversation as { turn?: number } | undefined)?.turn ??
          1) >= 2,
    ),
    "npc-chatter includes a later conversation turn",
  );
  const environment = book["review-environment"];
  assert.ok(
    environment.some((c) => !environmentEvidence(c).aligned),
    "review-environment includes misaligned learner evidence",
  );
  assert.ok(
    environment.some((c) => environmentEvidence(c).aligned),
    "review-environment includes aligned learner evidence",
  );
  assert.ok(
    environment.filter((c) => !environmentEvidence(c).aligned).length <=
      Math.ceil(perOp / 4),
    "at most one in four environment cases is misaligned",
  );
  for (const operation of OPERATIONS)
    for (const c of book[operation])
      assert.equal(
        JSON.stringify(c.payload).toLowerCase().includes("lorem"),
        false,
        `${c.id} contains placeholder text`,
      );
});
