import assert from "node:assert/strict";
import test from "node:test";
import {
  LEARNER_MAX_TOKENS,
  PERSONAS,
  askLearner,
  learnerMessages,
  learnerRequest,
  personaById,
  questionContext,
  readOffloadReply,
  type CaptureQuestion,
  type TranscriptTurn,
} from "./learner";

const question: CaptureQuestion = {
  title: "Cache invalidation",
  prompt: "Explain why a write-through cache can still serve stale reads.",
  starter: "// write-through, no invalidation\n",
};

const transcript: TranscriptTurn[] = [
  { role: "learner", text: "I think the cache never gets cleared." },
  {
    role: "tutor",
    text: "What happens when another writer changes the store?",
  },
  { role: "learner", text: "Then the cached copy is out of date." },
];

test("personas are present and distinct", () => {
  assert.ok(PERSONAS.length >= 7);
  const ids = PERSONAS.map((persona) => persona.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of [
    "strong",
    "partial",
    "misconception",
    "gap",
    "presses",
    "verbose",
    "copier",
  ] as const) {
    assert.ok(ids.includes(id), `missing persona ${id}`);
    assert.ok(personaById(id).style.length > 20);
  }
});

test("messages start with the persona system prompt and the question", () => {
  const messages = learnerMessages(PERSONAS[0], question, []);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes(PERSONAS[0].style));
  assert.ok(messages[0].content.includes("Never mention being an AI"));
  assert.equal(messages[1].role, "user");
  assert.equal(messages[1].content, questionContext(question));
  assert.ok(messages[1].content.includes(question.prompt));
  assert.ok(messages[1].content.includes("// write-through"));
});

test("transcript turns keep order and map learner to assistant", () => {
  const messages = learnerMessages(personaById("gap"), question, transcript);
  assert.deepEqual(
    messages.map((message) => message.role),
    ["system", "user", "assistant", "user", "assistant"],
  );
  assert.deepEqual(
    messages.slice(2).map((message) => message.content),
    transcript.map((turn) => turn.text),
  );
});

test("starter text is omitted when the question has none", () => {
  const messages = learnerMessages(
    PERSONAS[0],
    {
      title: "T",
      prompt: "P",
    },
    [],
  );
  assert.equal(messages[1].content.includes("Starter text"), false);
});

test("offload request has the exact capture fields", () => {
  const messages = learnerMessages(PERSONAS[0], question, transcript);
  const request = learnerRequest(messages);
  assert.deepEqual(Object.keys(request), [
    "route",
    "caller",
    "tag",
    "maxTokens",
    "messages",
  ]);
  assert.equal(request.route, "deepseek-flash");
  assert.equal(request.caller, "zombie-ai-capture");
  assert.equal(request.tag, "learner");
  assert.equal(request.maxTokens, LEARNER_MAX_TOKENS);
  assert.equal(request.maxTokens, 4000);
  assert.deepEqual(request.messages, messages);
  assert.equal(JSON.parse(JSON.stringify(request)).maxTokens, 4000);
});

test("reply parsing accepts success and rejects failures", () => {
  assert.equal(
    readOffloadReply('{"ok":true,"text":"  one line  ","costUsd":0.001}\n'),
    "one line",
  );
  assert.throws(
    () =>
      readOffloadReply('{"ok":false,"error":{"code":"quota","message":"no"}}'),
    /quota/,
  );
  assert.throws(() => readOffloadReply("no json here"), /no JSON response/);
  assert.throws(() => readOffloadReply('{"ok":true,"text":"   "}'), /empty/);
});

test("askLearner surfaces a spawn failure instead of spawning offload", async () => {
  // Point at a path that cannot exist so nothing real is executed.
  await assert.rejects(
    askLearner(PERSONAS[0], question, [], {
      bin: "/nonexistent/offload-capture-test",
      timeoutMs: 5_000,
    }),
    /could not spawn|exited/,
  );
});
