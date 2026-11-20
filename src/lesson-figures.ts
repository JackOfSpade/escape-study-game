/**
 * Pure figure maths and node trees for lessons: code lines, diagram layout and
 * step-through frames. No DOM access, so node can test it. Every string the
 * model wrote leaves here as `text` on a node, never as an attribute; every
 * attribute value is a class name, a number or an id built from indices.
 */
import type { LessonBlock } from "./lesson-types";

type Of<K extends LessonBlock["kind"]> = Extract<LessonBlock, { kind: K }>;

/**
 * One element the DOM layer will create. `text` becomes textContent, `html` is
 * accepted only on prose nodes and only as markdownToHtml output, and `on`
 * names an interaction the mount layer handles (never code).
 */
export interface LessonNode {
  tag: string;
  ns?: "svg";
  attrs?: Record<string, string>;
  text?: string;
  html?: string;
  children?: LessonNode[];
  on?: string;
}

type Rest = Omit<LessonNode, "tag" | "attrs" | "ns">;

/** An HTML node. */
export const n = (
  tag: string,
  attrs: Record<string, string> = {},
  rest: Rest = {},
): LessonNode => ({ tag, attrs, ...rest });

/** Plain text cut at its `code` spans: [text, code, text, ...]. */
export const codeRuns = (text: string) => text.split(/`([^`\n]+)`/);

/**
 * The content of a plain-text field (a prompt, an option, a caption, a table
 * cell). These fields are not markdown, but a model still writes `names` in
 * backticks there, so those become code nodes instead of showing the ticks.
 */
export const rich = (text: string): Rest => {
  const runs = codeRuns(text);
  if (runs.length === 1) return { text };
  return {
    children: runs.flatMap((run, i) =>
      run === "" ? [] : [n(i % 2 ? "code" : "span", {}, { text: run })],
    ),
  };
};

/** An SVG node. */
export const s = (
  tag: string,
  attrs: Record<string, string> = {},
  rest: Rest = {},
): LessonNode => ({ tag, ns: "svg", attrs, ...rest });

/** A number as an attribute value: short, finite, no exponent. */
const num = (value: number) =>
  String(Math.round((Number.isFinite(value) ? value : 0) * 100) / 100);

/** The lines of a piece of code; one trailing newline adds no empty line. */
export function splitCodeLines(code: string): string[] {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One span.lesson-line per line, each with its own line-number span. */
export function codeLineNodes(
  code: string,
  highlight: readonly number[] = [],
  current?: number,
): LessonNode[] {
  const marked = new Set(highlight);
  return splitCodeLines(code).map((line, index) => {
    const number = index + 1;
    const classes = ["lesson-line"];
    if (marked.has(number)) classes.push("is-highlight");
    if (number === current) classes.push("is-current");
    return n(
      "span",
      { class: classes.join(" ") },
      {
        children: [
          n(
            "span",
            { class: "lesson-line-no", "aria-hidden": "true" },
            { text: String(number) },
          ),
          n("span", { class: "lesson-line-text" }, { text: line }),
        ],
      },
    );
  });
}

/** The code panel shared by code blocks and step-through figures. */
export function codePanel(
  code: string,
  highlight: readonly number[] = [],
  current?: number,
): LessonNode {
  return n(
    "pre",
    { class: "lesson-pre", tabindex: "0" },
    {
      children: [
        n(
          "code",
          { class: "lesson-code" },
          { children: codeLineNodes(code, highlight, current) },
        ),
      ],
    },
  );
}

// ---------------------------------------------------------------------------
// Diagrams
// ---------------------------------------------------------------------------

export const DIAGRAM = {
  cellW: 196,
  cellH: 96,
  boxW: 128,
  boxH: 60,
  /** Estimated glyph width in viewBox units, for wrapping without measuring. */
  charW: 7,
  lineH: 15,
  nodeChars: 16,
  nodeLines: 3,
  edgeChars: 12,
  edgeLines: 2,
  edgeCharW: 6.2,
  /** Sideways shift of an arrow that has an opposite arrow beside it. */
  parallel: 8,
} as const;

/** Wraps a label onto at most `maxLines` lines of about `maxChars` characters,
 * breaking at spaces where it can and ending the last line with an ellipsis
 * when text is left over. */
export function wrapLabel(
  text: string,
  maxChars: number,
  maxLines: number,
): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  const flush = () => {
    if (line) lines.push(line);
    line = "";
  };
  for (let word of words) {
    while (word.length > maxChars) {
      flush();
      lines.push(word.slice(0, maxChars));
      word = word.slice(maxChars);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
    else {
      flush();
      line = word;
    }
  }
  flush();
  if (lines.length <= maxLines) return lines.length ? lines : [""];
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] =
    (last.length >= maxChars ? last.slice(0, maxChars - 1) : last) + "…";
  return kept;
}

const TONES = ["plain", "accent", "good", "bad"] as const;
type Tone = (typeof TONES)[number];
const toneOf = (value: unknown): Tone =>
  TONES.find((tone) => tone === value) ?? "plain";
const TONE_WORD: Record<Tone, string> = {
  plain: "",
  accent: "emphasised",
  good: "marked good",
  bad: "marked as a problem",
};

export interface DiagramBox {
  /** Position in the block's node list. */
  index: number;
  id: string;
  label: string;
  lines: string[];
  tone: Tone;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiagramEdge {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label?: string;
  labelLines: string[];
  /** Midpoint of the arrow, where the label sits. */
  mx: number;
  my: number;
}

export interface DiagramLayout {
  width: number;
  height: number;
  boxes: DiagramBox[];
  edges: DiagramEdge[];
}

const gridIndex = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(5, Math.floor(value)))
    : 0;

/** Where the ray from (cx, cy) along (dx, dy) leaves a box centred there. */
function exitPoint(
  cx: number,
  cy: number,
  dx: number,
  dy: number,
  hw: number,
  hh: number,
) {
  const tx = dx === 0 ? Infinity : hw / Math.abs(dx);
  const ty = dy === 0 ? Infinity : hh / Math.abs(dy);
  const t = Math.min(tx, ty);
  return { x: cx + dx * t, y: cy + dy * t };
}

/** Puts every node in its grid cell and joins the nodes with arrows. The grid
 * is trimmed to the columns and rows in use. Edges to missing nodes and edges
 * from a node to itself are left out. */
export function layoutDiagram(block: Of<"diagram">): DiagramLayout {
  const placed = block.nodes.map((node, index) => ({
    node,
    index,
    col: gridIndex(node.col),
    row: gridIndex(node.row),
  }));
  const cols = placed.map((p) => p.col);
  const rows = placed.map((p) => p.row);
  const lo = {
    col: cols.length ? Math.min(...cols) : 0,
    row: rows.length ? Math.min(...rows) : 0,
  };
  const hi = {
    col: cols.length ? Math.max(...cols) : 0,
    row: rows.length ? Math.max(...rows) : 0,
  };
  const boxes: DiagramBox[] = placed.map(({ node, index, col, row }) => ({
    index,
    id: node.id,
    label: node.label,
    lines: wrapLabel(node.label, DIAGRAM.nodeChars, DIAGRAM.nodeLines),
    tone: toneOf(node.tone),
    x: (col - lo.col) * DIAGRAM.cellW + (DIAGRAM.cellW - DIAGRAM.boxW) / 2,
    y: (row - lo.row) * DIAGRAM.cellH + (DIAGRAM.cellH - DIAGRAM.boxH) / 2,
    w: DIAGRAM.boxW,
    h: DIAGRAM.boxH,
  }));
  const byId = new Map<string, DiagramBox>();
  for (const box of boxes) if (!byId.has(box.id)) byId.set(box.id, box);
  const wanted = new Set(block.edges.map((e) => `${e.from}\u0000${e.to}`));
  const edges: DiagramEdge[] = [];
  for (const edge of block.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b || a === b) continue;
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h / 2;
    const bx = b.x + b.w / 2;
    const by = b.y + b.h / 2;
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    // An arrow with an opposite twin slides to its own side so both show.
    const side = wanted.has(`${edge.to}\u0000${edge.from}`)
      ? DIAGRAM.parallel
      : 0;
    const ox = -dy * side;
    const oy = dx * side;
    const start = exitPoint(ax + ox, ay + oy, dx, dy, a.w / 2, a.h / 2);
    const end = exitPoint(bx + ox, by + oy, -dx, -dy, b.w / 2, b.h / 2);
    edges.push({
      from: edge.from,
      to: edge.to,
      x1: start.x,
      y1: start.y,
      x2: end.x,
      y2: end.y,
      label: edge.label || undefined,
      labelLines: edge.label
        ? wrapLabel(edge.label, DIAGRAM.edgeChars, DIAGRAM.edgeLines)
        : [],
      mx: (start.x + end.x) / 2,
      my: (start.y + end.y) / 2,
    });
  }
  return {
    width: (hi.col - lo.col + 1) * DIAGRAM.cellW,
    height: (hi.row - lo.row + 1) * DIAGRAM.cellH,
    boxes,
    edges,
  };
}

/** The picture itself: one svg, drawn only from app-computed numbers. */
export function diagramSvg(block: Of<"diagram">, uid: string): LessonNode {
  const layout = layoutDiagram(block);
  const titleId = `${uid}-title`;
  const markerId = `${uid}-arrow`;
  const edgeNodes = layout.edges.map((edge) => {
    const kids: LessonNode[] = [
      s("line", {
        class: "lesson-edge-line",
        x1: num(edge.x1),
        y1: num(edge.y1),
        x2: num(edge.x2),
        y2: num(edge.y2),
        "marker-end": `url(#${markerId})`,
      }),
    ];
    if (edge.label) {
      const widest = Math.max(...edge.labelLines.map((l) => l.length));
      const w = widest * DIAGRAM.edgeCharW + 10;
      const h = edge.labelLines.length * 14 + 4;
      kids.push(
        s("rect", {
          class: "lesson-edge-label-bg",
          x: num(edge.mx - w / 2),
          y: num(edge.my - h / 2),
          width: num(w),
          height: num(h),
          rx: "3",
          ry: "3",
        }),
      );
      edge.labelLines.forEach((line, i) =>
        kids.push(
          s(
            "text",
            {
              class: "lesson-edge-label",
              x: num(edge.mx),
              y: num(edge.my + (i - (edge.labelLines.length - 1) / 2) * 14),
              "text-anchor": "middle",
              "dominant-baseline": "middle",
            },
            { text: line },
          ),
        ),
      );
    }
    return s("g", { class: "lesson-edge" }, { children: kids });
  });
  const boxNodes = layout.boxes.map((box) =>
    s(
      "g",
      { class: `lesson-node is-${box.tone}` },
      {
        children: [
          s("title", {}, { text: box.label }),
          s("rect", {
            class: "lesson-node-box",
            x: num(box.x),
            y: num(box.y),
            width: num(box.w),
            height: num(box.h),
            rx: "8",
            ry: "8",
          }),
          ...box.lines.map((line, i) =>
            s(
              "text",
              {
                class: "lesson-node-text",
                x: num(box.x + box.w / 2),
                y: num(
                  box.y +
                    box.h / 2 +
                    (i - (box.lines.length - 1) / 2) * DIAGRAM.lineH,
                ),
                "text-anchor": "middle",
                "dominant-baseline": "middle",
              },
              { text: line },
            ),
          ),
        ],
      },
    ),
  );
  return s(
    "svg",
    {
      class: `lesson-diagram-svg cols-${Math.max(1, Math.min(6, Math.round(layout.width / DIAGRAM.cellW)))}`,
      role: "img",
      "aria-labelledby": titleId,
      viewBox: `0 0 ${num(layout.width)} ${num(layout.height)}`,
    },
    {
      children: [
        s("title", { id: titleId }, { text: block.alt }),
        s(
          "defs",
          {},
          {
            children: [
              s(
                "marker",
                {
                  id: markerId,
                  markerWidth: "9",
                  markerHeight: "9",
                  refX: "8",
                  refY: "4.5",
                  orient: "auto",
                  markerUnits: "userSpaceOnUse",
                },
                {
                  children: [
                    s("path", {
                      class: "lesson-arrow-head",
                      d: "M 0 0 L 9 4.5 L 0 9 z",
                    }),
                  ],
                },
              ),
            ],
          },
        ),
        s("g", { class: "lesson-edges" }, { children: edgeNodes }),
        s("g", { class: "lesson-nodes" }, { children: boxNodes }),
      ],
    },
  );
}

/** The same diagram as lists, for anyone who cannot use the picture. */
export function diagramTextVersion(block: Of<"diagram">): LessonNode {
  const labels = new Map<string, string>();
  for (const node of block.nodes)
    if (!labels.has(node.id)) labels.set(node.id, node.label);
  const boxes = block.nodes.map((node) => {
    const word = TONE_WORD[toneOf(node.tone)];
    return n("li", {}, { text: word ? `${node.label} (${word})` : node.label });
  });
  const arrows = block.edges.flatMap((edge) => {
    const from = labels.get(edge.from);
    const to = labels.get(edge.to);
    if (from === undefined || to === undefined || from === to) return [];
    return [
      n(
        "li",
        {},
        { text: `${from} to ${to}${edge.label ? `: ${edge.label}` : ""}` },
      ),
    ];
  });
  const kids: LessonNode[] = [
    n("p", { class: "lesson-text-label" }, { text: "Boxes" }),
    n("ul", { class: "lesson-text-list" }, { children: boxes }),
  ];
  if (arrows.length)
    kids.push(
      n("p", { class: "lesson-text-label" }, { text: "Arrows" }),
      n("ul", { class: "lesson-text-list" }, { children: arrows }),
    );
  return n(
    "details",
    { class: "lesson-text-version" },
    {
      children: [
        n("summary", {}, { text: "Text version" }),
        n("div", { class: "lesson-text-body" }, { children: kids }),
      ],
    },
  );
}

// ---------------------------------------------------------------------------
// Step-through figures
// ---------------------------------------------------------------------------

export interface PreparedFrame {
  caption: string;
  /** 1-based line of the code, when it is in range. */
  line?: number;
  vars: { name: string; value: string }[];
  cells: string[];
  /** Pointer names under each cell, by cell index. */
  pointers: string[][];
  marked: boolean[];
}

export interface PreparedSteps {
  code?: string;
  codeLines: number;
  frames: PreparedFrame[];
  /** How many cell and variable slots the figure needs for any frame. */
  maxCells: number;
  maxVars: number;
}

/** Every frame's data, cleaned and ready before the figure is shown, so
 * stepping only has to copy it onto existing nodes. */
export function prepareSteps(block: Of<"steps">): PreparedSteps {
  const codeLines = block.code ? splitCodeLines(block.code).length : 0;
  const frames = block.frames.map((frame): PreparedFrame => {
    const cells = frame.cells ?? [];
    const pointers: string[][] = cells.map(() => []);
    for (const p of frame.pointers ?? [])
      if (Number.isInteger(p.index) && p.index >= 0 && p.index < cells.length)
        pointers[p.index].push(p.name);
    const marked = cells.map(() => false);
    for (const index of frame.marked ?? [])
      if (Number.isInteger(index) && index >= 0 && index < cells.length)
        marked[index] = true;
    const line =
      typeof frame.line === "number" &&
      Number.isInteger(frame.line) &&
      frame.line >= 1 &&
      frame.line <= codeLines
        ? frame.line
        : undefined;
    return {
      caption: frame.caption,
      line,
      vars: (frame.vars ?? []).map((v) => ({ name: v.name, value: v.value })),
      cells: [...cells],
      pointers,
      marked,
    };
  });
  return {
    code: block.code || undefined,
    codeLines,
    frames,
    maxCells: Math.max(0, ...frames.map((f) => f.cells.length)),
    maxVars: Math.max(0, ...frames.map((f) => f.vars.length)),
  };
}

/** The text a frame's pointers show under a cell. */
export const pointerText = (names: readonly string[]) =>
  names.length ? `↑ ${names.join(", ")}` : "";

/** "Step 2 of 5". */
export const stepCount = (index: number, total: number) =>
  `Step ${index + 1} of ${total}`;

const button = (
  label: string,
  on: string,
  extra: Record<string, string> = {},
) =>
  n(
    "button",
    { type: "button", class: "lesson-button", ...extra },
    { text: label, on },
  );

/** The figure for a step-through block, showing its first frame. `where` is
 * `{ section, block }` as numbers: they are the only way the figure is found
 * again. Returns undefined when the block has no frames. */
export function stepsFigure(
  block: Of<"steps">,
  where: { section: number; block: number },
  uid: string,
): { node: LessonNode; steps: PreparedSteps } | undefined {
  const steps = prepareSteps(block);
  const first = steps.frames[0];
  if (!first) return undefined;
  const total = steps.frames.length;
  const labelId = `${uid}-label`;
  const kids: LessonNode[] = [
    n("span", { class: "lesson-sr", id: labelId }, { text: block.alt }),
  ];
  if (steps.code)
    kids.push(
      n(
        "div",
        { class: "lesson-steps-code" },
        { children: [codePanel(steps.code, [], first.line)] },
      ),
    );
  if (steps.maxCells > 0) {
    const slots = Array.from({ length: steps.maxCells }, (_, i) => {
      const used = i < first.cells.length;
      return n(
        "div",
        {
          class: `lesson-cell${used && first.marked[i] ? " is-marked" : ""}`,
          ...(used ? {} : { hidden: "" }),
        },
        {
          children: [
            n(
              "span",
              { class: "lesson-cell-index", "aria-hidden": "true" },
              { text: String(i) },
            ),
            n(
              "span",
              { class: "lesson-cell-value" },
              { text: used ? first.cells[i] : "" },
            ),
            n(
              "span",
              {
                class: "lesson-sr",
                ...(used && first.marked[i] ? {} : { hidden: "" }),
              },
              { text: "marked" },
            ),
            n(
              "span",
              {
                class: "lesson-cell-pointers",
                ...(used && first.pointers[i].length ? {} : { hidden: "" }),
              },
              { text: used ? pointerText(first.pointers[i]) : "" },
            ),
          ],
        },
      );
    });
    kids.push(n("div", { class: "lesson-cells" }, { children: slots }));
  }
  if (steps.maxVars > 0) {
    const slots = Array.from({ length: steps.maxVars }, (_, i) => {
      const v = first.vars[i];
      return n(
        "li",
        { class: "lesson-var", ...(v ? {} : { hidden: "" }) },
        {
          children: [
            n("span", { class: "lesson-var-name" }, { text: v ? v.name : "" }),
            n("span", { class: "lesson-var-eq" }, { text: "=" }),
            n(
              "span",
              { class: "lesson-var-value" },
              { text: v ? v.value : "" },
            ),
          ],
        },
      );
    });
    kids.push(n("ul", { class: "lesson-vars" }, { children: slots }));
  }
  kids.push(
    n(
      "p",
      { class: "lesson-steps-caption", "aria-live": "polite" },
      rich(first.caption),
    ),
    n(
      "div",
      { class: "lesson-steps-controls" },
      {
        children: [
          button("Previous", "step-prev", { "aria-disabled": "true" }),
          button(
            "Next",
            "step-next",
            total > 1 ? {} : { "aria-disabled": "true" },
          ),
          button("Restart", "step-reset"),
          n(
            "span",
            { class: "lesson-steps-count" },
            { text: stepCount(0, total) },
          ),
        ],
      },
    ),
  );
  const figureKids: LessonNode[] = [
    n("div", { class: "lesson-figure-body" }, { children: kids }),
  ];
  if (block.caption) figureKids.push(n("figcaption", {}, rich(block.caption)));
  return {
    steps,
    node: n(
      "figure",
      {
        class: "lesson-figure lesson-steps",
        role: "group",
        tabindex: "0",
        "aria-labelledby": labelId,
        "data-section": String(where.section),
        "data-block": String(where.block),
      },
      { children: figureKids },
    ),
  };
}
