import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  BRIDGE_OUTAGE_GRACE_MS,
  bridgeRequest,
  checkBridge,
  nativeStudyScope,
  status,
  studyChatCode,
} from "../src/bridge-client";
const reply = (mode = "study-mode") =>
  Response.json({
    mode,
    label: "Synthetic bridge",
    capabilities: ["generate"],
    detail: "Local fixture only",
  });
/** AbortSignal.timeout timers do not hold the event loop open, so a test
 * waiting only on one must keep the loop alive until its deadline fires. */
function holdEventLoop(t: TestContext) {
  const timer = setInterval(() => {}, 1000);
  t.after(() => clearInterval(timer));
}
test("overlapping bridge checks cannot let an old failure replace a newer connection", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let fail!: (error: Error) => void,
    calls = 0;
  globalThis.fetch = async (_url, init) => {
    assert.ok(init?.signal instanceof AbortSignal);
    if (calls++ === 0)
      return new Promise<Response>((_resolve, reject) => {
        fail = reject;
      });
    return reply();
  };
  const older = checkBridge();
  await checkBridge();
  fail(Error("Old request failed"));
  await older;
  assert.equal(status().mode, "study-mode");
});

test("native routing scope stays outside frozen content and follows the archived run", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const nativeScope = nativeStudyScope(
    { id: "new-run" },
    { id: "station-a", runId: "original-run", questionRoom: "room-one" },
  );
  assert.deepEqual(nativeScope, {
    runId: "original-run",
    encounterId: "station-a",
    questionRoom: "room-one",
  });
  assert.deepEqual(nativeStudyScope({ id: "new-run" }, { id: "station-b" }), {
    runId: "new-run",
    encounterId: "station-b",
  });
  const payload = { requestId: "captured", packet: { encounter: "station-a" } };
  const frozen = JSON.stringify(payload);
  for (const provider of ["chatgpt-handoff", "study-mode"]) {
    globalThis.fetch = async (url, init) => {
      if (url === "/api/status") return reply(provider);
      assert.equal(url, "/api/bridge");
      const body = JSON.parse(String(init?.body));
      assert.equal(JSON.stringify(body.payload), frozen);
      assert.deepEqual(
        body.nativeScope,
        provider === "chatgpt-handoff" ? nativeScope : undefined,
      );
      return Response.json({ accepted: true });
    };
    await checkBridge();
    assert.deepEqual(
      await bridgeRequest("assess", payload, undefined, { nativeScope }),
      { accepted: true },
    );
  }
  assert.equal(JSON.stringify(payload), frozen);
});
test("malformed bridge capabilities fail closed without retaining a native identity", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [
    null,
    {},
    { mode: "study-mode", label: "fake", detail: "bad", capabilities: [42] },
  ]) {
    globalThis.fetch = async () => Response.json(body);
    await checkBridge();
    assert.equal(status().mode, "development");
  }
});
test("queued bridge transport preserves the original provider and receipt when connection status changes", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let mode = "chatgpt-handoff",
    requests = 0;
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply(mode);
    if (url === "/api/bridge") {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        operation: "tutor",
        payload: { question: "fictional" },
        provider: "chatgpt-handoff",
      });
      mode = "development";
      return Response.json(
        { handoff: { id: "id /#", hash: "hash ?/#" } },
        { status: 202 },
      );
    }
    const query = new URL(String(url), "http://fixture").searchParams;
    assert.equal(query.get("id"), "id /#");
    assert.equal(query.get("hash"), "hash ?/#");
    requests++;
    return Response.json({ answer: "fixture reply" });
  };
  await checkBridge();
  const pending = bridgeRequest("tutor", { question: "fictional" });
  await checkBridge();
  assert.deepEqual(await pending, { answer: "fixture reply" });
  assert.equal(requests, 1);
  assert.equal(status().mode, "development");
});

test("queued tutor progress distinguishes an unclaimed request from worker pickup without changing the frozen request", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const progress: string[] = [];
  let polls = 0;
  let health = 0;
  const captured = {
    requestId: "synthetic-phase-check",
    prompt: "@study\nSynthetic",
  };
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge") {
      assert.deepEqual(JSON.parse(String(init?.body)).payload, captured);
      return Response.json(
        { handoff: { id: "phase-job", hash: "phase-hash" } },
        { status: 202 },
      );
    }
    if (url === "/api/handoff/status") {
      health++;
      return Response.json({
        recent: [{ id: "phase-job", status: "working" }],
      });
    }
    const query = new URL(String(url), "http://synthetic").searchParams;
    assert.equal(query.get("id"), "phase-job");
    assert.equal(query.get("hash"), "phase-hash");
    return ++polls === 1
      ? Response.json({ status: "pending" }, { status: 202 })
      : Response.json({ text: "Synthetic follow-up", complete: false });
  };
  await checkBridge();
  assert.deepEqual(
    await bridgeRequest("tutor", captured, (p) => progress.push(p)),
    { text: "Synthetic follow-up", complete: false },
  );
  assert.deepEqual(progress, ["queued", "working"]);
  assert.equal(health, 1);
});

test("design progress uses its exact receipt even outside the recent-job window", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const progress: string[] = [];
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "exact", hash: "saved" } },
        { status: 202 },
      );
    if (url === "/api/handoff/status")
      return Response.json({
        recent: [{ id: "unrelated", status: "working" }],
      });
    return ++polls === 1
      ? Response.json(
          {
            handoff: {
              id: "exact",
              status: "working",
              lastWorkerActivityAt: Date.now(),
            },
          },
          { status: 202 },
        )
      : Response.json({ accepted: true });
  };
  await checkBridge();
  assert.deepEqual(
    await bridgeRequest("design-run", { requestId: "exact" }, (p) =>
      progress.push(p),
    ),
    { accepted: true },
  );
  assert.deepEqual(progress, ["queued", "working"]);
});

test("old design claims show stalled until actual worker activity resumes, including older relays", async (t) => {
  const original = globalThis.fetch,
    originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = original;
    Date.now = originalNow;
  });
  for (const exact of [true, false]) {
    let now = 1_000_000,
      polls = 0;
    Date.now = () => now;
    const progress: string[] = [];
    const metadata = () => ({
      id: "stale",
      status: "working",
      claimedAt: 1,
      ...(polls > 1 ? { lastWorkerActivityAt: now } : {}),
    });
    globalThis.fetch = async (url) => {
      if (url === "/api/status") return reply("chatgpt-handoff");
      if (url === "/api/bridge")
        return Response.json(
          { handoff: { id: "stale", hash: "saved" } },
          { status: 202 },
        );
      if (url === "/api/handoff/status")
        return Response.json({
          recent: [metadata()],
          public: { terminalRelay: { activeSessions: 1 } },
        });
      polls++;
      now += 2001;
      return polls < 3
        ? Response.json(
            exact ? { handoff: metadata() } : { status: "pending" },
            { status: 202 },
          )
        : Response.json({ accepted: true });
    };
    await checkBridge();
    assert.deepEqual(
      await bridgeRequest("design-run", { requestId: "stale" }, (p) =>
        progress.push(p),
      ),
      { accepted: true },
    );
    assert.deepEqual(progress, ["queued", "stalled", "working"]);
  }
});

test("a suspended page cannot extend a handoff deadline and its exact request stays retained", async (t) => {
  const original = globalThis.fetch,
    originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = original;
    Date.now = originalNow;
  });
  let now = 1_000_000,
    polls = 0;
  Date.now = () => now;
  const methods: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    methods.push(init?.method ?? "GET");
    if (url === "/api/bridge") {
      now += 31 * 60_000;
      return Response.json(
        { handoff: { id: "retained", hash: "saved" } },
        { status: 202 },
      );
    }
    polls++;
    return Response.json({ accepted: true });
  };
  await checkBridge();
  await assert.rejects(
    bridgeRequest("design-run", { requestId: "retained" }),
    /timed out.*saved/i,
  );
  assert.equal(polls, 0);
  assert.deepEqual(methods, ["POST"]);
});

test("a queued request keeps waiting through a relay restart and only gives up after the grace period", async (t) => {
  const original = globalThis.fetch,
    originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = original;
    Date.now = originalNow;
  });
  // Restart: a dropped connection, a proxy 502 and unparseable output, then the answer.
  const outage: (() => Promise<Response>)[] = [
    async () => Response.json({ status: "pending" }, { status: 202 }),
    async () => {
      throw TypeError("fetch failed");
    },
    async () => new Response("Bad gateway", { status: 502 }),
    async () => new Response("<html>", { status: 200 }),
    async () => Response.json({ text: "Back", complete: false }),
  ];
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "j", hash: "h" } },
        { status: 202 },
      );
    if (String(url).startsWith("/api/handoff/status"))
      return Response.json({
        public: { terminalRelay: { activeSessions: 1 } },
      });
    return outage[polls++]();
  };
  await checkBridge();
  assert.deepEqual(await bridgeRequest("tutor", { question: "q" }), {
    text: "Back",
    complete: false,
  });
  assert.equal(polls, outage.length);

  // A relay that never comes back fails once the grace period has passed.
  let now = 1_000_000;
  Date.now = () => now;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "j", hash: "h" } },
        { status: 202 },
      );
    now += BRIDGE_OUTAGE_GRACE_MS / 2 + 1;
    throw TypeError("fetch failed");
  };
  await assert.rejects(
    bridgeRequest("tutor", { question: "q" }),
    /stopped answering; your exact request is saved/,
  );
});

test("a closed study session stops renewing its queued relay job", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let active = true;
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (String(url).startsWith("/api/bridge/result")) {
      polls++;
      return Response.json({ status: "pending" }, { status: 202 });
    }
    active = false;
    return Response.json(
      { handoff: { id: "closed", hash: "captured" } },
      { status: 202 },
    );
  };
  await checkBridge();
  await assert.rejects(
    bridgeRequest("tutor", { requestId: "closed" }, undefined, {
      isActive: () => active,
    }),
    /session closed/,
  );
  assert.equal(polls, 0);
});

test("malformed relay metadata cannot claim an active study listener", async () => {
  const { relayServes } = await import("../src/bridge-client");
  for (const info of [
    null,
    [],
    { public: { terminalRelay: { activeSessions: "2" } } },
    { public: { terminalRelay: { activeSessions: Infinity } } },
    { public: { terminalRelay: { activeSessions: true } } },
  ])
    assert.equal(relayServes(info), false);
  assert.equal(
    relayServes({ public: { terminalRelay: { sessions: 2 } } }),
    true,
  );
  assert.equal(relayServes({ public: { workerActive: true } }), true);
});

test("invalid bridge response bodies report a protocol error instead of a property access failure", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [null, [], "invalid"]) {
    globalThis.fetch = async (url) =>
      url === "/api/status"
        ? reply("chatgpt-handoff")
        : Response.json(body, { status: 202 });
    await checkBridge();
    await assert.rejects(
      bridgeRequest("tutor", {}),
      /Invalid queued bridge receipt|Malformed bridge response/,
    );
  }
});

test("a session already closed before submission never releases a bridge request", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({});
  };
  await assert.rejects(
    bridgeRequest("tutor", {}, undefined, { isActive: () => false }),
    /session closed/,
  );
  assert.equal(calls, 0);
});

test("successful non-JSON replies reject while HTTP errors preserve the bridge's message", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () => new Response("<html>Proxy page</html>");
  await assert.rejects(bridgeRequest("tutor", {}), /Malformed bridge response/);
  globalThis.fetch = async () =>
    new Response("Synthetic service failure", { status: 503 });
  await assert.rejects(
    bridgeRequest("tutor", {}),
    /study bridge is not running/,
  );
  globalThis.fetch = async () =>
    new Response("Synthetic request refusal", { status: 400 });
  await assert.rejects(bridgeRequest("tutor", {}), /Synthetic request refusal/);
});

test("hung result polls have a short deadline and exhaust the outage grace instead of waiting for the whole conversation budget", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    Date.now = originalNow;
  });
  holdEventLoop(t);
  let now = 1000,
    polls = 0;
  Date.now = () => now;
  AbortSignal.timeout = (ms) => originalTimeout(ms === 5000 ? 10 : ms);
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "hung", hash: "saved" } },
        { status: 202 },
      );
    polls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => {
          now += BRIDGE_OUTAGE_GRACE_MS + 1;
          reject(init!.signal!.reason);
        },
        { once: true },
      );
    });
  };
  await checkBridge();
  await assert.rejects(bridgeRequest("tutor", {}), /stopped answering/);
  assert.equal(polls, 2);
});

test("queued HTTP refusals retain their plain-text reason without waiting through an outage grace", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let polls = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "saved", hash: "captured" } },
        { status: 202 },
      );
    polls++;
    if (polls > 1)
      return Response.json({ error: "unexpected retry" }, { status: 400 });
    return new Response("Synthetic stale question refusal", { status: 409 });
  };
  await checkBridge();
  await assert.rejects(
    bridgeRequest("tutor", {}),
    /Synthetic stale question refusal/,
  );
  assert.equal(polls, 1);
});

test("empty queued receipt identities fail before polling", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const receipt of [
    { id: "", hash: "h" },
    { id: "i", hash: " " },
  ]) {
    let polls = 0;
    globalThis.fetch = async (url) => {
      if (url === "/api/status") return reply("chatgpt-handoff");
      if (url === "/api/bridge")
        return Response.json({ handoff: receipt }, { status: 202 });
      polls++;
      return Response.json({ error: "unexpected poll" }, { status: 400 });
    };
    await checkBridge();
    await assert.rejects(
      bridgeRequest("tutor", {}),
      /Invalid queued bridge receipt/,
    );
    assert.equal(polls, 0);
  }
});

test("a lost handoff acknowledgement retries the identical released request before polling its original receipt", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bodies: string[] = [];
  const progress: string[] = [];
  let polls = 0;
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    if (url === "/api/bridge") {
      bodies.push(String(init?.body));
      // The relay can persist this request even when its acknowledgement is lost.
      if (bodies.length === 1) throw TypeError("Connection lost after enqueue");
      assert.equal(bodies[1], bodies[0]);
      return Response.json(
        { handoff: { id: "original-job", hash: "original-hash" } },
        { status: 202 },
      );
    }
    polls++;
    const query = new URL(String(url), "http://fixture").searchParams;
    assert.equal(query.get("id"), "original-job");
    assert.equal(query.get("hash"), "original-hash");
    return Response.json({ answer: "Recovered reply" });
  };
  await checkBridge();
  assert.deepEqual(
    await bridgeRequest(
      "tutor",
      { requestId: "synthetic-lost-ack", question: "Immutable question" },
      (phase) => progress.push(phase),
      {
        nativeScope: { runId: "synthetic-run", encounterId: "synthetic-task" },
      },
    ),
    { answer: "Recovered reply" },
  );
  assert.equal(bodies.length, 2);
  assert.equal(polls, 1);
  assert.deepEqual(progress, ["unknown", "queued"]);
});

test("a hung initial handoff submission has a short deadline and stops retrying after its outage grace", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const originalNow = Date.now;
  t.after(() => {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
    Date.now = originalNow;
  });
  holdEventLoop(t);
  let now = 1000,
    posts = 0;
  Date.now = () => now;
  AbortSignal.timeout = (ms) => originalTimeout(ms === 5000 ? 10 : ms);
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    assert.equal(url, "/api/bridge");
    posts++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => {
          now += BRIDGE_OUTAGE_GRACE_MS + 1;
          reject(init!.signal!.reason);
        },
        { once: true },
      );
    });
  };
  await checkBridge();
  await assert.rejects(
    bridgeRequest("tutor", { requestId: "synthetic-hung-post" }),
    /stopped answering; your exact request is saved/,
  );
  assert.equal(posts, 2);
});

test("handoff submission refusals and non-handoff failures are never automatically resubmitted", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const mode of ["chatgpt-handoff", "study-mode"]) {
    let posts = 0;
    globalThis.fetch = async (url) => {
      if (url === "/api/status") return reply(mode);
      posts++;
      if (mode === "study-mode") throw TypeError("Connection lost");
      return new Response("This chat is disconnected", { status: 409 });
    };
    await checkBridge();
    await assert.rejects(
      bridgeRequest("tutor", { requestId: "synthetic-refusal" }),
      mode === "study-mode" ? /Connection lost/ : /chat is disconnected/,
    );
    assert.equal(posts, 1);
  }
});

test("an invalid initial handoff response is reported without resubmitting the question", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let posts = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    posts++;
    return Response.json(["Malformed completion"]);
  };
  await checkBridge();
  await assert.rejects(
    bridgeRequest("tutor", { requestId: "synthetic-invalid-completion" }),
    /Malformed bridge response/,
  );
  assert.equal(posts, 1);
});

test("a structured handoff refusal is definitive even with a gateway status", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let posts = 0;
  globalThis.fetch = async (url) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    posts++;
    return posts === 1
      ? Response.json({ error: "Controlled outage" }, { status: 503 })
      : Response.json({ error: "Unexpected retry" }, { status: 400 });
  };
  await checkBridge();
  await assert.rejects(
    bridgeRequest("tutor", { requestId: "synthetic-service-refusal" }),
    /Controlled outage/,
  );
  assert.equal(posts, 1);
});

test("a gateway HTML response retries the same handoff submission", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const bodies: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    bodies.push(String(init?.body));
    if (bodies.length === 1)
      return new Response("<html>Bad gateway</html>", { status: 502 });
    assert.equal(bodies[1], bodies[0]);
    return Response.json({ answer: "Recovered after proxy restart" });
  };
  await checkBridge();
  assert.deepEqual(
    await bridgeRequest("tutor", { requestId: "synthetic-proxy-restart" }),
    { answer: "Recovered after proxy restart" },
  );
  assert.equal(bodies.length, 2);
});

test("cancelling an ambient queued request aborts its wait and discards only that exact temporary receipt", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  for (const operation of ["npc-chatter", "npc-chatter-review"]) {
    const calls: { url: string; method: string }[] = [];
    globalThis.fetch = async (url, init) => {
      if (url === "/api/status") return reply("chatgpt-handoff");
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      if (url === "/api/bridge")
        return Response.json(
          { handoff: { id: "temporary-job", hash: "temporary-hash" } },
          { status: 202 },
        );
      assert.equal(init?.method, "DELETE");
      return Response.json({ status: "discarded" });
    };
    await checkBridge();
    const controller = new AbortController();
    await assert.rejects(
      bridgeRequest(
        operation,
        { requestId: "temporary-request" },
        () => controller.abort(),
        { signal: controller.signal, timeoutMs: 3000 },
      ),
    );
    assert.deepEqual(calls, [
      { url: "/api/bridge", method: "POST" },
      {
        url: "/api/bridge/result?id=temporary-job&hash=temporary-hash",
        method: "DELETE",
      },
    ]);
  }
});

test("a consumed ambient result is discarded while an ordinary study receipt is retained", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  for (const operation of ["npc-chatter", "npc-chatter-review", "generate"]) {
    const methods: string[] = [];
    globalThis.fetch = async (url, init) => {
      if (url === "/api/status") return reply("chatgpt-handoff");
      methods.push(init?.method ?? "GET");
      if (url === "/api/bridge")
        return Response.json(
          { handoff: { id: "bound-job", hash: "bound-hash" } },
          { status: 202 },
        );
      return Response.json(
        init?.method === "DELETE"
          ? { status: "discarded" }
          : { text: "Stay close to the stairs." },
      );
    };
    await checkBridge();
    assert.deepEqual(await bridgeRequest(operation, { requestId: operation }), {
      text: "Stay close to the stairs.",
    });
    assert.deepEqual(
      methods,
      operation === "generate" ? ["POST", "GET"] : ["POST", "GET", "DELETE"],
    );
  }
});

test("explicit run-design cancellation discards only its exact receipt", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const calls: { url: string; method: string }[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "design-job", hash: "design-hash" } },
        { status: 202 },
      );
    assert.equal(init?.method, "DELETE");
    return Response.json({ status: "discarded" });
  };
  await checkBridge();
  const controller = new AbortController();
  await assert.rejects(
    bridgeRequest(
      "design-run",
      { requestId: "design-request" },
      () => controller.abort(),
      {
        signal: controller.signal,
        nativeScope: { runId: "generation-one", encounterId: "run-design" },
      },
    ),
  );
  assert.deepEqual(calls, [
    { url: "/api/bridge", method: "POST" },
    {
      url: "/api/bridge/result?id=design-job&hash=design-hash&operation=design-run",
      method: "DELETE",
    },
  ]);
});

test("a design generation routes through its captured chat without rotating the study chat", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const studyCode = studyChatCode(),
    sent: Record<string, unknown>[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ accepted: true });
  };
  await checkBridge();
  await bridgeRequest("design-run", { requestId: "design-one" }, undefined, {
    nativeScope: { runId: "generation-one", encounterId: "run-design" },
    chatCode: "DESIGN01",
  });
  assert.equal(sent[0].chatCode, "DESIGN01");
  assert.equal(studyChatCode(), studyCode);
  await bridgeRequest("generate", { requestId: "study-one" }, undefined, {
    nativeScope: { runId: "run-one", encounterId: "terminal-one" },
  });
  assert.equal(sent[1].chatCode, studyCode);
  await assert.rejects(
    bridgeRequest("design-run", { requestId: "invalid" }, undefined, {
      nativeScope: { runId: "generation-one", encounterId: "run-design" },
      chatCode: "invalid chat code",
    }),
    /Invalid captured handoff chat code/,
  );
  assert.equal(sent.length, 2);
});

test("run-design deadlines retain the exact queued request and completed designs are retained", async (t) => {
  holdEventLoop(t);
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const methods: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (url === "/api/status") return reply("chatgpt-handoff");
    methods.push(init?.method ?? "GET");
    if (url === "/api/bridge")
      return Response.json(
        { handoff: { id: "retained-design", hash: "retained-hash" } },
        { status: 202 },
      );
    return Response.json({ requestId: "retained", design: { version: 1 } });
  };
  await checkBridge();
  const controller = new AbortController();
  await assert.rejects(
    bridgeRequest("design-run", { requestId: "retained" }, undefined, {
      signal: controller.signal,
      timeoutMs: 20,
    }),
  );
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(methods, ["POST"]);
  methods.length = 0;
  assert.deepEqual(
    await bridgeRequest("design-run", { requestId: "retained" }),
    { requestId: "retained", design: { version: 1 } },
  );
  assert.deepEqual(methods, ["POST", "GET"]);
});

test("a streaming reply reports its text so far, then returns the answer", async () => {
  const original = globalThis.fetch;
  const bodies: any[] = [];
  const status = () =>
    Response.json({
      mode: "claude-cli",
      label: "Fake",
      detail: "Fixture",
      capabilities: [],
    });
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    if (String(input) === "/api/status") return status();
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      '{"text":"Wh"}\n{"text":"Why?"}\n{"answer":{"text":"Why?","complete":false}}\n',
      { headers: { "Content-Type": "application/x-ndjson" } },
    );
  }) as typeof fetch;
  try {
    await checkBridge();
    const seen: string[] = [];
    const answer = await bridgeRequest("tutor", { requestId: "s" }, undefined, {
      onText: (text) => seen.push(text),
    });
    assert.deepEqual(seen, ["Wh", "Why?"]);
    assert.equal((answer as any).text, "Why?");
    assert.equal(bodies[0].stream, true);
    globalThis.fetch = (async () =>
      new Response('{"text":"Wh"}\n{"error":"Usage limit"}\n', {
        headers: { "Content-Type": "application/x-ndjson" },
      })) as typeof fetch;
    await assert.rejects(
      bridgeRequest("tutor", {}, undefined, { onText: () => {} }),
      /Usage limit/,
    );
  } finally {
    globalThis.fetch = (async () =>
      Response.json({
        mode: "development",
        label: "Development fallback",
        detail: "Fixture ended",
        capabilities: [],
      })) as typeof fetch;
    await checkBridge();
    globalThis.fetch = original;
  }
});
