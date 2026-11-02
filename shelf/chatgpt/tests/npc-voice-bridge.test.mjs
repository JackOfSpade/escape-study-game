// Isolated temporary queues, synthetic workers and fake PCM; no live connector.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createHandoffQueue,
  NPC_CHATTER_TTL_MS,
} from "../scripts/chatgpt-handoff-queue.mjs";
import { createHandoffRoutes } from "../scripts/chatgpt-handoff-routes.mjs";
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";
import { createNpcSpeechService } from "../scripts/npc-speech-service.mjs";
import { sha256 } from "../scripts/lib/digest.mjs";
import {
  buildNpcDialogueReview,
  npcDialogueCandidateSource,
} from "../scripts/lib/npc-dialogue-policy.mjs";

const origin = "http://127.0.0.1:5173",
  worker = "synthetic-npc-worker";
const chatter = (id = "synthetic-chatter-1") => ({
  version: 1,
  requestId: id,
  runId: "synthetic-run",
  actorId: "npc-2",
  self: { id: "npc-2", name: "Synthetic survivor", activity: "exploring" },
  location: { floor: 0, position: { x: 20, y: 20 } },
  perception: { threatBand: "clear", visibleThreats: [] },
  instruction: "Use only this synthetic situation. No real learner records.",
});
const answer = (request) => ({
  requestId: request.requestId,
  actorId: request.actorId,
  text: "We can take the stairs once this room is clear.",
  delivery: "calm",
});
const dialogue = (id = "synthetic-grounded-dialogue") => ({
  ...chatter(id),
  capturedAt: 20,
  setting: "A continuing zombie catastrophe. Extraction is on the roof.",
  dialogue: {
    version: 1,
    facts: [
      {
        id: "setting.outbreak",
        kind: "setting",
        text: "The outbreak continues even when no threat is visible nearby.",
        key: "ongoing-outbreak",
      },
    ],
  },
});
const draft = (request) => ({
  requestId: request.requestId,
  actorId: request.actorId,
  decision: "speak",
  text: "Stay close. We still need to reach the roof.",
  purpose: "Keep the nearby group together during evacuation.",
  evidence: ["setting.outbreak"],
  delivery: "calm",
});
const reviewAnswer = (request, verdict = "accept") => ({
  requestId: request.requestId,
  actorId: request.actorId,
  candidateFingerprint: request.candidateFingerprint,
  verdict,
  issues: verdict === "revise" ? ["off-topic"] : [],
  note:
    verdict === "accept"
      ? "A brief grounded evacuation check-in."
      : "There is no reason for that small talk now.",
});
async function tempQueue(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "npc-voice-bridge-test-")),
    file = join(directory, "jobs.json"),
    queue = createHandoffQueue({ file, ...options });
  t.after(() => rm(directory, { recursive: true, force: true }));
  queue.enable(true);
  return { queue, directory, file };
}
async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}
function post(base, path, body, headers = {}) {
  return fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}
const resultPath = (receipt) =>
  `/api/bridge/result?id=${receipt.id}&hash=${receipt.hash}`;

function fakeWave() {
  const bytes = Buffer.alloc(44 + 4410);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(22050, 24);
  bytes.writeUInt32LE(44100, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(4410, 40);
  return bytes;
}

test("ambient jobs yield priority and transport capacity to every study operation", () => {
  const queue = createHandoffQueue();
  queue.enable(true);
  const voice = queue.enqueue("npc-chatter", chatter());
  const operations = ["assess", "group", "complete", "generate", "tutor"];
  const receipts = operations.map((operation) =>
    queue.enqueue(operation, {
      requestId: `synthetic-${operation}`,
      submitter: "human",
    }),
  );
  const served = operations.map((_, i) => queue.get(`study-worker-${i}`));
  assert.deepEqual(
    served.map((job) => job.operation),
    ["tutor", "generate", "complete", "group", "assess"],
  );
  assert.deepEqual(
    new Set(served.map((job) => job.jobId)),
    new Set(receipts.map((r) => r.id)),
  );
  assert.equal(queue.get(worker).jobId, voice.id);
  const small = createHandoffQueue({ maxJobs: 4 });
  small.enable(true);
  for (let i = 0; i < 4; i++)
    small.enqueue("npc-chatter", chatter(`ambient-${i}`));
  const study = small.enqueue("tutor", {
    requestId: "synthetic-important-study",
  });
  assert.equal(
    small.snapshot().queued,
    1,
    "temporary voices leave capacity for retained study",
  );
  assert.equal(small.get(worker).jobId, study.id);
});

test("NPC replies retain exact identity and reject markup, tool envelopes and altered contracts", () => {
  const queue = createHandoffQueue();
  queue.enable(true);
  const request = chatter(),
    receipt = queue.enqueue("npc-chatter", request),
    job = queue.get(worker),
    valid = answer(request);
  assert.match(job.instructions, /plain-text line/);
  assert.match(job.instructions, /untrusted evidence/);
  assert.doesNotMatch(
    job.instructions,
    /^@study/,
    "ambient speech must not turn into a tutoring session",
  );
  for (const bad of [
    { ...valid, actorId: "npc-3" },
    { ...valid, requestId: "other-request" },
    { ...valid, text: "<voice>Keep moving</voice>" },
    { ...valid, text: "[[slnc 800]]" },
    { ...valid, text: "```run-code```" },
    { ...valid, text: "two\nlines" },
    { ...valid, text: "https://example.com" },
    { ...valid, text: "x".repeat(181) },
    { ...valid, delivery: "screaming" },
    { ...valid, tool_calls: [{ name: "execute" }] },
    { ...valid, toolOutput: "Synthetic output" },
    { ...valid, text: { tool: "execute" } },
  ]) {
    assert.throws(
      () => queue.submit(worker, job.jobId, job.claim, bad),
      /exact NPC\/request identity/,
    );
    assert.equal(queue.result(receipt.id, receipt.hash).status, "pending");
  }
  assert.equal(
    queue.submit(worker, job.jobId, job.claim, valid).status,
    "accepted",
  );
  assert.deepEqual(queue.result(receipt.id, receipt.hash), {
    status: "done",
    answer: valid,
  });
});

test("temporary chatter has a four-job ceiling, idempotent retries and a fixed two-minute lifetime", () => {
  let clock = 1000;
  const queue = createHandoffQueue({ now: () => clock });
  queue.enable(true);
  const requests = Array.from({ length: 4 }, (_, i) =>
      chatter(`synthetic-limited-${i}`),
    ),
    receipts = requests.map((p) => queue.enqueue("npc-chatter", p)),
    job = queue.get(worker);
  assert.deepEqual(
    queue.enqueue("npc-chatter", requests[0]),
    receipts[0],
    "a retry at capacity returns its original receipt instead of rejecting the waiting game",
  );
  assert.throws(
    () => queue.enqueue("npc-chatter", chatter("fifth")),
    /excessive/,
  );
  clock += NPC_CHATTER_TTL_MS - 1;
  assert.equal(queue.snapshot().queued + queue.snapshot().working, 4);
  clock++;
  assert.equal(queue.snapshot().queued + queue.snapshot().working, 0);
  assert.throws(
    () => queue.result(receipts[0].id, receipts[0].hash),
    /Unknown exact/,
  );
  assert.throws(
    () => queue.submit(worker, job.jobId, job.claim, answer(requests[0])),
    /Wrong worker/,
  );
  assert.equal(
    queue.enqueue("npc-chatter", chatter("fresh-after-expiry")).id.length > 0,
    true,
  );
});

test("situational prompts and generated voices never enter the durable queue file", async (t) => {
  const { queue, file } = await tempQueue(t),
    request = chatter("SYNTHETIC_EPHEMERAL_REQUEST"),
    study = queue.enqueue("tutor", {
      requestId: "retained-synthetic-study",
      text: "synthetic study fixture",
    }),
    voice = queue.enqueue("npc-chatter", request);
  // A selector isolates the voice to exercise claiming/submission while retained study exists.
  const job = queue.get(
      worker,
      undefined,
      (j) => j.operation === "npc-chatter",
    ),
    reply = { ...answer(request), text: "SYNTHETIC_EPHEMERAL_SPOKEN_LINE" };
  queue.submit(worker, job.jobId, job.claim, reply);
  for (const marker of [
    request.requestId,
    request.actorId,
    reply.text,
    voice.id,
    "npc-chatter",
  ])
    assert.equal(
      (await readFile(file, "utf8")).includes(marker),
      false,
      marker,
    );
  const disk = JSON.parse(await readFile(file, "utf8"));
  assert.equal(disk.jobs.length, 1);
  assert.equal(disk.jobs[0].id, study.id);
  const restored = createHandoffQueue({ file });
  restored.enable(true);
  assert.throws(() => restored.result(voice.id, voice.hash), /Unknown exact/);
  assert.equal(restored.result(study.id, study.hash).status, "pending");
});

test("HTTP cancellation discards only exact ambient receipts and preserves study jobs", async (t) => {
  const { queue } = await tempQueue(t),
    handoff = createHandoffRoutes(queue, { token: "synthetic-worker-token" }),
    base = await listen(t, createStudyBridgeServer({ handoff }));
  const voiceResponse = await post(base, "/api/bridge", {
    operation: "npc-chatter",
    provider: "chatgpt-handoff",
    payload: chatter(),
  });
  assert.equal(voiceResponse.status, 202);
  const voice = (await voiceResponse.json()).handoff,
    studyResponse = await post(base, "/api/bridge", {
      operation: "tutor",
      provider: "chatgpt-handoff",
      payload: { requestId: "synthetic-cannot-cancel-study" },
    }),
    study = (await studyResponse.json()).handoff;
  const denied = await fetch(base + resultPath(voice), {
    method: "DELETE",
    headers: { Origin: "http://localhost:9999" },
  });
  assert.equal(denied.status, 403);
  assert.equal(
    (
      await fetch(base + resultPath({ ...voice, hash: "wrong-hash" }), {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
    200,
  );
  assert.equal(
    queue.result(voice.id, voice.hash).status,
    "pending",
    "a mismatched receipt cannot discard the actual voice request",
  );
  assert.equal(
    (
      await fetch(base + resultPath(study), {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
    409,
  );
  assert.equal(queue.result(study.id, study.hash).status, "pending");
  assert.equal(
    (
      await fetch(base + resultPath(voice), {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
    200,
  );
  assert.throws(() => queue.result(voice.id, voice.hash), /Unknown exact/);
  assert.equal(queue.result(study.id, study.hash).status, "pending");
});

test("ambient forwarding binds both captured provider fields and never crosses provider state", async (t) => {
  let upstreamCalls = 0;
  const upstream = createServer(async (req, res) => {
      for await (const _ of req) {
        /* consume synthetic request only */
      }
      upstreamCalls++;
      res.setHeader("Content-Type", "application/json");
      res.end("{}");
    }),
    endpoint = await listen(t, upstream),
    { queue } = await tempQueue(t),
    handoff = createHandoffRoutes(queue, { token: "synthetic-worker-token" }),
    base = await listen(t, createStudyBridgeServer({ endpoint, handoff }));
  const context = dialogue("synthetic-provider-review"),
    review = await buildNpcDialogueReview(context, draft(context), 0);
  for (const body of [
    {
      operation: "npc-chatter",
      provider: "study-mode",
      payload: chatter("top-level-mismatch"),
    },
    {
      operation: "npc-chatter",
      provider: "chatgpt-handoff",
      payload: { ...chatter("payload-mismatch"), provider: "study-mode" },
    },
    {
      operation: "npc-chatter-review",
      provider: "study-mode",
      payload: review,
    },
    {
      operation: "npc-chatter-review",
      provider: "chatgpt-handoff",
      payload: { ...review, provider: "study-mode" },
    },
  ])
    assert.equal((await post(base, "/api/bridge", body)).status, 409);
  assert.equal(queue.snapshot().queued, 0);
  assert.equal(upstreamCalls, 0);
  queue.enable(false);
  for (const [operation, payload] of [
    ["npc-chatter", chatter("provider-changed")],
    ["npc-chatter-review", review],
  ])
    assert.equal(
      (
        await post(base, "/api/bridge", {
          operation,
          provider: "chatgpt-handoff",
          payload,
        })
      ).status,
      409,
    );
  assert.equal(upstreamCalls, 0);
});

test("the actual loopback bridge carries a validated line into a one-use local WAV without study side effects", async (t) => {
  const { queue, directory } = await tempQueue(t),
    rendered = [],
    speech = createNpcSpeechService({
      tempRoot: directory,
      render: async (request) => {
        rendered.push(request);
        return fakeWave();
      },
    });
  t.after(() => speech.close());
  const handoff = createHandoffRoutes(queue, {
      token: "synthetic-worker-token",
    }),
    base = await listen(t, createStudyBridgeServer({ handoff, speech })),
    status = await (await fetch(base + "/api/status")).json();
  assert.ok(status.capabilities.includes("npc-chatter"));
  assert.equal(
    (await (await fetch(base + "/api/speech/status")).json()).available,
    true,
  );
  const request = chatter("synthetic-audible-line"),
    response = await post(base, "/api/bridge", {
      operation: "npc-chatter",
      provider: "chatgpt-handoff",
      payload: request,
    }),
    receipt = (await response.json()).handoff,
    job = queue.get(worker),
    reply = answer(request);
  queue.submit(worker, job.jobId, job.claim, reply);
  assert.deepEqual(
    await (await fetch(base + resultPath(receipt))).json(),
    reply,
  );
  const spokenResponse = await post(base, "/api/speech", {
      requestId: reply.requestId,
      actorId: reply.actorId,
      text: reply.text,
      voice: "steady",
    }),
    spoken = await spokenResponse.json();
  assert.equal(spokenResponse.status, 200);
  assert.equal(spoken.text, reply.text);
  assert.equal(rendered[0].text, reply.text);
  const wav = await fetch(base + spoken.audio.url);
  assert.equal(wav.headers.get("content-type"), "audio/wav");
  assert.deepEqual(Buffer.from(await wav.arrayBuffer()), fakeWave());
  assert.equal((await fetch(base + spoken.audio.url)).status, 410);
  assert.equal(speech.status().pending, 0);
  const tempDirectories = (await readdir(directory)).filter((name) =>
    name.startsWith("zombie-npc-speech-"),
  );
  for (const child of tempDirectories)
    assert.deepEqual(await readdir(join(directory, child)), []);
  assert.equal(
    (
      await fetch(base + resultPath(receipt), {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
    200,
  );
  assert.equal(queue.snapshot().done, 0);
  assert.equal(
    JSON.parse(await readFile(join(directory, "jobs.json"), "utf8")).jobs
      .length,
    0,
  );
});

test("new dialogue drafts allow creative speech or silence but require correlated known evidence", () => {
  for (const silent of [false, true]) {
    const queue = createHandoffQueue();
    queue.enable(true);
    const request = dialogue(silent ? "synthetic-silence" : "synthetic-speech"),
      receipt = queue.enqueue("npc-chatter", request),
      job = queue.get(worker),
      reply = silent
        ? {
            requestId: request.requestId,
            actorId: request.actorId,
            decision: "silent",
            reason: "Quiet is useful here.",
          }
        : draft(request);
    assert.match(job.instructions, /Silence is a valid/);
    assert.doesNotMatch(job.instructions, /^@study/);
    for (const bad of [
      answer(request),
      { ...draft(request), evidence: ["hidden.enemies"] },
      { ...draft(request), evidence: [] },
      { ...draft(request), actorId: "npc-elsewhere" },
    ])
      assert.throws(
        () => queue.submit(worker, job.jobId, job.claim, bad),
        /NPC dialogue draft/,
      );
    assert.equal(
      queue.submit(worker, job.jobId, job.claim, reply).status,
      "accepted",
    );
    assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, reply);
  }
  const queue = createHandoffQueue();
  queue.enable(true);
  assert.throws(
    () =>
      queue.enqueue("npc-chatter", {
        ...dialogue(),
        dialogue: { version: 1, facts: [] },
      }),
    /Invalid or excessive/,
  );
});

test("critic packets and replies bind the exact draft, not just a plausible-looking NPC identity", async () => {
  const queue = createHandoffQueue();
  queue.enable(true);
  const context = dialogue(),
    candidate = draft(context),
    request = await buildNpcDialogueReview(context, candidate, 0);
  assert.equal(
    request.candidateFingerprint,
    sha256(npcDialogueCandidateSource(candidate)),
  );
  for (const bad of [
    { ...request, candidateFingerprint: "f".repeat(64) },
    { ...request, candidate: { ...candidate, text: "A different candidate." } },
    { ...request, actorId: "npc-other" },
    { ...request, runId: "different-run" },
    { ...request, capturedAt: context.capturedAt + 1 },
    { ...request, candidate: { ...candidate, evidence: ["unknown.fact"] } },
    { ...request, attempt: 2 },
  ])
    assert.throws(
      () => queue.enqueue("npc-chatter-review", bad),
      /Invalid or excessive/,
    );
  const receipt = queue.enqueue("npc-chatter-review", request),
    job = queue.get(worker),
    reply = reviewAnswer(request);
  assert.match(job.instructions, /Evaluate the candidate independently/);
  assert.doesNotMatch(job.instructions, /^@study/);
  for (const bad of [
    { ...reply, candidateFingerprint: "0".repeat(64) },
    { ...reply, requestId: context.requestId },
    { ...reply, verdict: "accept", issues: ["off-topic"] },
    { ...reply, verdict: "revise", issues: [] },
    { ...reply, issues: ["arbitrary-score"] },
    { ...reply, replacement: "Do not play this unreviewed replacement." },
  ])
    assert.throws(
      () => queue.submit(worker, job.jobId, job.claim, bad),
      /NPC dialogue review/,
    );
  assert.equal(
    queue.submit(worker, job.jobId, job.claim, reply).status,
    "accepted",
  );
  assert.deepEqual(queue.result(receipt.id, receipt.hash).answer, reply);
});

test("conversation replies must target a heard turn and the critic binds their exact continuation intent", async () => {
  const context = dialogue("synthetic-conversation-reply");
  context.recentLines = [
    {
      id: "spoken-water-call",
      actorId: "npc-3",
      speakerName: "Synthetic listener",
      text: "Anyone got some water?",
      at: 18,
      conversationId: "synthetic-exchange",
      turn: 1,
    },
  ];
  context.conversation = {
    id: "synthetic-exchange",
    replyTo: "spoken-water-call",
    sourceActorId: "npc-3",
    turn: 2,
    maxTurns: 4,
    expiresAt: 48,
  };
  context.dialogue.facts.push({
    id: "speech:spoken-water-call",
    kind: "event",
    text: "You heard someone nearby say: Anyone got some water?",
    key: "synthetic-heard-water-request",
    expiresAt: 48,
  });
  const candidate = {
    ...draft(context),
    text: "I heard you. We still need to keep moving.",
    evidence: ["speech:spoken-water-call", "setting.outbreak"],
    conversation: { intent: "continue", replyTo: "spoken-water-call" },
  };
  for (const modify of [
    (bad) => {
      bad.recentLines = [];
    },
    (bad) => {
      bad.recentLines[0].actorId = "unheard-actor";
    },
    (bad) => {
      bad.recentLines[0].conversationId = "unrelated-exchange";
    },
    (bad) => {
      bad.recentLines[0].turn = 2;
    },
    (bad) => {
      bad.recentLines[0].at = 21;
    },
    (bad) => {
      bad.conversation.expiresAt = 20;
    },
    (bad) => {
      bad.conversation.expiresAt = 51;
    },
    (bad) => {
      bad.conversation.turn = 5;
    },
  ]) {
    const queue = createHandoffQueue(),
      bad = structuredClone(context);
    queue.enable(true);
    modify(bad);
    assert.throws(
      () => queue.enqueue("npc-chatter", bad),
      /Invalid or excessive/,
    );
  }
  const queue = createHandoffQueue();
  queue.enable(true);
  const receipt = queue.enqueue("npc-chatter", context),
    job = queue.get(worker);
  for (const bad of [
    { ...candidate, conversation: undefined },
    { ...candidate, conversation: { intent: "invite" } },
    {
      ...candidate,
      conversation: { intent: "continue", replyTo: "unheard-turn" },
    },
    { ...candidate, evidence: ["setting.outbreak"] },
  ])
    assert.throws(
      () => queue.submit(worker, job.jobId, job.claim, bad),
      /NPC dialogue draft/,
    );
  queue.submit(worker, job.jobId, job.claim, candidate);
  assert.deepEqual(
    queue.result(receipt.id, receipt.hash).answer.conversation,
    candidate.conversation,
  );
  queue.discardChatter(receipt.id, receipt.hash);
  const packet = await buildNpcDialogueReview(context, candidate, 0),
    close = await buildNpcDialogueReview(
      context,
      {
        ...candidate,
        conversation: { intent: "close", replyTo: "spoken-water-call" },
      },
      0,
    );
  assert.notEqual(packet.candidateFingerprint, close.candidateFingerprint);
  assert.throws(
    () =>
      queue.enqueue("npc-chatter-review", {
        ...packet,
        candidate: { ...candidate, conversation: close.candidate.conversation },
      }),
    /Invalid or excessive/,
  );
  const reviewReceipt = queue.enqueue("npc-chatter-review", packet),
    reviewJob = queue.get(worker);
  queue.submit(worker, reviewJob.jobId, reviewJob.claim, reviewAnswer(packet));
  assert.equal(
    queue.result(reviewReceipt.id, reviewReceipt.hash).answer.verdict,
    "accept",
  );
  const legacy = draft(dialogue("synthetic-no-conversation-canonical"));
  assert.equal(
    npcDialogueCandidateSource(legacy),
    JSON.stringify([
      legacy.requestId,
      legacy.actorId,
      legacy.text,
      legacy.delivery,
      legacy.purpose,
      [...legacy.evidence].sort(),
    ]),
    "existing standalone candidates retain their canonical fingerprint source",
  );
});

test("drafts and critics share one temporary capacity, expiry and study-priority budget", async () => {
  let clock = 1000;
  const queue = createHandoffQueue({ now: () => clock, maxJobs: 4 });
  queue.enable(true);
  const contexts = Array.from({ length: 2 }, (_, i) =>
    dialogue(`synthetic-mixed-${i}`),
  );
  const reviews = await Promise.all(
    contexts.map((p) => buildNpcDialogueReview(p, draft(p), 0)),
  );
  const receipts = contexts.map((p) => queue.enqueue("npc-chatter", p));
  receipts.push(...reviews.map((p) => queue.enqueue("npc-chatter-review", p)));
  assert.equal(queue.snapshot().queued, 4);
  assert.deepEqual(
    queue.enqueue("npc-chatter-review", reviews[0]),
    receipts[2],
  );
  assert.throws(
    () => queue.enqueue("npc-chatter", dialogue("synthetic-fifth")),
    /excessive/,
  );
  const study = queue.enqueue("tutor", {
    requestId: "synthetic-priority-study",
  });
  assert.equal(
    queue.snapshot().queued,
    1,
    "both kinds yield capacity to retained study",
  );
  assert.equal(queue.get(worker).jobId, study.id);
  for (const r of receipts)
    assert.throws(() => queue.result(r.id, r.hash), /Unknown exact/);
  const expiring = queue.enqueue("npc-chatter-review", reviews[0]);
  clock += NPC_CHATTER_TTL_MS;
  assert.equal(queue.snapshot().queued, 0);
  assert.throws(
    () => queue.result(expiring.id, expiring.hash),
    /Unknown exact/,
  );
  assert.equal(queue.result(study.id, study.hash).status, "pending");
});

test("critic context, candidate and verdict never persist and old saved ambient reviews are discarded", async (t) => {
  const { queue, file } = await tempQueue(t),
    context = dialogue("SYNTHETIC_PRIVATE_EPHEMERAL_DRAFT"),
    request = await buildNpcDialogueReview(context, draft(context), 0),
    study = queue.enqueue("tutor", { requestId: "synthetic-retained-context" }),
    receipt = queue.enqueue("npc-chatter-review", request),
    job = queue.get(
      worker,
      undefined,
      (j) => j.operation === "npc-chatter-review",
    ),
    reply = reviewAnswer(request, "silence");
  queue.submit(worker, job.jobId, job.claim, reply);
  const raw = await readFile(file, "utf8");
  for (const marker of [
    context.requestId,
    request.candidate.text,
    receipt.id,
    request.candidateFingerprint,
    "npc-chatter-review",
  ])
    assert.equal(raw.includes(marker), false, marker);
  const disk = JSON.parse(raw);
  disk.jobs.push({
    id: receipt.id,
    operation: "npc-chatter-review",
    requestId: request.requestId,
    hash: sha256(
      JSON.stringify({ operation: "npc-chatter-review", payload: request }),
    ),
    payload: request,
    status: "queued",
    createdAt: 1000,
  });
  await writeFile(file, JSON.stringify(disk), { mode: 0o600 });
  const restored = createHandoffQueue({ file });
  restored.enable(true);
  assert.throws(
    () => restored.result(receipt.id, receipt.hash),
    /Unknown exact/,
  );
  assert.equal(restored.result(study.id, study.hash).status, "pending");
});

test("the real review HTTP operation returns an editor verdict, supports exact cancellation and retains study", async (t) => {
  const { queue } = await tempQueue(t),
    handoff = createHandoffRoutes(queue, { token: "synthetic-worker-token" }),
    base = await listen(t, createStudyBridgeServer({ handoff })),
    context = dialogue("synthetic-off-topic-review"),
    candidate = { ...draft(context), text: "How's the weather today?" },
    request = await buildNpcDialogueReview(context, candidate, 0);
  assert.ok(
    (await (await fetch(base + "/api/status")).json()).capabilities.includes(
      "npc-chatter-review",
    ),
  );
  const response = await post(base, "/api/bridge", {
    operation: "npc-chatter-review",
    provider: "chatgpt-handoff",
    payload: request,
  });
  assert.equal(response.status, 202);
  const receipt = (await response.json()).handoff,
    job = queue.get(worker),
    reply = reviewAnswer(request, "revise");
  queue.submit(worker, job.jobId, job.claim, reply);
  assert.deepEqual(
    await (await fetch(base + resultPath(receipt))).json(),
    reply,
    "valid evidence IDs never override an editor's semantic rejection",
  );
  const study = queue.enqueue("tutor", {
    requestId: "synthetic-review-keeps-study",
  });
  assert.equal(
    (
      await fetch(base + resultPath(receipt), {
        method: "DELETE",
        headers: { Origin: "https://unrelated.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + resultPath(receipt), {
        method: "DELETE",
        headers: { Origin: origin },
      })
    ).status,
    200,
  );
  assert.throws(() => queue.result(receipt.id, receipt.hash), /Unknown exact/);
  assert.equal(queue.result(study.id, study.hash).status, "pending");
});
