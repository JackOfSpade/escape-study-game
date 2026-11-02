// Actual HTTP relay with a fake gateway. This verifies transport and routing, never model output.
import assert from "node:assert/strict";
import { request, type Server } from "node:http";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { AI_OPERATIONS } from "../scripts/lib/ai-contracts.mjs";
// @ts-expect-error Local .mjs server is exercised directly without a declaration shim.
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return `http://127.0.0.1:${addr.port}/`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
const origin = "http://127.0.0.1:5173";
function fakeGateway() {
  const calls: { operation: string; payload: unknown }[] = [];
  return {
    calls,
    enabled: () => true,
    async run(operation: string, payload: unknown) {
      calls.push({ operation, payload });
      return { echoed: payload };
    },
  };
}
test("actual relay forwards a complete large reconciliation to the gateway and rejects cross-origin or unknown operations", async () => {
  const claude = fakeGateway();
  const relay = createStudyBridgeServer({ claude });
  const base = await listen(relay);
  try {
    const status = await (await fetch(base + "api/status")).json();
    assert.equal(status.mode, "claude-cli");
    assert.deepEqual(status.capabilities, AI_OPERATIONS);
    assert.ok(status.capabilities.includes("reconcile-roadmap"));
    // Exceeds the old 1.5 MB route cap, within the complete-document context limit.
    const candidate = "Untrusted source data only. ".repeat(65_000);
    const payload = {
      requestId: "synthetic-transport",
      local: "original",
      candidate,
    };
    const post = (origin: string, operation: string, extra = {}) =>
      fetch(base + "api/bridge", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({ operation, payload, ...extra }),
      });
    const response = await post(origin, "reconcile-roadmap");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { echoed: payload });
    assert.equal(claude.calls.length, 1);
    assert.equal(claude.calls[0].operation, "reconcile-roadmap");
    assert.deepEqual(claude.calls[0].payload, payload);
    for (const [from, operation, expected] of [
      ["https://untrusted.invalid", "reconcile-roadmap", 403],
      [origin, "unrecognized-operation", 400],
    ] as const)
      assert.equal((await post(from, operation)).status, expected);
    assert.equal(claude.calls.length, 1);
  } finally {
    await close(relay);
  }
});
test("actual relay reports a gateway failure without taking itself down", async () => {
  const claude = {
    enabled: () => true,
    async run() {
      throw Object.assign(Error("Synthetic gateway failure"), {
        status: 429,
        code: "SYNTHETIC",
      });
    },
  };
  const relay = createStudyBridgeServer({ claude });
  const base = await listen(relay);
  try {
    const failed = await fetch(base + "api/bridge", {
      method: "POST",
      body: JSON.stringify({ operation: "reconcile-roadmap", payload: {} }),
    });
    assert.equal(failed.status, 429);
    assert.deepEqual(await failed.json(), {
      error: "Synthetic gateway failure",
      code: "SYNTHETIC",
    });
    assert.equal(
      (await (await fetch(base + "api/status")).json()).mode,
      "claude-cli",
    );
  } finally {
    await close(relay);
  }
});
test("actual relay preserves UTF-8 split across network chunks and bounds incoming bytes", async () => {
  const claude = fakeGateway();
  const relay = createStudyBridgeServer({ claude });
  const base = await listen(relay);
  try {
    const payload = { candidate: "中文 🧟 café — exact source" };
    const bytes = Buffer.from(
      JSON.stringify({ operation: "reconcile-roadmap", payload }),
    );
    // End actual HTTP writes inside both a three-byte and a four-byte character.
    const cuts = [
      bytes.indexOf(Buffer.from("中")) + 1,
      bytes.indexOf(Buffer.from("🧟")) + 2,
    ];
    const response = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const req = request(base + "api/bridge", { method: "POST" }, (res) => {
          res.setEncoding("utf8");
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode!, body }));
          res.on("error", reject);
        });
        req.on("error", reject);
        void (async () => {
          req.write(bytes.subarray(0, cuts[0]));
          await delay(20);
          req.write(bytes.subarray(cuts[0], cuts[1]));
          await delay(20);
          req.end(bytes.subarray(cuts[1]));
        })().catch(reject);
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { echoed: payload });
    assert.deepEqual(
      claude.calls.map((call) => call.payload),
      [payload],
    );
    // Fewer than six million JS characters, but more than six million UTF-8 bytes.
    const oversized = await fetch(base + "api/bridge", {
      method: "POST",
      body: JSON.stringify({
        operation: "reconcile-roadmap",
        payload: "中".repeat(2_000_000),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.match((await oversized.json()).error, /Request too large/);
    assert.equal(claude.calls.length, 1);
  } finally {
    await close(relay);
  }
});
test("actual relay without a gateway reports development and never accepts AI work", async () => {
  const relay = createStudyBridgeServer(),
    base = await listen(relay);
  try {
    const status = await (await fetch(base + "api/status")).json();
    assert.equal(status.mode, "development");
    assert.deepEqual(status.capabilities, []);
    const result = await fetch(base + "api/bridge", {
      method: "POST",
      body: JSON.stringify({ operation: "reconcile-roadmap", payload: {} }),
    });
    assert.equal(result.status, 503);
  } finally {
    await close(relay);
  }
});
test("relay rejects a saved request captured under another provider before it reaches the gateway", async () => {
  const claude = fakeGateway();
  const relay = createStudyBridgeServer({ claude }),
    base = await listen(relay);
  const post = (body: Record<string, unknown>) =>
    fetch(base + "api/bridge", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify(body),
    });
  const operations = [
    "materialize-work",
    "materialize-outcome",
    "review-environment",
    "group",
    "complete",
    "tutor",
  ];
  const payload = (operation: string, provider?: string) => ({
    requestId: `synthetic-${operation}`,
    ...(provider ? { provider } : {}),
    mode:
      operation === "group"
        ? "catch-up"
        : operation === "complete"
          ? "retrospective-npc-outcome"
          : undefined,
  });
  try {
    for (const operation of operations)
      for (const provider of ["chatgpt-handoff", "study-mode", "untrusted"]) {
        assert.equal(
          (await post({ operation, payload: payload(operation, provider) }))
            .status,
          409,
        );
        assert.equal(
          (await post({ operation, provider, payload: payload(operation) }))
            .status,
          409,
        );
      }
    assert.equal(claude.calls.length, 0);
    for (const operation of operations) {
      assert.equal(
        (await post({ operation, payload: payload(operation) })).status,
        200,
      );
      assert.equal(
        (
          await post({
            operation,
            provider: "claude-cli",
            payload: payload(operation, "claude-cli"),
          })
        ).status,
        200,
      );
    }
    assert.equal(claude.calls.length, operations.length * 2);
  } finally {
    await close(relay);
  }
});
