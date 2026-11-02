// Retired: discarding the queued ChatGPT critic receipt (DELETE
// /api/bridge/result). The Claude CLI request is aborted instead. Not built here.
test("pause, voices off and a new run discard the actual queued critic receipt", async (t) => {
  for (const reason of ["pause", "off", "new-run"] as const) {
    const f = fixture(),
      deleted: string[] = [],
      submitted: unknown[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "/api/status")
          return Response.json({
            mode: "claude-cli",
            label: "Synthetic relay",
            capabilities: ["npc-chatter", "npc-chatter-review"],
            detail: "Offline fixture",
          });
        if (url === "/api/bridge") {
          submitted.push(JSON.parse(String(init?.body)));
          return Response.json(
            {
              handoff: {
                id: "synthetic-review-job",
                hash: "synthetic-review-hash",
              },
            },
            { status: 202 },
          );
        }
        if (
          url.startsWith("/api/bridge/result?") &&
          init?.method === "DELETE"
        ) {
          deleted.push(url);
          return new Response(null, { status: 204 });
        }
        throw Error(`Unexpected synthetic transport request: ${url}`);
      },
    );
    await checkBridge();
    f.transport.review = (packet, signal, active) => {
      f.calls.reviews.push({ packet, signal, active });
      return npcVoiceTransport.review(packet, signal, active);
    };
    await dispatch(f);
    await answer(f);
    await until(() => submitted.length === 1);
    assert.equal(
      (submitted[0] as { operation: string }).operation,
      "npc-chatter-review",
    );
    if (reason === "pause") f.g.paused = true;
    if (reason === "off") f.g.settings.npcVoices = false;
    f.director.update(reason === "new-run" ? game() : f.g);
    await until(() => deleted.length === 1);
    assert.equal(
      deleted[0],
      "/api/bridge/result?id=synthetic-review-job&hash=synthetic-review-hash",
    );
    noSpeech(f);
    f.director.dispose();
    t.mock.restoreAll();
  }
});
