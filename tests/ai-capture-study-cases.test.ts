import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { buildPrompt } from "../scripts/claude-gateway.mjs";
import { buildStudyCases } from "../scripts/ai-capture/build-study-cases";

const OPERATIONS = ["generate", "tutor", "assess"] as const;

test("study cases are varied, realistic and bridge-ready", async () => {
  const book = await buildStudyCases({ perOp: 6 });
  for (const operation of OPERATIONS) {
    const cases = book[operation];
    assert.equal(cases.length, 6);
    assert.equal(new Set(cases.map((c) => c.id)).size, 6);
    assert.equal(new Set(cases.map((c) => JSON.stringify(c.payload))).size, 6);
    for (const studyCase of cases) {
      assert.equal(studyCase.operation, operation);
      assert.doesNotThrow(() => buildPrompt(operation, studyCase.payload));
      assert.ok(
        !JSON.stringify(studyCase.payload).toLowerCase().includes("lorem"),
      );
    }
  }
  const contracts = book.generate.map((c) => c.payload.contract as any);
  const shapes = contracts.map((c) =>
    JSON.stringify([c.track, c.objectiveIds, c.depth, c.ledgerVersion]),
  );
  assert.equal(new Set(shapes).size, 6);
  assert.ok(new Set(contracts.map((c) => c.track)).size >= 2);
  const multiTurn = book.tutor.filter((c) => {
    const messages = c.payload.messages as { kind: string }[];
    return messages.filter((m) => m.kind === "human").length > 1;
  });
  assert.ok(multiTurn.length >= 1);
});
