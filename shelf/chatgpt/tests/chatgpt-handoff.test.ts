// Real queue/HTTP/stdio mechanics with synthetic answers, not native Study Mode.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
// @ts-expect-error Direct .mjs transport test.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Direct .mjs transport test.
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Direct .mjs transport test.
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";
// @ts-expect-error Direct .mjs native relay integration.
import { createTerminalRelayApp } from "../scripts/terminal-relay-app.mjs";
const worker = "synthetic-worker-one",
  other = "synthetic-worker-two";
const payload = (requestId: string) => ({
  requestId,
  problem: { prompt: "Synthetic task; never real learner proof" },
  messages: [{ text: "PRIVATE_SYNTHETIC_TUTOR_CONTEXT" }],
});

test("exact progress survives recent-list eviction and advances only for its worker", () => {
  let clock = 1000;
  const q = createHandoffQueue({ now: () => clock });
  q.enable(true);
  const receipt = q.enqueue("tutor", payload("progress-owner"));
  assert.deepEqual(q.progress(receipt.id, receipt.hash), {
    id: receipt.id,
    status: "queued",
  });
  const job = q.get(worker);
  assert.deepEqual(q.progress(receipt.id, receipt.hash), {
    id: receipt.id,
    status: "working",
    claimedAt: 1000,
    lastWorkerActivityAt: 1000,
  });
  clock += 6 * 60_000;
  for (let index = 0; index < 6; index++)
    q.enqueue("tutor", payload(`progress-neighbor-${index}`));
  q.get(other);
  q.result(receipt.id, receipt.hash);
  assert.equal(
    q
      .snapshot()
      .recent.some((entry: { id: string }) => entry.id === receipt.id),
    false,
  );
  assert.equal(q.progress(receipt.id, receipt.hash).lastWorkerActivityAt, 1000);
  assert.throws(() => q.progress(receipt.id, "wrong"), /Unknown exact/);
  assert.throws(
    () => q.workerActivity(other, receipt.id, job.claim),
    /Wrong worker/,
  );
  q.get(worker);
  assert.equal(
    q.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
    clock,
  );
  q.submit(worker, job.jobId, job.claim, { text: "Exact synthetic answer." });
  assert.equal(
    q.result(receipt.id, receipt.hash).answer.text,
    "Exact synthetic answer.",
  );
});

test("rejected authenticated submissions refresh activity without accepting work or freshening unrelated claims", () => {
  let clock = 1000;
  const q = createHandoffQueue({ now: () => clock });
  q.enable(true);
  const receipt = q.enqueue("tutor", payload("rejected-activity"));
  const job = q.get(worker);
  clock += 6 * 60_000;
  for (const args of [
    [other, job.jobId, job.claim],
    [worker, job.jobId, "wrong-claim"],
    [worker, "wrong-job", job.claim],
  ]) {
    assert.throws(() => q.submit(...args, {}), /Wrong worker/);
    assert.equal(
      q.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
      1000,
    );
  }
  assert.throws(() => q.submit(worker, job.jobId, job.claim, {}), /text/i);
  assert.equal(
    q.progress(receipt.id, receipt.hash).lastWorkerActivityAt,
    clock,
  );
  assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
  assert.equal(q.get(worker).claim, job.claim);
  q.submit(worker, job.jobId, job.claim, {
    text: "Corrected synthetic response.",
  });
  assert.equal(
    q.result(receipt.id, receipt.hash).answer.text,
    "Corrected synthetic response.",
  );
});

test("roadmap handoff binds both file hashes and retains its claim after malformed proposals", () => {
  const q = createHandoffQueue();
  const p = {
    requestId: "synthetic-roadmap",
    provider: "chatgpt-handoff",
    localHash: "local-hash",
    candidateHash: "incoming-hash",
    local: "local fixture",
    candidate: "incoming fixture",
    instruction: "Preserve source evidence",
  };
  assert.throws(() => q.enqueue("reconcile-roadmap", p), /disabled/);
  q.enable(true);
  const receipt = q.enqueue("reconcile-roadmap", p),
    job = q.get(worker);
  assert.equal(job.operation, "reconcile-roadmap");
  assert.deepEqual(job.payload, p);
  assert.match(job.instructions, /explicitly adopt/);
  const answer = {
    requestId: p.requestId,
    localHash: p.localHash,
    candidateHash: p.candidateHash,
    canonical: "# Complete synthetic proposal",
    definitions: [],
    mappings: [],
    completeScopes: [],
    decisions: [],
    rationale: "Local transport fixture only",
  };
  for (const bad of [
    { ...answer, localHash: "other" },
    { ...answer, candidateHash: "other" },
    { ...answer, requestId: "other" },
    { ...answer, canonical: "" },
    { ...answer, decisions: {} },
  ]) {
    assert.throws(
      () => q.submit(worker, job.jobId, job.claim, bad),
      /exact roadmap|complete canonical/,
    );
    assert.deepEqual(q.get(worker), job);
    assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
  }
  assert.equal(
    q.submit(worker, job.jobId, job.claim, answer).status,
    "accepted",
  );
  assert.deepEqual(q.result(receipt.id, receipt.hash), {
    status: "done",
    answer,
  });
});

test("ChatGPT handoffs are explicitly released, prioritized, exact-request bound and once-only", () => {
  const q = createHandoffQueue();
  assert.throws(() => q.enqueue("tutor", payload("tutor-1")), /disabled/);
  q.enable(true);
  const background = q.enqueue("assess", payload("assessment-1")),
    foreground = q.enqueue("tutor", payload("tutor-1"));
  assert.deepEqual(q.enqueue("tutor", payload("tutor-1")), foreground);
  assert.throws(
    () => q.enqueue("tutor", { ...payload("tutor-1"), changed: true }),
    /Conflicting/,
  );
  assert.throws(() => q.enqueue("run-code", payload("bad")), /Unsupported/);
  const job = q.get(worker);
  assert.equal(job.jobId, foreground.id);
  assert.equal(job.operation, "tutor");
  assert.deepEqual(
    q.get(worker),
    job,
    "repeated pulls return the exact owned job",
  );
  assert.equal(
    q.get(other).jobId,
    background.id,
    "workers never claim the same request",
  );
  assert.throws(
    () => q.submit(other, job.jobId, job.claim, { text: "wrong worker" }),
    /Wrong worker/,
  );
  assert.throws(() => q.submit(worker, job.jobId, job.claim, {}), /nonempty/);
  assert.deepEqual(q.result(foreground.id, foreground.hash), {
    status: "pending",
  });
  assert.equal(
    q.submit(worker, job.jobId, job.claim, {
      text: "Which assumption needs checking?",
    }).status,
    "accepted",
  );
  assert.equal(
    q.submit(worker, job.jobId, job.claim, {
      text: "Which assumption needs checking?",
    }).status,
    "duplicate",
  );
  assert.throws(
    () => q.submit(worker, job.jobId, job.claim, { text: "Rerolled answer" }),
    /Conflicting duplicate/,
  );
  assert.throws(() => q.result(foreground.id, "wrong-hash"), /Unknown exact/);
  assert.match(job.instructions, /Native|native/);
  assert.match(job.instructions, /untrusted evidence/);
  q.enable(false);
  assert.throws(() => q.result(foreground.id, foreground.hash), /disabled/);
});

test("interrupted handoffs retain exact jobs and answers; authorization does not survive restart and requeue invalidates stale claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "dead-air-handoff-")),
    file = join(dir, "jobs.json");
  try {
    let q = createHandoffQueue({ file });
    q.enable(true);
    const receipt = q.enqueue("tutor", payload("durable")),
      job = q.get(worker);
    assert.equal(lstatSync(file).mode & 0o777, 0o600);
    q = createHandoffQueue({ file });
    assert.equal(q.snapshot().enabled, false);
    assert.throws(() => q.get(worker), /disabled/);
    q.enable(true);
    assert.deepEqual(q.get(worker), job);
    q.requeueWorking();
    const replacement = q.get(other);
    assert.equal(replacement.jobId, job.jobId);
    assert.notEqual(replacement.claim, job.claim);
    assert.throws(
      () => q.submit(worker, job.jobId, job.claim, { text: "late" }),
      /Wrong worker/,
    );
    q.submit(other, replacement.jobId, replacement.claim, {
      text: "Retained answer",
    });
    q = createHandoffQueue({ file });
    q.enable(true);
    assert.deepEqual(q.result(receipt.id, receipt.hash), {
      status: "done",
      answer: { text: "Retained answer" },
    });
    const before = q.snapshot(),
      disk = readFileSync(file, "utf8");
    renameSync(dir, dir + "-moved");
    assert.throws(() => q.enqueue("tutor", payload("write-failed")));
    assert.deepEqual(
      q.snapshot(),
      before,
      "failed durable writes must roll back memory",
    );
    renameSync(dir + "-moved", dir);
    assert.equal(readFileSync(file, "utf8"), disk);
    chmodSync(file, 0o644);
    assert.throws(() => createHandoffQueue({ file }), /Unsafe/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + "-moved", { recursive: true, force: true });
  }
});

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  return `http://127.0.0.1:${addr.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

test("actual loopback relay queues ChatGPT work without claiming native Study Mode and rejects cross-origin release or unauthorized workers", async () => {
  const q = createHandoffQueue(),
    handoff = createHandoffRoutes(q, { token: "synthetic-test-token" }),
    server = createStudyBridgeServer({ handoff }),
    base = await listen(server);
  const post = (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await (await fetch(base + "/api/status")).json()).mode,
      "development",
    );
    assert.equal(
      (
        await post(
          "/api/handoff/control",
          { action: "enable", enabled: true },
          { Origin: "http://localhost:9999" },
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/handoff/control",
          { action: "enable", enabled: true },
          { Origin: "http://127.0.0.1:5173" },
        )
      ).status,
      200,
    );
    const status = await (await fetch(base + "/api/status")).json();
    assert.equal(status.mode, "chatgpt-handoff");
    assert.match(status.detail, /not verified/);
    assert.match(status.detail, /no OpenAI API calls/);
    const response = await post(
      "/api/bridge",
      { operation: "tutor", payload: payload("http-tutor") },
      { Origin: "http://127.0.0.1:5173" },
    );
    assert.equal(response.status, 202);
    const { handoff: receipt } = await response.json();
    assert.equal(
      (await post("/api/handoff/worker", { action: "get", worker })).status,
      403,
    );
    assert.equal(
      (
        await post(
          "/api/handoff/worker",
          { action: "get", worker },
          {
            Authorization: "Bearer synthetic-test-token",
            Origin: "http://127.0.0.1:5173",
          },
        )
      ).status,
      403,
    );
    const auth = { Authorization: "Bearer synthetic-test-token" };
    const job = await (
      await post("/api/handoff/worker", { action: "get", worker }, auth)
    ).json();
    assert.equal(job.payload.requestId, "http-tutor");
    const resultUrl = `${base}/api/bridge/result?id=${receipt.id}&hash=${receipt.hash}`;
    const pendingResponse = await fetch(resultUrl);
    assert.equal(pendingResponse.status, 202);
    const pending = await pendingResponse.json();
    assert.equal(pending.status, "pending");
    assert.equal(pending.handoff.id, receipt.id);
    assert.equal(pending.handoff.status, "working");
    assert.ok(Number.isFinite(pending.handoff.claimedAt));
    assert.ok(Number.isFinite(pending.handoff.lastWorkerActivityAt));
    assert.equal(
      JSON.stringify(pending).includes("PRIVATE_SYNTHETIC_TUTOR_CONTEXT"),
      false,
    );
    assert.equal(
      (
        await post(
          "/api/handoff/worker",
          {
            action: "submit",
            worker,
            jobId: job.jobId,
            claim: job.claim,
            answer: {},
          },
          auth,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await post(
          "/api/handoff/worker",
          {
            action: "submit",
            worker,
            jobId: job.jobId,
            claim: job.claim,
            answer: { text: "Explain the boundary." },
          },
          auth,
        )
      ).status,
      200,
    );
    assert.deepEqual(await (await fetch(resultUrl)).json(), {
      text: "Explain the boundary.",
    });
    assert.ok(status.capabilities.includes("direct-study"));
    const nativeResponse = await post(
      "/api/bridge",
      {
        operation: "tutor",
        payload: {
          requestId: "synthetic-http-native",
          sessionId: "synthetic-http-native-session",
          questionFingerprint: "synthetic-http-native-fingerprint",
          mode: "terminal-direct",
          probe: {
            facets: [
              { id: "stale-state", description: "Avoid stale UI state" },
            ],
          },
          problem: {
            title: "Synthetic native",
            prompt: "Explain stale UI state",
            rubric: [],
          },
          messages: [],
        },
      },
      { Origin: "http://127.0.0.1:5173" },
    );
    assert.equal(nativeResponse.status, 202);
    const { handoff: nativeReceipt } = await nativeResponse.json();
    const nativeResultUrl = `${base}/api/bridge/result?id=${nativeReceipt.id}&hash=${nativeReceipt.hash}`;
    assert.equal((await fetch(nativeResultUrl)).status, 202);
    const legacyPull = await (
      await post("/api/handoff/worker", { action: "get", worker }, auth)
    ).json();
    assert.equal(
      legacyPull.status,
      "waiting",
      "legacy local worker cannot claim native questions",
    );
    const nativeApp = createTerminalRelayApp({ queue: q });
    const grant = { linkId: "synthetic-http-owner" };
    const nativeTurn = nativeApp.call(
      "get_current_study_question",
      {},
      grant,
    ).structuredContent;
    assert.equal(nativeTurn.requestId, "synthetic-http-native");
    nativeApp.call(
      "finish_study_question",
      {
        relayId: nativeTurn.relayId,
        turnId: nativeTurn.turnId,
        questionFingerprint: nativeTurn.questionFingerprint,
        text: "Synthetic completion sent.",
        outcome: "gap",
        transcript: [
          { role: "user", text: "I don't know this stale-state case." },
        ],
        knowledge: { facets: [{ id: "stale-state", status: "gap" }] },
      },
      grant,
    );
    const nativeReturned = await (await fetch(nativeResultUrl)).json();
    assert.equal(nativeReturned.complete, true);
    assert.equal(nativeReturned.outcome, "gap");
    assert.equal(nativeReturned.transcript[0].role, "user");
    const summary = await (await fetch(base + "/api/handoff/status")).text();
    assert.ok(!summary.includes("PRIVATE_SYNTHETIC"));
  } finally {
    await close(server);
  }
});

test("actual stdio MCP worker pulls and submits only its correlated local handoff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dead-air-mcp-")),
    tokenFile = join(dir, "worker-token");
  writeFileSync(tokenFile, "synthetic-stdio-token", { mode: 0o600 });
  const q = createHandoffQueue();
  q.enable(true);
  const receipt = q.enqueue("tutor", payload("stdio-tutor"));
  const server = createStudyBridgeServer({
      handoff: createHandoffRoutes(q, { token: "synthetic-stdio-token" }),
    }),
    base = await listen(server);
  const child = spawn(process.execPath, ["scripts/chatgpt-handoff-mcp.mjs"], {
    env: {
      ...process.env,
      DEAD_AIR_RELAY_URL: base,
      DEAD_AIR_TOKEN_FILE: tokenFile,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiting = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  let sequence = 0;
  const lines = createInterface({ input: child.stdout });
  let stderr = "";
  child.stderr.on("data", (part) => {
    stderr += part;
  });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    waiting.get(value.id)?.resolve(value);
    waiting.delete(value.id);
  });
  const rpc = (method: string, params?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
      );
    });
  const timeout = setTimeout(() => {
    for (const p of waiting.values()) p.reject(Error("MCP test timeout"));
  }, 10_000);
  try {
    const init = await rpc("initialize", { protocolVersion: "2025-11-25" });
    assert.equal(init.result.serverInfo.name, "dead-air-chatgpt-handoff");
    const list = await rpc("tools/list");
    assert.deepEqual(
      list.result.tools.map((t: any) => t.name),
      ["get_study_handoff", "submit_study_handoff", "read_study_handoff_part"],
    );
    const reply = await rpc("tools/call", {
        name: "get_study_handoff",
        arguments: {},
      }),
      job = JSON.parse(reply.result.content[0].text);
    assert.equal(job.payload.requestId, "stdio-tutor");
    const submitted = await rpc("tools/call", {
      name: "submit_study_handoff",
      arguments: {
        jobId: job.jobId,
        claim: job.claim,
        response: JSON.stringify({ text: "Controlled stdio guidance" }),
      },
    });
    assert.equal(
      JSON.parse(submitted.result.content[0].text).status,
      "accepted",
    );
    assert.deepEqual(q.result(receipt.id, receipt.hash).answer, {
      text: "Controlled stdio guidance",
    });
    assert.ok(!stderr.includes("synthetic-stdio-token"));
  } finally {
    clearTimeout(timeout);
    child.kill("SIGTERM");
    lines.close();
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("large packets require every stable Unicode-preserving part before a response can be submitted", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const source = {
    ...payload("large-tutor"),
    context: "Exact private context 🙂 boundary\n".repeat(50_000),
  };
  const receipt = q.enqueue("tutor", source),
    job = q.get(worker);
  assert.equal(job.payload, undefined);
  assert.equal(job.payloadManifest.format, "chunked-json");
  assert.throws(
    () =>
      q.submit(worker, job.jobId, job.claim, {
        text: "Unjustified partial review",
      }),
    /every payload part/,
  );
  assert.throws(() => q.part(other, job.jobId, job.claim, 0), /Wrong worker/);
  const parts = [];
  for (let index = 0; index < job.payloadManifest.parts; index++) {
    const part = q.part(worker, job.jobId, job.claim, index);
    assert.equal(part.payloadSha256, job.payloadManifest.sha256);
    parts.push(part.text);
    assert.ok(Buffer.byteLength(JSON.stringify(part)) < 300_000);
  }
  assert.deepEqual(JSON.parse(parts.join("")), source);
  q.submit(worker, job.jobId, job.claim, {
    text: "Complete packet was available for this controlled reply",
  });
  assert.equal(q.result(receipt.id, receipt.hash).status, "done");
});

test("explicit corrected replies retain the exact original request and previous answer while invalidating stale submissions", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const receipt = q.enqueue("tutor", payload("correction")),
    job = q.get(worker);
  q.submit(worker, job.jobId, job.claim, { text: "First controlled reply" });
  q.reopen(job.jobId);
  assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
  const corrected = q.get(worker);
  assert.equal(corrected.jobId, job.jobId);
  assert.equal(corrected.requestHash, job.requestHash);
  assert.deepEqual(corrected.payload, job.payload);
  assert.notEqual(corrected.claim, job.claim);
  assert.equal(corrected.correction.round, 1);
  assert.ok(
    !JSON.stringify(corrected.correction).includes("First controlled reply"),
  );
  assert.throws(
    () =>
      q.submit(worker, job.jobId, job.claim, {
        text: "Late first-round result",
      }),
    /Wrong worker/,
  );
  q.submit(worker, corrected.jobId, corrected.claim, {
    text: "Corrected controlled reply",
  });
  assert.deepEqual(q.result(receipt.id, receipt.hash).answer, {
    text: "Corrected controlled reply",
  });
});

test("interactive priority ages fairly and completed requests do not impose an artificial per-session tutoring count", () => {
  let now = 0;
  const q = createHandoffQueue({ now: () => now, maxJobs: 1 });
  q.enable(true);
  for (let i = 0; i < 4; i++) {
    q.enqueue("tutor", payload(`done-${i}`));
    const job = q.get(worker);
    q.submit(worker, job.jobId, job.claim, { text: "Controlled answer" });
  }
  assert.equal(q.snapshot().done, 4);
  const aged = createHandoffQueue({ now: () => now });
  aged.enable(true);
  const background = aged.enqueue("assess", payload("old-assessment"));
  now = 150_000;
  aged.enqueue("tutor", payload("new-tutor"));
  assert.equal(aged.get(worker).jobId, background.id);
});

test("queued requests nobody served within a day expire like answered ones, while a claimed job and fresh work stay", () => {
  let now = 0;
  const q = createHandoffQueue({ now: () => now });
  q.enable(true);
  const abandoned = q.enqueue("tutor", payload("abandoned-run"));
  const claimed = q.enqueue("tutor", payload("claimed-run"));
  const served = q.get(worker);
  assert.equal(served.jobId, abandoned.id);
  q.submit(worker, served.jobId, served.claim, { text: "Answered" });
  assert.equal(q.get(worker).jobId, claimed.id);
  now = 23 * 3600_000;
  const recent = q.enqueue("tutor", payload("recent-run"));
  assert.deepEqual(
    q
      .snapshot()
      .recent.map((j: { id: string; status: string }) => [j.id, j.status]),
    [
      [abandoned.id, "done"],
      [claimed.id, "working"],
      [recent.id, "queued"],
    ],
  );
  now = 25 * 3600_000;
  const fresh = q.enqueue("tutor", payload("fresh-run"));
  assert.deepEqual(
    q
      .snapshot()
      .recent.map((j: { id: string; status: string }) => [j.id, j.status]),
    [
      [claimed.id, "working"],
      [recent.id, "queued"],
      [fresh.id, "queued"],
    ],
  );
  // The exact saved request can be retried after expiry: it is re-created.
  assert.throws(
    () => q.result(abandoned.id, abandoned.hash),
    /Unknown exact handoff request/,
  );
  assert.notEqual(
    q.enqueue("tutor", payload("abandoned-run")).id,
    abandoned.id,
  );
});

test("expiry preserves a queued learner turn that is still awaited and frees it after polling stops", () => {
  let now = 0;
  const q = createHandoffQueue({ now: () => now });
  q.enable(true);
  const receipt = q.enqueue("tutor", payload("still-awaited-after-a-day"));
  now = 25 * 3600_000;
  assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
  now += 61_000; // A hidden game tab may wake only once a minute.
  q.enqueue("tutor", payload("unrelated-new-turn"));
  assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
  const job = q.get(worker);
  assert.equal(job.jobId, receipt.id);
  q.releaseWorker(worker);
  now += 76_000;
  q.enqueue("tutor", payload("after-requester-left"));
  assert.throws(
    () => q.result(receipt.id, receipt.hash),
    /Unknown exact handoff request/,
  );
});

test("worker pulls roll back a claim change when its durable write fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "dead-air-handoff-pull-"));
  const file = join(dir, "jobs.json");
  try {
    const q = createHandoffQueue({ file });
    q.enable(true);
    const receipt = q.enqueue("tutor", payload("durable-claim"));
    const before = q.snapshot();
    renameSync(dir, dir + "-moved");
    assert.throws(() => q.get(worker));
    assert.deepEqual(q.snapshot(), before);
    renameSync(dir + "-moved", dir);
    const job = q.get(other);
    assert.equal(job.jobId, receipt.id);
    assert.deepEqual(q.get(other), job);
    assert.equal(q.get(worker).status, "waiting");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dir + "-moved", { recursive: true, force: true });
  }
});

test("generation handoffs require enough visible facts and a bounded task without relying on tutor clarification", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const contract = {
    id: "synthetic-state-categories",
    objectiveIds: ["SYNTHETIC:STATE"],
    scopes: ["Distinguish interface, server and cached state."],
    depth: 1,
  };
  const receipt = q.enqueue("generate", {
    requestId: "synthetic-standalone-question",
    contract,
  });
  const job = q.get(worker);
  assert.equal(job.jobId, receipt.id);
  assert.deepEqual(job.payload.contract, contract);
  for (const requirement of [
    /prompt must stand on its own/,
    /essential scenario, interface, data, code, implementation, business rules and timing facts/,
    /without tutor chat/,
    /fixed facts explicitly.*intentional design choices/,
    /concrete, bounded question rather than pasting a curriculum scope/,
    /classification, list the actual items to classify/,
    /tracing or critique, supply the relevant code, event trace or evidence/,
    /every requested requirement visible in the prompt, never only in the rubric or later chat/,
    /Do not grade unstated assumptions/,
    /unrelated generic requests for assumptions, edge cases or a product recommendation/,
    /must not supply the explanation, classification or worked result/,
    /Copy the exact eligible contract/,
    /existing stable scope definitions are copied exactly, never rewritten/,
    /D1 is conceptual diagnosis with an empty workspace starter and no unsolicited key-step hints/,
  ])
    assert.match(job.instructions, requirement);
});

test("generation rejects rubric objects before accepting a reply and retains the same claim for a corrected string rubric", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const contract = {
    id: "synthetic-format",
    objectiveIds: ["SYNTHETIC:EMPTY"],
    depth: 1,
  };
  const receipt = q.enqueue("generate", {
    requestId: "synthetic-rubric-format",
    contract,
  });
  const job = q.get(worker);
  const answer = {
    title: "Fictional boundary",
    prompt: "Which boundary needs checking?",
    starter: "",
    rubric: [{ facetId: "boundary", criterion: "Explain the empty case" }],
    contract,
    scopeDefinitions: [
      { id: "synthetic", objectiveId: "SYNTHETIC:EMPTY", facets: [] },
    ],
  };
  assert.match(job.instructions, /rubric is an array of strings/);
  assert.throws(
    () => q.submit(worker, job.jobId, job.claim, answer),
    /rubric as an array of strings/,
  );
  assert.deepEqual(q.result(receipt.id, receipt.hash), { status: "pending" });
  assert.equal(q.get(worker).claim, job.claim);
  assert.equal(
    q.submit(worker, job.jobId, job.claim, {
      ...answer,
      rubric: ["boundary: Explain the empty case"],
    }).status,
    "accepted",
  );
  assert.equal(
    q.result(receipt.id, receipt.hash).answer.rubric[0],
    "boundary: Explain the empty case",
  );
});

test("group reply rejects string references and changed revisions while retaining its exact request and claim", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const receipt = q.enqueue("group", {
    requestId: "synthetic-reference-format",
    mode: "reply",
    sourceRevision: 3,
    events: [{ seq: 12, author: "human", kind: "reasoning" }],
  });
  const job = q.get(worker),
    answer = {
      requestId: "synthetic-reference-format",
      sourceRevision: 3,
      messages: [
        {
          author: "synthetic-robin",
          kind: "question",
          text: "Which boundary?",
          refs: ["message:12"],
        },
      ],
    };
  assert.throws(
    () => q.submit(worker, job.jobId, job.claim, answer),
    /integer sequence numbers/,
  );
  assert.throws(
    () =>
      q.submit(worker, job.jobId, job.claim, {
        ...answer,
        sourceRevision: 4,
        messages: [],
      }),
    /Preserve sourceRevision/,
  );
  assert.deepEqual(q.result(receipt.id, receipt.hash), { status: "pending" });
  assert.equal(q.get(worker).claim, job.claim);
  assert.equal(
    q.submit(worker, job.jobId, job.claim, {
      ...answer,
      messages: [{ ...answer.messages[0], refs: [12] }],
    }).status,
    "accepted",
  );
});

test("assessment handoff rejects result labels as execution states and retains the exact claim for correction", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const receipt = q.enqueue("assess", {
      requestId: "synthetic-execution-schema",
      packet: { encounter: "synthetic" },
    }),
    job = q.get(worker);
  assert.match(job.instructions, /execution:not-run\|executed/);
  assert.ok(!job.instructions.includes("execution:not-run|passed|failed"));
  const answer = {
    visitOutcome: "unresolved",
    findings: [
      {
        objectiveId: "PY:SYNTHETIC",
        facet: "boundary",
        outcome: "unknown",
        evidence: [],
        execution: "not-run",
        rationale: "Shape fixture; no grade",
      },
    ],
    scopeReviews: [],
    helpAttributions: [],
  };
  for (const execution of ["passed", "failed", true, {}, null]) {
    assert.throws(
      () =>
        q.submit(worker, job.jobId, job.claim, {
          ...answer,
          findings: [{ ...answer.findings[0], execution }],
        }),
      /execution must be/,
    );
    assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
    assert.deepEqual(q.get(worker), job);
  }
  assert.equal(
    q.submit(worker, job.jobId, job.claim, answer).status,
    "accepted",
  );
  assert.equal(
    q.result(receipt.id, receipt.hash).answer.findings[0].execution,
    "not-run",
  );
});

test("group duplicate text keeps the worker claim pending until it supplies distinct contributions", () => {
  const q = createHandoffQueue();
  q.enable(true);
  const receipt = q.enqueue("group", {
      requestId: "distinct-replies",
      mode: "reply",
      sourceRevision: 1,
      events: [],
    }),
    job = q.get(worker);
  const answer = {
    requestId: "distinct-replies",
    sourceRevision: 1,
    messages: [
      {
        author: "npc-a",
        kind: "question",
        text: "Which boundary?\nWhy?",
        refs: [],
      },
      {
        author: "npc-b",
        kind: "question",
        text: " Which boundary?\r\nWhy? ",
        refs: [],
      },
    ],
  };
  assert.throws(
    () => q.submit(worker, job.jobId, job.claim, answer),
    /distinct reply text/,
  );
  assert.equal(q.result(receipt.id, receipt.hash).status, "pending");
  assert.deepEqual(q.get(worker), job);
  answer.messages[1].text = "What does the empty case tell us?";
  assert.equal(
    q.submit(worker, job.jobId, job.claim, answer).status,
    "accepted",
  );
});

test("unattended opt-in revocation holds exact queued packets, invalidates claims and parts, and cannot be replaced by generic sharing", () => {
  const q = createHandoffQueue(),
    p = {
      requestId: "synthetic-autonomous-large",
      provider: "chatgpt-handoff",
      background: true,
      autonomyAllowed: true,
      sourceRevision: 0,
      workspace: "",
      work: [],
      speakers: [],
      snapshot: { events: [] },
      fixture: "x".repeat(510000),
    };
  assert.throws(() => q.setAutonomous(true), /disabled/);
  q.enable(true);
  assert.equal(q.snapshot().autonomousWork, false);
  assert.throws(() => q.enqueue("materialize-work", p), /Unattended/);
  assert.throws(
    () => q.enqueue("materialize-work", { ...p, autonomyAllowed: "true" }),
    /booleans/,
  );
  q.setAutonomous(true);
  const receipt = q.enqueue("materialize-work", p),
    job = q.get(worker);
  assert.ok(job.payloadManifest);
  q.part(worker, job.jobId, job.claim, 0);
  q.setAutonomous(false);
  assert.equal(q.snapshot().heldAutonomous, 1);
  assert.equal(q.snapshot().queued, 1);
  assert.equal(q.get(worker).status, "waiting");
  assert.throws(() => q.part(worker, job.jobId, job.claim, 1), /Wrong/);
  assert.throws(() => q.submit(worker, job.jobId, job.claim, {}), /Wrong/);
  assert.throws(() => q.result(receipt.id, receipt.hash), /Unattended/);
  // Explicit human tutoring remains released; revocation is scoped to NPC jobs.
  q.enqueue("tutor", payload("synthetic-still-explicit"));
  const tutor = q.get(worker);
  assert.equal(tutor.operation, "tutor");
  q.submit(worker, tutor.jobId, tutor.claim, {
    text: "A bounded human-requested hint",
  });
  q.enable(false);
  q.enable(true);
  assert.equal(q.snapshot().autonomousWork, false);
  assert.equal(q.get(worker).status, "waiting");
  q.setAutonomous(true);
  const retry = q.get(worker);
  assert.equal(retry.jobId, job.jobId);
  assert.equal(retry.requestHash, job.requestHash);
  assert.notEqual(retry.claim, job.claim);
  const answer = { requestId: p.requestId, sourceRevision: 0, notes: [] };
  assert.throws(
    () => q.submit(worker, retry.jobId, retry.claim, answer),
    /every payload part/,
  );
  for (let n = 0; n < retry.payloadManifest.parts; n++)
    q.part(worker, retry.jobId, retry.claim, n);
  q.submit(worker, retry.jobId, retry.claim, answer);
  q.setAutonomous(false);
  assert.throws(() => q.result(receipt.id, receipt.hash), /Unattended/);
  q.setAutonomous(true);
  assert.deepEqual(q.result(receipt.id, receipt.hash), {
    status: "done",
    answer,
  });
});

test("unattended release never restores on relay launch, and stale autonomous claims cannot resume from disk", () => {
  const directory = mkdtempSync(join(tmpdir(), "synthetic-autonomy-")),
    file = join(directory, "jobs.json");
  try {
    const q = createHandoffQueue({ file });
    q.enable(true);
    q.setAutonomous(true);
    const p = {
      requestId: "synthetic-npc-complete",
      provider: "chatgpt-handoff",
      submitter: "synthetic-npc",
      autonomyAllowed: true,
    };
    const receipt = q.enqueue("complete", p),
      prior = q.get(worker);
    const restored = createHandoffQueue({ file });
    assert.equal(restored.snapshot().enabled, false);
    assert.equal(restored.snapshot().autonomousWork, false);
    assert.equal(restored.snapshot().working, 0);
    restored.enable(true);
    assert.equal(restored.get(worker).status, "waiting");
    assert.equal(restored.snapshot().heldAutonomous, 1);
    assert.throws(
      () =>
        restored.submit(worker, prior.jobId, prior.claim, {
          complete: true,
          feedback: "synthetic",
          qualified: [],
        }),
      /Wrong/,
    );
    restored.setAutonomous(true);
    const next = restored.get(worker);
    assert.notEqual(next.claim, prior.claim);
    assert.equal(next.jobId, receipt.id);
    assert.deepEqual(next.payload, p);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual HTTP unattended control requires the game origin and advertises autonomy only after separate opt-in", async () => {
  const q = createHandoffQueue(),
    handoff = createHandoffRoutes(q, { token: "synthetic-optin-control" }),
    server = createStudyBridgeServer({ handoff }),
    base = await listen(server);
  const control = (body: unknown, origin = "http://127.0.0.1:5173") =>
    fetch(base + "/api/handoff/control", {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal(
      (await control({ action: "autonomous", enabled: true })).status,
      409,
    );
    await control({ action: "enable", enabled: true });
    const capabilities = async () =>
      (await (await fetch(base + "/api/status")).json()).capabilities;
    assert.ok(!(await capabilities()).includes("autonomous-work"));
    assert.equal(
      (
        await control(
          { action: "autonomous", enabled: true },
          "http://localhost:9999",
        )
      ).status,
      403,
    );
    assert.equal(q.snapshot().autonomousWork, false);
    assert.equal(
      (await control({ action: "autonomous", enabled: true })).status,
      200,
    );
    assert.ok((await capabilities()).includes("autonomous-work"));
    await control({ action: "enable", enabled: false });
    await control({ action: "enable", enabled: true });
    assert.ok(!(await capabilities()).includes("autonomous-work"));
    assert.equal(q.snapshot().autonomousWork, false);
  } finally {
    await close(server);
  }
});

test("a local diagnostic request scope filters both priority selection and retained claims without disclosing unrelated packets", () => {
  const q = createHandoffQueue();
  q.enable(true);
  q.enqueue("tutor", {
    requestId: "unrelated-private",
    text: "DO_NOT_SEND_TO_DIAGNOSTIC",
  });
  q.enqueue("tutor", {
    requestId: "synthetic-scope/one",
    text: "Approved fixture",
  });
  assert.throws(() => q.get(worker, ""), /scope/);
  const job = q.get(worker, "synthetic-scope/");
  assert.equal(job.payload.requestId, "synthetic-scope/one");
  assert.ok(!JSON.stringify(job).includes("DO_NOT_SEND_TO_DIAGNOSTIC"));
  assert.equal(q.get(worker, "different-scope/").status, "waiting");
  assert.equal(q.get(worker, "synthetic-scope/").claim, job.claim);
  q.submit(worker, job.jobId, job.claim, { text: "Scoped fixture reply" });
  assert.equal(q.get(worker, "synthetic-scope/").status, "waiting");
  assert.equal(q.snapshot().queued, 1);
  assert.equal(q.get(other).payload.requestId, "unrelated-private");
});

test("terminal dialogue handoff requires an explicit boolean completion decision and preserves correction claim", () => {
  const q = createHandoffQueue();
  q.enable(true);
  q.enqueue("tutor", {
    ...payload("synthetic-dialogue"),
    mode: "terminal-dialogue",
    studyPrompt: "@study",
  });
  const job = q.get(worker);
  assert.match(job.instructions, /complete:boolean/);
  assert.throws(
    () => q.submit(worker, job.jobId, job.claim, { text: "Synthetic reply" }),
    /complete:boolean/,
  );
  assert.throws(
    () =>
      q.submit(worker, job.jobId, job.claim, {
        text: "Synthetic reply",
        complete: "true",
      }),
    /complete:boolean/,
  );
  assert.match(job.instructions, /assume the learner already knows/i);
  assert.match(job.instructions, /outcome\?:'solved'\|'gap'/);
  assert.match(job.instructions, /impliedBy/);
  for (const bad of [
    { text: "x", complete: true, outcome: "partial" },
    { text: "x", complete: true, knowledge: "none" },
    { text: "x", complete: true, knowledge: { facets: "all" } },
    { text: "x", complete: true, knowledge: { facets: [{ id: "a" }] } },
    {
      text: "x",
      complete: true,
      knowledge: { facets: [{ id: "a", status: "known" }] },
    },
    { text: "x", complete: true, knowledge: { signal: { fluency: "great" } } },
    {
      text: "x",
      complete: true,
      knowledge: { facets: [{ id: "a", status: "gap", partOf: 7 }] },
    },
    {
      text: "x",
      complete: true,
      knowledge: {
        facets: [{ id: "a", status: "gap", partOf: "b", description: [] }],
      },
    },
  ])
    assert.throws(
      () => q.submit(worker, job.jobId, job.claim, bad),
      /outcome must be|knowledge must be/,
    );
  assert.match(
    job.instructions,
    /partOf \(a known facet id\) and a short description/,
  );
  assert.equal(
    q.submit(worker, job.jobId, job.claim, {
      text: "Synthetic follow-up",
      complete: false,
      knowledge: {
        facets: [
          { id: "a", status: "implied", impliedBy: "b" },
          { id: "c", status: "gap", partOf: "a", description: "Part C" },
        ],
        signal: { fluency: "partial" },
      },
    }).status,
    "accepted",
  );
});
