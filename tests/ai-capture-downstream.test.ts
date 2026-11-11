import assert from "node:assert/strict";
import test from "node:test";
import { scopeKey } from "../src/learning-model";
import type { Contract } from "../src/model";
import { buildStudyCases } from "../scripts/ai-capture/build-study-cases";
import {
  ASSESS_ATTEMPT_NOTE,
  TUTOR_MESSAGE,
  buildDownstreamCases,
  problemFrom,
  type GenerateCase,
  type LadderRow,
} from "../scripts/ai-capture/build-downstream-cases";

const SETTING = "sonnet:medium";
const REP = 3;

/** One real generate case plus a generated answer shaped like a ladder row. */
const fixture = (async () => {
  const book = await buildStudyCases({ perOp: 1 });
  const generateCase = book.generate[0] as GenerateCase;
  const contract = generateCase.payload.contract as Contract;
  const objectiveId = contract.objectiveIds[0];
  const answer = {
    text: "Here is the question the generate arm wrote.",
    title: "Window totals in an inverter feed",
    prompt:
      "Write `window_totals(readings, size)` returning every full-window total. Keep one running total, and name the boundary that a naive version gets wrong.",
    starter:
      "def window_totals(readings: list[int], size: int) -> list[int]:\n    totals = []\n    running = 0\n    return totals\n",
    rubric: [
      "Keeps a running total of the last `size` readings.",
      "Adds the entering reading and removes the leaving one.",
      "Reports a total only once the window is full.",
    ],
    contract,
    scopeDefinitions: [
      {
        id: scopeKey(objectiveId, contract.depth),
        objectiveId,
        depth: contract.depth,
        sourceScope: "Window state and the moment a total is eligible.",
        facets: [
          {
            id: "core",
            description: "Window state and the moment a total is eligible.",
          },
          {
            id: "boundary",
            description:
              "Boundary: size one and size equal to the input length.",
          },
        ],
      },
    ],
    estimatedSolveSeconds: 300,
  };
  const row = (overrides: Record<string, unknown> = {}) => ({
    caseId: generateCase.id,
    operation: "generate",
    setting: SETTING,
    rep: REP,
    outcome: "valid",
    answers: [{ text: "An earlier answer from the same rep." }, answer],
    ...overrides,
  });
  return { generateCase, answer, row };
})();

test("downstream cases carry the generated problem exactly", async () => {
  const { generateCase, answer, row } = await fixture;
  const book = await buildDownstreamCases({
    rows: [row()],
    generateCases: [generateCase],
    setting: SETTING,
    rep: REP,
  });
  assert.deepEqual(book.skipped, []);
  assert.equal(book.tutor.length, 1);
  assert.equal(book.assess.length, 1);
  const tutor = book.tutor[0];
  const assess = book.assess[0];
  assert.equal(tutor.id, `tutor-from-${generateCase.id}`);
  assert.equal(assess.id, `assess-from-${generateCase.id}`);
  assert.equal(tutor.operation, "tutor");
  assert.equal(assess.operation, "assess");

  const expected = problemFrom(answer);
  assert.equal(expected.provenance, "claude-cli");
  assert.equal("text" in expected, false);
  const tutorProblem = tutor.payload.problem as Record<string, unknown>;
  assert.deepEqual(tutorProblem, expected);
  assert.equal(tutorProblem.title, answer.title);
  assert.equal(tutorProblem.prompt, answer.prompt);
  assert.equal(tutor.payload.prompt, TUTOR_MESSAGE);

  const packet = assess.payload.packet as Record<string, unknown>;
  const assessProblem = packet.problem as Record<string, unknown>;
  assert.deepEqual(assessProblem, expected);
  assert.equal(assessProblem.title, answer.title);
  assert.equal(assessProblem.prompt, answer.prompt);
  assert.deepEqual(packet.workspace, {
    content: `${answer.starter}\n${ASSESS_ATTEMPT_NOTE}\n`,
    revision: 1,
  });

  // Another arm at another setting and rep pairs by the same generate id.
  const other = await buildDownstreamCases({
    rows: [
      row({
        setting: "opus:high",
        rep: 7,
        answers: [{ ...answer, title: "A second title" }],
      }),
    ],
    generateCases: [generateCase],
    setting: "opus:high",
    rep: 7,
  });
  assert.deepEqual(
    other.tutor.map((c) => c.id),
    [tutor.id],
  );
  assert.deepEqual(
    other.assess.map((c) => c.id),
    [assess.id],
  );
  assert.equal(
    (other.tutor[0].payload.problem as Record<string, unknown>).title,
    "A second title",
  );
});

test("rows that are invalid or from another arm are skipped", async () => {
  const { generateCase, row } = await fixture;
  const cases: LadderRow[][] = [
    [row({ outcome: "invalid" }) as LadderRow],
    [row({ outcome: "incomplete" }) as LadderRow],
    [row({ setting: "opus:high" }) as LadderRow],
    [row({ rep: REP + 1 }) as LadderRow],
    [row({ operation: "tutor" }) as LadderRow],
    [],
  ];
  for (const rows of cases) {
    const book = await buildDownstreamCases({
      rows,
      generateCases: [generateCase],
      setting: SETTING,
      rep: REP,
    });
    assert.deepEqual(book.tutor, []);
    assert.deepEqual(book.assess, []);
    assert.deepEqual(book.skipped, [generateCase.id]);
  }
});

test("problemFrom allows an empty starter but rejects a missing one", async () => {
  const { answer } = await fixture;
  const conceptual = problemFrom({ ...answer, starter: "" });
  assert.equal(conceptual.starter, "");
  assert.equal(conceptual.provenance, "claude-cli");
  const { starter: _starter, ...withoutStarter } = answer;
  assert.throws(() => problemFrom(withoutStarter), /no starter/);
});
