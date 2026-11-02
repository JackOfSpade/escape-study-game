// Only isolated fake IO plus the real queue; never the running/public bridge.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
// @ts-expect-error Diagnostic module intentionally uses plain JavaScript.
import * as probeModule from "../scripts/smoke-chatgpt-optional.mjs";
const { createOptionalProbe, optionalCheck } = probeModule;
// @ts-expect-error Diagnostic module intentionally uses plain JavaScript.
import * as semanticModule from "../scripts/smoke-chatgpt-boundaries.mjs";
const { createSemanticProbe, semanticBoundaryCheck } = semanticModule;
// @ts-expect-error Actual queue module.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
const source = readFileSync(
  "docs/evidence/chatgpt-optional-capabilities-plan.json",
  "utf8",
);
function harness(semantic = false) {
  const q = createHandoffQueue();
  let state: any,
    report: any,
    worker = false,
    scoped = false,
    prefix = "",
    stopFails = false,
    publishFails = false,
    uncertainValidation = false;
  const calls: { path: string; body: any }[] = [];
  const probe = (semantic ? createSemanticProbe : createOptionalProbe)({
    source: semantic
      ? readFileSync(
          "docs/evidence/chatgpt-semantic-boundaries-plan.json",
          "utf8",
        )
      : source,
    read: () => structuredClone(state),
    write: (s: any) => {
      state = structuredClone(s);
    },
    publish: (r: any) => {
      if (publishFails) throw Error("Synthetic disk outage");
      report = structuredClone(r);
    },
    uuid: () => "synthetic-probe-id",
    now: () => "2026-10-17T00:00:00Z",
    async call(path: string, body: any) {
      calls.push({ path, body: structuredClone(body) });
      if (path === "/api/handoff/status")
        return {
          status: 200,
          value: {
            ...q.snapshot(),
            public: {
              linked: true,
              workerActive: worker,
              workerScoped: scoped,
            },
            tunnel: { verified: true },
          },
        };
      if (path === "/api/status")
        return {
          status: 200,
          value: {
            mode: "chatgpt-handoff",
            capabilities: [
              "generate",
              "assess",
              "materialize-work",
              "group",
              "materialize-outcome",
              "complete",
              "review-environment",
            ],
          },
        };
      if (path === "/api/handoff/control") {
        if (body.action === "enable") q.enable(body.enabled);
        if (body.action === "worker") {
          worker = true;
          scoped = true;
          prefix = body.requestPrefix;
          return {
            status: 200,
            value: { session: "SYNTHETIC_PRIVATE_CODE_DO_NOT_PRINT" },
          };
        }
        if (body.action === "stop-worker") {
          if (stopFails) throw Error("Synthetic cleanup outage");
          worker = false;
          scoped = false;
          q.enable(false);
        }
        return { status: 200, value: {} };
      }
      if (path === "/api/bridge") {
        const receipt = q.enqueue(body.operation, body.payload);
        if (body.operation === "complete" && uncertainValidation) {
          uncertainValidation = false;
          throw Error("Synthetic lost receipt after enqueue");
        }
        return { status: 202, value: { handoff: receipt } };
      }
      const url = new URL(path, "http://synthetic.invalid"),
        result = q.result(
          url.searchParams.get("id"),
          url.searchParams.get("hash"),
        );
      return {
        status: result.status === "pending" ? 202 : 200,
        value: result.answer ?? { pending: true },
      };
    },
  });
  return {
    q,
    probe,
    calls,
    get state() {
      return state;
    },
    get report() {
      return report;
    },
    set stopFails(v: boolean) {
      stopFails = v;
    },
    set publishFails(v: boolean) {
      publishFails = v;
    },
    set uncertainValidation(v: boolean) {
      uncertainValidation = v;
    },
    next: () => q.get("synthetic-probe-worker", prefix),
  };
}
function reply(job: any) {
  const p = job.payload;
  if (job.operation === "materialize-work")
    return {
      requestId: p.requestId,
      sourceRevision: p.sourceRevision,
      notes: [
        {
          workId: p.work[0].id,
          author: p.work[0].actor,
          text: "Tentative recorded prefix review",
          refs: [p.work[0].seq],
        },
      ],
    };
  if (job.operation === "group")
    return {
      requestId: p.requestId,
      sourceRevision: p.sourceRevision,
      messages: [
        {
          author: p.speakers[0].id,
          kind: "observation",
          text: "Recorded conceptual work, shown now",
          refs: [p.range.refs[0]],
        },
      ],
    };
  if (job.operation === "materialize-outcome")
    return {
      requestId: p.requestId,
      problem: p.commitment.problem,
      solution:
        "The result is7; total equals the processed prefix sum. Empty input leaves zero.",
      authors: [p.speakers[0].id],
      refs: [p.commitment.work[0].seq],
      execution: "not-run",
    };
  if (job.operation === "complete")
    return {
      requestId: p.requestId,
      complete: true,
      feedback: "Synthetic independently reviewed fixture",
      execution: "not-run",
    };
  return {
    requestId: p.requestId,
    sourceHash: p.sourceHash,
    observationId: p.observation.id,
    observationFingerprint: p.observation.fingerprint,
    envId: p.definition.id,
    classification: "reported-exposure",
    learnerWork: false,
    learnerWorkQuote: "",
    reviewedOutputs: [],
    covered: [],
    remaining: ["No actual output"],
    completeScope: false,
    rationale: "Fictional discussion is not practical observation",
  };
}
function serve(h: ReturnType<typeof harness>) {
  const job = h.next();
  assert.equal(job.status, "served");
  h.q.submit("synthetic-probe-worker", job.jobId, job.claim, reply(job));
  return job;
}

test("preparation and missing approval cannot create a code, enable sharing or enqueue any request", async () => {
  const h = harness();
  assert.equal(h.probe.plan().requests, 5);
  assert.equal(h.calls.length, 0);
  await assert.rejects(h.probe.start(), /approval/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.state, undefined);
  const altered = createOptionalProbe({
    source: source + " ",
    read: () => undefined,
    write: () => assert.fail(),
    call: () => assert.fail(),
    publish: () => assert.fail(),
  });
  await assert.rejects(altered.start(true), /plan changed/);
  assert.equal(optionalCheck({ payload: {} }, null), false);
  assert.equal(
    optionalCheck(
      { operation: "materialize-work", payload: { requestId: "x" } },
      { requestId: "x", notes: [null] },
    ),
    false,
  );
});
test("isolated five-job pipeline scopes its worker, persists intent before effects, derives only the exact returned candidate and cleans without exporting its code", async () => {
  const h = harness();
  await h.probe.start(true);
  assert.equal(h.state.phase, "waiting");
  assert.equal(h.state.tasks.length, 4);
  const worker = h.calls.find((c) => c.body?.action === "worker")!;
  assert.equal(worker.body.requestPrefix, h.state.prefix);
  assert.equal(h.calls.filter((c) => c.path === "/api/bridge").length, 4);
  await assert.rejects(h.probe.start(true), /retained/);
  assert.deepEqual(await h.probe.advance(), { pending: true });
  for (let n = 0; n < 4; n++) serve(h);
  h.uncertainValidation = true;
  await assert.rejects(h.probe.advance(), /lost receipt/);
  assert.equal(h.state.tasks.length, 5);
  assert.equal(h.state.tasks[4].receipt, undefined);
  await h.probe.advance();
  const complete = h.state.tasks[4],
    candidate = h.state.answers["survivor-reconstruction"];
  assert.equal(complete.payload.solution, candidate.solution);
  assert.deepEqual(complete.payload.problem, candidate.problem);
  assert.deepEqual(await h.probe.finish(), {
    pending: true,
    received: 4,
    total: 5,
  });
  serve(h);
  assert.equal(h.q.snapshot().done, 5);
  await h.probe.advance();
  assert.equal(h.q.snapshot().done, 5);
  const result = await h.probe.finish();
  assert.equal(result.completed, true);
  assert.ok(result.checks.every((c: any) => c.limitedCheckPassed));
  assert.equal(h.state.session, undefined);
  assert.equal(h.state.phase, "finished");
  assert.equal(h.q.snapshot().enabled, false);
  assert.equal(h.q.snapshot().autonomousWork, false);
  assert.ok(!JSON.stringify(result).includes("SYNTHETIC_PRIVATE_CODE"));
  assert.ok(!JSON.stringify(h.report).includes("SYNTHETIC_PRIVATE_CODE"));
  const calls = h.calls.length;
  await h.probe.finish();
  assert.equal(h.calls.length, calls);
});
test("cleanup and report failures retain exact answers and recover without polling a disabled queue or minting another worker code", async () => {
  const h = harness();
  await h.probe.start(true);
  for (let n = 0; n < 4; n++) serve(h);
  await h.probe.advance();
  serve(h);
  h.stopFails = true;
  await assert.rejects(h.probe.finish(), /cleanup outage/);
  assert.equal(h.state.phase, "cleanup-required");
  assert.ok(h.state.session);
  assert.equal(Object.keys(h.state.answers).length, 5);
  h.stopFails = false;
  h.publishFails = true;
  await assert.rejects(h.probe.finish(), /disk outage/);
  assert.equal(h.state.phase, "cleaned");
  assert.equal(h.state.session, undefined);
  h.publishFails = false;
  await h.probe.finish();
  assert.equal(h.state.phase, "finished");
  assert.equal(h.calls.filter((c) => c.body?.action === "worker").length, 1);
  assert.equal(h.q.snapshot().done, 5);
});

test("static six-request semantic probe uses one scoped code, has no seventh derived request and retains raw responses for separate review", async () => {
  const h = harness(true);
  assert.equal(h.probe.plan().requests, 6);
  await assert.rejects(h.probe.start(), /approval/);
  assert.equal(h.calls.length, 0);
  await h.probe.start(true);
  assert.equal(h.state.tasks.length, 6);
  assert.ok(h.state.prefix.startsWith("semantic-boundary-smoke-"));
  await assert.rejects(h.probe.advance(), /no derived/);
  const fixtureAnswers: any[] = [];
  for (let i = 0; i < 6; i++) {
    const job = h.next();
    assert.equal(job.status, "served");
    const p = job.payload;
    let answer: any;
    if (job.operation === "generate")
      answer = {
        title: "Local fixture only",
        prompt: "Local fixture only",
        starter: "",
        rubric: ["Fixture"],
        contract: p.contract,
        scopeDefinitions: Object.values(p.existingScopeDefinitions),
      };
    else if (job.operation === "group")
      answer = {
        requestId: p.requestId,
        sourceRevision: p.sourceRevision,
        messages: [
          {
            author: p.speakers[0].id,
            kind: "question",
            text: "Local fixture only",
            refs: [2],
          },
        ],
      };
    else
      answer = {
        visitOutcome: "unresolved",
        scopeReviews: [],
        helpAttributions: [],
        findings: [
          {
            objectiveId: p.scopeDefinitions[0].objectiveId,
            depth: 1,
            facet: p.scopeDefinitions[0].facets[0].id,
            outcome: "unknown",
            evidence: [2],
            execution: "not-run",
            completeCheckpointScope: false,
            rationale: "Local fixture only",
          },
        ],
      };
    fixtureAnswers.push(answer);
    h.q.submit("synthetic-probe-worker", job.jobId, job.claim, answer);
  }
  const result = await h.probe.finish();
  assert.equal(result.completed, true);
  assert.equal(result.checks.length, 6);
  assert.ok(result.checks.every((c: any) => c.limitedCheckPassed));
  assert.equal(h.q.snapshot().done, 6);
  assert.equal(h.q.snapshot().enabled, false);
  assert.equal(h.state.session, undefined);
  assert.equal(h.calls.filter((c) => c.body?.action === "worker").length, 1);
  assert.equal(Object.keys(h.report.answers).length, fixtureAnswers.length);
  assert.ok(h.report.semanticReview.includes("Unreviewed"));
  assert.equal(
    semanticBoundaryCheck({ operation: "assess", payload: {} }, {}),
    false,
  );
  await assert.rejects(h.probe.start(true), /retained/);
});
