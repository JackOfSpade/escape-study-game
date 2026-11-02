import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error The diagnostic CLI exports pure answer and receipt checkers.
import * as probe from "../scripts/smoke-chatgpt-curriculum.mjs";
// @ts-expect-error Actual isolated queue transport.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Actual isolated queue transport.
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Actual isolated queue transport.
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";
const { evaluateCurriculumProbe, handoffReceipt } = probe;
const plan = JSON.parse(
  readFileSync("docs/evidence/chatgpt-curriculum-quality-plan.json", "utf8"),
);
const scope = plan.tasks[1].payload.scopeDefinitions[0];
function assessment(outcome: string) {
  return {
    findings: scope.facets.map((f: { id: string }) => ({
      objectiveId: scope.objectiveId,
      depth: 1,
      facet: f.id,
      outcome,
      evidence: [2],
      completeCheckpointScope: false,
      execution: "not-run",
      rationale: "Controlled checker fixture, not actual model output.",
    })),
    visitOutcome: "usable",
    scopeReviews: [
      {
        id: scope.id,
        completeCoverage: true,
        rationale: "Controlled source projection.",
      },
    ],
    helpAttributions: [] as {
      messageId: string;
      facets: string[];
      rationale: string;
    }[],
  };
}
test("curriculum quality diagnostic permits D1 explanation without execution, but not copied or incorrect independent credit", () => {
  const independent = assessment("independent");
  assert.equal(evaluateCurriculumProbe(plan.tasks[1], independent), true);
  assert.equal(evaluateCurriculumProbe(plan.tasks[2], independent), false);
  assert.equal(evaluateCurriculumProbe(plan.tasks[3], independent), false);
  const assisted = assessment("assisted");
  assisted.helpAttributions.push({
    messageId: "fictional-tutor-help",
    facets: ["*"],
    rationale: "Supplied before the response.",
  });
  assert.equal(evaluateCurriculumProbe(plan.tasks[2], assisted), true);
  const incorrect = assessment("contradicted");
  assert.equal(evaluateCurriculumProbe(plan.tasks[3], incorrect), true);
});
test("curriculum diagnostic rejects unrelated scope, fabricated execution, duplicate facets and malformed provider output", () => {
  for (const change of [
    (a: any) => (a.findings[0].objectiveId = "PY:T99.1"),
    (a: any) => (a.findings[0].execution = "passed"),
    (a: any) => (a.findings[0].evidence = [999]),
    (a: any) => a.findings.push(a.findings[0]),
    (a: any) => a.findings.splice(0, 1),
    (a: any) => (a.scopeReviews[0].completeCoverage = false),
    (a: any) => (a.findings[0] = null),
  ]) {
    const answer = assessment("independent");
    change(answer);
    assert.equal(evaluateCurriculumProbe(plan.tasks[1], answer), false);
  }
  for (const value of [null, {}, [], { findings: [null] }])
    assert.equal(evaluateCurriculumProbe(plan.tasks[1], value), false);
});
test("generation checker preserves frozen D1 source facets and disallows invented runtime requirements", () => {
  const task = plan.tasks[0],
    answer = {
      title: "Controlled question",
      prompt: "Explain a new window trace",
      starter: "",
      rubric: ["D1 state reasoning"],
      contract: structuredClone(task.payload.contract),
      scopeDefinitions: Object.values(task.payload.existingScopeDefinitions),
    };
  assert.equal(evaluateCurriculumProbe(task, answer), true);
  const runtime = { ...answer, runtime: { language: "python" } };
  assert.equal(evaluateCurriculumProbe(task, runtime), false);
  const escalated = structuredClone(answer);
  escalated.contract.depth = 2;
  assert.equal(evaluateCurriculumProbe(task, escalated), false);
});
test(
  "preparation and missing-approval rejection cannot create private worker state or access the relay",
  { skip: existsSync(".local/chatgpt-handoff/curriculum-quality-smoke.json") },
  () => {
    const file = ".local/chatgpt-handoff/curriculum-quality-smoke.json";
    const metadata = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/smoke-chatgpt-curriculum.mjs", "plan"],
        { encoding: "utf8" },
      ),
    );
    assert.equal(metadata.released, false);
    assert.equal(metadata.accessCodePrinted, false);
    const rejected = spawnSync(
      process.execPath,
      ["scripts/smoke-chatgpt-curriculum.mjs", "start"],
      { encoding: "utf8" },
    );
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /Obtain explicit approval/);
    assert.equal(existsSync(file), false);
  },
);

test("diagnostic consumes actual HTTP queue receipts and re-enqueues the identical packet without another job", async () => {
  const queue = createHandoffQueue();
  queue.enable(true);
  const server = createStudyBridgeServer({
    handoff: createHandoffRoutes(queue),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const post = () =>
      fetch(`http://127.0.0.1:${address.port}/api/bridge`, {
        method: "POST",
        headers: {
          Origin: "http://127.0.0.1:5173",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation: "generate",
          payload: {
            ...plan.tasks[0].payload,
            requestId: "controlled-receipt-only",
            sessionId: "controlled-diagnostic",
          },
        }),
      });
    const first = await post();
    assert.equal(first.status, 202);
    const receipt = handoffReceipt(await first.json());
    assert.deepEqual(handoffReceipt(await (await post()).json()), receipt);
    assert.equal(queue.snapshot().queued, 1);
    assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");
    assert.throws(
      () => handoffReceipt({ id: receipt.id, hash: receipt.hash }),
      /exact handoff receipt/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
