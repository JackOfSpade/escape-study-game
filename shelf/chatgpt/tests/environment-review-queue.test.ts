// Retired: the ChatGPT ENV review through the handoff queue and worker routes.
// Depends on the shelved queue; not built here.
// @ts-expect-error Actual transport module is intentionally plain JavaScript.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Actual transport module is intentionally plain JavaScript.
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Actual transport module is intentionally plain JavaScript.
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";

test("actual loopback ChatGPT ENV queue accepts a corrected claim, applies only separate practical evidence and releases no job until enabled", async () => {
  const { g, o, l } = await fixture(),
    before = structuredClone(l);
  const q = createHandoffQueue(),
    server = createStudyBridgeServer({
      handoff: createHandoffRoutes(q, { token: "synthetic-env-transport" }),
    });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    original = globalThis.fetch;
  // Route actual client requests into this isolated relay; never the public bridge.
  globalThis.fetch = (url, options) =>
    original(new URL(String(url), base), {
      ...options,
      headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
    });
  let release!: EnvironmentReviewPayload;
  await reviewEnvironment(
    g,
    r,
    o.id,
    async (p) => {
      release = p;
      throw Error("capture only");
    },
    false,
    "chatgpt-handoff",
  );
  const post = (path: string, body: unknown, worker = false) =>
    original(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(worker
          ? { Authorization: "Bearer synthetic-env-transport" }
          : { Origin: "http://127.0.0.1:5173" }),
      },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (
        await post("/api/bridge", {
          operation: "review-environment",
          payload: release,
        })
      ).status,
      503,
    );
    assert.equal(q.snapshot().queued, 0);
    await post("/api/handoff/control", { action: "enable", enabled: true });
    await checkBridge();
    const status = await (await original(base + "/api/status")).json();
    assert.equal(status.mode, "chatgpt-handoff");
    assert.ok(status.capabilities.includes("review-environment"));
    const pending = reviewEnvironmentObservation(g, r, o.id, true);
    let job: any;
    for (let n = 0; n < 100; n++) {
      job = await (
        await post(
          "/api/handoff/worker",
          { action: "get", worker: "synthetic-env-worker" },
          true,
        )
      ).json();
      if (job.operation) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.operation, "review-environment");
    assert.deepEqual(job.payload, release);
    assert.match(job.instructions, /separate practical review/);
    const good = judgment(job.payload, "partially-observed");
    for (const bad of [
      { ...good, observationFingerprint: "other" },
      {
        ...good,
        reviewedOutputs: [
          { kind: "supplied-output", excerpt: "invented output" },
        ],
      },
      { ...good, classification: "observed" },
    ]) {
      const result = await post(
        "/api/handoff/worker",
        {
          action: "submit",
          worker: "synthetic-env-worker",
          jobId: job.jobId,
          claim: job.claim,
          answer: bad,
        },
        true,
      );
      assert.equal(result.status, 409);
      const same = await (
        await post(
          "/api/handoff/worker",
          { action: "get", worker: "synthetic-env-worker" },
          true,
        )
      ).json();
      assert.equal(same.jobId, job.jobId);
      assert.equal(same.claim, job.claim);
    }
    assert.equal(
      (
        await post(
          "/api/handoff/worker",
          {
            action: "submit",
            worker: "synthetic-env-worker",
            jobId: job.jobId,
            claim: job.claim,
            answer: good,
          },
          true,
        )
      ).status,
      200,
    );
    await pending;
    assert.equal(
      g.study.environmentReviews![0].state,
      "applied",
      g.study.environmentReviews![0].error,
    );
    assert.equal(l.environmentEvidence![0].provenance, "chatgpt-handoff");
    for (const key of [
      "cells",
      "attempts",
      "evidence",
      "sessions",
      "tracks",
      "cycle",
    ] as const)
      assert.deepEqual(l[key], before[key]);
    const restored = recover(decode(encode(g)));
    assert.deepEqual(
      restored.study.learner!.environmentEvidence,
      l.environmentEvidence,
    );
    const exported = await prepareRoadmapExport(r, restored.study.learner!);
    assert.ok(exported.content.includes(l.environmentEvidence![0].id));
    const summary = await (await original(base + "/api/handoff/status")).text();
    assert.ok(!summary.includes("SYNTHETIC_OUTPUT_SECRET"));
    assert.equal(q.snapshot().done, 1);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "fixture",
        detail: "fixture",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(resolve));
  }
});
