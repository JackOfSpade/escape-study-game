import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { buildPrompt } from "../scripts/claude-gateway.mjs";
// @ts-expect-error Local .mjs module is exercised directly without a declaration shim.
import { readCases } from "../scripts/ai-ladder.mjs";
import {
  buildChatFromLessons,
  buildLessonCases,
  captureChat,
  CHAT_SCRIPTS,
  fixturePayload,
  LESSON_SPECS,
  lessonFixture,
  parseRows,
  SYNTHETIC_LESSONS,
  writeChatFromRun,
  writeLessonCases,
} from "../scripts/ai-capture/build-lesson-cases";
import { roadmap } from "../scripts/ai-capture/build-study-cases";
import { normalizeLesson } from "../scripts/lib/lesson-schema.mjs";
import { lessonPayload } from "../src/lesson";

const r = roadmap();
const book = buildLessonCases();

test("twelve distinct, bridge-ready cases per operation", async () => {
  const cases = await book;
  for (const operation of ["lesson", "lesson-chat"] as const) {
    const list = cases[operation];
    assert.equal(list.length, 12);
    assert.equal(new Set(list.map((c) => c.id)).size, 12);
    assert.equal(new Set(list.map((c) => JSON.stringify(c.payload))).size, 12);
    for (const item of list) {
      assert.equal(item.operation, operation);
      const built = buildPrompt(operation, item.payload);
      assert.ok(built.system.length > 0 && built.user.length > 0);
    }
  }
});

test("lesson payloads are lessonPayload's own output and cover the stresses", async () => {
  const cases = (await book).lesson;
  for (const [index, item] of cases.entries()) {
    const f = lessonFixture(r, index);
    assert.deepEqual(
      item.payload,
      JSON.parse(
        JSON.stringify(
          lessonPayload(f.g, r, f.gap, f.requestId, f.spec.previousTitle),
        ),
      ),
    );
    assert.deepEqual(
      item.payload,
      JSON.parse(JSON.stringify(fixturePayload(f))),
    );
    // The objective is a real curriculum objective; the gap's facet is one the
    // question defined (its scope facets, or its rubric without a scope).
    const gap = item.payload.gap as any;
    const objective = r.tracks[gap.track as "PY" | "PE"].objectives.find(
      (o) => o.id === gap.objectiveIds[0],
    );
    assert.ok(objective, gap.objectiveIds[0]);
    const scope = item.payload.scope as any;
    if (scope) {
      assert.equal(scope.sourceScope, objective!.scope);
      const parent = gap.partOf ?? gap.facet;
      assert.ok(
        scope.facets.some(
          (x: any) =>
            x.id === parent.id && x.description === parent.description,
        ),
      );
    }
  }
  const payloads = cases.map((c) => c.payload as any);
  const tracks = new Set(payloads.map((p) => p.gap.track));
  assert.ok(tracks.has("PY") && tracks.has("PE"));
  assert.deepEqual(
    [...new Set(payloads.map((p) => p.gap.depth))].sort(),
    [1, 2, 3],
  );
  const some = (test: (p: any) => boolean) => payloads.some(test);
  assert.ok(some((p) => p.gap.partOf) && some((p) => !p.gap.partOf));
  assert.ok(some((p) => p.diagnostic) && some((p) => !p.diagnostic));
  assert.ok(some((p) => p.scope) && some((p) => !p.scope));
  assert.ok(some((p) => p.previousTitle));
  assert.ok(some((p) => /```python/.test(p.diagnostic?.prompt ?? "")));
  // One statement quotes its own diagnostic question.
  assert.ok(
    some(
      (p) =>
        p.diagnostic &&
        LESSON_SPECS.some(
          (s) =>
            s.statement === p.gap.statement &&
            /window_totals|onboarding/.test(s.statement),
        ),
    ),
  );
  assert.ok(!JSON.stringify(payloads).toLowerCase().includes("lorem"));
});

test("chat payloads come through the real lesson controller", async () => {
  for (const { lesson } of SYNTHETIC_LESSONS) {
    const { dropped } = normalizeLesson(lesson);
    assert.deepEqual(dropped, []);
  }
  const chat = (await book)["lesson-chat"];
  const payloads = chat.map((c) => c.payload as any);
  for (const p of payloads) {
    assert.match(p.requestId, /^lesson-chat-gap-run-.+-\d+$/);
    assert.equal(p.responseFormat, "{text, section?}");
    assert.ok(p.sectionIds.length >= 2);
    if (p.focus) assert.ok(p.sectionIds.includes(p.focus));
  }
  assert.equal(new Set(payloads.map((p) => p.message)).size, 12);
  assert.ok(payloads.some((p) => p.focus));
  assert.ok(payloads.some((p) => p.history.length >= 2));
  assert.ok(payloads.some((p) => p.message === "I still don't get it."));

  // The stub host sees exactly the request the app sends.
  const seen: { operation: string; payload: any }[] = [];
  const f = lessonFixture(r, SYNTHETIC_LESSONS[0].caseIndex);
  const captured = await captureChat(
    f,
    SYNTHETIC_LESSONS[0].lesson,
    {
      kind: "probe",
      turns: () => [{ text: "Why add first?", focus: "worked-example" }],
    },
    (operation, payload) => seen.push({ operation, payload }),
  );
  assert.deepEqual(
    seen.map((call) => call.operation),
    ["lesson", "lesson-chat"],
  );
  // The controller names its own lesson request; everything else is the
  // payload the lesson case for this gap holds.
  const { requestId: _sent, ...sent } = seen[0].payload;
  const { requestId: _built, ...built } = fixturePayload(lessonFixture(r, 0));
  assert.deepEqual(sent, built);
  assert.equal(seen[1].payload.message, "Why add first?");
  assert.equal(seen[1].payload.focus, "worked-example");
  assert.equal(seen[1].payload.lessonId, f.gap.id);
  assert.equal(seen[1].payload.gap.description, f.gap.facet.description);
  assert.equal(CHAT_SCRIPTS.length, 12);
  // Last: strict equal narrows the payload's type.
  assert.equal(seen[1].payload, captured);
});

test("--lessons-from reads a ladder arm's valid lesson rows", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lesson-cases-"));
  try {
    const gapOf = (index: number) => lessonFixture(r, index).gap.id;
    const row = (caseId: string, over: Record<string, unknown>) =>
      JSON.stringify({
        caseId,
        operation: "lesson",
        setting: "sonnet:high",
        rep: 0,
        outcome: "valid",
        answers: [],
        ...over,
      });
    const lines = [
      row("lesson-1", {
        answers: [
          {
            requestId: "x",
            gapId: gapOf(0),
            lesson: SYNTHETIC_LESSONS[0].lesson,
          },
        ],
      }),
      row("lesson-2", { outcome: "invalid" }),
      row("lesson-3", {
        setting: "opus:high",
        answers: [{ gapId: gapOf(2), lesson: SYNTHETIC_LESSONS[1].lesson }],
      }),
      row("lesson-9", {
        answers: [{ gapId: gapOf(8), lesson: SYNTHETIC_LESSONS[2].lesson }],
      }),
      row("lesson-10", { answers: [{ gapId: "someone-else", lesson: {} }] }),
    ];
    writeFileSync(join(dir, "results.jsonl"), `${lines.join("\n")}\n`);
    const { chat, skipped } = await buildChatFromLessons({
      rows: parseRows(join(dir, "results.jsonl")),
      setting: "sonnet:high",
      rep: 0,
    });
    assert.deepEqual(
      chat.map((c) => c.id),
      ["lesson-chat-from-lesson-1", "lesson-chat-from-lesson-9"],
    );
    assert.equal(skipped.length, 10);
    const first = chat[0].payload as any;
    assert.equal(
      first.lesson.title,
      "Keep one running total as the window slides",
    );
    assert.equal(first.lessonId, gapOf(0));
    for (const c of chat)
      assert.doesNotThrow(() => buildPrompt(c.operation, c.payload));

    const out = join(dir, "cases");
    writeLessonCases(out, { "lesson-chat": chat });
    assert.equal(statSync(out).mode & 0o777, 0o700);
    const file = join(out, "lesson-chat.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(
      JSON.parse(readFileSync(join(out, "index.json"), "utf8")),
      {
        "lesson-chat": 2,
      },
    );
    assert.equal(readCases(file).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--lessons-from refuses a bad setting, a missing --out or no pairs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lesson-cases-"));
  try {
    const out = join(dir, "cases");
    writeLessonCases(out, { lesson: [], "lesson-chat": [] });
    const chatFile = join(out, "lesson-chat.json");
    const before = readFileSync(chatFile, "utf8");
    const indexBefore = readFileSync(join(out, "index.json"), "utf8");
    writeFileSync(
      join(dir, "results.jsonl"),
      `${JSON.stringify({
        caseId: "lesson-1",
        operation: "lesson",
        setting: "sonnet:high",
        rep: 0,
        outcome: "valid",
        answers: [
          {
            gapId: lessonFixture(r, 0).gap.id,
            lesson: SYNTHETIC_LESSONS[0].lesson,
          },
        ],
      })}\n`,
    );
    const base = { out, from: dir, setting: "sonnet:high", rep: 0 };
    await assert.rejects(
      writeChatFromRun({ ...base, setting: "typo" }),
      /Invalid setting/,
    );
    await assert.rejects(
      writeChatFromRun({ ...base, out: undefined }),
      /explicit --out/,
    );
    await assert.rejects(
      writeChatFromRun({ ...base, rep: 1 }),
      /nothing written/,
    );
    await assert.rejects(
      writeChatFromRun({ ...base, setting: "opus:high" }),
      /nothing written/,
    );
    assert.equal(readFileSync(chatFile, "utf8"), before);
    assert.equal(readFileSync(join(out, "index.json"), "utf8"), indexBefore);

    const { chat } = await writeChatFromRun(base);
    assert.equal(chat.length, 1);
    assert.equal(
      JSON.parse(readFileSync(join(out, "index.json"), "utf8"))["lesson-chat"],
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
