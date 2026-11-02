// Isolated fake gateway, synthetic situations and fake PCM; no live model.
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createStudyBridgeServer } from "../scripts/study-bridge-server.mjs";
import { createNpcSpeechService } from "../scripts/npc-speech-service.mjs";
import { sha256 } from "../scripts/lib/digest.mjs";
import {
  AI_OPERATIONS,
  taskInstructions,
  validateAnswer,
} from "../scripts/lib/ai-contracts.mjs";
import {
  buildNpcDialogueReview,
  npcDialogueCandidateSource,
} from "../scripts/lib/npc-dialogue-policy.mjs";

const origin = "http://127.0.0.1:5173";
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
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body),
  });
}
/** A gateway whose answers pass through the real validators, as in production. */
function gateway(reply) {
  return {
    enabled: () => true,
    async run(operation, payload) {
      const job = { operation, payload };
      const value = reply(job);
      validateAnswer(job, value);
      return value;
    },
  };
}
const rejects = (job, bad, pattern) =>
  assert.throws(() => validateAnswer(job, bad), pattern);

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

test("NPC replies retain exact identity and reject markup, tool envelopes and altered contracts", () => {
  const request = chatter(),
    job = { operation: "npc-chatter", payload: request },
    valid = answer(request),
    instructions = taskInstructions("npc-chatter", request);
  assert.match(instructions, /plain-text line/);
  assert.match(instructions, /untrusted evidence/);
  assert.doesNotMatch(
    instructions,
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
  ])
    rejects(job, bad, /exact NPC\/request identity/);
  validateAnswer(job, valid);
});

test("new dialogue drafts allow creative speech or silence but require correlated known evidence", () => {
  for (const silent of [false, true]) {
    const request = dialogue(silent ? "synthetic-silence" : "synthetic-speech"),
      job = { operation: "npc-chatter", payload: request },
      reply = silent
        ? {
            requestId: request.requestId,
            actorId: request.actorId,
            decision: "silent",
            reason: "Quiet is useful here.",
          }
        : draft(request);
    assert.match(
      taskInstructions("npc-chatter", request),
      /Silence is a valid/,
    );
    for (const bad of [
      answer(request),
      { ...draft(request), evidence: ["hidden.enemies"] },
      { ...draft(request), evidence: [] },
      { ...draft(request), actorId: "npc-elsewhere" },
    ])
      rejects(job, bad, /NPC dialogue draft/);
    validateAnswer(job, reply);
  }
});

test("critic packets and replies bind the exact draft, not just a plausible-looking NPC identity", async () => {
  const context = dialogue(),
    candidate = draft(context),
    request = await buildNpcDialogueReview(context, candidate, 0),
    job = { operation: "npc-chatter-review", payload: request },
    reply = reviewAnswer(request);
  assert.equal(
    request.candidateFingerprint,
    sha256(npcDialogueCandidateSource(candidate)),
  );
  assert.match(
    taskInstructions("npc-chatter-review", request),
    /Evaluate the candidate independently/,
  );
  for (const bad of [
    { ...reply, candidateFingerprint: "0".repeat(64) },
    { ...reply, requestId: context.requestId },
    { ...reply, verdict: "accept", issues: ["off-topic"] },
    { ...reply, verdict: "revise", issues: [] },
    { ...reply, issues: ["arbitrary-score"] },
    { ...reply, replacement: "Do not play this unreviewed replacement." },
  ])
    rejects(job, bad, /NPC dialogue review/);
  validateAnswer(job, reply);
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
  const job = { operation: "npc-chatter", payload: context };
  for (const bad of [
    { ...candidate, conversation: undefined },
    { ...candidate, conversation: { intent: "invite" } },
    {
      ...candidate,
      conversation: { intent: "continue", replyTo: "unheard-turn" },
    },
    { ...candidate, evidence: ["setting.outbreak"] },
  ])
    rejects(job, bad, /NPC dialogue draft/);
  validateAnswer(job, candidate);
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
  validateAnswer(
    { operation: "npc-chatter-review", payload: packet },
    reviewAnswer(packet),
  );
  // A verdict for the "continue" candidate cannot stand in for the "close" one.
  rejects(
    { operation: "npc-chatter-review", payload: close },
    reviewAnswer(packet),
    /NPC dialogue review/,
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

test("the actual loopback bridge carries a validated line into a one-use local WAV without study side effects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "npc-voice-bridge-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const rendered = [],
    speech = createNpcSpeechService({
      tempRoot: directory,
      render: async (request) => {
        rendered.push(request);
        return fakeWave();
      },
    }),
    request = chatter("synthetic-audible-line"),
    reply = answer(request);
  t.after(() => speech.close());
  const base = await listen(
      t,
      createStudyBridgeServer({
        speech,
        claude: gateway(() => reply),
      }),
    ),
    status = await (await fetch(base + "/api/status")).json();
  assert.ok(status.capabilities.includes("npc-chatter"));
  assert.equal(
    (await (await fetch(base + "/api/speech/status")).json()).available,
    true,
  );
  const response = await post(base, "/api/bridge", {
    operation: "npc-chatter",
    provider: "claude-cli",
    payload: request,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), reply);
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
});

test("the real review HTTP operation returns an editor verdict the validators accept", async (t) => {
  const context = dialogue("synthetic-off-topic-review"),
    candidate = { ...draft(context), text: "How's the weather today?" },
    request = await buildNpcDialogueReview(context, candidate, 0),
    reply = reviewAnswer(request, "revise"),
    base = await listen(
      t,
      createStudyBridgeServer({ claude: gateway(() => reply) }),
    );
  assert.ok(
    (await (await fetch(base + "/api/status")).json()).capabilities.includes(
      "npc-chatter-review",
    ),
  );
  assert.ok(AI_OPERATIONS.includes("npc-chatter-review"));
  const response = await post(base, "/api/bridge", {
    operation: "npc-chatter-review",
    provider: "claude-cli",
    payload: request,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    reply,
    "valid evidence IDs never override an editor's semantic rejection",
  );
});
