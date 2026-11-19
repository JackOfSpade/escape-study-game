import assert from "node:assert/strict";
import test from "node:test";
import {
  DIAGRAM,
  layoutDiagram,
  prepareSteps,
  wrapLabel,
} from "../src/lesson-figures";
import {
  assertSafeTree,
  HTML_TAGS,
  lessonTree,
  ON_NAMES,
  predictOutcome,
  PROSE_CLASSES,
  SVG_ATTRS,
  SVG_TAGS,
  type LessonNode,
} from "../src/lesson-render";
import type { LessonDoc } from "../src/lesson-types";

const HOSTILE = [
  "<img src=x onerror=alert(1)>",
  "<script>window.__pwned=1</script>",
  "javascript:alert(1)",
  '" onmouseover="x',
  "</pre><svg onload=1>",
];
/** A different hostile string for each field, so a leak names its source. */
let seq = 0;
const bad = (label: string) => `${HOSTILE[seq++ % HOSTILE.length]} ${label}`;

function fixture(): LessonDoc {
  seq = 0;
  return {
    v: 1,
    title: bad("title"),
    summary: bad("summary"),
    minutes: 5,
    sections: [
      {
        id: "intro",
        title: bad("section title"),
        blocks: [
          { kind: "prose", text: bad("prose") },
          { kind: "callout", tone: "key-idea", text: bad("callout") },
          { kind: "callout", tone: "misconception", text: bad("callout") },
          { kind: "callout", tone: "watch-out", text: bad("callout") },
          {
            kind: "code",
            language: "python",
            code: `x = 1\n${bad("code")}\n\ny = 2\n`,
            caption: bad("code caption"),
            highlight: [2],
          },
          {
            kind: "table",
            caption: bad("table caption"),
            columns: [bad("column"), bad("column")],
            rows: [[bad("cell"), bad("cell")]],
          },
        ],
      },
      {
        id: "figures-2",
        title: bad("section title"),
        blocks: [
          {
            kind: "diagram",
            alt: bad("alt"),
            caption: bad("diagram caption"),
            nodes: [
              { id: "a", label: bad("node"), col: 0, row: 0, tone: "accent" },
              { id: "b", label: bad("node"), col: 1, row: 0, tone: "good" },
              { id: "c", label: bad("node"), col: 1, row: 1, tone: "bad" },
            ],
            edges: [
              { from: "a", to: "b", label: bad("edge") },
              { from: "b", to: "c" },
              { from: "c", to: "b", label: bad("edge") },
            ],
          },
          {
            kind: "steps",
            alt: bad("alt"),
            caption: bad("steps caption"),
            code: `a = [1, 2]\n${bad("code")}`,
            frames: [
              {
                caption: bad("frame"),
                line: 1,
                vars: [{ name: bad("var"), value: bad("value") }],
                cells: [bad("cell"), bad("cell")],
                pointers: [{ name: bad("pointer"), index: 0 }],
                marked: [1],
              },
              { caption: bad("frame"), line: 2, cells: [bad("cell")] },
            ],
          },
          {
            kind: "predict",
            prompt: bad("prompt"),
            options: [
              { id: "opt-a", text: bad("option") },
              { id: "opt-b", text: bad("option") },
            ],
            correctId: "opt-b",
            explanation: bad("explanation"),
          },
          { kind: "recall", prompt: bad("prompt"), exemplar: bad("exemplar") },
        ],
      },
    ],
  };
}

function walk(node: LessonNode, visit: (node: LessonNode) => void) {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

const HTML_ATTRS = new Set([
  "class",
  "id",
  "role",
  "tabindex",
  "hidden",
  "type",
  "disabled",
  "rows",
  "for",
  "name",
  "value",
  "scope",
]);

test("the hostile fixture builds a tree that passes assertSafeTree", () => {
  const tree = lessonTree(fixture(), {});
  assert.doesNotThrow(() => assertSafeTree(tree));
});

test("every tag, attribute and interaction is on the allowlist", () => {
  walk(lessonTree(fixture(), {}), (node) => {
    const tags = node.ns === "svg" ? SVG_TAGS : HTML_TAGS;
    assert.ok(tags.has(node.tag), `tag ${node.tag}`);
    for (const [name, value] of Object.entries(node.attrs ?? {})) {
      const ok =
        HTML_ATTRS.has(name) ||
        /^aria-[a-z]+$/.test(name) ||
        /^data-[a-z][a-z0-9-]*$/.test(name) ||
        (node.ns === "svg" && SVG_ATTRS.has(name));
      assert.ok(ok, `attribute ${name} on ${node.tag}`);
      assert.ok(!/^on/i.test(name));
      assert.ok(
        !["href", "src", "style", "srcdoc", "xlink:href"].includes(name),
      );
      assert.ok(!value.includes("<"), `${name} holds <`);
      assert.ok(!/javascript:/i.test(value), `${name} holds javascript:`);
      if (name === "value") assert.equal(node.tag, "button");
    }
    if (node.on !== undefined) assert.ok(ON_NAMES.has(node.on));
  });
});

test("no model string reaches any attribute value", () => {
  const needles = ["onerror", "onload", "onmouseover", "__pwned", "alert", "<"];
  walk(lessonTree(fixture(), {}), (node) => {
    for (const value of Object.values(node.attrs ?? {}))
      for (const needle of needles)
        assert.ok(!value.includes(needle), `${needle} in attribute ${value}`);
  });
});

test("html appears only on prose nodes and only as escaped markdown", () => {
  let count = 0;
  walk(lessonTree(fixture(), {}), (node) => {
    if (node.html === undefined) return;
    count++;
    const classes = (node.attrs?.class ?? "").split(/\s+/);
    assert.ok(
      PROSE_CLASSES.some((c) => classes.includes(c)),
      node.attrs?.class,
    );
    assert.ok(!/<img|<script|<svg/i.test(node.html), node.html);
    // No tag carries an attribute named on*, and none is an element of ours.
    for (const tag of node.html.matchAll(/<[^>]*>/g))
      assert.ok(!/\son\w+\s*=/i.test(tag[0]), tag[0]);
    // Hostile markup is escaped (kept as text), not dropped or passed on.
    if (node.html.includes("onerror"))
      assert.ok(node.html.includes("&lt;img"), node.html);
  });
  // prose, three callouts and the predict explanation
  assert.equal(count, 5);
});

test("model text reaches the tree as text", () => {
  const texts: string[] = [];
  walk(lessonTree(fixture(), {}), (node) => {
    if (node.text !== undefined) texts.push(node.text);
  });
  for (const label of [
    "title",
    "summary",
    "node",
    "cell",
    "option",
    "exemplar",
    "frame",
  ])
    assert.ok(
      texts.some((t) => t.endsWith(label)),
      label,
    );
});

test("assertSafeTree refuses what the allowlist does not hold", () => {
  const bads: LessonNode[] = [
    { tag: "a", attrs: { class: "x" } },
    { tag: "script" },
    { tag: "img", attrs: { class: "x" } },
    { tag: "div", attrs: { href: "x" } },
    { tag: "div", attrs: { onclick: "x" } },
    { tag: "div", attrs: { style: "color:red" } },
    { tag: "div", attrs: { class: "javascript:alert(1)" } },
    { tag: "div", attrs: { class: "<b>" } },
    { tag: "div", attrs: { class: '" onmouseover="x' } },
    { tag: "div", attrs: { value: "x" } },
    { tag: "div", attrs: { class: "lesson-prose" }, on: "alert(1)" },
    { tag: "div", attrs: { class: "lesson" }, html: "<p>x</p>" },
    { tag: "div", attrs: { class: "lesson-prose" }, html: "<img src=x>" },
    {
      tag: "div",
      attrs: { class: "lesson-prose" },
      html: "<p onclick=x>x</p>",
    },
    { tag: "div", attrs: { class: "lesson-prose" }, html: "<p>x</p><script>" },
    {
      tag: "div",
      attrs: { class: "lesson-prose" },
      html: "<p>x</p><img src=x",
    },
    { tag: "rect", attrs: { x: "1" } },
    { tag: "rect", ns: "svg", attrs: { href: "#x" } },
    { tag: "rect", ns: "svg", attrs: { "xlink:href": "#x" } },
    { tag: "div", attrs: { x: "1" } },
    { tag: "div", children: [{ tag: "p", attrs: { onerror: "x" } }] },
  ];
  for (const unsafe of bads)
    assert.throws(() => assertSafeTree(unsafe), Error, JSON.stringify(unsafe));
  assert.doesNotThrow(() =>
    assertSafeTree({
      tag: "div",
      attrs: { class: "lesson-prose" },
      html: '<p>a&lt;b</p><ol start="3"><li>x</li></ol><pre><code>y</code></pre>',
    }),
  );
});

test("section ids appear only in their validated form, and a bad one is refused", () => {
  const ids: string[] = [];
  walk(lessonTree(fixture(), {}), (node) => {
    if (node.tag === "section") ids.push(node.attrs!.id);
  });
  assert.deepEqual(ids, ["lesson-section-intro", "lesson-section-figures-2"]);
  for (const id of ['x" onmouseover="y', "<b>", "Intro", "9a", "a b"]) {
    const lesson = fixture();
    lesson.sections[0].id = id;
    assert.throws(() => lessonTree(lesson, {}), /section id/);
  }
});

test("option ids never become attributes; options carry their index", () => {
  const lesson = fixture();
  const block = lesson.sections[1].blocks[2];
  assert.equal(block.kind, "predict");
  if (block.kind === "predict") {
    block.options[0].id = '" onmouseover="x';
    block.correctId = block.options[1].id;
  }
  const seen: string[] = [];
  walk(lessonTree(lesson, {}), (node) => {
    if (node.on === "predict-choose") seen.push(node.attrs!["data-option"]);
    for (const value of Object.values(node.attrs ?? {}))
      assert.ok(!value.includes("onmouseover"));
  });
  assert.deepEqual(seen, ["0", "1"]);
});

test("a saved predict answer comes back chosen, with neutral wording", () => {
  const find = (tree: LessonNode, cls: string) => {
    const out: LessonNode[] = [];
    walk(tree, (node) => {
      if ((node.attrs?.class ?? "").split(/\s+/).includes(cls)) out.push(node);
    });
    return out;
  };
  const fresh = lessonTree(fixture(), {});
  assert.equal(find(fresh, "is-chosen").length, 0);
  assert.equal(find(fresh, "lesson-predict-result")[0].attrs!.hidden, "");
  assert.equal(find(fresh, "lesson-explanation")[0].attrs!.hidden, "");

  const wrong = lessonTree(fixture(), { "figures-2/2": "opt-a" });
  const [chosen] = find(wrong, "is-chosen");
  assert.equal(chosen.attrs!["aria-pressed"], "true");
  assert.equal(chosen.attrs!["data-option"], "0");
  assert.equal(find(wrong, "lesson-explanation")[0].attrs!.hidden, undefined);
  const result = find(wrong, "lesson-predict-result")[0];
  assert.match(result.text!, /^The lesson's answer is: /);

  const right = lessonTree(fixture(), { "figures-2/2": "opt-b" });
  assert.equal(
    find(right, "lesson-predict-result")[0].text,
    "That matches the lesson's answer.",
  );
  assert.equal(find(right, "is-chosen")[0].attrs!["data-option"], "1");

  const unknown = lessonTree(fixture(), { "figures-2/2": "nope" });
  assert.equal(find(unknown, "is-chosen").length, 0);

  const wording = [
    ...find(wrong, "lesson-predict-result"),
    ...find(right, "lesson-predict-result"),
  ]
    .map((r) => r.text)
    .join(" ");
  for (const word of ["pass", "fail", "correct", "score", "grade", "credit"])
    assert.ok(!new RegExp(`\\b${word}\\b`, "i").test(wording), word);
});

test("predictOutcome is neutral and ignores unknown answers", () => {
  const block = {
    kind: "predict" as const,
    prompt: "p",
    options: [
      { id: "a", text: "Alpha" },
      { id: "b", text: "Beta" },
    ],
    correctId: "b",
    explanation: "e",
  };
  assert.equal(predictOutcome(block, undefined), undefined);
  assert.equal(predictOutcome(block, "zzz"), undefined);
  assert.equal(
    predictOutcome(block, "a")!.text,
    "The lesson's answer is: Beta.",
  );
  assert.equal(predictOutcome(block, "b")!.matches, true);
});

test("a saved recall answer is restored and unlocks the comparison", () => {
  const find = (tree: LessonNode, cls: string) => {
    let hit: LessonNode | undefined;
    walk(tree, (node) => {
      if (!hit && (node.attrs?.class ?? "").split(/\s+/).includes(cls))
        hit = node;
    });
    return hit!;
  };
  const empty = lessonTree(fixture(), {});
  assert.equal(find(empty, "lesson-recall-reveal").attrs!.disabled, "");
  const text = "I would explain it in my own words here.";
  const saved = lessonTree(fixture(), { "figures-2/3": text });
  assert.equal(find(saved, "lesson-recall-input").text, text);
  assert.equal(find(saved, "lesson-recall-reveal").attrs!.disabled, undefined);
  assert.equal(find(saved, "lesson-recall-compare").attrs!.hidden, "");
});

test("steps frames are prepared up front and bad indices are dropped", () => {
  const prepared = prepareSteps({
    kind: "steps",
    alt: "a",
    code: "a\nb",
    frames: [
      {
        caption: "one",
        line: 9,
        cells: ["x", "y"],
        pointers: [
          { name: "i", index: 1 },
          { name: "j", index: 7 },
        ],
        marked: [0, 5],
      },
      { caption: "two", line: 2, vars: [{ name: "n", value: "1" }] },
    ],
  });
  assert.equal(prepared.frames[0].line, undefined);
  assert.deepEqual(prepared.frames[0].pointers, [[], ["i"]]);
  assert.deepEqual(prepared.frames[0].marked, [true, false]);
  assert.equal(prepared.frames[1].line, 2);
  assert.equal(prepared.maxCells, 2);
  assert.equal(prepared.maxVars, 1);
});

test("wrapLabel breaks at spaces, splits long words and ends with an ellipsis", () => {
  assert.deepEqual(wrapLabel("Hash table", 16, 3), ["Hash table"]);
  assert.deepEqual(wrapLabel("alpha beta gamma delta", 11, 3), [
    "alpha beta",
    "gamma delta",
  ]);
  assert.deepEqual(wrapLabel("x".repeat(20), 16, 3), ["x".repeat(16), "xxxx"]);
  const long = wrapLabel(
    "one two three four five six seven eight nine ten",
    10,
    3,
  );
  assert.equal(long.length, 3);
  assert.ok(long[2].endsWith("…"));
  assert.ok(long.every((line) => line.length <= 10));
  assert.deepEqual(wrapLabel("   ", 10, 3), [""]);
});

test("diagram boxes sit inside the viewBox and never overlap", () => {
  const layout = layoutDiagram({
    kind: "diagram",
    alt: "a",
    nodes: [
      { id: "a", label: "Client", col: 2, row: 1 },
      { id: "b", label: "Server with a long name here", col: 3, row: 1 },
      { id: "c", label: "Cache", col: 3, row: 3 },
      { id: "d", label: "Disk", col: 2, row: 3 },
    ],
    edges: [],
  });
  // Trimmed to the used columns and rows: 2 by 3 cells.
  assert.equal(layout.width, 2 * DIAGRAM.cellW);
  assert.equal(layout.height, 3 * DIAGRAM.cellH);
  for (const box of layout.boxes) {
    assert.ok(box.x >= 0 && box.y >= 0);
    assert.ok(box.x + box.w <= layout.width && box.y + box.h <= layout.height);
    assert.ok(box.lines.length <= DIAGRAM.nodeLines);
  }
  for (const [i, a] of layout.boxes.entries())
    for (const b of layout.boxes.slice(i + 1))
      assert.ok(
        a.x + a.w <= b.x ||
          b.x + b.w <= a.x ||
          a.y + a.h <= b.y ||
          b.y + b.h <= a.y,
        `${a.id} overlaps ${b.id}`,
      );
});

test("diagram arrows start and end on box borders and skip bad edges", () => {
  const layout = layoutDiagram({
    kind: "diagram",
    alt: "a",
    nodes: [
      { id: "a", label: "A", col: 0, row: 0 },
      { id: "b", label: "B", col: 2, row: 0 },
      { id: "c", label: "C", col: 1, row: 2 },
    ],
    edges: [
      { from: "a", to: "b", label: "go" },
      { from: "b", to: "a" },
      { from: "a", to: "c" },
      { from: "a", to: "a" },
      { from: "a", to: "missing" },
    ],
  });
  assert.equal(layout.edges.length, 3);
  const box = (id: string) => layout.boxes.find((b) => b.id === id)!;
  const onBorder = (p: { x: number; y: number }, b: ReturnType<typeof box>) => {
    const inX = p.x >= b.x - 1e-6 && p.x <= b.x + b.w + 1e-6;
    const inY = p.y >= b.y - 1e-6 && p.y <= b.y + b.h + 1e-6;
    const edgeX =
      Math.abs(p.x - b.x) < 1e-6 || Math.abs(p.x - (b.x + b.w)) < 1e-6;
    const edgeY =
      Math.abs(p.y - b.y) < 1e-6 || Math.abs(p.y - (b.y + b.h)) < 1e-6;
    return inX && inY && (edgeX || edgeY);
  };
  for (const edge of layout.edges) {
    assert.ok(
      onBorder({ x: edge.x1, y: edge.y1 }, box(edge.from)),
      `${edge.from} start`,
    );
    assert.ok(
      onBorder({ x: edge.x2, y: edge.y2 }, box(edge.to)),
      `${edge.to} end`,
    );
  }
  // The a-to-b and b-to-a arrows are both drawn, side by side.
  const [ab, ba] = layout.edges;
  assert.notEqual(ab.y1, ba.y1);
  assert.deepEqual(ab.labelLines, ["go"]);
});

test("an empty diagram still has a viewBox", () => {
  const layout = layoutDiagram({
    kind: "diagram",
    alt: "a",
    nodes: [],
    edges: [],
  });
  assert.ok(layout.width > 0 && layout.height > 0);
});
