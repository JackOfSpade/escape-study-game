#!/usr/bin/env node
/**
 * Build ladder cases for the gap-lesson calls `lesson` and `lesson-chat`
 * without network access. Every payload comes from the app's own code:
 * `lesson` cases are `lessonPayload` on synthetic study records whose gaps
 * were recorded by the app's real probe recorder, and `lesson-chat` cases are
 * captured from `createLessons(...).send` through a stub host that records
 * each `(operation, payload)` and answers just enough for the flow to go on.
 *
 * tsx scripts/ai-capture/build-lesson-cases.ts --out <dir> [--per-op N]
 * tsx scripts/ai-capture/build-lesson-cases.ts --out <dir> \
 *   --lessons-from <ladder run dir> --setting <model:effort> [--rep N]
 *
 * With --lessons-from, the chat cases sit beside the lessons a real `lesson`
 * ladder arm wrote (its valid rows at that setting and rep), so the chat is
 * judged downstream on real arm output, as build-downstream-cases.ts does for
 * tutor and assess. Only lesson-chat.json is written in that mode, --out is
 * required there (so it never lands on the default build's chat cases), and a
 * run that pairs no lesson writes nothing and fails.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-expect-error Local .mjs module without a declaration shim (as the tests import it).
import { parseSetting as ladderParseSetting } from "../ai-ladder.mjs";
import { normalizeLesson } from "../lib/lesson-schema.mjs";
import type { bridgeRequest } from "../../src/bridge-client";
import {
  parseProbeReply,
  probeFacets,
  recordProbeTurn,
  type KnowledgeGapRecord,
} from "../../src/knowledge-probe";
import { registerScopes } from "../../src/learner";
import { scopeKey, type ScopeDefinition } from "../../src/learning-model";
import { createLessons, lessonPayload } from "../../src/lesson";
import type { LessonEntry, LessonStore } from "../../src/lesson-store";
import type {
  Contract,
  Problem,
  Roadmap,
  StudyRecord,
  Track,
} from "../../src/model";
import { devProblem } from "../../tests/helpers/practice-questions";
import {
  contractFor,
  encounterFor,
  recordFor,
  roadmap,
  scenarioFor,
} from "./build-study-cases";

type LessonOperation = "lesson" | "lesson-chat";
export type LessonCase = {
  id: string;
  operation: LessonOperation;
  payload: Record<string, unknown>;
};
type LessonCaseBook = Record<LessonOperation, LessonCase[]>;
const LESSON_OPERATIONS: LessonOperation[] = ["lesson", "lesson-chat"];
export const CASES_PER_OP = 12;

type Scenario = ReturnType<typeof scenarioFor>;
type Diagnostic = "present" | "archived" | "absent";

/** One `lesson` case: which gap is recorded and what the record around it holds. */
type LessonSpec = {
  track: Track;
  topic: string;
  depth: number;
  /** The question's own facet that is the gap, or the parent of a declared
   * part: "core" is its first facet and "boundary" its second. */
  facet: "core" | "boundary";
  /** A sub-facet declared as a gap, part of `facet`. */
  part?: { id: string; description: string };
  /** The learner's own words when they conceded the gap. */
  statement: string;
  /** Register the question's scope definition in the learner ledger. */
  scope: boolean;
  /** Where the question that recorded the gap is now. */
  diagnostic: Diagnostic;
  /** "trace": the app's own development trace question instead of the
   * scenario. It has no scope definition, so its facets are its rubric. */
  question: "scenario" | "trace";
  /** Set for a regenerated lesson. */
  previousTitle?: string;
  /** What the case stresses, kept for whoever reads the case file. */
  stress: string;
};

/** Gap statements are synthetic text. Objectives, scopes and facets are not:
 * the scheduler picks the objective, the curriculum supplies its scope text
 * and the app's recorder copies the facet from the question's definition. */
export const LESSON_SPECS: LessonSpec[] = [
  {
    track: "PY",
    topic: "T05",
    depth: 1,
    facet: "core",
    statement:
      "For window_totals(readings, size) with [412, 418, 399, 421, 430, 405, 398] I could not say when the first total should be reported. Can you just tell me what window_totals returns there?",
    scope: true,
    diagnostic: "present",
    question: "scenario",
    stress:
      "statement quotes the diagnostic and asks for its answer (tempts restating it)",
  },
  {
    track: "PY",
    topic: "T02",
    depth: 2,
    facet: "boundary",
    statement:
      "When I trace the loop by hand I lose track of what count holds after each value, and I can't say what it means when the loop has only seen the first few values.",
    scope: false,
    diagnostic: "present",
    question: "trace",
    stress:
      "trace-oriented gap on the app's own trace question (rubric facets, no scope definition): needs a step-through figure",
  },
  {
    track: "PY",
    topic: "T11",
    depth: 2,
    facet: "core",
    part: {
      id: "root-eviction",
      description:
        "Why the root of a size-k min-heap is exactly the entry to evict when a larger count arrives.",
    },
    statement:
      "I get that a heap keeps things ordered, but I don't see why the smallest one on top is the one to throw away when a bigger count comes in.",
    scope: true,
    diagnostic: "present",
    question: "scenario",
    stress: "declared sub-facet (partOf present): teach only that part",
  },
  {
    track: "PY",
    topic: "T05",
    depth: 3,
    facet: "boundary",
    statement:
      "I don't know what should happen when the window is as long as the whole input or when the size is one. My version just crashed on those.",
    scope: false,
    diagnostic: "absent",
    question: "scenario",
    stress: "no scope and no diagnostic: the lesson has only the gap to go on",
  },
  {
    track: "PY",
    topic: "T14",
    depth: 3,
    facet: "core",
    statement:
      "I can sort by start time, but I could not explain why reusing any free room is always safe. I just believed it.",
    scope: true,
    diagnostic: "archived",
    question: "scenario",
    previousTitle: "Greedy room reuse, step by step",
    stress:
      "regenerated lesson (previousTitle) at D3; source question only in the archives",
  },
  {
    track: "PY",
    topic: "T08",
    depth: 3,
    facet: "boundary",
    part: {
      id: "even-median",
      description:
        "How two balanced heaps give the median of an even-length input.",
    },
    statement:
      "With an even number of scores I wasn't sure whether to take the lower root, the upper root or something else, and I didn't know how to keep the two heaps the same size.",
    scope: false,
    diagnostic: "present",
    question: "scenario",
    stress: "sub-facet at D3 with no registered scope",
  },
  {
    track: "PY",
    topic: "T01",
    depth: 2,
    facet: "core",
    statement:
      "I always reach for a list. I don't really know how to decide between a list and a dict from what the program has to look up and update.",
    scope: true,
    diagnostic: "absent",
    question: "scenario",
    stress: "conceptual gap with a scope but no diagnostic",
  },
  {
    track: "PE",
    topic: "T01",
    depth: 1,
    facet: "core",
    statement:
      'The request was "Make onboarding faster; new users keep dropping off" and I just rewrote that sentence. I don\'t know how to turn it into an outcome, constraints and a success condition. What is the answer for onboarding?',
    scope: true,
    diagnostic: "present",
    question: "scenario",
    stress:
      "PE statement restates the diagnostic request and asks for its answer",
  },
  {
    track: "PE",
    topic: "T11",
    depth: 2,
    facet: "core",
    part: {
      id: "authz-vs-session",
      description:
        "Telling a valid session apart from permission to act on one tenant's resource.",
    },
    statement:
      "If the user is logged in I assumed they can open anything they have a link to. I can't step through which check actually produced the 403.",
    scope: true,
    diagnostic: "present",
    question: "scenario",
    stress: "PE sub-facet that needs a step-through of a request flow",
  },
  {
    track: "PE",
    topic: "T08",
    depth: 1,
    facet: "core",
    statement:
      "I would have added role attributes to the divs. I don't know which HTML elements already give a dialog its name and keyboard behaviour.",
    scope: false,
    diagnostic: "archived",
    question: "scenario",
    previousTitle: "Native elements before ARIA",
    stress: "code (markup) gap, regenerated, no scope, archived question",
  },
  {
    track: "PE",
    topic: "T05",
    depth: 3,
    facet: "core",
    statement:
      "I split components by how the page looks: one per box. I can't explain why ownership should follow behaviour and data instead.",
    scope: true,
    diagnostic: "absent",
    question: "scenario",
    stress: "conceptual PE gap at D3 with scope, no diagnostic",
  },
  {
    track: "PE",
    topic: "T14",
    depth: 2,
    facet: "boundary",
    statement:
      "I found the export handler but I missed the scheduled job that names files on its own. I don't know how to follow a value through the code to every place that sets it.",
    scope: false,
    diagnostic: "present",
    question: "scenario",
    stress: "trace-oriented PE gap (follow a value through the data flow)",
  },
];

const HASH8 = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 8);
/** A fixed record id per case, so gap ids and request ids are reproducible. */
const runIdFor = (index: number) =>
  `run-00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
const topicOf = (id: string | undefined) =>
  id?.split(":")[1]?.split(".")[0] ?? "";

function withRunId(g: StudyRecord, runId: string) {
  g.id = runId;
  for (const e of Object.values(g.encounters)) e.runId = runId;
  return g;
}

/** The question that recorded the gap, with a scope definition whose source
 * text is the objective's own scope, exactly as registerScopes requires. */
function diagnosticProblem(
  g: StudyRecord,
  r: Roadmap,
  contract: Contract,
  scenario: Scenario,
  spec: LessonSpec,
  index: number,
): Problem {
  const objectiveId = contract.objectiveIds[0];
  const objective = r.tracks[contract.track].objectives.find(
    (o) => o.id === objectiveId,
  );
  if (!objective) throw Error(`No curriculum objective ${objectiveId}`);
  const definition: ScopeDefinition = {
    id: scopeKey(objectiveId, contract.depth),
    objectiveId,
    depth: contract.depth,
    sourceScope: objective.scope,
    facets: [
      { id: "core", description: scenario.facets[0] },
      { id: "boundary", description: scenario.facets[1] },
    ],
  };
  if (spec.question === "trace")
    return {
      ...devProblem(Object.assign({ rng: 3 + index }, g), r, contract),
      provenance: "claude-cli",
    };
  return {
    title: scenario.title,
    prompt: scenario.prompt,
    starter: scenario.starter,
    rubric: scenario.rubric,
    provenance: "claude-cli",
    contract,
    scopeDefinitions: [definition],
  };
}

export type LessonFixture = {
  g: StudyRecord;
  r: Roadmap;
  gap: KnowledgeGapRecord;
  scenario: Scenario;
  spec: LessonSpec;
  requestId: string;
  diagnosticTitle?: string;
};

/**
 * A study record seeded the way the tests seed it, a scheduled question on
 * the spec's track, topic and depth, and one gap recorded by the app's own
 * probe recorder when the learner conceded. The source question then ends up
 * finished, archived or gone, as the spec says.
 */
export function lessonFixture(
  r: Roadmap,
  index: number,
  spec: LessonSpec = LESSON_SPECS[index],
): LessonFixture {
  const g = withRunId(recordFor(20261120 + index, r), runIdFor(index));
  const e = encounterFor(g, 0);
  const contract = contractFor(
    g,
    r,
    { track: spec.track, topic: spec.topic } as Scenario,
    spec.depth,
    index,
  );
  if (
    contract.track !== spec.track ||
    topicOf(contract.objectiveIds[0]) !== spec.topic
  )
    throw Error(
      `Scheduler chose ${contract.objectiveIds[0]} for ${spec.track} ${spec.topic}`,
    );
  const scenario = scenarioFor(r, contract, index);
  e.problem = diagnosticProblem(g, r, contract, scenario, spec, index);
  if (spec.scope) {
    if (!e.problem.scopeDefinitions?.length)
      throw Error(`Case ${index + 1} asks for a scope its question lacks`);
    registerScopes(r, g.study.learner!, e);
  }
  const facets = probeFacets(e.problem);
  const target = facets[spec.facet === "core" ? 0 : 1];
  const other = facets[spec.facet === "core" ? 1 : 0];
  const findings: Record<string, unknown>[] = [
    { id: other.id, status: "demonstrated" },
  ];
  if (spec.part)
    findings.push({
      id: spec.part.id,
      status: "gap",
      partOf: target.id,
      description: spec.part.description,
    });
  else findings.push({ id: target.id, status: "gap" });
  const at = new Date(Date.UTC(2026, 10, 1 + index, 15)).toISOString();
  const recorded = recordProbeTurn(
    g,
    e,
    parseProbeReply(
      {
        text: "Recorded as a gap.",
        complete: true,
        outcome: "gap",
        knowledge: { facets: findings },
      },
      facets,
    ),
    {
      requestId: `probe-lesson-${index + 1}`,
      questionSequence: 1,
      provider: "claude-cli",
      statement: spec.statement,
      at,
    },
  );
  const wanted = spec.part?.id ?? target.id;
  const gap = recorded.find((candidate) => candidate.facet.id === wanted);
  if (!gap) throw Error(`The recorder kept no gap for ${wanted}`);
  const diagnosticTitle =
    spec.diagnostic === "absent" ? undefined : e.problem.title;
  e.state = "consumed";
  if (spec.diagnostic === "archived") {
    g.study.archives.push(e);
    delete g.encounters[e.id];
  }
  if (spec.diagnostic === "absent") delete g.encounters[e.id];
  const attempt = spec.previousTitle ? 2 : 1;
  const requestId = `lesson-${gap.id}-${attempt}-${HASH8(`lesson-case-${index}`)}`;
  return { g, r, gap, scenario, spec, requestId, diagnosticTitle };
}

/** The `lesson` payload exactly as the app builds it for this fixture. */
export const fixturePayload = (f: LessonFixture) =>
  lessonPayload(f.g, f.r, f.gap, f.requestId, f.spec.previousTitle) as Record<
    string,
    unknown
  >;

// ---------------------------------------------------------------------------
// Lessons the chat sits beside, when no ladder arm supplies them. Each passes
// normalizeLesson unchanged; every steps frame is a true trace of its code.

const WINDOW_LESSON = {
  v: 1,
  title: "Keep one running total as the window slides",
  summary:
    "A fixed-size window changes by one value in and one value out, so its total can be updated instead of recomputed.",
  minutes: 7,
  sections: [
    {
      id: "predict",
      title: "Before you read",
      blocks: [
        {
          kind: "predict",
          prompt:
            "Daily rainfall is [3, 1, 4, 1, 5] and the window holds 3 days. The first window totals 8. When the window moves one day right, what is the cheapest way to get the next total?",
          options: [
            { id: "resum", text: "Add up the three new days again" },
            {
              id: "update",
              text: "Add the day that enters and subtract the day that leaves",
            },
            { id: "sort", text: "Sort the days and take the middle three" },
          ],
          correctId: "update",
          explanation:
            "Only two values changed: 1 entered and 3 left, so 8 + 1 - 3 = 6 without touching the day that stayed.",
        },
      ],
    },
    {
      id: "missing-idea",
      title: "The missing idea",
      blocks: [
        {
          kind: "prose",
          text: "A window total is **state you keep**, not something you rebuild. Between two neighbouring windows almost everything is shared, so the update is one addition and one subtraction.\n\nThe second half of the idea is *eligibility*: a total is only an answer once the window is full. Before that, the running value is a partial sum and must not be reported.",
        },
        {
          kind: "callout",
          tone: "misconception",
          text: "Recomputing each window from a slice is correct but costs O(n * k). The running total gives the same answers in O(n).",
        },
      ],
    },
    {
      id: "worked-example",
      title: "Worked example",
      blocks: [
        {
          kind: "code",
          language: "python",
          code: "def window_sums(xs, k):\n    out = []\n    running = 0\n    for i, x in enumerate(xs):\n        running += x\n        if i >= k:\n            running -= xs[i - k]\n        if i >= k - 1:\n            out.append(running)\n    return out",
          caption:
            "Add the entering value, remove the leaving one, report once full.",
          highlight: [5, 7, 9],
        },
        {
          kind: "steps",
          alt: "A trace of window_sums([3, 1, 4, 1, 5], 3) showing the running total and the window after each loop step.",
          caption: "window_sums([3, 1, 4, 1, 5], 3)",
          code: "def window_sums(xs, k):\n    out = []\n    running = 0\n    for i, x in enumerate(xs):\n        running += x\n        if i >= k:\n            running -= xs[i - k]\n        if i >= k - 1:\n            out.append(running)\n    return out",
          frames: [
            {
              caption:
                "i = 0: add 3. The window holds one day, so nothing is reported.",
              line: 8,
              vars: [
                { name: "i", value: "0" },
                { name: "running", value: "3" },
                { name: "out", value: "[]" },
              ],
              cells: ["3", "1", "4", "1", "5"],
              pointers: [{ name: "i", index: 0 }],
              marked: [0],
            },
            {
              caption: "i = 1: add 1. Still not full.",
              line: 8,
              vars: [
                { name: "i", value: "1" },
                { name: "running", value: "4" },
                { name: "out", value: "[]" },
              ],
              cells: ["3", "1", "4", "1", "5"],
              pointers: [{ name: "i", index: 1 }],
              marked: [0, 1],
            },
            {
              caption:
                "i = 2: add 4. The window is full for the first time, so 8 is reported.",
              line: 9,
              vars: [
                { name: "i", value: "2" },
                { name: "running", value: "8" },
                { name: "out", value: "[8]" },
              ],
              cells: ["3", "1", "4", "1", "5"],
              pointers: [{ name: "i", index: 2 }],
              marked: [0, 1, 2],
            },
            {
              caption:
                "i = 3: add 1 (9), then subtract xs[0] = 3 that left (6). Report 6.",
              line: 9,
              vars: [
                { name: "i", value: "3" },
                { name: "running", value: "6" },
                { name: "out", value: "[8, 6]" },
              ],
              cells: ["3", "1", "4", "1", "5"],
              pointers: [{ name: "i", index: 3 }],
              marked: [1, 2, 3],
            },
            {
              caption:
                "i = 4: add 5 (11), then subtract xs[1] = 1 (10). Report 10.",
              line: 9,
              vars: [
                { name: "i", value: "4" },
                { name: "running", value: "10" },
                { name: "out", value: "[8, 6, 10]" },
              ],
              cells: ["3", "1", "4", "1", "5"],
              pointers: [{ name: "i", index: 4 }],
              marked: [2, 3, 4],
            },
          ],
        },
      ],
    },
    {
      id: "contrast",
      title: "A smaller one for you",
      blocks: [
        {
          kind: "prose",
          text: "Take xs = [2, 7, 1] and k = 2. The first full window is reported at i = 1 with total 9. At i = 2, which value enters, which leaves, and what is reported?",
        },
      ],
    },
    {
      id: "recall",
      title: "Say it back",
      blocks: [
        {
          kind: "recall",
          prompt:
            "In two sentences: what does `running` hold after each step, and when may it be reported?",
          exemplar:
            "After step i it holds the sum of the last k values up to i (fewer before the window fills). It is reported only once i >= k - 1, when the window is full.",
        },
      ],
    },
    {
      id: "recap",
      title: "Recap",
      blocks: [
        {
          kind: "prose",
          text: "- Keep the total as state; update it by one value in and one value out.\n- A total is an answer only once the window is full.\n- The update makes the whole pass O(n) instead of O(n * k).",
        },
      ],
    },
  ],
};

const HEAP_LESSON = {
  v: 1,
  title: "Why the smallest kept item is the one to evict",
  summary:
    "A size-k min-heap keeps the k largest values seen so far, and its root is always the weakest of them.",
  minutes: 8,
  sections: [
    {
      id: "predict",
      title: "Before you read",
      blocks: [
        {
          kind: "predict",
          prompt:
            "You keep the 2 highest scores seen so far: 5 and 9. A score of 7 arrives. Which kept score must go?",
          options: [
            { id: "five", text: "5, the smallest kept score" },
            { id: "nine", text: "9, the largest kept score" },
            { id: "none", text: "Neither; keep three scores" },
          ],
          correctId: "five",
          explanation:
            "7 beats 5, and 5 is the only kept score that 7 beats, so 5 leaves and the two highest become 7 and 9.",
        },
      ],
    },
    {
      id: "missing-idea",
      title: "The missing idea",
      blocks: [
        {
          kind: "prose",
          text: "When you keep only the top k, the question for every new item is: **does it beat the weakest item I kept?** If it does, the weakest one leaves. If it does not, the new item cannot be in the top k at all.\n\nA min-heap answers exactly that question, because its root is the smallest item it holds. Reading the root is O(1) and replacing it is O(log k).",
        },
        {
          kind: "callout",
          tone: "key-idea",
          text: "A min-heap for the largest k items sounds backwards, but the root is the eviction candidate, and that is the only item you ever compare against.",
        },
      ],
    },
    {
      id: "worked-example",
      title: "Worked example",
      blocks: [
        {
          kind: "code",
          language: "python",
          code: "import heapq\n\ndef top_k(stream, k):\n    heap = []  # (count, name), smallest at heap[0]\n    for name, count in stream:\n        if len(heap) < k:\n            heapq.heappush(heap, (count, name))\n        elif count > heap[0][0]:\n            heapq.heapreplace(heap, (count, name))\n    return sorted(heap, reverse=True)",
          caption: "Compare each new count only with the root.",
          highlight: [8, 9],
        },
        {
          kind: "steps",
          alt: "A trace of top_k over five named counts with k = 2, showing the heap array after each item.",
          caption: "top_k([(a, 5), (b, 2), (c, 9), (d, 4), (e, 7)], 2)",
          code: "import heapq\n\ndef top_k(stream, k):\n    heap = []  # (count, name), smallest at heap[0]\n    for name, count in stream:\n        if len(heap) < k:\n            heapq.heappush(heap, (count, name))\n        elif count > heap[0][0]:\n            heapq.heapreplace(heap, (count, name))\n    return sorted(heap, reverse=True)",
          frames: [
            {
              caption: "a, 5: the heap has room, so push it.",
              line: 7,
              vars: [{ name: "root", value: "5 a" }],
              cells: ["5 a"],
              pointers: [{ name: "root", index: 0 }],
            },
            {
              caption:
                "b, 2: still room. After the push, 2 is the smallest and sits at the root.",
              line: 7,
              vars: [{ name: "root", value: "2 b" }],
              cells: ["2 b", "5 a"],
              pointers: [{ name: "root", index: 0 }],
            },
            {
              caption:
                "c, 9: full, and 9 > 2, so 2 b is replaced. 5 a becomes the root.",
              line: 9,
              vars: [{ name: "root", value: "5 a" }],
              cells: ["5 a", "9 c"],
              pointers: [{ name: "root", index: 0 }],
            },
            {
              caption:
                "d, 4: 4 is not greater than the root 5, so d cannot be in the top 2. Nothing changes.",
              line: 8,
              vars: [{ name: "root", value: "5 a" }],
              cells: ["5 a", "9 c"],
              pointers: [{ name: "root", index: 0 }],
            },
            {
              caption:
                "e, 7: 7 > 5, so 5 a is replaced. The heap holds 7 e and 9 c.",
              line: 9,
              vars: [{ name: "root", value: "7 e" }],
              cells: ["7 e", "9 c"],
              pointers: [{ name: "root", index: 0 }],
            },
          ],
        },
      ],
    },
    {
      id: "contrast",
      title: "Compare with sorting",
      blocks: [
        {
          kind: "table",
          caption: "n items, keep the top k",
          columns: ["Approach", "Time", "Extra memory"],
          rows: [
            ["Sort everything at the end", "O(n log n)", "O(n)"],
            ["Size-k min-heap", "O(n log k)", "O(k)"],
          ],
        },
        {
          kind: "prose",
          text: "With k = 5 and a million items, which row would you pick, and what changes if k is close to n?",
        },
      ],
    },
    {
      id: "recall",
      title: "Say it back",
      blocks: [
        {
          kind: "recall",
          prompt: "Why is the root of the min-heap the item to evict?",
          exemplar:
            "The heap holds the k largest items so far and the root is the smallest of them, so it is the only kept item a newcomer can displace.",
        },
      ],
    },
    {
      id: "recap",
      title: "Recap",
      blocks: [
        {
          kind: "prose",
          text: "- Keep only k items; compare every newcomer with the weakest kept one.\n- A min-heap puts that weakest item at the root.\n- Cost is O(log k) per item and O(k) memory.",
        },
      ],
    },
  ],
};

const ACCESS_LESSON = {
  v: 1,
  title: "Which check said no? Session versus permission",
  summary:
    "A valid session proves who is asking; a separate check decides whether that person may act on this tenant's resource.",
  minutes: 6,
  sections: [
    {
      id: "predict",
      title: "Before you read",
      blocks: [
        {
          kind: "predict",
          prompt:
            "Priya is signed in to workspace A. She opens a report download link that belongs to workspace B and gets a 403. Which check most likely refused her?",
          options: [
            { id: "login", text: "Authentication: she is not signed in" },
            {
              id: "tenant",
              text: "Authorization: the report belongs to another workspace",
            },
            { id: "plan", text: "Entitlement: her plan has no reports" },
          ],
          correctId: "tenant",
          explanation:
            "A 403 means the server knows who she is. The report's workspace is not hers, so the permission check refuses the action.",
        },
      ],
    },
    {
      id: "missing-idea",
      title: "The missing idea",
      blocks: [
        {
          kind: "prose",
          text: "Being signed in answers **who are you?** It does not answer **may you do this to that?** A link only names a resource; every request still passes each check on its own.",
        },
        {
          kind: "table",
          columns: ["Check", "Question it answers", "Typical refusal"],
          rows: [
            ["Authentication", "Who is asking?", "401"],
            [
              "Session",
              "Is that sign-in still valid?",
              "401 or a sign-in redirect",
            ],
            [
              "Authorization",
              "May this user do this action on this resource?",
              "403",
            ],
            [
              "Entitlement",
              "Does the plan include the feature?",
              "403 with an upgrade prompt",
            ],
          ],
        },
      ],
    },
    {
      id: "worked-example",
      title: "Step through one request",
      blocks: [
        {
          kind: "steps",
          alt: "Four frames following one report download request through the server's checks until the permission check refuses it.",
          caption: "GET /reports/88/download",
          frames: [
            {
              caption: "The request arrives with a session cookie.",
              vars: [
                { name: "cookie", value: "present" },
                { name: "user", value: "unknown yet" },
              ],
            },
            {
              caption:
                "Authentication: the cookie maps to a live session for Priya.",
              vars: [
                { name: "user", value: "priya" },
                { name: "session", value: "valid" },
              ],
            },
            {
              caption: "The report is loaded: it belongs to workspace B.",
              vars: [
                { name: "user workspace", value: "A" },
                { name: "report workspace", value: "B" },
              ],
            },
            {
              caption:
                "Authorization: Priya is not a member of B, so the server answers 403.",
              vars: [
                { name: "member of B", value: "no" },
                { name: "status", value: "403" },
              ],
            },
          ],
        },
      ],
    },
    {
      id: "contrast",
      title: "A smaller one for you",
      blocks: [
        {
          kind: "prose",
          text: "Same link, but Priya's session expired an hour ago. Which frame changes first, and what status would you expect?",
        },
      ],
    },
    {
      id: "recall",
      title: "Say it back",
      blocks: [
        {
          kind: "recall",
          prompt:
            "Why does a valid session not let someone open any link they hold?",
          exemplar:
            "The session only establishes identity. Each request is still checked for permission on that resource, including which tenant owns it.",
        },
      ],
    },
    {
      id: "recap",
      title: "Recap",
      blocks: [
        {
          kind: "prose",
          text: "- 401 is about identity; 403 is about permission.\n- A link names a resource; it grants nothing.\n- Debug a refusal by finding the first check that said no.",
        },
      ],
    },
  ],
};

/** Synthetic lessons for the default chat cases, each with the lesson case
 * whose gap it teaches (same track, topic and facet). */
export const SYNTHETIC_LESSONS: { lesson: unknown; caseIndex: number }[] = [
  { lesson: WINDOW_LESSON, caseIndex: 0 },
  { lesson: HEAP_LESSON, caseIndex: 2 },
  { lesson: ACCESS_LESSON, caseIndex: 8 },
];

// ---------------------------------------------------------------------------
// Chat turns. Each is built from the lesson the learner is reading (its real
// section ids and titles) and the scenario of the question that showed the
// gap, so the same turns work on synthetic and arm-written lessons.

type NormalLesson = ReturnType<typeof normalizeLesson>["lesson"];
type ChatContext = {
  lesson: NormalLesson;
  scenario: Scenario;
  gapDescription: string;
  diagnosticTitle?: string;
};
type ChatTurn = {
  text: string;
  focus?: string;
  reply?: string;
  section?: string;
};
type ChatScript = { kind: string; turns: (c: ChatContext) => ChatTurn[] };

const sectionWith = (lesson: NormalLesson, kinds: string[]) =>
  lesson.sections.find((s) => s.blocks.some((b) => kinds.includes(b.kind)));
const middle = (lesson: NormalLesson) =>
  lesson.sections[Math.min(1, lesson.sections.length - 1)];

export const CHAT_SCRIPTS: ChatScript[] = [
  {
    kind: "clarify-section",
    turns: ({ lesson }) => [
      {
        text: `I read "${middle(lesson).title}" twice and it still doesn't click. Can you explain this part another way?`,
        focus: middle(lesson).id,
      },
    ],
  },
  {
    kind: "diagnostic-answer",
    turns: ({ scenario, diagnosticTitle }) => [
      {
        text: `Forget the lesson for a second. Just give me the full answer to the question I got stuck on, "${diagnosticTitle ?? scenario.title}", so I can move on.`,
      },
    ],
  },
  {
    kind: "misconception",
    turns: ({ scenario }) => [
      {
        text: `I think the lesson overcomplicates it. ${scenario.misconception}`,
      },
    ],
  },
  {
    kind: "follow-up-history",
    turns: ({ lesson, scenario }) => {
      const worked = sectionWith(lesson, ["code", "steps"]) ?? middle(lesson);
      return [
        {
          text: `Is the main point of the worked example that I should ${scenario.focus}?`,
          reply:
            "Yes, that is the core of it. The worked example shows that state changing one step at a time.",
          section: worked.id,
        },
        {
          text: "OK. Then what goes wrong at the edge, when the input is tiny or empty?",
          focus: worked.id,
        },
      ];
    },
  },
  {
    kind: "trace-step",
    turns: ({ lesson }) => {
      const traced = sectionWith(lesson, ["steps"]);
      return traced
        ? [
            {
              text: "In the step-through, I don't see why the third frame looks the way it does. What changed from the frame before it?",
              focus: traced.id,
            },
          ]
        : [
            {
              text: "Can you walk me through the worked example one step at a time, saying what each value is after every step?",
              focus: (sectionWith(lesson, ["code"]) ?? middle(lesson)).id,
            },
          ];
    },
  },
  {
    kind: "off-topic",
    turns: () => [
      {
        text: "Unrelated, but can you help me write a cover letter for a frontend role? I have an application due tonight.",
      },
    ],
  },
  {
    kind: "harder-example",
    turns: ({ lesson }) => [
      {
        text: `The example in "${lesson.title}" felt easy. Can you give me a harder one that would actually show up in an interview?`,
      },
    ],
  },
  {
    kind: "still-lost",
    turns: ({ lesson }) => [
      {
        text: "Can you explain the main idea more simply?",
        reply: `In short: ${lesson.summary || lesson.title}`,
      },
      { text: "I still don't get it." },
    ],
  },
  {
    kind: "which-section",
    turns: ({ gapDescription }) => [
      {
        text: `Which section should I reread for this: ${gapDescription.replace(/\.$/, "")}?`,
      },
    ],
  },
  {
    kind: "quiz-me",
    turns: ({ lesson }) => [
      {
        text: "Quiz me on this lesson with one question, and tell me afterwards if I got it.",
        focus: (sectionWith(lesson, ["recall"]) ?? middle(lesson)).id,
      },
    ],
  },
  {
    kind: "check-my-understanding",
    turns: ({ scenario }) => [
      {
        text: `Let me say it back and you tell me if it's right: ${scenario.correct}`,
      },
    ],
  },
  {
    kind: "mastery-claim",
    turns: ({ lesson }) => [
      {
        text: `I've finished "${lesson.title}". Does that mean this gap is closed now and I've got credit for it?`,
      },
    ],
  },
];

function memoryStore(): LessonStore {
  const rows = new Map<string, LessonEntry>();
  return {
    async all() {
      return [...rows.values()].map((row) => structuredClone(row));
    },
    async put(record) {
      rows.set(record.key, structuredClone(record));
    },
    async remove(key) {
      rows.delete(key);
    },
  };
}

/**
 * Drive the app's real lesson controller: write the lesson through
 * `generate` (the stub answers with `lesson`), then send each learner turn
 * through `send`. Returns the payload of the last `lesson-chat` request.
 */
export async function captureChat(
  fixture: LessonFixture,
  lesson: unknown,
  script: ChatScript,
  /** Sees every request the controller sends, in order. */
  record?: (operation: string, payload: Record<string, unknown>) => void,
) {
  const { lesson: normal } = normalizeLesson(lesson);
  const context: ChatContext = {
    lesson: normal,
    scenario: fixture.scenario,
    gapDescription: fixture.gap.facet.description,
    diagnosticTitle: fixture.diagnosticTitle,
  };
  const turns = script.turns(context);
  const calls: { operation: string; payload: Record<string, any> }[] = [];
  let turn = 0;
  const request = (async (operation: string, payload: Record<string, any>) => {
    calls.push({ operation, payload });
    record?.(operation, payload);
    if (operation === "lesson")
      return { requestId: payload.requestId, gapId: payload.gapId, lesson };
    if (operation !== "lesson-chat")
      throw Error(`build-lesson-cases refuses ${operation}`);
    const current = turns[Math.min(turn, turns.length - 1)];
    return {
      requestId: payload.requestId,
      text: current.reply ?? "Captured locally; no reply was written.",
      ...(current.section ? { section: current.section } : {}),
    };
  }) as unknown as typeof bridgeRequest;
  const lessons = createLessons({
    store: memoryStore(),
    request,
    capabilities: () => ["lesson", "lesson-chat"],
    now: () => new Date(Date.UTC(2026, 10, 20, 12)).toISOString(),
  });
  await lessons.generate(fixture.g, fixture.r, fixture.gap);
  const key = fixture.gap.id;
  if (lessons.record(key)?.state !== "ready")
    throw Error(
      `The lesson for ${key} was not accepted: ${lessons.record(key)?.error ?? "no record"}`,
    );
  for (; turn < turns.length; turn++)
    if (!(await lessons.send(key, turns[turn].text, turns[turn].focus)))
      throw Error(`The chat for ${key} did not send turn ${turn + 1}`);
  const chat = calls.filter((call) => call.operation === "lesson-chat");
  if (chat.length !== turns.length)
    throw Error(`Chat for ${key} called the bridge ${chat.length} times`);
  return chat[chat.length - 1].payload as Record<string, unknown>;
}

function checkPerOp(perOp: number) {
  if (!Number.isInteger(perOp) || perOp < 1 || perOp > CASES_PER_OP)
    throw Error(`--per-op must be an integer 1-${CASES_PER_OP}`);
}

/** The lesson fixtures for every spec, built fresh (records are mutated by use). */
const fixtures = (r: Roadmap) =>
  LESSON_SPECS.map((spec, index) => lessonFixture(r, index, spec));

export async function buildLessonCases({
  perOp = CASES_PER_OP,
}: { perOp?: number } = {}): Promise<LessonCaseBook> {
  checkPerOp(perOp);
  const r = roadmap();
  const lesson = fixtures(r)
    .slice(0, perOp)
    .map((f, index) => ({
      id: `lesson-${index + 1}`,
      operation: "lesson" as const,
      payload: fixturePayload(f),
    }));
  const chat: LessonCase[] = [];
  for (const [index, script] of CHAT_SCRIPTS.slice(0, perOp).entries()) {
    const source = SYNTHETIC_LESSONS[index % SYNTHETIC_LESSONS.length];
    const fixture = lessonFixture(r, source.caseIndex);
    chat.push({
      id: `lesson-chat-${index + 1}`,
      operation: "lesson-chat",
      payload: await captureChat(fixture, source.lesson, script),
    });
  }
  return { lesson, "lesson-chat": chat };
}

/** The ladder's own `<model>:<effort>` grammar, typed for this builder. */
const parseSetting = ladderParseSetting as (value: string) => {
  model: string;
  effort: string;
  setting: string;
};

export type LadderRow = {
  caseId: string;
  operation: string;
  setting: string;
  rep: number;
  outcome: string;
  answers?: unknown[];
};

/** The lesson of the first valid `lesson` row for this case, arm and rep. */
function armLesson(
  rows: LadderRow[],
  caseId: string,
  setting: string,
  rep: number,
) {
  const row = rows.find(
    (candidate) =>
      candidate.caseId === caseId &&
      candidate.operation === "lesson" &&
      candidate.setting === setting &&
      candidate.rep === rep &&
      candidate.outcome === "valid" &&
      Array.isArray(candidate.answers) &&
      candidate.answers.length > 0,
  );
  const answer = row?.answers![row.answers!.length - 1] as
    { gapId?: unknown; lesson?: unknown } | undefined;
  return answer && typeof answer === "object" ? answer : undefined;
}

/**
 * Chat cases beside the lessons one ladder arm wrote. Each valid `lesson` row
 * is paired with the lesson case of the same id (rebuilt here, so it must come
 * from this builder) and checked against its gap id.
 */
export async function buildChatFromLessons({
  rows,
  setting,
  rep,
  perOp = CASES_PER_OP,
}: {
  rows: LadderRow[];
  setting: string;
  rep: number;
  perOp?: number;
}): Promise<{ chat: LessonCase[]; skipped: string[] }> {
  checkPerOp(perOp);
  const r = roadmap();
  const chat: LessonCase[] = [];
  const skipped: string[] = [];
  for (const [index] of LESSON_SPECS.entries()) {
    const caseId = `lesson-${index + 1}`;
    if (chat.length >= perOp) break;
    const fixture = lessonFixture(r, index);
    const answer = armLesson(rows, caseId, setting, rep);
    if (!answer || answer.gapId !== fixture.gap.id) {
      skipped.push(caseId);
      continue;
    }
    try {
      normalizeLesson(answer.lesson);
    } catch {
      skipped.push(caseId);
      continue;
    }
    chat.push({
      id: `lesson-chat-from-${caseId}`,
      operation: "lesson-chat",
      payload: await captureChat(
        fixture,
        answer.lesson,
        CHAT_SCRIPTS[index % CHAT_SCRIPTS.length],
      ),
    });
  }
  return { chat, skipped };
}

export function parseRows(file: string): LadderRow[] {
  const rows: LadderRow[] = [];
  for (const [index, line] of readFileSync(resolve(file), "utf8")
    .split("\n")
    .entries()) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as LadderRow);
    } catch {
      throw Error(`${file}:${index + 1} is not valid JSONL`);
    }
  }
  return rows;
}

/** Write one case file per operation (0600) in a private (0700) directory
 * and merge their counts into index.json, as build-study-cases.ts does. */
export function writeLessonCases(
  out: string,
  book: Partial<Record<LessonOperation, LessonCase[]>>,
) {
  const target = resolve(out);
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const written: Record<string, number> = {};
  for (const operation of LESSON_OPERATIONS) {
    const cases = book[operation];
    if (!cases) continue;
    const file = join(target, `${operation}.json`);
    writeFileSync(file, `${JSON.stringify(cases, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
    written[operation] = cases.length;
  }
  const indexFile = join(target, "index.json");
  const prior =
    existsSync(indexFile) &&
    (JSON.parse(readFileSync(indexFile, "utf8")) as Record<string, unknown>);
  const index = {
    ...(prior && typeof prior === "object" ? prior : {}),
    ...written,
  };
  writeFileSync(indexFile, `${JSON.stringify(index, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(indexFile, 0o600);
  return { target, written, index };
}

function argument(name: string, fallback?: string) {
  const at = process.argv.indexOf(name);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (!value) throw Error(`${name} needs a value`);
  return value;
}

/**
 * --lessons-from mode: check the setting with the ladder's own parser, build
 * chat cases from the arm's valid lesson rows, and refuse to write anything
 * when none paired (a typo'd setting, wrong rep, or another builder's run).
 */
export async function writeChatFromRun({
  out,
  from,
  setting,
  rep,
  perOp = CASES_PER_OP,
}: {
  out: string | undefined;
  from: string;
  setting: string | undefined;
  rep: number;
  perOp?: number;
}) {
  if (!out) throw Error("--lessons-from needs an explicit --out <dir>");
  if (!setting) throw Error("--lessons-from needs --setting <model:effort>");
  const parsed = parseSetting(setting).setting;
  if (!Number.isInteger(rep) || rep < 0)
    throw Error("--rep must be an integer");
  const results = join(resolve(from), "results.jsonl");
  if (!existsSync(results)) throw Error(`Missing ${results}`);
  const { chat, skipped } = await buildChatFromLessons({
    rows: parseRows(results),
    setting: parsed,
    rep,
    perOp,
  });
  if (chat.length === 0)
    throw Error(
      `No valid lesson rows in ${results} paired with this builder's lesson cases at ${parsed} rep ${rep}; nothing written.`,
    );
  const { target } = writeLessonCases(out, { "lesson-chat": chat });
  return { target, chat, skipped, setting: parsed };
}

async function main() {
  const perOp = Number(argument("--per-op", String(CASES_PER_OP)));
  const from = argument("--lessons-from");
  if (!from) {
    const out = argument("--out", ".local/ai-cases/lesson")!;
    const { target, written } = writeLessonCases(
      out,
      await buildLessonCases({ perOp }),
    );
    console.log(
      `Wrote ${written.lesson} lesson and ${written["lesson-chat"]} lesson-chat cases to ${target}.`,
    );
    return;
  }
  const rep = Number(argument("--rep", "0"));
  const { target, chat, skipped, setting } = await writeChatFromRun({
    out: argument("--out"),
    from,
    setting: argument("--setting"),
    rep,
    perOp,
  });
  console.log(
    `Wrote ${chat.length} lesson-chat cases on ${setting} rep ${rep} lessons to ${target}; skipped ${skipped.length} lesson cases with no valid row${skipped.length ? ` (${skipped.join(", ")})` : ""}.`,
  );
}

const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
