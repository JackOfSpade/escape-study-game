import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { bridgeRequest } from "../src/bridge-client";
import { eligible, initialStudy } from "../src/curriculum";
import type { KnowledgeGapRecord } from "../src/knowledge-probe";
import { createLessons, openLessonGaps } from "../src/lesson";
import type { LessonStore } from "../src/lesson-store";
import type { Roadmap } from "../src/model";
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

test("a whole lesson flow leaves a frozen study record and roadmap untouched", async () => {
  const g = createPlayableGame(1, r, initialStudy(r, "live"));
  const contract = eligible(r, g.study);
  const e = g.encounters["question-0"];
  e.problem = devProblem(Object.assign({ rng: 3 }, g), r, contract);
  e.state = "in-progress";
  const gap: KnowledgeGapRecord = {
    id: "gap-iso",
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
  };
  g.study.knowledgeGaps = [gap];
  const roadmap = structuredClone(r);
  deepFreeze(g);
  deepFreeze(roadmap);
  const beforeRecord = JSON.stringify(g),
    beforeRoadmap = JSON.stringify(roadmap);

  const rows = new Map<string, string>();
  const store: LessonStore = {
    async all() {
      return [...rows.values()].map((v) => JSON.parse(v));
    },
    async put(rec) {
      rows.set(rec.key, JSON.stringify(rec));
    },
    async remove(key) {
      rows.delete(key);
    },
  };
  let chatFails = true;
  const lessons = createLessons({
    store,
    request: (async (op: string, p: any) => {
      if (op === "lesson")
        return { requestId: p.requestId, gapId: p.gapId, lesson: LESSON };
      if (chatFails) {
        chatFails = false;
        throw Error("Failed to fetch");
      }
      return { requestId: p.requestId, text: "A reply.", section: "idea" };
    }) as unknown as typeof bridgeRequest,
    capabilities: () => ["lesson", "lesson-chat"],
  });

  assert.equal(openLessonGaps(g).length, 1);
  await lessons.load();
  await lessons.generate(g, roadmap, gap);
  lessons.markRead(gap.id);
  lessons.setResponse(gap.id, "idea/1", "a");
  lessons.setResponse(gap.id, "idea/2", "Subtract the outgoing value.");
  await lessons.send(gap.id, "Why add?", "idea");
  await lessons.retryChat(gap.id);
  await lessons.generate(g, roadmap, gap, { fresh: true });
  await lessons.flush();

  assert.equal(lessons.record(gap.id)!.state, "ready");
  assert.ok(rows.has(gap.id));
  assert.equal(JSON.stringify(g), beforeRecord);
  assert.equal(JSON.stringify(roadmap), beforeRoadmap);
  assert.equal(g.study.knowledgeGaps![0].resolved, undefined);
});

const source = (path: string) => readFileSync(path, "utf8");
const imports = (text: string) =>
  [
    ...text.matchAll(
      /(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*import\s+["']([^"']+)["']/g,
    ),
  ].map((m) => m[1] ?? m[2] ?? m[3]);

test("the import scanner sees static, multi-line, dynamic and bare imports", () => {
  assert.deepEqual(
    imports(
      'import a from "./a";\nimport {\n  b,\n} from "./b";\nexport * from "./c";\nconst d = await import("./d");\nimport "./e";',
    ),
    ["./a", "./b", "./c", "./d", "./e"],
  );
});

test("the save, the learner model and the curriculum never import a lesson module", () => {
  for (const file of [
    "src/learner.ts",
    "src/curriculum.ts",
    "src/knowledge-probe.ts",
    "src/persistence.ts",
    "src/storage.ts",
    "src/ai.ts",
  ]) {
    const found = imports(source(file));
    assert.deepEqual(
      found.filter((path) => path.includes("lesson")),
      [],
      `${file} imports a lesson module`,
    );
  }
});

test("the lesson modules reach neither the save nor anything that records learning", () => {
  const forbidden = [
    "recordProbeTurn",
    "recordGapReview",
    "syncEstablished",
    "applyLearningAssessment",
    "beginVisit",
    "finishVisit",
    "countStudyTurn",
    "completeQuestion",
  ];
  for (const file of [
    "src/lesson.ts",
    "src/lesson-store.ts",
    "src/lesson-surface.ts",
    "src/lesson-render.ts",
    "src/lesson-figures.ts",
  ]) {
    const text = source(file),
      found = imports(text);
    assert.ok(found.length > 0, `${file}: import scan found nothing`);
    for (const path of found) {
      assert.ok(
        !/(^|\/)(persistence|storage)$/.test(path),
        `${file} imports ${path}`,
      );
    }
    for (const name of forbidden)
      assert.ok(!text.includes(name), `${file} mentions ${name}`);
    assert.ok(!/\.resolved\s*=[^=]/.test(text), `${file} sets a resolved flag`);
    assert.ok(!text.includes("dead-air-durable-state"));
    assert.ok(!/\bsave\(|\bpersist\(/.test(text), `${file} saves the record`);
  }
  assert.match(source("src/lesson-store.ts"), /"dead-air-lessons"/);
  assert.ok(!imports(source("src/lesson.ts")).includes("./model-writes"));
});

test("lesson text and chat are never sent into question, assessment or tutor requests", () => {
  // The one-way rule: only src/lesson.ts and its own view may name lesson
  // operations; nothing that builds a generate, tutor or assess request does.
  for (const file of [
    "src/ai.ts",
    "src/knowledge-probe.ts",
    "src/learner.ts",
  ]) {
    const text = source(file);
    assert.ok(
      !/["']lesson(-chat)?["']/.test(text),
      `${file} names a lesson op`,
    );
  }
});
