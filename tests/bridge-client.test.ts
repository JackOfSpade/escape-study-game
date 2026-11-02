import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgeRequest, checkBridge, status } from "../src/bridge-client";
const reply = (mode = "claude-cli") =>
  Response.json({
    mode,
    label: "Synthetic bridge",
    capabilities: ["generate"],
    detail: "Local fixture only",
  });
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
  assert.equal(status().mode, "claude-cli");
});

test("malformed bridge capabilities and retired providers fail closed", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [
    null,
    {},
    { mode: "claude-cli", label: "fake", detail: "bad", capabilities: [42] },
    // A bridge that still reports a retired provider is unusable, not trusted.
    { mode: "chatgpt-handoff", label: "old", detail: "old", capabilities: [] },
    { mode: "study-mode", label: "old", detail: "old", capabilities: [] },
  ]) {
    globalThis.fetch = async () => Response.json(body);
    await checkBridge();
    assert.equal(status().mode, "development");
  }
});

test("invalid bridge response bodies report a protocol error instead of a property access failure", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  for (const body of [null, [], "invalid"]) {
    globalThis.fetch = async (url) =>
      url === "/api/status" ? reply() : Response.json(body);
    await checkBridge();
    await assert.rejects(
      bridgeRequest("tutor", {}),
      /Malformed bridge response/,
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
    bridgeRequest("tutor", {}, { isActive: () => false }),
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
    const answer = await bridgeRequest(
      "tutor",
      { requestId: "s" },
      {
        onText: (text) => seen.push(text),
      },
    );
    assert.deepEqual(seen, ["Wh", "Why?"]);
    assert.equal((answer as any).text, "Why?");
    assert.equal(bodies[0].stream, true);
    globalThis.fetch = (async () =>
      new Response('{"text":"Wh"}\n{"error":"Usage limit"}\n', {
        headers: { "Content-Type": "application/x-ndjson" },
      })) as typeof fetch;
    await assert.rejects(
      bridgeRequest("tutor", {}, { onText: () => {} }),
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
