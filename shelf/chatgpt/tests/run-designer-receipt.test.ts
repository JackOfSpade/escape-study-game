// Retired: run-design queue receipts and explicit cancellation. Needs the
// shelved handoff queue and bridge-client (see RE-ENABLE.md); not built here.
test("a timed-out design preserves its receipt for explicit cancellation after reload", async (t) => {
  const originalFetch = globalThis.fetch,
    originalTimeout = AbortSignal.timeout;
  t.after(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  });
  AbortSignal.timeout = (ms) =>
    originalTimeout(ms === HANDOFF_TIMEOUT_MS ? 20 : ms);
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status")
      return Response.json({
        mode: "chatgpt-handoff",
        label: "Synthetic designer",
        detail: "Synthetic test only",
        capabilities: ["design-run"],
      });
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "retained-design", hash: "retained-hash" } },
        { status: 202 },
      );
    assert.equal(init?.method, "DELETE");
    return Response.json({ status: "discarded" });
  };
  await checkBridge();
  const draft = newDesignDraft("synthetic-run", 42, []),
    initial = structuredClone(draft),
    controller = new AbortController();
  let captured = "";
  await assert.rejects(
    prepareDesignedRun(draft, {
      signal: controller.signal,
      capture: (current) => {
        captured = JSON.stringify(current);
      },
      build: () => assert.fail("A pending design must not build a run"),
    }),
  );
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(
    calls.map((call) => call.method),
    ["POST"],
  );
  const restored = parseDesignDraft(JSON.parse(captured));
  assert.deepEqual(restored.request, initial.request);
  assert.equal(restored.chatCode, initial.chatCode);
  assert.deepEqual(restored.receipt, {
    requestId: initial.request.requestId,
    id: "retained-design",
    hash: "retained-hash",
  });
  assert.throws(
    () =>
      parseDesignDraft({
        ...restored,
        receipt: { ...restored.receipt, requestId: "design-unrelated" },
      }),
    /Invalid saved run-design receipt/,
  );
  await cancelDesignDraft(restored);
  assert.deepEqual(calls.at(-1), {
    url: "/api/bridge/result?id=retained-design&hash=retained-hash&operation=design-run",
    method: "DELETE",
  });
});
