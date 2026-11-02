// Retired: the ChatGPT catch-up worker through the handoff queue. The Claude
// gateway does not advertise "retrospective-group", so live catch-up is not
// offered. Depends on the shelved queue; not built here.
// @ts-expect-error Actual transport module is intentionally plain JavaScript.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Actual transport module is intentionally plain JavaScript.
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Actual transport module is intentionally plain JavaScript.
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";

test("actual local ChatGPT catch-up worker corrects the same claim, summarizes once and never receives private tutor context", async () => {
  const f = await fixture(),
    q = createHandoffQueue();
  const server = createStudyBridgeServer({
    handoff: createHandoffRoutes(q, { token: "synthetic-catchup-token" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`,
    original = globalThis.fetch;
  f.g.study.profile = "live";
  const learner = JSON.stringify(f.g.study.learner);
  f.e.tutor.push({
    id: "private-fixture",
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_CATCHUP_EXCLUDED",
    seq: ++f.g.seq,
    worldTime: 0,
    provenance: "study-mode",
  });
  f.e.history.push({
    seq: f.g.seq,
    at: 0,
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_CATCHUP_EXCLUDED",
    revision: f.e.revision,
  });
  globalThis.fetch = (url, options) =>
    original(new URL(String(url), base), {
      ...options,
      headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
    });
  const post = (body: unknown) =>
    original(base + "/api/handoff/worker", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic-catchup-token",
      },
      body: JSON.stringify(body),
    });
  try {
    q.enable(true);
    await checkBridge();
    const pending = openChat(f.g, f.e);
    let job: any;
    for (let n = 0; n < 100; n++) {
      job = await (
        await post({ action: "get", worker: "synthetic-catchup-worker" })
      ).json();
      if (job.operation) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.operation, "group");
    assert.equal(job.payload.mode, "catch-up");
    assert.equal(job.payload.provider, "chatgpt-handoff");
    assert.ok(
      !JSON.stringify(job.payload).includes("PRIVATE_CATCHUP_EXCLUDED"),
    );
    const good = answer(job.payload);
    for (const bad of [
      { ...good, sourceRevision: 999 },
      { ...good, messages: [{ ...good.messages[0], kind: "proposal" }] },
      { ...good, messages: [{ ...good.messages[0], refs: [-1] }] },
      { ...good, messages: [{ ...good.messages[0], author: "unselected" }] },
    ]) {
      assert.equal(
        (
          await post({
            action: "submit",
            worker: "synthetic-catchup-worker",
            jobId: job.jobId,
            claim: job.claim,
            answer: bad,
          })
        ).status,
        409,
      );
      const same = await (
        await post({ action: "get", worker: "synthetic-catchup-worker" })
      ).json();
      assert.equal(same.claim, job.claim);
    }
    assert.equal(
      (
        await post({
          action: "submit",
          worker: "synthetic-catchup-worker",
          jobId: job.jobId,
          claim: job.claim,
          answer: good,
        })
      ).status,
      200,
    );
    await pending;
    assert.equal(f.e.catchups![0].state, "applied", f.e.catchups![0].error);
    assert.equal(f.e.group[0].provenance, "chatgpt-handoff-catch-up");
    const shown = JSON.stringify(f.e.group);
    closeChat(f.g, f.e);
    await openChat(f.g, f.e);
    assert.equal(JSON.stringify(f.e.group), shown);
    assert.equal(q.snapshot().done, 1);
    assert.equal(q.snapshot().queued, 0);
    assert.equal(JSON.stringify(f.g.study.learner), learner);
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
