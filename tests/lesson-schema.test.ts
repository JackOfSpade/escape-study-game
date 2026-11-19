import assert from "node:assert/strict";
import test from "node:test";
import {
  LESSON_BLOCK_KINDS,
  LESSON_FORMAT,
  LESSON_LIMITS,
  lessonBlockKey,
  lessonPlainText,
  normalizeLesson,
} from "../scripts/lib/lesson-schema.mjs";

// The fixtures are deliberately loose: the point is to feed the validator
// shapes the types forbid.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;

/** One lesson that uses every block kind and is already in clean form. */
const valid = (): J => ({
  v: 1,
  title: "Why a queue gives first in, first out",
  summary:
    "Order of removal is the whole difference between a queue and a stack.",
  minutes: 8,
  sections: [
    {
      id: "predict",
      title: "Predict first",
      blocks: [
        {
          kind: "predict",
          prompt:
            "Items 1, 2 and 3 are added to a queue. Which comes out first?",
          options: [
            { id: "a", text: "1" },
            { id: "b", text: "3" },
          ],
          correctId: "a",
          explanation:
            "A queue removes the oldest item first, so 1 leaves first.",
        },
        { kind: "prose", text: "Make a guess before you read on." },
      ],
    },
    {
      id: "idea",
      title: "The idea",
      blocks: [
        {
          kind: "prose",
          text: "A queue serves items in the order they arrived.\n\n- add at the back\n- remove from the front",
        },
        {
          kind: "callout",
          tone: "misconception",
          text: "A queue is not sorted: it only remembers arrival order.",
        },
        {
          kind: "diagram",
          alt: "A producer adds to a queue and a consumer removes from it.",
          caption: "Flow of items",
          nodes: [
            { id: "p", label: "Producer", col: 0, row: 0, tone: "accent" },
            { id: "q", label: "Queue", col: 1, row: 0 },
            { id: "c", label: "Consumer", col: 2, row: 0, tone: "good" },
          ],
          edges: [
            { from: "p", to: "q", label: "add" },
            { from: "q", to: "c" },
          ],
        },
      ],
    },
    {
      id: "worked",
      title: "Worked example",
      blocks: [
        {
          kind: "prose",
          text: "Trace the loop. `i` counts how many items we have removed.",
        },
        {
          kind: "code",
          language: "python",
          code: "items = [1, 2, 3]\nwhile items:\n    items.pop(0)",
          caption: "Drain a list from the front",
          highlight: [2, 3],
        },
        {
          kind: "steps",
          alt: "Three frames showing the list shrink from the front.",
          caption: "Draining",
          code: "items = [1, 2, 3]\nwhile items:\n    items.pop(0)",
          frames: [
            {
              caption: "Start with three items.",
              line: 1,
              vars: [{ name: "n", value: "3" }],
              cells: ["1", "2", "3"],
              pointers: [{ name: "front", index: 0 }],
              marked: [0],
            },
            {
              caption: "Remove the front item.",
              line: 3,
              vars: [{ name: "n", value: "2" }],
              cells: ["2", "3"],
              pointers: [{ name: "front", index: 0 }],
              marked: [0, 1],
            },
          ],
        },
        {
          kind: "table",
          caption: "Stack against queue",
          columns: ["Structure", "Removes"],
          rows: [
            ["Stack", "newest"],
            ["Queue", "oldest"],
          ],
        },
      ],
    },
    {
      id: "recall",
      title: "Close the book",
      blocks: [
        {
          kind: "recall",
          prompt: "Explain from memory why a queue is first in, first out.",
          exemplar:
            "Items leave in the order they arrived because removal is at the front and adding is at the back.",
        },
        {
          kind: "prose",
          text: "- order of arrival\n- front and back\n- not sorted",
        },
      ],
    },
  ],
});

const clone = (value: unknown): J => JSON.parse(JSON.stringify(value));
const normalize = (mutate: (doc: J) => void) => {
  const doc = valid();
  mutate(doc);
  return normalizeLesson(doc);
};
const rejects = (mutate: (doc: J) => void, pattern: RegExp = /./) =>
  assert.throws(
    () => normalize(mutate),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, pattern);
      return true;
    },
  );
/** The first block of a kind in a raw lesson, with where it sits. */
const find = (doc: J, kind: string) => {
  for (const section of doc.sections)
    for (const [index, block] of section.blocks.entries())
      if (block.kind === kind) return { section, index, block };
  throw Error(`fixture has no ${kind}`);
};

test("a full lesson using every block kind round-trips unchanged", () => {
  const { lesson, dropped } = normalizeLesson(valid());
  assert.deepEqual(lesson, valid());
  assert.deepEqual(dropped, []);
  const kinds = new Set(
    lesson.sections.flatMap((s: J) => s.blocks.map((b: J) => b.kind)),
  );
  assert.deepEqual([...kinds].sort(), [...LESSON_BLOCK_KINDS].sort());
  assert.deepEqual(normalizeLesson(lesson), { lesson, dropped: [] });
});

test("the limits and the format text agree", () => {
  assert.equal(LESSON_LIMITS.bytes, 48_000);
  assert.deepEqual([...LESSON_LIMITS.sections], [2, 8]);
  assert.deepEqual([...LESSON_LIMITS.frames], [2, 14]);
  assert.equal(lessonBlockKey("worked", 2), "worked/2");
  for (const kind of LESSON_BLOCK_KINDS)
    assert.ok(LESSON_FORMAT.includes(`"kind":"${kind}"`), kind);
  for (const key of ["knowledge", "complete", "mastery", "resolved"])
    assert.ok(LESSON_FORMAT.includes(key), key);
  assert.ok(LESSON_FORMAT.includes(String(LESSON_LIMITS.prose)));
});

test("a lesson that is not a plain object is refused", () => {
  for (const value of [null, undefined, 7, "lesson", [], [valid()]])
    assert.throws(() => normalizeLesson(value), /JSON object/);
  class Lesson {
    v = 1;
  }
  assert.throws(() => normalizeLesson(new Lesson()), /JSON object/);
  assert.throws(
    () => normalizeLesson(Object.create(valid())),
    /JSON object/,
    "an inherited lesson is not a lesson",
  );
});

test("every forbidden top-level key is refused by name", () => {
  for (const key of [
    "knowledge",
    "complete",
    "outcome",
    "help",
    "mastery",
    "findings",
    "closes",
    "resolved",
  ])
    rejects(
      (doc) => (doc[key] = true),
      new RegExp(`must not contain "${key}"`),
    );
  rejects((doc) => (doc.extra = 1), /unknown top-level key/);
  assert.throws(
    () => normalizeLesson(JSON.parse(`{"__proto__":{"v":1}}`)),
    /unknown top-level key/,
  );
});

test("each core rule has a failing case", () => {
  rejects((doc) => (doc.v = 2), /v must be 1/);
  rejects((doc) => delete doc.v, /v must be 1/);
  rejects((doc) => (doc.title = "ab"), /title/);
  rejects((doc) => (doc.title = "t".repeat(101)), /title/);
  rejects((doc) => (doc.title = 5), /title/);
  rejects((doc) => delete doc.summary, /summary/);
  rejects((doc) => (doc.summary = "s".repeat(301)), /summary/);
  for (const minutes of [1, 21, 5.5, "5", null, NaN])
    rejects((doc) => (doc.minutes = minutes), /minutes/);
  rejects((doc) => (doc.sections = doc.sections.slice(0, 1)), /sections/);
  rejects(
    (doc) =>
      (doc.sections = Array.from({ length: 9 }, (_, i) => ({
        ...clone(doc.sections[1]),
        id: `s${i}`,
      }))),
    /sections/,
  );
  rejects((doc) => (doc.sections = "none"), /sections/);
  rejects((doc) => (doc.sections[0] = "nope"), /section 1/);
  for (const id of ["Bad", "1a", "a b", "a".repeat(33), "", 3, "-a"])
    rejects((doc) => (doc.sections[0].id = id), /section 1 id/);
  rejects((doc) => (doc.sections[1].id = "predict"), /repeated/);
  rejects((doc) => (doc.sections[0].title = ""), /title/);
  rejects((doc) => (doc.sections[0].title = "t".repeat(81)), /title/);
  rejects((doc) => delete doc.sections[0].blocks, /blocks/);
  rejects((doc) => (doc.sections[0].blocks = []), /no usable block/);
  rejects(
    (doc) =>
      (doc.sections[0].blocks = Array.from({ length: 11 }, () => ({
        kind: "prose",
        text: "x",
      }))),
    /more than 10 blocks/,
  );
  rejects(
    (doc) =>
      (doc.sections[0].blocks = [
        { kind: "callout", tone: "nonsense", text: "x" },
      ]),
    /no usable block/,
  );
});

test("a lesson needs at least one prose block", () => {
  rejects((doc) => {
    for (const section of doc.sections)
      section.blocks = section.blocks.filter((b: J) => b.kind !== "prose");
  }, /prose block/);
});

test("a lesson over the byte limit is refused", () => {
  rejects((doc) => {
    for (const section of doc.sections)
      for (let i = 0; i < 6; i++)
        section.blocks.push({ kind: "prose", text: `${i}`.repeat(2400) });
  }, /larger than 48000 bytes/);
});

test("prose limits and bad characters refuse the lesson", () => {
  const prose = (doc: J) => find(doc, "prose").block;
  rejects((doc) => (prose(doc).text = ""), /prose text/);
  rejects((doc) => (prose(doc).text = "   "), /prose text/);
  rejects((doc) => (prose(doc).text = "p".repeat(2401)), /prose text/);
  rejects((doc) => (prose(doc).text = 4), /prose text/);
  rejects((doc) => delete prose(doc).text, /prose text/);
  rejects((doc) => (prose(doc).text = "a\u0000b"), /control character/);
  rejects((doc) => (prose(doc).text = "a‮b"), /bidirectional/);
  const { lesson } = normalize((doc) => (prose(doc).text = "p".repeat(2400)));
  assert.equal(lesson.sections[0].blocks[1].kind, "prose");
});

test("control and bidirectional characters are refused everywhere", () => {
  const bad = [
    "\u0000",
    "\u0001",
    "\u0008",
    "\u000B",
    "\u000C",
    "\u001B",
    "\u007F",
    "‪",
    "‫",
    "‬",
    "‭",
    "‮",
    "⁦",
    "⁧",
    "⁨",
    "⁩",
  ];
  for (const char of bad) {
    rejects((doc) => (doc.title = `a${char}bc`), /title/);
    rejects((doc) => (doc.summary = `a${char}b`), /summary/);
    rejects((doc) => (doc.sections[0].title = `a${char}b`), /title/);
    rejects((doc) => (find(doc, "prose").block.text = `a${char}b`), /prose/);
    // In an optional block it only costs that block.
    const { lesson, dropped } = normalize(
      (doc) => (find(doc, "callout").block.text = `a${char}b`),
    );
    assert.equal(dropped.length, 1);
    assert.match(dropped[0], /^idea\/1:callout: /);
    assert.equal(lesson.sections[1].blocks.length, 2);
  }
  const crlf = normalize((doc) => {
    doc.sections[1].blocks[0].text = "one\r\ntwo\rthree\tfour";
  });
  assert.equal(
    (crlf.lesson.sections[1].blocks[0] as J).text,
    "one\ntwo\nthree\tfour",
  );
});

/** Each case breaks one rule of one optional block; the block alone is lost. */
const droppedCases: [string, string, (block: J) => void][] = [
  ["callout", "tone", (b) => (b.tone = "warning")],
  ["callout", "empty text", (b) => (b.text = "")],
  ["callout", "long text", (b) => (b.text = "c".repeat(601))],
  ["code", "language", (b) => (b.language = "rust")],
  ["code", "empty code", (b) => (b.code = "")],
  ["code", "long code", (b) => (b.code = "c".repeat(3001))],
  ["code", "81 lines", (b) => (b.code = "x\n".repeat(80) + "x")],
  ["code", "long caption", (b) => (b.caption = "c".repeat(161))],
  [
    "code",
    "13 highlights",
    (b) => (b.highlight = Array.from({ length: 13 }, (_, i) => i + 1)),
  ],
  ["code", "repeated highlight", (b) => (b.highlight = [1, 1])],
  ["code", "highlight zero", (b) => (b.highlight = [0])],
  ["code", "highlight past the end", (b) => (b.highlight = [4])],
  ["code", "highlight type", (b) => (b.highlight = ["1"])],
  ["diagram", "empty alt", (b) => (b.alt = "")],
  ["diagram", "long alt", (b) => (b.alt = "a".repeat(241))],
  ["diagram", "long caption", (b) => (b.caption = "a".repeat(161))],
  ["diagram", "one node", (b) => (b.nodes = b.nodes.slice(0, 1))],
  [
    "diagram",
    "13 nodes",
    (b) =>
      (b.nodes = Array.from({ length: 13 }, (_, i) => ({
        id: `n${i}`,
        label: "n",
        col: i % 6,
        row: Math.floor(i / 6),
      }))),
  ],
  ["diagram", "repeated node id", (b) => (b.nodes[1].id = "p")],
  ["diagram", "node id pattern", (b) => (b.nodes[1].id = "Q")],
  ["diagram", "empty label", (b) => (b.nodes[0].label = "")],
  ["diagram", "long label", (b) => (b.nodes[0].label = "l".repeat(49))],
  ["diagram", "col out of range", (b) => (b.nodes[0].col = 6)],
  ["diagram", "negative row", (b) => (b.nodes[0].row = -1)],
  ["diagram", "fractional col", (b) => (b.nodes[0].col = 0.5)],
  [
    "diagram",
    "shared cell",
    (b) => ((b.nodes[1].col = 0), (b.nodes[1].row = 0)),
  ],
  ["diagram", "node tone", (b) => (b.nodes[0].tone = "red")],
  ["diagram", "edge from missing", (b) => (b.edges[0].from = "zz")],
  ["diagram", "edge to missing", (b) => (b.edges[0].to = "zz")],
  ["diagram", "self edge", (b) => (b.edges[0].to = "p")],
  ["diagram", "long edge label", (b) => (b.edges[0].label = "e".repeat(33))],
  [
    "diagram",
    "17 edges",
    (b) =>
      (b.edges = Array.from({ length: 17 }, () => ({ from: "p", to: "q" }))),
  ],
  ["table", "one column", (b) => ((b.columns = ["a"]), (b.rows = [["x"]]))],
  [
    "table",
    "six columns",
    (b) => ((b.columns = "abcdef".split("")), (b.rows = [Array(6).fill("x")])),
  ],
  ["table", "no rows", (b) => (b.rows = [])],
  [
    "table",
    "eleven rows",
    (b) => (b.rows = Array.from({ length: 11 }, () => ["a", "b"])),
  ],
  ["table", "ragged row", (b) => (b.rows[1] = ["only"])],
  ["table", "long column", (b) => (b.columns[0] = "c".repeat(41))],
  ["table", "long cell", (b) => (b.rows[0][0] = "c".repeat(161))],
  ["steps", "empty alt", (b) => (b.alt = "")],
  ["steps", "one frame", (b) => (b.frames = b.frames.slice(0, 1))],
  [
    "steps",
    "fifteen frames",
    (b) => (b.frames = Array.from({ length: 15 }, () => ({ caption: "f" }))),
  ],
  ["steps", "empty frame caption", (b) => (b.frames[0].caption = "")],
  ["steps", "line without code", (b) => delete b.code],
  ["steps", "line past the code", (b) => (b.frames[0].line = 4)],
  [
    "steps",
    "nine vars",
    (b) =>
      (b.frames[0].vars = Array.from({ length: 9 }, (_, i) => ({
        name: `v${i}`,
        value: "1",
      }))),
  ],
  [
    "steps",
    "long var name",
    (b) => (b.frames[0].vars[0].name = "n".repeat(25)),
  ],
  [
    "steps",
    "long var value",
    (b) => (b.frames[0].vars[0].value = "v".repeat(41)),
  ],
  ["steps", "fifteen cells", (b) => (b.frames[0].cells = Array(15).fill("c"))],
  ["steps", "long cell", (b) => (b.frames[0].cells[0] = "c".repeat(13))],
  [
    "steps",
    "five pointers",
    (b) =>
      (b.frames[0].pointers = Array.from({ length: 5 }, () => ({
        name: "p",
        index: 0,
      }))),
  ],
  ["steps", "pointer past cells", (b) => (b.frames[0].pointers[0].index = 3)],
  [
    "steps",
    "long pointer name",
    (b) => (b.frames[0].pointers[0].name = "p".repeat(17)),
  ],
  ["steps", "pointers without cells", (b) => delete b.frames[0].cells],
  [
    "steps",
    "marked without cells",
    (b) => ((b.frames[0].pointers = []), delete b.frames[0].cells),
  ],
  ["steps", "repeated marked", (b) => (b.frames[0].marked = [1, 1])],
  ["steps", "marked past cells", (b) => (b.frames[0].marked = [3])],
  ["predict", "one option", (b) => (b.options = b.options.slice(0, 1))],
  [
    "predict",
    "five options",
    (b) => (b.options = "abcde".split("").map((id) => ({ id, text: id }))),
  ],
  ["predict", "repeated option id", (b) => (b.options[1].id = "a")],
  ["predict", "option id pattern", (b) => (b.options[1].id = "B!")],
  ["predict", "unknown correctId", (b) => (b.correctId = "z")],
  ["predict", "long prompt", (b) => (b.prompt = "p".repeat(401))],
  ["predict", "long option", (b) => (b.options[0].text = "o".repeat(201))],
  ["predict", "empty explanation", (b) => (b.explanation = "")],
  ["predict", "long explanation", (b) => (b.explanation = "e".repeat(801))],
  ["recall", "empty prompt", (b) => (b.prompt = "")],
  ["recall", "long prompt", (b) => (b.prompt = "p".repeat(401))],
  ["recall", "long exemplar", (b) => (b.exemplar = "e".repeat(1001))],
];

test("an invalid optional block is dropped and named, and the rest is kept", () => {
  for (const [kind, rule, mutate] of droppedCases) {
    const raw = valid();
    const { section, index, block } = find(raw, kind);
    mutate(block);
    const { lesson, dropped } = normalizeLesson(raw);
    assert.equal(dropped.length, 1, `${kind}: ${rule}`);
    assert.match(
      dropped[0],
      new RegExp(`^${section.id}/${index}:${kind}: .+`),
      `${kind}: ${rule}`,
    );
    const expected = valid();
    const target = expected.sections.find((s: J) => s.id === section.id);
    target.blocks.splice(index, 1);
    assert.deepEqual(lesson, expected, `${kind}: ${rule}`);
  }
});

test("a code block at its limits is kept", () => {
  const { lesson, dropped } = normalize((doc) => {
    const block = find(doc, "code").block;
    block.code = Array.from({ length: 80 }, (_, i) => `l${i}`).join("\n");
    block.highlight = Array.from({ length: 12 }, (_, i) => i + 1);
  });
  assert.deepEqual(dropped, []);
  assert.equal((find(lesson, "code").block as J).highlight.length, 12);
});

test("unknown kinds and non-blocks are dropped with their original index", () => {
  const { lesson, dropped } = normalize((doc) => {
    doc.sections[1].blocks.unshift(
      { kind: "video", src: "https://example.test/x.mp4" },
      "just a string",
      { kind: "__proto__" },
      { text: "no kind" },
    );
  });
  assert.deepEqual(dropped, [
    "idea/0:video: unknown block kind",
    "idea/1:unknown: not a block",
    "idea/2:__proto__: unknown block kind",
    "idea/3:unknown: unknown block kind",
  ]);
  assert.deepEqual(lesson, valid());
  const hostile = normalize((doc) => {
    doc.sections[1].blocks.push({ kind: "<img src=x onerror=alert(1)>" });
  });
  assert.match(hostile.dropped[0], /^idea\/3:\?img\?src\?x\?onerror\?alert: /);
  assert.ok(!hostile.dropped[0].includes("<"));
});

test("the clean copy holds no unknown key at any level and is a separate object", () => {
  const raw = valid();
  const extras = ["__proto__", "style", "href", "onclick", "src", "innerHTML"];
  const decorate = (value: J, top = true) => {
    if (Array.isArray(value)) return value.forEach((v) => decorate(v, false));
    if (!value || typeof value !== "object") return;
    for (const inner of Object.values(value)) decorate(inner, false);
    if (!top)
      for (const key of extras)
        Object.defineProperty(value, key, {
          value:
            key === "__proto__" ? { polluted: true } : "javascript:alert(1)",
          enumerable: true,
          configurable: true,
          writable: true,
        });
  };
  decorate(raw);
  const before = JSON.stringify(raw);
  const { lesson, dropped } = normalizeLesson(raw);
  assert.deepEqual(dropped, []);
  assert.deepEqual(lesson, valid());
  assert.equal(JSON.stringify(raw), before, "the input is not touched");
  assert.equal(({} as J).polluted, undefined);
  const walk = (value: J, path: string) => {
    if (Array.isArray(value))
      return value.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!value || typeof value !== "object") return;
    assert.equal(Object.getPrototypeOf(value), Object.prototype, path);
    for (const key of Object.keys(value)) {
      assert.ok(!extras.includes(key), `${path}.${key}`);
      walk(value[key], `${path}.${key}`);
    }
  };
  walk(lesson, "lesson");
  assert.notEqual(lesson, raw);
  assert.notEqual(lesson.sections[0], raw.sections[0]);
  assert.notEqual(lesson.sections[0].blocks[0], raw.sections[0].blocks[0]);
  // Changing the input afterwards cannot change what was returned.
  raw.sections[0].blocks[0].prompt = "changed";
  assert.equal(JSON.stringify(lesson), JSON.stringify(valid()));
});

test("single-line fields collapse whitespace and prose is trimmed", () => {
  const { lesson } = normalize((doc) => {
    doc.title = "  A   spaced\ttitle \n here ";
    find(doc, "prose").block.text = "\n\n  Body text.  \n";
  });
  assert.equal(lesson.title, "A spaced title here");
  assert.equal((find(lesson, "prose").block as J).text, "Body text.");
});

test("lessonPlainText reads each section in order and can be cut", () => {
  const { lesson } = normalizeLesson(valid());
  const plain = lessonPlainText(lesson);
  const heads = [
    "predict: Predict first",
    "idea: The idea",
    "worked: Worked example",
    "recall: Close the book",
  ].map((h) => plain.indexOf(`## ${h}`));
  assert.ok(heads.every((at) => at >= 0));
  assert.deepEqual(
    [...heads].sort((a, b) => a - b),
    heads,
  );
  assert.ok(plain.includes("```python\nitems = [1, 2, 3]"));
  assert.ok(plain.includes("Producer -> Queue (add)"));
  assert.ok(plain.includes("Queue -> Consumer"));
  assert.ok(plain.includes("Structure | Removes"));
  assert.ok(plain.includes("Queue | oldest"));
  assert.ok(plain.includes("1. Start with three items."));
  assert.ok(plain.includes("2. Remove the front item."));
  assert.ok(plain.includes("n = 3"));
  assert.ok(plain.includes("cells [1, 2, 3]"));
  assert.ok(plain.includes("Predict: Items 1, 2 and 3"));
  assert.ok(plain.includes("- b: 3"));
  assert.ok(plain.includes("Correct option: a: 1"));
  assert.ok(plain.includes("Explanation: A queue removes the oldest"));
  assert.ok(plain.includes("Recall: Explain from memory"));
  assert.ok(plain.includes("Exemplar: Items leave in the order"));
  assert.ok(plain.includes("[misconception] A queue is not sorted"));
  const cut = lessonPlainText(lesson, 120);
  assert.equal(cut.length, 120);
  assert.equal(cut.slice(0, 119), plain.slice(0, 119));
  assert.ok(cut.endsWith("…"));
  assert.equal(lessonPlainText(lesson, plain.length), plain);
  assert.equal(lessonPlainText(lesson, 0), "");
});

/** A small deterministic generator, so a failing mutation can be replayed. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const JUNK: J[] = [
  null,
  true,
  0,
  -1,
  1.5,
  1e9,
  "NaN",
  "",
  " ",
  "x".repeat(5000),
  "a\u0000b",
  "a‮b",
  "\r\n",
  [],
  {},
  [1, 2, 3],
  { kind: "prose", text: "injected" },
  { kind: "table" },
  "<script>alert(1)</script>",
];
test("seeded mutation fuzz: a lesson is either stable under normalising or an Error", () => {
  const random = mulberry32(Number(process.env.LESSON_FUZZ_SEED ?? 20261119));
  const pick = <T>(items: T[]): T =>
    structuredClone(items[Math.floor(random() * items.length)]);
  const nodes = (root: J) => {
    const found: { holder: J; key: string | number }[] = [];
    const visit = (holder: J) => {
      if (!holder || typeof holder !== "object") return;
      for (const key of Object.keys(holder)) {
        found.push({ holder, key });
        visit(holder[key]);
      }
    };
    visit(root);
    return found;
  };
  let accepted = 0,
    rejected = 0,
    dropped = 0;
  for (let round = 0; round < 4000; round++) {
    const doc = valid();
    for (let step = 1 + Math.floor(random() * 3); step > 0; step--) {
      const spots = nodes(doc);
      const { holder, key } = spots[Math.floor(random() * spots.length)];
      const op = Math.floor(random() * 5);
      if (op === 0) {
        if (Array.isArray(holder)) holder.splice(Number(key), 1);
        else delete holder[key];
      } else if (op === 1) holder[key] = pick(JUNK);
      else if (op === 2 && !Array.isArray(holder))
        Object.defineProperty(
          holder,
          pick(["__proto__", "style", "kind", "id", "x"]),
          {
            value: pick(JUNK),
            enumerable: true,
            configurable: true,
            writable: true,
          },
        );
      else if (op === 3 && typeof holder[key] === "string")
        holder[key] =
          holder[key] + pick(["\u0007", "⁧", "\n\n", "é", "", "   "]);
      else if (op === 4 && typeof holder[key] === "number")
        holder[key] = holder[key] + pick([-1, 1, 100, 0.5, -100]);
    }
    let result;
    try {
      result = normalizeLesson(doc);
    } catch (error) {
      assert.ok(error instanceof Error, `round ${round} threw a non-Error`);
      assert.ok(error.message.length > 0 && error.message.length < 400);
      rejected++;
      continue;
    }
    accepted++;
    if (result.dropped.length) dropped++;
    assert.ok(result.lesson.sections.length >= 2);
    const again = normalizeLesson(result.lesson);
    assert.deepEqual(again.lesson, result.lesson, `round ${round}`);
    assert.deepEqual(again.dropped, [], `round ${round}`);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(result.lesson)).length <=
        LESSON_LIMITS.bytes,
    );
    assert.equal(({} as J).x, undefined);
  }
  assert.ok(accepted > 400, `accepted ${accepted}`);
  assert.ok(rejected > 400, `rejected ${rejected}`);
  assert.ok(dropped > 100, `dropped ${dropped}`);
});
