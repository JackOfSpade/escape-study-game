// Real protected HTTP/OAuth and synthetic signed connector assertions. No real account token is used.
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Direct local .mjs security integration.
import { createPublicHandoffBridge } from "../scripts/chatgpt-public-bridge.mjs";
// @ts-expect-error Direct local .mjs security integration.
import { createHandoffQueue } from "../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Direct local .mjs security integration.
import { validateClientMetadata } from "../scripts/chatgpt-security/cimd.mjs";
const hostname = "synthetic-game.lullascape.com",
  issuer = `https://${hostname}`,
  clientId = "https://chatgpt.com/oauth/client.json",
  redirect = "https://chatgpt.com/connector_platform_oauth_redirect";
const metadata = {
  client_id: clientId,
  client_uri: "https://chatgpt.com/",
  redirect_uris: [redirect],
  token_endpoint_auth_method: "private_key_jwt",
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "ChatGPT",
  token_endpoint_auth_signing_alg: "RS256",
  jwks_uri: "https://chatgpt.com/oauth/jwks.json",
};
const parseTool = (body: any) => JSON.parse(body.result.content[0].text);

async function proxyFetch(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    redirect?: string;
  } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      url,
      { method: init.method ?? "GET", headers: init.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (part) => chunks.push(part));
        res.on("end", () =>
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode!,
              headers: Object.fromEntries(
                Object.entries(res.headers)
                  .filter(([, value]) => value !== undefined)
                  .map(([key, value]) => [
                    key,
                    Array.isArray(value) ? value.join(", ") : String(value),
                  ]),
              ),
            }),
          ),
        );
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });
}

test("separate game connector requires local pairing, PKCE, a signed client assertion, OAuth, permitted proxy source and current worker session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dead-air-public-")),
    q = createHandoffQueue();
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 }),
    jwk = {
      ...keys.publicKey.export({ format: "jwk" }),
      kid: "controlled-public-key",
      alg: "RS256",
      use: "sig",
    };
  const bridge = createPublicHandoffBridge({
    hostname,
    queue: q,
    directory: dir,
    connectorRanges: ["203.0.113.0/24"],
    fetchClientMetadata: async () => validateClientMetadata(metadata, clientId),
    fetchJwks: async () => ({ keys: [jwk] }),
  });
  await new Promise<void>((resolve) =>
    bridge.server.listen(0, "127.0.0.1", resolve),
  );
  const address = bridge.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Host: hostname, "CF-Connecting-IP": "203.0.113.10" };
  const post = async (
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    proxyFetch(base + path, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...extra,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
      redirect: "manual",
    });
  const form = (body: Record<string, string>) =>
    new URLSearchParams(body).toString();
  const assertion = () => {
    const header = Buffer.from(
        JSON.stringify({ alg: "RS256", kid: jwk.kid, typ: "JWT" }),
      ).toString("base64url"),
      now = Math.floor(Date.now() / 1000),
      payload = Buffer.from(
        JSON.stringify({
          iss: clientId,
          sub: clientId,
          aud: issuer + "/oauth/token",
          iat: now,
          exp: now + 60,
          jti: randomUUID(),
        }),
      ).toString("base64url"),
      input = header + "." + payload;
    return (
      input +
      "." +
      sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString(
        "base64url",
      )
    );
  };
  try {
    const discovery = await proxyFetch(
      base + "/.well-known/oauth-protected-resource/mcp",
      { headers },
    );
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).resource, issuer + "/mcp");
    const denied = await post("/mcp", {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    assert.equal(denied.status, 401);
    assert.equal(
      (await post("/api/bridge", {}, headers)).status,
      404,
      "public listener exposes no local game API",
    );
    const verifier = randomBytes(32).toString("base64url"),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      state: "controlled-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: issuer + "/mcp",
      scope: "handoff",
    });
    const closed = await proxyFetch(base + "/oauth/authorize?" + query, {
      headers,
    });
    assert.equal(closed.status, 403);
    const { pairingCode } = bridge.openPairing();
    const consent = await proxyFetch(base + "/oauth/authorize?" + query, {
      headers,
    });
    assert.equal(consent.status, 200);
    const html = await consent.text();
    assert.match(html, /zombie-escape-study-game/);
    assert.ok(!html.includes("Infinite Canvas"));
    const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
    assert.ok(txn);
    const approved = await post(
      "/oauth/authorize",
      form({ txn, action: "approve", pairing_code: pairingCode }),
      { "Content-Type": "application/x-www-form-urlencoded", Origin: issuer },
    );
    assert.equal(approved.status, 302);
    const returned = new URL(approved.headers.get("location")!);
    assert.equal(returned.origin, "https://chatgpt.com");
    assert.equal(returned.searchParams.get("state"), "controlled-state");
    const code = returned.searchParams.get("code")!;
    const tokenBody = {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: issuer + "/mcp",
      client_id: clientId,
    };
    const unsigned = await post("/oauth/token", form(tokenBody), {
      "Content-Type": "application/x-www-form-urlencoded",
    });
    assert.equal(
      unsigned.status,
      401,
      "a known code cannot bypass required connector signatures",
    );
    // A failed unsigned request must not consume the valid code before authenticated exchange.
    const tokenResponse = await post(
      "/oauth/token",
      form({
        ...tokenBody,
        client_assertion_type:
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        client_assertion: assertion(),
      }),
      { "Content-Type": "application/x-www-form-urlencoded" },
    );
    assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
    const token = await tokenResponse.json();
    assert.equal(bridge.status().linked, true);
    const authorized = { Authorization: `Bearer ${token.access_token}` };
    assert.equal(
      (
        await post(
          "/mcp",
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { ...authorized, "CF-Connecting-IP": "198.51.100.9" },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await post(
          "/mcp",
          { jsonrpc: "2.0", id: 3, method: "tools/list" },
          { ...authorized, Host: "unrelated.example" },
        )
      ).status,
      421,
    );
    const listing = await (
      await post(
        "/mcp",
        { jsonrpc: "2.0", id: 4, method: "tools/list" },
        authorized,
      )
    ).json();
    assert.equal(listing.result.tools.length, 15);
    const relayTools = listing.result.tools.filter((t: any) =>
      [
        "open_study_terminal",
        "get_current_study_question",
        "claim_study_terminal_turn",
        "read_study_terminal",
        "read_study_terminal_context",
        "reply_study_terminal_job",
        "finish_study_preparation",
        "finish_study_question",
      ].includes(t.name),
    );
    assert.equal(relayTools.length, 8);
    const nativeGetter = relayTools.find(
      (t: any) => t.name === "get_current_study_question",
    );
    const contextReader = relayTools.find(
      (t: any) => t.name === "read_study_terminal_context",
    );
    for (const alias of ["chat", "chat_code", "chatCode"])
      assert.deepEqual(
        contextReader.inputSchema.properties[alias],
        nativeGetter.inputSchema.properties[alias],
        "public context reads advertise the same chat binding as the getter",
      );
    assert.equal(
      nativeGetter._meta.ui,
      undefined,
      "plain native chat requires no resource card",
    );
    assert.ok(
      relayTools.every((t: any) => !t.inputSchema.required.includes("session")),
      "the live terminal app is OAuth-bound, not worker-session bound",
    );
    const legacy = listing.result.tools.filter((t: any) =>
      [
        "get_study_handoff",
        "read_study_handoff_part",
        "submit_study_handoff",
      ].includes(t.name),
    );
    assert.equal(legacy.length, 3);
    assert.ok(
      legacy.every((t: any) => t.inputSchema.required.includes("session")),
    );
    const embedded = listing.result.tools.find(
      (t: any) => t.name === "open_study_terminal_demo",
    );
    assert.equal(
      embedded._meta.ui.resourceUri,
      "ui://zombie-study/terminal-demo-v1.html",
    );
    const resources = await (
      await post(
        "/mcp",
        { jsonrpc: "2.0", id: 40, method: "resources/list" },
        authorized,
      )
    ).json();
    assert.equal(resources.result.resources.length, 2);
    assert.ok(
      resources.result.resources.every(
        (r: any) => r.mimeType === "text/html;profile=mcp-app",
      ),
    );
    const liveTemplate = await (
      await post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 43,
          method: "resources/read",
          params: { uri: "ui://zombie-study/terminal-relay-v1.html" },
        },
        authorized,
      )
    ).json();
    assert.ok(
      liveTemplate.result.contents[0].text.includes(
        "claim_study_terminal_turn",
      ),
    );
    const template = await (
      await post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 41,
          method: "resources/read",
          params: { uri: embedded._meta.ui.resourceUri },
        },
        authorized,
      )
    ).json();
    assert.ok(template.result.contents[0].text.includes("ui/message"));
    const opened = await (
      await post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: { name: "open_study_terminal_demo", arguments: {} },
        },
        authorized,
      )
    ).json();
    assert.equal(opened.result.structuredContent.synthetic, true);
    assert.equal(opened.result.structuredContent.keys, 0);
    assert.equal(
      q.snapshot().enabled,
      false,
      "opening a synthetic demo does not release real game requests",
    );
    assert.equal(q.snapshot().enabled, false);
    assert.throws(() => bridge.newWorker(), /Release handoffs/);
    // The live terminal relay opens over OAuth alone but claims nothing until
    // the player releases sharing; it never serves non-terminal jobs.
    const relayOpened = await (
      await post(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 44,
          method: "tools/call",
          params: { name: "open_study_terminal", arguments: {} },
        },
        authorized,
      )
    ).json();
    const relay = relayOpened.result.structuredContent;
    assert.equal(relay.live, true);
    assert.equal(relay.released, false);
    assert.equal(q.snapshot().enabled, false);
    q.enable(true);
    const dialogue = q.enqueue("tutor", {
      requestId: "synthetic-terminal-dialogue",
      mode: "terminal-dialogue",
      problem: { title: "Synthetic", prompt: "Terminal", rubric: ["r"] },
      messages: [{ kind: "human", text: "hello", seq: 1 }],
    });
    // The game is waiting on this turn; the relay serves only waited-on turns.
    q.result(dialogue.id, dialogue.hash);
    const relayCall = async (name: string, args: unknown) =>
      (
        await (
          await post(
            "/mcp",
            {
              jsonrpc: "2.0",
              id: randomUUID(),
              method: "tools/call",
              params: { name, arguments: args },
            },
            authorized,
          )
        ).json()
      ).result;
    const relayClaimed = (
      await relayCall("claim_study_terminal_turn", {
        relayId: relay.relayId,
        revision: relay.revision,
      })
    ).structuredContent;
    assert.equal(relayClaimed.turn.requestId, "synthetic-terminal-dialogue");
    assert.match(relayClaimed.turn.prompt, /^@study\n/);
    assert.equal(q.snapshot().working, 1);
    assert.equal(bridge.status().terminalRelay.pendingTurns, 1);
    const relayReplied = (
      await relayCall("reply_study_terminal_job", {
        relayId: relay.relayId,
        turnId: relayClaimed.turn.turnId,
        text: "Synthetic relay reply",
        complete: false,
      })
    ).structuredContent;
    assert.equal(relayReplied.turn.status, "answered");
    assert.equal(q.snapshot().done, 1);
    const relayWrong = await relayCall("reply_study_terminal_job", {
      relayId: relay.relayId,
      turnId: relayClaimed.turn.turnId,
      text: "Changed",
      complete: true,
    });
    assert.equal(relayWrong.isError, true);
    assert.equal(q.snapshot().done, 1);
    q.enable(false);
    q.enable(true);
    const current = bridge.newWorker(),
      receipt = q.enqueue("tutor", {
        requestId: "protected-tutor",
        problem: { prompt: "Controlled private task" },
      });
    const rpc = async (name: string, args: unknown) =>
      parseTool(
        await (
          await post(
            "/mcp",
            {
              jsonrpc: "2.0",
              id: randomUUID(),
              method: "tools/call",
              params: { name, arguments: args },
            },
            authorized,
          )
        ).json(),
      );
    const wrong = await rpc("get_study_handoff", {
      session: "old-or-unknown-session",
    });
    assert.equal(wrong.status, "rejected");
    assert.equal(q.snapshot().queued, 1);
    const job = await rpc("get_study_handoff", { session: current.session });
    assert.equal(job.payload.requestId, "protected-tutor");
    const sent = await rpc("submit_study_handoff", {
      session: current.session,
      jobId: job.jobId,
      claim: job.claim,
      response: JSON.stringify({ text: "Controlled protected answer" }),
    });
    assert.equal(sent.status, "accepted");
    assert.deepEqual(q.result(receipt.id, receipt.hash).answer, {
      text: "Controlled protected answer",
    });
    const second = bridge.newWorker();
    assert.equal(
      (await rpc("get_study_handoff", { session: current.session })).status,
      "rejected",
    );
    const pending = q.enqueue("tutor", {
      requestId: "stopped-worker-test",
      problem: { prompt: "Synthetic stop test" },
    });
    const held = await rpc("get_study_handoff", { session: second.session });
    const heldTurn = q.enqueue("tutor", {
      requestId: "synthetic-terminal-held",
      mode: "terminal-dialogue",
      problem: { title: "Synthetic", prompt: "Held", rubric: [] },
      messages: [{ kind: "human", text: "held", seq: 1 }],
    });
    q.result(heldTurn.id, heldTurn.hash);
    const relayHeld = (
      await relayCall("claim_study_terminal_turn", {
        relayId: relay.relayId,
        revision: relayReplied.revision,
      })
    ).structuredContent;
    assert.equal(relayHeld.turn.requestId, "synthetic-terminal-held");
    assert.equal(q.snapshot().working, 2);
    q.enable(false);
    bridge.stopWorker();
    assert.equal(q.snapshot().enabled, false);
    assert.equal(q.snapshot().working, 0);
    assert.equal(q.snapshot().queued, 2);
    assert.equal(bridge.status().terminalRelay.pendingTurns, 0);
    const relayStopped = await relayCall("reply_study_terminal_job", {
      relayId: relay.relayId,
      turnId: relayHeld.turn.turnId,
      text: "Late",
      complete: true,
    });
    assert.equal(relayStopped.isError, true);
    assert.equal(q.snapshot().done, 2);
    assert.equal(bridge.status().workerActive, false);
    assert.equal(bridge.status().linked, true);
    assert.equal(
      (await rpc("get_study_handoff", { session: second.session })).status,
      "rejected",
    );
    q.enable(true);
    const relayAgain = (
      await relayCall("claim_study_terminal_turn", {
        relayId: relay.relayId,
        revision: relayHeld.revision,
      })
    ).structuredContent;
    assert.equal(relayAgain.turn.requestId, "synthetic-terminal-held");
    await relayCall("reply_study_terminal_job", {
      relayId: relay.relayId,
      turnId: relayAgain.turn.turnId,
      text: "Resumed relay reply",
      complete: true,
    });
    assert.equal(q.snapshot().queued, 1);
    const fresh = bridge.newWorker();
    const reclaimed = await rpc("get_study_handoff", {
      session: fresh.session,
    });
    assert.equal(reclaimed.jobId, pending.id);
    assert.notEqual(reclaimed.claim, held.claim);
    await rpc("submit_study_handoff", {
      session: fresh.session,
      jobId: reclaimed.jobId,
      claim: reclaimed.claim,
      response: JSON.stringify({ text: "Synthetic resumed answer" }),
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      originalGet = q.get;
    q.get = (...args: any[]) => {
      const value = originalGet(...args);
      if (value.status === "waiting") entered();
      return value;
    };
    const inFlight = rpc("get_study_handoff", { session: fresh.session });
    await waiting;
    const renewed = bridge.newWorker();
    q.enqueue("tutor", {
      requestId: "synthetic-after-renewal",
      text: "SYNTHETIC_RENEWAL_PRIVATE",
    });
    const retired = await inFlight;
    q.get = originalGet;
    assert.equal(
      retired.status,
      "rejected",
      "A retired long poll must not read a packet arriving after renewal",
    );
    assert.equal(q.snapshot().working, 0);
    assert.equal(q.snapshot().queued, 1);
    const renewalJob = await rpc("get_study_handoff", {
      session: renewed.session,
    });
    await rpc("submit_study_handoff", {
      session: renewed.session,
      jobId: renewalJob.jobId,
      claim: renewalJob.claim,
      response: JSON.stringify({ text: "Synthetic current-session answer" }),
    });
    const prefix = "synthetic-optional-probe/";
    q.enqueue("tutor", {
      requestId: "synthetic-unrelated-private",
      text: "SYNTHETIC_NOT_APPROVED_FOR_SCOPED_WORKER",
    });
    q.enqueue("tutor", {
      requestId: prefix + "only-approved-packet",
      text: "Synthetic approved packet",
    });
    const scoped = bridge.newWorker(prefix);
    assert.equal(bridge.status().workerScoped, true);
    assert.ok(scoped.starter.includes(prefix));
    assert.throws(() => bridge.newWorker(""), /scope/);
    // Extra model arguments cannot widen the owner-captured scope.
    const scopedJob = await rpc("get_study_handoff", {
      session: scoped.session,
      requestPrefix: "synthetic-unrelated",
    });
    assert.equal(scopedJob.payload.requestId, prefix + "only-approved-packet");
    assert.ok(
      !JSON.stringify(scopedJob).includes(
        "SYNTHETIC_NOT_APPROVED_FOR_SCOPED_WORKER",
      ),
    );
    await rpc("submit_study_handoff", {
      session: scoped.session,
      jobId: scopedJob.jobId,
      claim: scopedJob.claim,
      response: JSON.stringify({ text: "Scoped synthetic answer" }),
    });
    assert.equal(q.snapshot().queued, 1);
    const normal = bridge.newWorker();
    assert.equal(bridge.status().workerScoped, false);
    assert.equal(
      (await rpc("get_study_handoff", { session: scoped.session })).status,
      "rejected",
    );
    const unrelated = await rpc("get_study_handoff", {
      session: normal.session,
    });
    assert.equal(unrelated.payload.requestId, "synthetic-unrelated-private");
    await rpc("submit_study_handoff", {
      session: normal.session,
      jobId: unrelated.jobId,
      claim: unrelated.claim,
      response: JSON.stringify({
        text: "Separately authorized synthetic answer",
      }),
    });
    // The ordinary composer flow uses normal OAuth tool results and one final
    // callback. Legacy worker pulls cannot consume the native question.
    const native = q.enqueue("tutor", {
      requestId: "synthetic-native-protected",
      sessionId: "synthetic-native-session",
      questionFingerprint: "synthetic-native-fingerprint",
      mode: "terminal-direct",
      probe: {
        facets: [{ id: "stale-results", description: "Avoid stale results" }],
      },
      problem: {
        title: "Synthetic UI",
        prompt: "How do you avoid stale results?",
        rubric: [],
      },
      messages: [],
    });
    q.result(native.id, native.hash);
    const legacyAlongside = q.enqueue("tutor", {
      requestId: "synthetic-legacy-alongside-native",
    });
    const alongside = await rpc("get_study_handoff", {
      session: normal.session,
    });
    assert.equal(
      alongside.payload.requestId,
      "synthetic-legacy-alongside-native",
    );
    await rpc("submit_study_handoff", {
      session: normal.session,
      jobId: alongside.jobId,
      claim: alongside.claim,
      response: JSON.stringify({ text: "Synthetic legacy response" }),
    });
    assert.equal(
      q.result(legacyAlongside.id, legacyAlongside.hash).status,
      "done",
    );
    const direct = (await relayCall("get_current_study_question", {}))
      .structuredContent;
    assert.equal(direct.status, "question");
    assert.equal(direct.requestId, "synthetic-native-protected");
    assert.match(direct.prompt, /ordinary ChatGPT composer/);
    const nativeAnswer = {
      relayId: direct.relayId,
      turnId: direct.turnId,
      questionFingerprint: direct.questionFingerprint,
      text: "Synthetic native completion sent for validation.",
      outcome: "solved",
      knowledge: { facets: [{ id: "stale-results", status: "demonstrated" }] },
      transcript: [
        { role: "assistant", text: "How do you avoid stale results?" },
        {
          role: "user",
          text: "SYNTHETIC_NATIVE_PRIVATE: ignore responses for old request IDs.",
        },
      ],
    };
    assert.equal(
      (
        await relayCall("finish_study_question", {
          ...nativeAnswer,
          complete: true,
        })
      ).isError,
      true,
    );
    assert.equal(
      (
        await relayCall("finish_study_question", {
          ...nativeAnswer,
          questionFingerprint: "wrong",
        })
      ).isError,
      true,
    );
    assert.equal(q.result(native.id, native.hash).status, "pending");
    const sentNative = (await relayCall("finish_study_question", nativeAnswer))
      .structuredContent;
    assert.equal(sentNative.completion.status, "sent");
    assert.equal(sentNative.completion.duplicate, false);
    assert.equal(q.result(native.id, native.hash).answer.complete, true);
    assert.deepEqual(
      q.result(native.id, native.hash).answer.transcript,
      nativeAnswer.transcript,
    );
    assert.equal(
      (await relayCall("finish_study_question", nativeAnswer)).structuredContent
        .completion.duplicate,
      true,
    );
    const finishEvents = bridge
      .status()
      .diagnostics.filter(
        (event: any) =>
          event.kind === "tool-result" &&
          event.tool === "finish_study_question" &&
          event.outcome === "sent",
      );
    assert.deepEqual(
      finishEvents.map((event: any) => event.duplicate),
      [false, true],
    );
    assert.equal(
      (
        await relayCall("finish_study_question", {
          ...nativeAnswer,
          text: "changed",
        })
      ).isError,
      true,
    );
    // Native preparation uses the same ordinary-chat OAuth identity, never a
    // fabricated legacy session. The async after branch must be awaited by
    // the actual MCP HTTP dispatcher before it serializes its result.
    const nativeScope = {
      runId: "synthetic-protected-native-run",
      encounterId: "synthetic-protected-native-station",
      questionRoom: "synthetic-protected-native-room",
    };
    const preparationPayload = {
      requestId: "synthetic-protected-preparation",
      encounterId: nativeScope.encounterId,
      contract: { track: "PY", objectiveIds: ["PY:fixture"], depth: 1 },
      generationPolicy: "Exact synthetic preparation policy",
      curriculum: "PRIVATE_PREPARATION_SOURCE_ROWS",
    };
    const preparationReceipt = q.enqueue(
      "generate",
      preparationPayload,
      nativeScope,
    );
    q.result(preparationReceipt.id, preparationReceipt.hash);
    const legacyPreparationNeighbor = q.enqueue("tutor", {
      requestId: "synthetic-legacy-neighbor-preparation",
    });
    const legacyNeighbor = await rpc("get_study_handoff", {
      session: normal.session,
    });
    assert.equal(legacyNeighbor.jobId, legacyPreparationNeighbor.id);
    await rpc("submit_study_handoff", {
      session: normal.session,
      jobId: legacyNeighbor.jobId,
      claim: legacyNeighbor.claim,
      response: JSON.stringify({ text: "Synthetic legacy neighbor" }),
    });
    const preparation = (await relayCall("get_current_study_question", {}))
      .structuredContent;
    assert.equal(preparation.phase, "prepare");
    assert.equal(preparation.jobFingerprint, preparationReceipt.hash);
    assert.ok(preparation.prompt.includes("PRIVATE_PREPARATION_SOURCE_ROWS"));
    const prepared = (
      await relayCall("finish_study_preparation", {
        relayId: preparation.relayId,
        turnId: preparation.turnId,
        jobFingerprint: preparation.jobFingerprint,
        response: JSON.stringify({
          title: "Synthetic prepared question",
          prompt: "Explain stale results",
          starter: "",
          rubric: ["Avoid stale results"],
          contract: preparationPayload.contract,
          scopeDefinitions: [
            {
              id: "PY:fixture/D1",
              objectiveId: "PY:fixture",
              depth: 1,
              sourceScope: "Synthetic source scope",
              facets: [
                { id: "stale-results", description: "Avoid stale results" },
              ],
            },
          ],
        }),
      })
    ).structuredContent;
    assert.equal(prepared.completion.status, "sent");
    const nextNativePayload = {
      requestId: "synthetic-protected-prepared-question",
      sessionId: "synthetic-protected-prepared-session",
      runId: nativeScope.runId,
      encounterId: nativeScope.encounterId,
      mode: "terminal-direct",
      profile: "live",
      questionFingerprint: "synthetic-protected-prepared-fingerprint",
      probe: {
        facets: [{ id: "stale-results", description: "Avoid stale results" }],
      },
      problem: {
        title: "Synthetic prepared question",
        prompt: "Explain stale results",
        rubric: [],
      },
    };
    // Four outstanding continuations fill the bounded bridge. A completion
    // arriving then must be an explicit retryable tool error, never success.
    const waitingNext = Promise.all(
      Array.from({ length: 4 }, () =>
        relayCall("get_current_study_question", {
          after: prepared.completion.continuation.after,
        }),
      ),
    );
    let saturated = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const calls = bridge
        .status()
        .diagnostics.filter((event: any) => event.kind === "tool-call")
        .slice(-4);
      saturated =
        calls.length === 4 &&
        calls.every(
          (event: any) => event.tool === "get_current_study_question",
        );
      if (saturated) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(saturated, true);
    const busyFinish = await relayCall("finish_study_question", nativeAnswer);
    const nextArrival = new Promise<void>((resolve) =>
      setTimeout(() => {
        const queued = q.enqueue("tutor", nextNativePayload, nativeScope);
        q.result(queued.id, queued.hash);
        resolve();
      }, 25),
    );
    const nextNative = (await waitingNext)[0].structuredContent;
    await nextArrival;
    assert.equal(busyFinish.isError, true);
    assert.equal(busyFinish.structuredContent.status, "retryable");
    assert.equal(busyFinish.structuredContent.reason, "bridge_busy");
    assert.ok(
      bridge
        .status()
        .diagnostics.some(
          (event: any) =>
            event.kind === "tool-result" &&
            event.tool === "finish_study_question" &&
            event.status === "retryable" &&
            event.reason === "bridge_busy",
        ),
    );
    assert.equal(nextNative.status, "question");
    assert.equal(nextNative.requestId, nextNativePayload.requestId);
    assert.equal(
      (
        await relayCall("finish_study_question", {
          ...nativeAnswer,
          relayId: nextNative.relayId,
          turnId: nextNative.turnId,
          questionFingerprint: nextNative.questionFingerprint,
        })
      ).structuredContent.completion.continuation.expected,
      "assessment",
    );
    // Large chat-scoped preparation must remain readable through the actual
    // protected tool dispatcher without exposing its chunks to another chat.
    const contextChat = "CONTEXT1";
    const scopedPayload = {
      ...preparationPayload,
      requestId: "synthetic-protected-scoped-context",
      curriculum: "PRIVATE_SCOPED_CONTEXT_ROW 🙂\n".repeat(6000),
    };
    const scopedReceipt = q.enqueue(
      "generate",
      scopedPayload,
      nativeScope,
      contextChat,
    );
    q.result(scopedReceipt.id, scopedReceipt.hash);
    const scopedTurn = (
      await relayCall("get_current_study_question", { chat: contextChat })
    ).structuredContent;
    assert.equal(scopedTurn.phase, "prepare");
    assert.ok(!scopedTurn.prompt.includes(scopedPayload.curriculum));
    const contextArgs = {
      relayId: scopedTurn.relayId,
      turnId: scopedTurn.turnId,
      part: "payload",
      index: 0,
    };
    for (const [args, error] of [
      [contextArgs, /chat code/i],
      [{ ...contextArgs, chat: "OTHERCHAT" }, /disconnected/i],
    ] as const) {
      const rejected = await relayCall("read_study_terminal_context", args);
      assert.equal(rejected.isError, true);
      assert.match(JSON.parse(rejected.content[0].text).note, error);
      assert.ok(
        !JSON.stringify(rejected).includes("PRIVATE_SCOPED_CONTEXT_ROW"),
      );
    }
    assert.deepEqual(
      (await relayCall("get_current_study_question", { chat: contextChat }))
        .structuredContent,
      scopedTurn,
      "rejected context reads preserve the pending scoped claim",
    );
    const firstChunk = (
      await relayCall("read_study_terminal_context", {
        ...contextArgs,
        chat: contextChat,
      })
    ).structuredContent;
    assert.ok(firstChunk.parts > 1);
    const chunks = [firstChunk.text];
    for (let index = 1; index < firstChunk.parts; index++)
      chunks.push(
        (
          await relayCall("read_study_terminal_context", {
            ...contextArgs,
            chat: contextChat,
            index,
          })
        ).structuredContent.text,
      );
    assert.deepEqual(JSON.parse(chunks.join("")), scopedPayload);
    const scopedCompletion = (
      await relayCall("finish_study_preparation", {
        relayId: scopedTurn.relayId,
        turnId: scopedTurn.turnId,
        jobFingerprint: scopedTurn.jobFingerprint,
        response: JSON.stringify(
          q.result(preparationReceipt.id, preparationReceipt.hash).answer,
        ),
      })
    ).structuredContent;
    assert.equal(scopedCompletion.completion.status, "sent");
    assert.equal(q.result(scopedReceipt.id, scopedReceipt.hash).status, "done");
    await post(
      "/mcp",
      { jsonrpc: "2.0", id: randomUUID(), method: "tools/list" },
      authorized,
    );
    const disk = readFileSync(join(dir, "oauth.json"), "utf8");
    assert.ok(!disk.includes(token.access_token));
    assert.ok(!disk.includes(token.refresh_token));
    assert.ok(!disk.includes(pairingCode));
    const rejectedFinish = await relayCall("finish_study_question", {
      relayId: "SYNTHETIC_NATIVE_PRIVATE",
      turnId: "missing",
    });
    assert.equal(rejectedFinish.isError, true);
    const diagnostics = bridge.status().diagnostics;
    assert.ok(
      diagnostics.some(
        (event: any) =>
          event.kind === "tool-call" && event.tool === "finish_study_question",
      ),
    );
    assert.ok(
      diagnostics.some(
        (event: any) =>
          event.kind === "tool-result" &&
          event.tool === "finish_study_question" &&
          event.status === "returned",
      ),
    );
    assert.ok(
      diagnostics.some(
        (event: any) =>
          event.kind === "tool-result" &&
          event.tool === "finish_study_question" &&
          event.status === "rejected",
      ),
    );
    assert.ok(
      diagnostics.some(
        (event: any) => event.kind === "rpc" && event.method === "tools/list",
      ),
    );
    assert.ok(diagnostics.length <= 64);
    const diagnosticText = JSON.stringify(diagnostics);
    for (const secret of [
      token.access_token,
      token.refresh_token,
      pairingCode,
      current.session,
      second.session,
      fresh.session,
      renewed.session,
      scoped.session,
      normal.session,
      scopedJob.claim,
      prefix,
      held.claim,
      "SYNTHETIC_NATIVE_PRIVATE",
      "PRIVATE_PREPARATION_SOURCE_ROWS",
      "PRIVATE_SCOPED_CONTEXT_ROW",
    ])
      assert.ok(!diagnosticText.includes(secret));
    // A consumer cannot mutate the retained diagnostic events through status.
    diagnostics[0].kind = "modified";
    assert.notEqual(bridge.status().diagnostics[0].kind, "modified");
    bridge.revoke();
    assert.equal(q.snapshot().enabled, false);
    assert.equal(
      (
        await post(
          "/mcp",
          { jsonrpc: "2.0", id: 5, method: "tools/list" },
          authorized,
        )
      ).status,
      401,
    );
  } finally {
    await bridge.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("public connector refuses unsafe hostname or bridge directory and starts with no restored worker session", () => {
  const q = createHandoffQueue(),
    dir = mkdtempSync(join(tmpdir(), "dead-air-public-"));
  try {
    for (const hostname of [
      "lullascape.com",
      "infinite.example",
      "https://game.lullascape.com",
      "-bad.lullascape.com",
      "game.lullascape.com.evil.invalid",
    ])
      assert.throws(
        () => createPublicHandoffBridge({ hostname, queue: q, directory: dir }),
        /distinct game hostname/,
      );
    const bridge = createPublicHandoffBridge({
      hostname,
      queue: q,
      directory: dir,
    });
    assert.equal(bridge.status().workerActive, false);
    assert.equal(bridge.status().linked, false);
    assert.ok(bridge.openPairing().pairingCode);
    assert.equal(bridge.status().pairingOpen, true);
    assert.equal(q.snapshot().enabled, false);
    assert.equal(q.snapshot().queued, 0);
    bridge.closePairing();
    assert.equal(bridge.status().pairingOpen, false);
    assert.throws(() => bridge.newWorker(), /Release handoffs/);
    void bridge.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
