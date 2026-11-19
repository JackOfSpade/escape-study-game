import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { bridgeRequest } from "../src/bridge-client";
import { eligible, initialStudy } from "../src/curriculum";
import type { KnowledgeGapRecord } from "../src/knowledge-probe";
import {
  createLessons,
  lessonGap,
  lessonOffer,
  lessonPayload,
  openLessonGaps,
} from "../src/lesson";
import { lessonTree } from "../src/lesson-render";
import type { LessonStore } from "../src/lesson-store";
import type { Roadmap, StudyRecord } from "../src/model";
import { devProblem } from "./helpers/practice-questions";
import { createPlayableGame } from "./helpers/record";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

const LESSON = {
  v: 1,
  title: "Sliding windows",
  summary: "One idea.",
  minutes: 5,
  sections: [
    {
      id: "idea",
      title: "The idea",
      blocks: [
        { kind: "prose", text: "A window keeps a running total." },
        {
          kind: "predict",
          prompt: "What happens next?",
          options: [
            { id: "a", text: "Add" },
            { id: "b", text: "Subtract" },
          ],
          correctId: "a",
          explanation: "It adds.",
        },
        { kind: "recall", prompt: "Explain.", exemplar: "Subtract, then add." },
      ],
    },
    {
      id: "more",
      title: "More",
      blocks: [{ kind: "prose", text: "Second section." }],
    },
  ],
};
const OTHER = { ...LESSON, title: "A different angle" };

/** A study record with an unasked question to hang a problem on. */
function fixture() {
  const g = createPlayableGame(1, r, initialStudy(r, "live"));
  const contract = eligible(r, g.study);
  const e = g.encounters["question-0"];
  e.problem = devProblem(Object.assign({ rng: 3 }, g), r, contract);
  e.state = "in-progress";
  return { g, contract, e };
}
function gapOf(
  g: StudyRecord,
  contract: { track: string; objectiveIds: string[]; depth: number },
  over: Partial<KnowledgeGapRecord> = {},
): KnowledgeGapRecord {
  return {
    id: "gap-x/question-0-window",
    encounter: `${g.id}/question-0`,
    runId: g.id,
    track: contract.track,
    objectiveIds: [...contract.objectiveIds],
    depth: contract.depth,
    facet: { id: "window", description: "Update the running total" },
    statement: "I do not know how the total updates.",
    requestId: "probe-1",
    provider: "claude-cli",
    at: "2026-11-19T10:00:00.000Z",
    ...over,
  };
}

function memoryStore() {
  const rows = new Map<string, string>(),
    fail = { all: false, put: false };
  const store: LessonStore = {
    async all() {
      if (fail.all) throw Error("database unavailable");
      return [...rows.values()].map((v) => JSON.parse(v));
    },
    async put(record) {
      if (fail.put) throw Error("quota exceeded");
      rows.set(record.key, JSON.stringify(record));
    },
    async remove(key) {
      rows.delete(key);
    },
  };
  return { store, rows, fail };
}

interface Call {
  op: string;
  payload: any;
  options?: { onText?: (t: string) => void };
}
function harness(
  handler: (call: Call) => unknown | Promise<unknown>,
  caps = ["lesson", "lesson-chat"],
) {
  const calls: Call[] = [],
    mem = memoryStore();
  let changes = 0;
  const request = (async (op: string, payload: unknown, options: any) => {
    const call = { op, payload, options };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof bridgeRequest;
  const lessons = createLessons({
    store: mem.store,
    request,
    capabilities: () => caps,
    now: () => "2026-11-19T12:00:00.000Z",
    onChange: () => void changes++,
  });
  return { lessons, calls, mem, changes: () => changes };
}
const good =
  (lesson: unknown = LESSON) =>
  (c: Call) => ({
    requestId: c.payload.requestId,
    gapId: c.payload.gapId,
    lesson,
  });
const saved = (mem: ReturnType<typeof memoryStore>, key: string) =>
  JSON.parse(mem.rows.get(key)!);

test("lessonGap copies the facts a lesson needs and nothing else", () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract, {
    partOf: { id: "whole", description: "The whole idea", partOf: "x" },
  });
  assert.deepEqual(lessonGap(gap), {
    id: gap.id,
    track: gap.track,
    objectiveIds: gap.objectiveIds,
    depth: gap.depth,
    facet: { id: "window", description: "Update the running total" },
    partOf: { id: "whole", description: "The whole idea" },
    statement: gap.statement,
    resolved: false,
  });
  assert.equal(
    lessonGap({
      ...gap,
      resolved: {
        at: "",
        encounter: "",
        requestId: "",
        status: "demonstrated",
      },
    }).resolved,
    true,
  );
});

test("a lesson is not offered while an unfinished question covers the same objectives", () => {
  const { g, contract, e } = fixture();
  const gap = lessonGap(gapOf(g, contract));
  const blocked = lessonOffer(g, gap);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /Finish the open question on this topic first/);
  e.state = "consumed";
  assert.deepEqual(lessonOffer(g, gap), { allowed: true });
  e.state = "in-progress";
  assert.equal(
    lessonOffer(g, { ...gap, objectiveIds: ["PY:NOT-THIS-ONE"] }).allowed,
    true,
  );
  e.problem = undefined;
  assert.equal(lessonOffer(g, gap).allowed, true);
});

test("a lesson is not offered while a question on the same topic is still being written", () => {
  const { g, contract, e } = fixture();
  const gap = lessonGap(gapOf(g, contract));
  e.problem = undefined;
  e.state = "available";
  const pending = (contractValue: unknown) => ({
    requestId: "gen-1",
    payload: { contract: contractValue },
  });
  assert.deepEqual(lessonOffer(g, gap), { allowed: true });

  // Its saved contract names the topic.
  e.pendingGeneration = pending({ objectiveIds: [...contract.objectiveIds] });
  const blocked = lessonOffer(g, gap);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reason!, /Finish the open question on this topic first/);
  e.pendingGeneration = pending({ objectiveIds: ["PY:NOT-THIS-ONE"] });
  assert.equal(lessonOffer(g, gap).allowed, true);

  // No readable contract: the topic is unknown, so it blocks.
  for (const unreadable of [
    undefined,
    null,
    "text",
    {},
    { objectiveIds: "PY:X" },
    { objectiveIds: [1, 2] },
  ]) {
    e.pendingGeneration = pending(unreadable);
    assert.equal(
      lessonOffer(g, gap).allowed,
      false,
      JSON.stringify(unreadable),
    );
  }
  e.pendingGeneration = { requestId: "gen-1", payload: {} };
  assert.equal(lessonOffer(g, gap).allowed, false);
  delete e.pendingGeneration;
  assert.equal(lessonOffer(g, gap).allowed, true);
  e.generation = "gen-2";
  assert.equal(lessonOffer(g, gap).allowed, false);

  // A readable contract on another topic wins over a bare generation mark.
  e.pendingGeneration = pending({ objectiveIds: ["PY:NOT-THIS-ONE"] });
  assert.equal(lessonOffer(g, gap).allowed, true);

  // A consumed encounter never blocks.
  e.pendingGeneration = pending({ objectiveIds: [...contract.objectiveIds] });
  e.state = "consumed";
  assert.equal(lessonOffer(g, gap).allowed, true);
});

test("open gaps are newest first, unresolved only and de-duplicated by facet, depth and objectives", () => {
  const { g, contract } = fixture();
  const at = (n: number) => `2026-11-19T10:0${n}:00.000Z`;
  g.study.knowledgeGaps = [
    gapOf(g, contract, { id: "old", at: at(1) }),
    gapOf(g, contract, {
      id: "other",
      at: at(2),
      facet: { id: "b", description: "A different facet" },
    }),
    gapOf(g, contract, { id: "new", at: at(3) }),
    gapOf(g, contract, {
      id: "done",
      at: at(4),
      facet: { id: "c", description: "Closed already" },
      resolved: {
        at: at(5),
        encounter: "e",
        requestId: "q",
        status: "demonstrated",
      },
    }),
    gapOf(g, contract, { id: "deeper", at: at(0), depth: contract.depth + 1 }),
  ];
  assert.deepEqual(
    openLessonGaps(g).map((x) => x.id),
    ["new", "other", "deeper"],
  );
  assert.deepEqual(openLessonGaps(createPlayableGame(2, r)), []);
});

test("the lesson payload carries the gap and its source question and nothing private", () => {
  const { g, contract, e } = fixture();
  const gap = gapOf(g, contract, { statement: "S".repeat(600) });
  (e.tutor as unknown[]).push({
    id: "t1",
    author: "tutor",
    kind: "tutor",
    text: "TUTOR-SECRET",
    seq: 1,
    worldTime: 1,
  });
  e.workspace = "LEARNER-WORKSPACE-ANSWER";
  const key = `${contract.objectiveIds[0]}/D${contract.depth}`;
  g.study.learner!.scopes[key] = {
    id: key,
    objectiveId: contract.objectiveIds[0],
    depth: contract.depth,
    facets: [{ id: "window", description: "Update the running total" }],
  } as never;
  const p = lessonPayload(g, r, gap, "req-1") as any;
  assert.equal(p.requestId, "req-1");
  assert.equal(p.gapId, gap.id);
  assert.equal(p.gap.statement.length, 400);
  assert.deepEqual(p.gap.facet, gap.facet);
  assert.deepEqual(p.gap.objectiveIds, gap.objectiveIds);
  assert.equal(p.scope.id, key);
  assert.equal(p.diagnostic.title, e.problem!.title);
  assert.ok(p.diagnostic.prompt.length <= 1200);
  assert.equal(p.curriculum, r.tracks[contract.track].curriculum);
  assert.ok(typeof p.lessonPolicy === "string" && p.lessonPolicy.length > 100);
  assert.equal("previousTitle" in p, false);
  const text = JSON.stringify(p);
  assert.ok(!text.includes("TUTOR-SECRET"));
  assert.ok(!text.includes("LEARNER-WORKSPACE-ANSWER"));
  assert.ok(!text.includes("S".repeat(401)));
  assert.equal(
    (lessonPayload(g, r, gap, "req-2", "Old title") as any).previousTitle,
    "Old title",
  );
  e.problem = undefined;
  const bare = lessonPayload(g, r, gap, "req-3") as any;
  assert.equal("diagnostic" in bare, false);
});

test("the source question is found among archives too", () => {
  const { g, contract, e } = fixture();
  g.study.archives.push(e);
  delete g.encounters["question-0"];
  const p = lessonPayload(g, r, gapOf(g, contract), "r") as any;
  assert.equal(p.diagnostic.title, e.problem!.title);
});

test("generate writes a lesson, saves it and does not repeat it", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness(good());
  await h.lessons.generate(g, r, gap);
  const rec = h.lessons.record(gap.id)!;
  assert.equal(rec.state, "ready");
  assert.equal(rec.attempt, 1);
  assert.equal(rec.lesson!.title, "Sliding windows");
  assert.match(
    rec.requestId,
    /^lesson-gap-x\/question-0-window-1-[0-9a-f]{8}$/,
  );
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].op, "lesson");
  assert.equal(h.calls[0].payload.gapId, gap.id);
  assert.equal(saved(h.mem, gap.id).state, "ready");
  assert.ok(h.changes() >= 2);
  await h.lessons.generate(g, r, gap);
  assert.equal(h.calls.length, 1);
});

test("generate while pending is ignored", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  let release!: () => void;
  const h = harness(
    (c) =>
      new Promise((res) => {
        release = () => res(good()(c));
      }),
  );
  const first = h.lessons.generate(g, r, gap);
  assert.equal(h.lessons.record(gap.id)!.state, "pending");
  await h.lessons.generate(g, r, gap);
  assert.equal(h.calls.length, 1);
  release();
  await first;
  assert.equal(h.lessons.record(gap.id)!.state, "ready");
});

test("dropped optional blocks are kept as a note", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const bad = structuredClone(LESSON) as any;
  bad.sections[1].blocks.push({ kind: "diagram", alt: "x", nodes: "no" });
  const h = harness(good(bad));
  await h.lessons.generate(g, r, gap);
  const rec = h.lessons.record(gap.id)!;
  assert.equal(rec.state, "ready");
  assert.equal(rec.lesson!.sections[1].blocks.length, 1);
  assert.equal(rec.dropped!.length, 1);
});

test("a reply the app refuses renews the request id; a transport failure keeps it", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  let mode: "mismatch" | "invalid" | "down" | "ok" = "mismatch";
  const h = harness((c) => {
    if (mode === "down") throw Error("Failed to fetch");
    if (mode === "mismatch")
      return { requestId: c.payload.requestId, gapId: "other", lesson: LESSON };
    if (mode === "invalid")
      return {
        requestId: c.payload.requestId,
        gapId: gap.id,
        lesson: { v: 1 },
      };
    return good()(c);
  });
  await h.lessons.generate(g, r, gap);
  let rec = h.lessons.record(gap.id)!;
  assert.equal(rec.state, "failed");
  assert.match(rec.error!, /could not be used/);
  const first = h.calls[0].payload.requestId;
  assert.notEqual(rec.requestId, first);
  assert.equal(saved(h.mem, gap.id).requestId, rec.requestId);

  mode = "invalid";
  await h.lessons.generate(g, r, gap);
  const second = h.calls[1].payload.requestId;
  assert.notEqual(second, first);
  rec = h.lessons.record(gap.id)!;
  assert.equal(rec.state, "failed");
  assert.notEqual(rec.requestId, second);

  mode = "down";
  const beforeDown = rec.requestId;
  await h.lessons.generate(g, r, gap);
  assert.equal(h.calls[2].payload.requestId, beforeDown);
  rec = h.lessons.record(gap.id)!;
  assert.equal(rec.state, "failed");
  assert.match(rec.error!, /Failed to fetch/);
  assert.equal(rec.requestId, beforeDown);
  assert.equal(rec.attempt, 3);

  mode = "ok";
  await h.lessons.generate(g, r, gap);
  assert.equal(h.calls[3].payload.requestId, beforeDown);
  assert.equal(h.lessons.record(gap.id)!.state, "ready");
  assert.equal(h.lessons.record(gap.id)!.error, undefined);
});

test("without the lesson capabilities generate fails plainly and sends nothing", async () => {
  const { g, contract } = fixture();
  const h = harness(good(), ["generate", "tutor"]);
  assert.equal(h.lessons.available(), false);
  await h.lessons.generate(g, r, gapOf(g, contract));
  assert.equal(h.calls.length, 0);
  const rec = h.lessons.record("gap-x/question-0-window")!;
  assert.equal(rec.state, "failed");
  assert.ok(!rec.error!.includes("!"));
  assert.equal(
    harness(good(), ["lesson", "lesson-chat"]).lessons.available(),
    true,
  );
  assert.equal(harness(good(), ["lesson"]).lessons.available(), false);
});

test("a request lost with the page is interrupted on load and can be retried under its id", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness(good());
  await h.mem.store.put({
    key: gap.id,
    state: "pending",
    requestId: "lesson-lost-1",
    attempt: 1,
    createdAt: "2026-11-19T09:00:00.000Z",
    responses: {},
    chat: [],
    chatSeq: 0,
  });
  await h.lessons.load();
  assert.equal(h.lessons.record(gap.id)!.state, "interrupted");
  assert.equal(saved(h.mem, gap.id).state, "interrupted");
  assert.equal(h.lessons.loadError(), "");
  await h.lessons.generate(g, r, gap);
  assert.equal(h.calls[0].payload.requestId, "lesson-lost-1");
  assert.equal(h.lessons.record(gap.id)!.state, "ready");
});

test("regenerating keeps the old lesson until the new one is valid, then replaces it and clears what belonged to it", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  let next: (c: Call) => unknown = good();
  let hold: Promise<void> | undefined;
  const h = harness(async (c) => {
    if (c.op === "lesson-chat")
      return { requestId: c.payload.requestId, text: "A reply." };
    await hold;
    return next(c);
  });
  await h.lessons.generate(g, r, gap);
  const rec = h.lessons.record(gap.id)!;
  h.lessons.markRead(gap.id);
  h.lessons.setResponse(gap.id, "idea/1", "a");
  await h.lessons.send(gap.id, "A question?");
  assert.ok(rec.readAt && rec.chat.length === 2);
  const oldId = rec.requestId;

  // A new lesson that cannot be used leaves the old one, with its work.
  next = (c) => ({ requestId: c.payload.requestId, gapId: gap.id, lesson: {} });
  await h.lessons.generate(g, r, gap, { fresh: true });
  const regen = h.calls.filter((c) => c.op === "lesson")[1];
  assert.equal(regen.payload.previousTitle, "Sliding windows");
  assert.notEqual(regen.payload.requestId, oldId);
  assert.equal(rec.state, "failed");
  assert.equal(rec.lesson!.title, "Sliding windows");
  assert.equal(rec.chat.length, 2);
  assert.ok(rec.readAt);

  // While the next one is being written the old one stays visible.
  let release!: () => void;
  hold = new Promise((res) => (release = res));
  next = good(OTHER);
  const pending = h.lessons.generate(g, r, gap, { fresh: true });
  assert.equal(rec.state, "pending");
  assert.equal(rec.lesson!.title, "Sliding windows");
  release();
  await pending;
  assert.equal(rec.state, "ready");
  assert.equal(rec.lesson!.title, "A different angle");
  assert.deepEqual(rec.responses, {});
  assert.deepEqual(rec.chat, []);
  assert.equal(rec.readAt, undefined);
  assert.equal(saved(h.mem, gap.id).lesson.title, "A different angle");
});

async function readyLesson(
  chat: (c: Call) => unknown,
  tweak?: (h: ReturnType<typeof harness>) => void,
) {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness((c) => (c.op === "lesson" ? good()(c) : chat(c)));
  tweak?.(h);
  await h.lessons.generate(g, r, gap);
  return { h, gap, key: gap.id, rec: h.lessons.record(gap.id)! };
}
const chatCalls = (h: ReturnType<typeof harness>) =>
  h.calls.filter((c) => c.op === "lesson-chat");

test("a chat message is answered, with streaming text along the way", async () => {
  let h!: ReturnType<typeof harness>,
    key = "";
  let during: (string | undefined)[] = [];
  ({ h, key } = await readyLesson((c) => {
    c.options!.onText!("Because the");
    during.push(h.lessons.streaming(key));
    c.options!.onText!("Because the new value enters.");
    during.push(h.lessons.streaming(key));
    return {
      requestId: c.payload.requestId,
      text: "Because the new value enters.",
      section: "idea",
    };
  }));
  await h.lessons.send(key, "  Why add?  ", "more");
  const call = chatCalls(h)[0];
  assert.deepEqual(during, ["Because the", "Because the new value enters."]);
  assert.equal(h.lessons.streaming(key), undefined);
  assert.equal(call.payload.requestId, `lesson-chat-${key}-1`);
  assert.equal(call.payload.lessonId, key);
  assert.equal(call.payload.message, "Why add?");
  assert.equal(call.payload.responseFormat, "{text, section?}");
  assert.equal(call.payload.gap.description, "Update the running total");
  assert.deepEqual(call.payload.sectionIds, ["idea", "more"]);
  assert.equal(call.payload.focus, "more");
  assert.equal(call.payload.lesson.title, "Sliding windows");
  assert.match(call.payload.lesson.text, /## idea: The idea/);
  assert.deepEqual(call.payload.history, []);
  assert.ok(String(call.payload.instruction).length > 50);
  const rec = h.lessons.record(key)!;
  assert.deepEqual(
    rec.chat.map((m) => [m.role, m.state]),
    [
      ["learner", "sent"],
      ["tutor", "sent"],
    ],
  );
  assert.equal(rec.chat[1].section, "idea");
  assert.equal(rec.chatSeq, 1);
  assert.equal(saved(h.mem, key).chat.length, 2);
});

test("a tutor section outside the lesson is dropped, and a focus outside it is not sent", async () => {
  const { h, key } = await readyLesson((c) => ({
    requestId: c.payload.requestId,
    text: "An answer.",
    section: "nowhere",
  }));
  await h.lessons.send(key, "Hello", "nowhere");
  assert.equal("focus" in chatCalls(h)[0].payload, false);
  assert.equal("section" in h.lessons.record(key)!.chat[1], false);
});

test("history is the last twelve settled messages, clipped, and the message is clipped", async () => {
  const { h, key, rec } = await readyLesson((c) => ({
    text: "R".repeat(2000),
    requestId: c.payload.requestId,
  }));
  for (let i = 0; i < 8; i++)
    await h.lessons.send(key, `q${i} ` + "Q".repeat(5000));
  await h.lessons.send(key, "last");
  const last = chatCalls(h).at(-1)!.payload;
  assert.equal(last.history.length, 12);
  assert.ok(last.history.every((m: any) => m.text.length <= 1500));
  assert.equal(last.message, "last");
  assert.equal(chatCalls(h)[1].payload.message.length, 4000);
  assert.equal(rec.chat.at(-1)!.text, "R".repeat(2000));
  assert.deepEqual(
    chatCalls(h).map((c) => c.payload.requestId),
    Array.from({ length: 9 }, (_, i) => `lesson-chat-${key}-${i + 1}`),
  );
});

test("a failed message is marked failed and retried under a new request id", async () => {
  let fail = true;
  const { h, key, rec } = await readyLesson((c) => {
    if (fail) throw Error("Failed to fetch");
    return { requestId: c.payload.requestId, text: "Now it works." };
  });
  await h.lessons.send(key, "Please explain");
  assert.equal(rec.chat.length, 1);
  assert.equal(rec.chat[0].state, "failed");
  assert.match(rec.chat[0].error!, /Failed to fetch/);
  assert.equal(saved(h.mem, key).chat[0].state, "failed");
  fail = false;
  await h.lessons.retryChat(key);
  const [first, second] = chatCalls(h);
  assert.notEqual(first.payload.requestId, second.payload.requestId);
  assert.equal(second.payload.message, "Please explain");
  assert.deepEqual(second.payload.history, []);
  assert.deepEqual(
    rec.chat.map((m) => [m.role, m.state]),
    [
      ["learner", "sent"],
      ["tutor", "sent"],
    ],
  );
  assert.equal(rec.chat[0].error, undefined);
  await h.lessons.retryChat(key);
  assert.equal(chatCalls(h).length, 2);
});

test("a mismatched or empty reply fails the message", async () => {
  let reply: unknown = { requestId: "someone-else", text: "x" };
  const { h, key, rec } = await readyLesson(() => reply);
  await h.lessons.send(key, "one");
  assert.equal(rec.chat[0].state, "failed");
  reply = { text: "   " };
  await h.lessons.retryChat(key);
  assert.equal(rec.chat[0].state, "failed");
  assert.equal(rec.chat.length, 1);
});

test("send is ignored when blank, without a ready lesson, or while a reply is pending", async () => {
  let release!: () => void;
  const { h, key, rec } = await readyLesson(
    (c) =>
      new Promise((res) => {
        release = () => res({ requestId: c.payload.requestId, text: "ok" });
      }),
  );
  await h.lessons.send(key, "   ");
  await h.lessons.send("no-such-lesson", "hello");
  assert.equal(chatCalls(h).length, 0);
  const first = h.lessons.send(key, "first");
  assert.equal(rec.chat[0].state, "pending");
  await h.lessons.send(key, "second");
  assert.equal(chatCalls(h).length, 1);
  release();
  await first;
  assert.equal(rec.chat.length, 2);
  rec.state = "failed";
  await h.lessons.send(key, "third");
  assert.equal(chatCalls(h).length, 1);
});

test("a reply that lands after the lesson was replaced is discarded", async () => {
  let release!: () => void;
  let lessonCall = 0;
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness((c) => {
    if (c.op === "lesson") return good(lessonCall++ ? OTHER : LESSON)(c);
    return new Promise((res) => {
      release = () => res({ requestId: c.payload.requestId, text: "stale" });
    });
  });
  await h.lessons.generate(g, r, gap);
  const sending = h.lessons.send(gap.id, "question");
  await h.lessons.generate(g, r, gap, { fresh: true });
  release();
  await sending;
  const rec = h.lessons.record(gap.id)!;
  assert.deepEqual(rec.chat, []);
  assert.equal(rec.lesson!.title, "A different angle");
});

test("a message sent while an older chat request is still in flight is not dropped after the lesson is replaced", async () => {
  const releases: (() => void)[] = [];
  let lessonCall = 0;
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness((c) => {
    if (c.op === "lesson") return good(lessonCall++ ? OTHER : LESSON)(c);
    return new Promise((res) => {
      releases.push(() =>
        res({
          requestId: c.payload.requestId,
          text: `answer ${releases.length}`,
        }),
      );
    });
  });
  await h.lessons.generate(g, r, gap);
  const first = h.lessons.send(gap.id, "old question");
  await h.lessons.generate(g, r, gap, { fresh: true });
  // The new conversation can talk at once.
  const second = h.lessons.send(gap.id, "new question");
  assert.equal(chatCalls(h).length, 2);
  releases[0]();
  assert.equal(await first, true);
  const rec = h.lessons.record(gap.id)!;
  // The old request finishing must not free the new one's slot.
  assert.equal(await h.lessons.send(gap.id, "third"), false);
  assert.deepEqual(
    rec.chat.map((m) => [m.text, m.state]),
    [["new question", "pending"]],
  );
  releases[1]();
  assert.equal(await second, true);
  assert.deepEqual(
    rec.chat.map((m) => [m.role, m.state]),
    [
      ["learner", "sent"],
      ["tutor", "sent"],
    ],
  );
  assert.equal(rec.chat[1].text, "answer 2");
  assert.equal(h.lessons.streaming(gap.id), undefined);
});

test("send and retryChat resolve true only when a request started, and never throw", async () => {
  let fail = true;
  const { h, key } = await readyLesson((c) => {
    if (fail) throw Error("boom");
    return { requestId: c.payload.requestId, text: "ok" };
  });
  assert.equal(await h.lessons.send(key, "   "), false);
  assert.equal(await h.lessons.send("no-such-lesson", "hi"), false);
  assert.equal(await h.lessons.retryChat(key), false);
  assert.equal(await h.lessons.send(key, "hello"), true);
  assert.equal(h.lessons.record(key)!.chat[0].state, "failed");
  fail = false;
  assert.equal(await h.lessons.retryChat(key), true);
  assert.equal(h.lessons.record(key)!.chat[0].state, "sent");
  assert.equal(await h.lessons.retryChat(key), false);
});

test("the tutor is given the whole lesson, up to the lesson size limit", async () => {
  const filler = "x".repeat(2200);
  const long = {
    ...LESSON,
    sections: ["a", "b", "c", "d"].map((id) => ({
      id: `part-${id}`,
      title: id,
      blocks: [1, 2, 3, 4, 5].map((n) => ({
        kind: "prose",
        text: n === 5 && id === "d" ? `${filler} ENDMARK` : filler,
      })),
    })),
  };
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness((c) =>
    c.op === "lesson"
      ? good(long)(c)
      : { requestId: c.payload.requestId, text: "ok" },
  );
  await h.lessons.generate(g, r, gap);
  assert.equal(h.lessons.record(gap.id)!.state, "ready");
  await h.lessons.send(gap.id, "hello");
  const sent = chatCalls(h)[0].payload;
  assert.ok(sent.lesson.text.length > 24000);
  assert.ok(sent.lesson.text.endsWith("ENDMARK"));
  assert.deepEqual(sent.sectionIds, ["part-a", "part-b", "part-c", "part-d"]);
});

test("prose with a huge list number still draws", () => {
  const lesson = structuredClone(LESSON) as any;
  lesson.sections[1].blocks.push({
    kind: "prose",
    text: "1234567. a thing\n\n99999999999999999999) x\n\n3. fine",
  });
  assert.doesNotThrow(() => lessonTree(lesson, {}));
});

test("the chat keeps only the newest 200 messages", async () => {
  const { h, key, rec } = await readyLesson((c) => ({
    requestId: c.payload.requestId,
    text: "ok",
  }));
  for (let i = 0; i < 101; i++) await h.lessons.send(key, `m${i}`);
  assert.equal(rec.chat.length, 200);
  assert.equal(rec.chat.at(-1)!.role, "tutor");
  assert.equal(rec.chat[0].text, "m1");
  assert.equal(saved(h.mem, key).chat.length, 200);
});

test("a chat that was waiting when the page closed fails on load and can be retried", async () => {
  const { h, key } = await readyLesson((c) => ({
    requestId: c.payload.requestId,
    text: "ok",
  }));
  const stored = saved(h.mem, key);
  stored.chat.push({
    id: "m-x",
    role: "learner",
    text: "unanswered",
    at: "2026-11-19T12:00:00.000Z",
    state: "pending",
  });
  h.mem.rows.set(key, JSON.stringify(stored));
  const again = harness((c) => ({
    requestId: c.payload.requestId,
    text: "ok",
  }));
  for (const [k, v] of h.mem.rows) again.mem.rows.set(k, v);
  await again.lessons.load();
  const rec = again.lessons.record(key)!;
  assert.equal(rec.chat[0].state, "failed");
  await again.lessons.retryChat(key);
  assert.equal(rec.chat[0].state, "sent");
});

test("done reading and answers are saved, and answers wait for their pause or a flush", async () => {
  const { h, key, rec } = await readyLesson(() => ({}));
  h.lessons.markRead(key);
  assert.equal(rec.readAt, "2026-11-19T12:00:00.000Z");
  await h.lessons.flush();
  assert.equal(saved(h.mem, key).readAt, rec.readAt);

  h.lessons.setResponse(key, "idea/1", "b");
  h.lessons.setResponse(
    key,
    "idea/2",
    "Subtract the outgoing value. ".repeat(200),
  );
  h.lessons.setResponse(key, "idea/0", "prose takes no answer");
  h.lessons.setResponse(key, "idea/9", "no such block");
  h.lessons.setResponse(key, "nowhere/0", "no such section");
  h.lessons.setResponse(key, "../etc", "bad key");
  assert.deepEqual(Object.keys(rec.responses), ["idea/1", "idea/2"]);
  assert.equal(rec.responses["idea/2"].length, 4000);
  assert.deepEqual(saved(h.mem, key).responses, {});
  await h.lessons.flush();
  assert.equal(saved(h.mem, key).responses["idea/1"], "b");
  h.lessons.setResponse(key, "idea/1", "");
  assert.equal("idea/1" in rec.responses, false);
  await h.lessons.flush();
  assert.equal("idea/1" in saved(h.mem, key).responses, false);
});

test("the debounced save lands on its own after a pause", async () => {
  const { h, key } = await readyLesson(() => ({}));
  h.lessons.setResponse(key, "idea/1", "a");
  const stored = () => h.mem.rows.get(key)?.includes('"idea/1":"a"');
  for (let i = 0; i < 40 && !stored(); i++)
    await new Promise((res) => setTimeout(res, 50));
  assert.equal(saved(h.mem, key).responses["idea/1"], "a");
});

test("a store that fails never throws into the caller, and the lesson still works", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const h = harness((c) =>
    c.op === "lesson"
      ? good()(c)
      : { requestId: c.payload.requestId, text: "A reply." },
  );
  h.mem.fail.all = true;
  h.mem.fail.put = true;
  await h.lessons.load();
  assert.match(h.lessons.loadError(), /could not be read/);
  await h.lessons.generate(g, r, gap);
  const rec = h.lessons.record(gap.id)!;
  assert.equal(rec.state, "ready");
  await h.lessons.send(gap.id, "Hello");
  assert.equal(rec.chat.length, 2);
  h.lessons.markRead(gap.id);
  h.lessons.setResponse(gap.id, "idea/1", "a");
  await h.lessons.flush();
  assert.equal(h.mem.rows.size, 0);
  assert.match(h.lessons.saveError(gap.id), /not being saved/);

  // A store that opens but then refuses writes is noted per record.
  const w = harness(good());
  w.mem.fail.put = true;
  await w.lessons.load();
  assert.equal(w.lessons.loadError(), "");
  await w.lessons.generate(g, r, gap);
  assert.equal(w.lessons.record(gap.id)!.state, "ready");
  assert.match(w.lessons.saveError(gap.id), /could not be saved/);
  w.mem.fail.put = false;
  w.lessons.markRead(gap.id);
  await w.lessons.flush();
  assert.equal(w.lessons.saveError(gap.id), "");
});

test("an onChange that throws does not cost the learner the lesson", async () => {
  const { g, contract } = fixture();
  const gap = gapOf(g, contract);
  const mem = memoryStore();
  const lessons = createLessons({
    store: mem.store,
    request: (async (_op: string, p: any) => ({
      requestId: p.requestId,
      gapId: p.gapId,
      lesson: LESSON,
    })) as unknown as typeof bridgeRequest,
    capabilities: () => ["lesson", "lesson-chat"],
    onChange() {
      throw Error("repaint failed");
    },
  });
  await lessons.generate(g, r, gap);
  assert.equal(lessons.record(gap.id)!.state, "ready");
});
