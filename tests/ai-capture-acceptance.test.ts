import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAcceptanceCases,
  scoreAcceptance,
  TURNS,
} from "../scripts/ai-capture/build-acceptance-cases";

test("acceptance cases are real tutor requests with the verdict in the id", async () => {
  const cases = await buildAcceptanceCases();
  assert.equal(cases.length, TURNS.length);
  assert.ok(cases.some((c) => c.id.startsWith("accept-")));
  assert.ok(cases.filter((c) => c.id.startsWith("open-")).length >= 4);
  for (const c of cases) {
    assert.equal(c.operation, "tutor");
    const payload = c.payload as Record<string, any>;
    assert.equal(payload.mode, "terminal-dialogue");
    // The tutor sees the rubric as examples of evidence only.
    assert.equal("rubric" in payload.problem, false);
    assert.ok(payload.problem.evidenceExamples.length);
    assert.ok(payload.probe.facets.length);
    assert.equal(payload.messages.at(-1).kind, "human");
  }
  const disputed = cases.find((c) => c.id === "accept-disputed-wording")!;
  const messages = (disputed.payload as Record<string, any>).messages;
  assert.deepEqual(
    messages.map((m: { kind: string }) => m.kind),
    ["human", "tutor", "human"],
  );
  assert.deepEqual(messages[1].help.nudges, ["qualified-restatement"]);
});

test("scoring compares each reply with the verdict written beforehand", () => {
  const row = (caseId: string, answer: unknown, outcome = "valid") =>
    JSON.stringify({ caseId, outcome, answers: [answer] });
  const solved = { complete: true, outcome: "solved" };
  const scores = scoreAcceptance(
    [
      row("accept-a", solved),
      row("accept-a", { complete: false }),
      row("open-b", { complete: false }),
      // Conceding a gap is not acceptance.
      row("open-b", { complete: true, outcome: "gap" }),
      row("open-b", solved),
      row("accept-c", solved, "invalid"),
      row("tutor-1", solved),
      "not json",
    ].join("\n"),
  );
  assert.deepEqual(scores, [
    { id: "accept-a", expected: "accept", runs: 2, matched: 1, got: ["accept", "open"] }, // prettier-ignore
    { id: "open-b", expected: "open", runs: 3, matched: 2, got: ["open", "open", "accept"] }, // prettier-ignore
    { id: "accept-c", expected: "accept", runs: 1, matched: 0, got: ["invalid"] }, // prettier-ignore
  ]);
});

test("only the hint button turns the tutor's offer into an unlocked hint", async () => {
  const { checkBridge, offeredHelp, send } = await import("../src/ai");
  const { contractFor, encounterFor, gameFor, roadmap, withBridge } =
    await import("../scripts/ai-capture/build-study-cases");
  const question = TURNS.find((t) => t.id.startsWith("open-recomputes"))!;
  const run = async (acceptHint: boolean) => {
    const r = roadmap();
    const g = gameFor(20261950, r);
    const e = encounterFor(g, 0);
    const contract = contractFor(g, r, question.question as never, 1, 0);
    e.problem = {
      title: "Synthetic",
      prompt: question.question.prompt,
      starter: "",
      rubric: question.question.rubric,
      provenance: "claude-cli",
      contract,
      scopeDefinitions: [
        {
          id: `${contract.objectiveIds[0]}/D1`,
          objectiveId: contract.objectiveIds[0],
          depth: 1,
          sourceScope: "Synthetic scope",
          facets: question.question.facets,
        },
      ],
    };
    const payloads: Record<string, any>[] = [];
    await withBridge(
      (operation, payload) => {
        if (operation === "tutor") payloads.push(payload);
        return {
          help: { nudges: [], hints: [], gives: [], offers: ["running-total"] },
          text: "The next hint will be recorded as answered with a hint. Do you want it?",
          complete: false,
        };
      },
      async () => {
        await checkBridge();
        await send(g, e, "Synthetic first attempt", r);
        assert.deepEqual(offeredHelp(e), ["running-total"]);
        await send(g, e, "Yes, give me a hint.", r, acceptHint);
      },
    );
    return { second: payloads[1], learner: e.tutor.filter((m) => m.kind === "human").at(-1)! }; // prettier-ignore
  };
  const typed = await run(false);
  assert.deepEqual(typed.second.helpPolicy, { unlocked: [] });
  assert.equal("accepts" in typed.learner, false);
  const pressed = await run(true);
  assert.deepEqual(pressed.second.helpPolicy, { unlocked: ["running-total"] });
  assert.deepEqual(pressed.learner.accepts, ["running-total"]);
});
