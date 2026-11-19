import assert from "node:assert/strict";
import test from "node:test";
import {
  AI_OPERATIONS,
  taskInstructions,
  validateAnswer,
  // @ts-expect-error Direct .mjs contract test.
} from "../scripts/lib/ai-contracts.mjs";
// @ts-expect-error Direct .mjs gateway test.
import { buildPrompt, taskProfile } from "../scripts/claude-gateway.mjs";
import {
  LESSON_CHAT_POLICY,
  LESSON_POLICY,
} from "../scripts/lib/lesson-policy.mjs";
import { LESSON_FORMAT, LESSON_LIMITS } from "../scripts/lib/lesson-schema.mjs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

const TUTOR_OPENING = "Use a patient study tutor approach";
const MIDDLE =
  "You are processing a request from an interview-preparation study workspace";

const lesson = (): J => ({
  v: 1,
  title: "A queue serves oldest first",
  summary: "",
  minutes: 5,
  sections: [
    {
      id: "predict",
      title: "Predict",
      blocks: [{ kind: "prose", text: "Guess first." }],
    },
    {
      id: "idea",
      title: "The idea",
      blocks: [{ kind: "prose", text: "Oldest leaves first." }],
    },
  ],
});
const lessonJob = (payload: J = {}) => ({
  operation: "lesson",
  payload: { requestId: "r1", gapId: "g1", ...payload },
});
const lessonAnswer = (over: J = {}): J => ({
  requestId: "r1",
  gapId: "g1",
  lesson: lesson(),
  ...over,
});
const chatJob = (payload: J = {}) => ({
  operation: "lesson-chat",
  payload: { requestId: "c1", sectionIds: ["predict", "idea"], ...payload },
});

test("both lesson operations are served and have their own profile", () => {
  assert.ok(AI_OPERATIONS.includes("lesson"));
  assert.ok(AI_OPERATIONS.includes("lesson-chat"));
  assert.equal(AI_OPERATIONS.length, new Set(AI_OPERATIONS).size);
  for (const operation of AI_OPERATIONS) taskProfile(operation, {});
  assert.equal(taskProfile("lesson").model, "opus");
  assert.equal(taskProfile("lesson").effort, "high");
  assert.equal(taskProfile("lesson-chat").model, "sonnet");
  assert.equal(taskProfile("lesson-chat").effort, "medium");
});

test("lesson instructions open as a lesson writer and carry the policy", () => {
  const text: string = taskInstructions("lesson", {});
  assert.ok(
    text.startsWith(
      "Write one short lesson that teaches a single knowledge gap to a learner preparing for software engineering interviews, following the operation contract below. ",
    ),
  );
  assert.ok(text.includes(MIDDLE));
  assert.ok(text.endsWith(LESSON_POLICY));
  assert.ok(LESSON_POLICY.endsWith(LESSON_FORMAT));
  assert.ok(!text.includes(TUTOR_OPENING));
  assert.ok(!/probe/i.test(text));
  assert.ok(!text.includes("avoid giving away"));
  assert.ok(!text.includes("Write one practice question"));
});

test("lesson-chat instructions open as a lesson tutor and carry the policy", () => {
  const text: string = taskInstructions("lesson-chat", {});
  assert.ok(
    text.startsWith(
      "Answer a learner's question about the lesson they are reading, following the operation contract below. ",
    ),
  );
  assert.ok(text.includes(MIDDLE));
  assert.ok(text.endsWith(LESSON_CHAT_POLICY));
  assert.ok(!text.includes(TUTOR_OPENING));
  assert.ok(!text.includes("avoid giving away"));
  // The policy itself says "do not probe"; nothing else may mention it.
  assert.ok(!/probe/i.test(text.replace(LESSON_CHAT_POLICY, "")));
});

test("the other operations keep their openings", () => {
  for (const operation of [
    "tutor",
    "assess",
    "reconcile-roadmap",
    "review-environment",
  ])
    assert.ok(
      taskInstructions(operation, {}).startsWith(TUTOR_OPENING),
      operation,
    );
  assert.ok(
    taskInstructions("generate", {}).startsWith(
      "Write one practice question for a learner preparing",
    ),
  );
});

test("no operation's instructions contain the word undefined", () => {
  for (const operation of AI_OPERATIONS) {
    const text: string = taskInstructions(operation, {});
    assert.ok(text.length > 500, operation);
    assert.ok(!text.includes("undefined"), operation);
    assert.ok(!text.includes("[object"), operation);
  }
});

test("the lesson policy teaches one gap in the fixed order and claims nothing", () => {
  for (const needle of [
    "payload.gap",
    "payload.gap.statement",
    "payload.curriculum",
    "payload.diagnostic",
    "predict block",
    "recall block",
    "three-bullet recap",
    "5 to 10 minutes",
    "payload.gap.partOf",
    "payload.scope",
    "payload.previousTitle",
    "a different angle, use a different example and give it a different title",
    "at most three figures",
    "alt text",
    "Never claim the gap is closed",
    "Return {requestId, gapId, lesson}. Copy requestId and gapId exactly.",
  ])
    assert.ok(LESSON_POLICY.includes(needle), needle);
  const order = [
    "open with a predict block",
    "name the misconception",
    "one worked example",
    "a contrast or a second, smaller example",
    "a recall block",
    "three-bullet recap",
  ].map((s) => LESSON_POLICY.indexOf(s));
  assert.ok(order.every((at) => at >= 0));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  for (const needle of [
    "tutor sitting beside",
    "payload.lesson",
    "payload.sectionIds",
    "payload.focus",
    "the section the learner is looking at",
    "not recorded",
    "no links",
    "Return {text, section?}",
  ])
    assert.ok(LESSON_CHAT_POLICY.includes(needle), needle);
});

test("a lesson request puts the curriculum and policy in the cached system prompt", () => {
  const payload = {
    requestId: "r9",
    gapId: "g1",
    curriculum: { big: true },
    lessonPolicy: "Stable lesson text",
    gap: { id: "g1" },
    diagnostic: { title: "d" },
  };
  const built = buildPrompt("lesson", payload);
  assert.ok(built.system.includes('"curriculum":{"big":true}'));
  assert.ok(built.system.includes("Stable lesson text"));
  assert.ok(built.system.includes(LESSON_POLICY));
  assert.ok(!built.system.includes("patient study tutor"));
  assert.ok(built.user.includes("diagnostic"));
  assert.ok(!built.user.includes("curriculum"));
  const chat = buildPrompt("lesson-chat", {
    requestId: "c1",
    lesson: "## idea: The idea",
    sectionIds: ["idea"],
    message: "why?",
  });
  assert.ok(chat.system.includes("## idea: The idea"));
  assert.ok(chat.user.includes("why?"));
  assert.ok(!chat.system.includes("Teach by making the learner think"));
});

test("a lesson answer is accepted when it keeps the ids and the lesson is usable", () => {
  assert.doesNotThrow(() => validateAnswer(lessonJob(), lessonAnswer()));
  // The gap id may come from payload.gap.
  assert.doesNotThrow(() =>
    validateAnswer(
      { operation: "lesson", payload: { requestId: "r1", gap: { id: "g1" } } },
      lessonAnswer(),
    ),
  );
  // Dropped blocks are not a failure.
  const withBadBlock = lessonAnswer();
  withBadBlock.lesson.sections[0].blocks.push({
    kind: "callout",
    tone: "loud",
    text: "x",
  });
  assert.doesNotThrow(() => validateAnswer(lessonJob(), withBadBlock));
});

test("a lesson answer is refused with a reason the model can act on", () => {
  const refuse = (answer: unknown, pattern: RegExp, job = lessonJob()) =>
    assert.throws(() => validateAnswer(job, answer), pattern);
  refuse(lessonAnswer({ knowledge: {} }), /remove "knowledge"/);
  refuse(lessonAnswer({ complete: true }), /remove "complete"/);
  refuse(lessonAnswer({ outcome: "solved" }), /remove "outcome"/);
  const missing = lessonAnswer();
  delete missing.gapId;
  refuse(missing, /Return requestId, gapId and lesson/);
  const noLesson = lessonAnswer();
  delete noLesson.lesson;
  refuse(noLesson, /Return requestId, gapId and lesson/);
  refuse(lessonAnswer({ requestId: "other" }), /Copy requestId and gapId/);
  refuse(lessonAnswer({ gapId: "other" }), /Copy requestId and gapId/);
  refuse(
    lessonAnswer({ lesson: "text" }),
    /The lesson cannot be used: .*JSON object/,
  );
  refuse(lessonAnswer({ lesson: { ...lesson(), v: 2 } }), /v must be 1/);
  refuse(
    lessonAnswer({ lesson: { ...lesson(), complete: true } }),
    /must not contain "complete"/,
  );
  refuse(
    lessonAnswer({ lesson: { ...lesson(), mastery: "high" } }),
    /must not contain "mastery"/,
  );
  const noProse = lessonAnswer();
  noProse.lesson.sections[0].blocks = [
    { kind: "recall", prompt: "p", exemplar: "e" },
  ];
  noProse.lesson.sections[1].blocks = [
    { kind: "recall", prompt: "p", exemplar: "e" },
  ];
  refuse(noProse, /at least one prose block/);
  refuse([], /bounded JSON object/);
  refuse(null, /bounded JSON object/);
  // A request without the ids cannot be satisfied by an answer without them.
  assert.throws(() =>
    validateAnswer(
      { operation: "lesson", payload: {} },
      { lesson: lesson(), requestId: "x", gapId: "y" },
    ),
  );
});

test("a lesson-chat reply is accepted or refused on its own small contract", () => {
  const job = chatJob();
  for (const answer of [
    { text: "Because the oldest item leaves first." },
    { text: "See this.", section: "idea" },
    { text: "ok", requestId: "c1" },
    { text: "x".repeat(LESSON_LIMITS.chatText) },
  ])
    assert.doesNotThrow(() => validateAnswer(job, answer));
  const refuse = (answer: unknown, pattern: RegExp, j = job) =>
    assert.throws(() => validateAnswer(j, answer), pattern);
  refuse({}, /text must be a nonempty string/);
  refuse({ text: "" }, /text must be a nonempty string/);
  refuse({ text: "   \n" }, /text must be a nonempty string/);
  refuse({ text: 4 }, /text must be a nonempty string/);
  refuse(
    { text: "x".repeat(LESSON_LIMITS.chatText + 1) },
    /at most 6000 characters/,
  );
  for (const key of [
    "knowledge",
    "help",
    "complete",
    "outcome",
    "partComplete",
  ])
    refuse({ text: "t", [key]: true }, new RegExp(`remove "${key}"`));
  refuse({ text: "t", requestId: "other" }, /Copy requestId/);
  refuse({ text: "t", section: "nowhere" }, /payload\.sectionIds/);
  refuse({ text: "t", section: 3 }, /payload\.sectionIds/);
  refuse({ text: "t", section: null }, /payload\.sectionIds/);
  refuse({ text: "t", section: "idea" }, /payload\.sectionIds/, {
    operation: "lesson-chat",
    payload: { requestId: "c1" },
  });
  refuse({ text: "t", section: "idea" }, /payload\.sectionIds/, {
    operation: "lesson-chat",
    payload: { requestId: "c1", sectionIds: "idea" },
  });
});
