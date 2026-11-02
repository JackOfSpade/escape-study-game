// Retired: the ChatGPT unattended worker flow (handoff queue, worker routes,
// handoffAutonomous opt-in). The claude gateway never advertises
// "autonomous-work". Depends on the shelved queue; not built here.
test("actual ChatGPT unattended workflow requires both opt-ins, rejects late local revocation, holds server-revoked completion and explicitly retries exact NPC work", async () => {
  const f = fixture(),
    relay = await localHandoff(),
    original = globalThis.fetch;
  f.e.tutor.push({
    id: "secret-optin",
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_AUTONOMY_EXCLUDED",
    seq: ++f.g.seq,
    worldTime: 0,
    provenance: "study-mode",
  });
  f.e.history.push({
    seq: f.g.seq,
    author: "tutor",
    kind: "tutor",
    text: "PRIVATE_AUTONOMY_EXCLUDED",
    at: 0,
    revision: 0,
  });
  globalThis.fetch = (url, options) =>
    original(new URL(String(url), relay.base), {
      ...options,
      headers: { ...options?.headers, Origin: "http://127.0.0.1:5173" },
    });
  const worker = "synthetic-optional-worker";
  const post = (body: unknown) =>
    original(relay.base + "/api/handoff/worker", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer synthetic-optional-token",
      },
      body: JSON.stringify(body),
    });
  const next = async (operation: string) => {
    let job: any;
    for (let n = 0; n < 200; n++) {
      job = await (await post({ action: "get", worker })).json();
      if (job.operation) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(job.operation, operation);
    return job;
  };
  const answer = (job: any, value: unknown) =>
    post({
      action: "submit",
      worker,
      jobId: job.jobId,
      claim: job.claim,
      answer: value,
    });
  try {
    await checkBridge();
    f.g.settings.handoffAutonomous = true;
    assert.equal(
      autonomousNpcWork(f.g, r),
      undefined,
      "The local preference alone cannot grant server release",
    );
    relay.queue.setAutonomous(true);
    await checkBridge();
    f.g.settings.handoffAutonomous = false;
    assert.equal(
      autonomousNpcWork(f.g, r),
      undefined,
      "Server capability alone cannot opt this client in",
    );
    assert.equal(relay.queue.snapshot().queued, 0);
    f.g.settings.handoffAutonomous = true;
    const drafting = autonomousNpcWork(f.g, r),
      draft = await next("materialize-work");
    assert.equal(draft.payload.provider, "chatgpt-handoff");
    assert.equal(draft.payload.background, true);
    assert.ok(
      !JSON.stringify(draft.payload).includes("PRIVATE_AUTONOMY_EXCLUDED"),
    );
    // Local revocation takes effect before the server-control roundtrip.
    f.g.settings.handoffAutonomous = false;
    assert.equal((await answer(draft, reply(draft.payload))).status, 200);
    await drafting;
    assert.equal(f.e.materializations![0].state, "failed");
    assert.equal(f.e.proposals?.length ?? 0, 0);
    assert.equal(f.e.workspace, "abc");
    f.g.settings.handoffAutonomous = true;
    assert.equal(
      autonomousNpcWork(f.g, r),
      undefined,
      "Failed captured work is never automatically rerun",
    );
    assert.ok(claimStation(f.g, f.h, f.ss[0].id));
    await materializeObservedWork(f.g, f.e, true);
    assert.equal(
      f.e.materializations![0].state,
      "applied",
      f.e.materializations![0].error,
    );
    assert.equal(f.e.proposals![0].provider, "chatgpt-handoff");
    assert.equal(
      f.e.workspace,
      "abc",
      "Even ready candidates cannot interrupt the present human",
    );
    assert.equal(autonomousNpcWork(f.g, r), undefined);
    releaseStation(f.h);
    const completing = autonomousNpcWork(f.g, r),
      completion = await next("complete");
    assert.equal(f.e.workspace, "aBOUNDARYc");
    assert.equal(completion.payload.provider, "chatgpt-handoff");
    assert.equal(completion.payload.submitter, f.a.id);
    assert.equal(completion.payload.autonomyAllowed, true);
    assert.ok(
      !JSON.stringify(completion.payload).includes("PRIVATE_AUTONOMY_EXCLUDED"),
    );
    relay.queue.setAutonomous(false);
    const valid = {
      complete: true,
      feedback: "Synthetic NPC acceptance only",
      qualified: [f.a.id],
    };
    assert.equal((await answer(completion, valid)).status, 409);
    await completing;
    assert.equal(f.e.submissions[0].status, "error");
    assert.notEqual(f.e.state, "consumed");
    assert.equal(relay.queue.snapshot().heldAutonomous, 1);
    relay.queue.setAutonomous(true);
    await checkBridge();
    assert.equal(
      autonomousNpcWork(f.g, r),
      undefined,
      "A captured failed submission requires explicit retry",
    );
    const retry = retrySubmission(f.g, f.e, r, f.e.submissions[0].id),
      same = await next("complete");
    assert.equal(same.jobId, completion.jobId);
    assert.equal(same.requestHash, completion.requestHash);
    assert.deepEqual(same.payload, completion.payload);
    assert.notEqual(same.claim, completion.claim);
    assert.equal((await answer(same, valid)).status, 200);
    await retry;
    assert.equal(f.e.state, "consumed");
    assert.equal(f.e.submissions[0].author, f.a.id);
    assert.ok(f.a.access.includes(0));
    assert.ok(!f.h.access.includes(0));
    assert.equal(f.g.study.visits.length, 0);
    assert.equal(f.g.study.assessments.length, 0);
    assert.equal(f.g.study.learner!.evidence.length, 0);
    assert.equal(relay.queue.snapshot().done, 2);
  } finally {
    globalThis.fetch = async () =>
      Response.json({
        mode: "development",
        label: "fixture ended",
        detail: "",
        capabilities: [],
      });
    await checkBridge();
    globalThis.fetch = original;
    await relay.close();
  }
});
