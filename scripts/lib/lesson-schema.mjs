/**
 * The lesson document: one typed JSON shape that the model fills in and that
 * trusted app code draws. A lesson is data, never markup. normalizeLesson
 * reads an untrusted value field by field and returns a clean copy that holds
 * only known keys, so nothing the model invents (a URL, a style, an event
 * handler, a stray key) can survive into what the app renders or stores.
 *
 * Dependency free, so the bridge (Node) and the browser can both import it.
 * The contract for callers is scripts/lib/lesson-schema.d.mts.
 */

export const LESSON_LIMITS = Object.freeze({
  bytes: 48_000,
  sections: Object.freeze([2, 8]),
  blocksPerSection: 10,
  prose: 2400,
  code: 3000,
  frames: Object.freeze([2, 14]),
  nodes: 12,
  edges: 16,
  chatText: 6000,
});

export const LESSON_BLOCK_KINDS = Object.freeze([
  "prose",
  "callout",
  "code",
  "diagram",
  "table",
  "steps",
  "predict",
  "recall",
]);

/** The schema as the model is told it. Numbers come from the limits above so
 * the prompt and the validator cannot drift apart. */
export const LESSON_FORMAT = [
  `The lesson is one JSON object: {"v":1,"title":string 3-100 characters,"summary":string up to 300,"minutes":integer 2-20,"sections":[${LESSON_LIMITS.sections[0]}-${LESSON_LIMITS.sections[1]} sections]}. No other top-level key: never write knowledge, complete, outcome, help, mastery, findings, closes or resolved.`,
  `A section is {"id":string,"title":string 1-80,"blocks":[1-${LESSON_LIMITS.blocksPerSection} blocks]}. A section id is lowercase letters, digits and hyphens, starts with a letter, at most 32 characters, unique in the lesson (for example "predict", "worked-example"). At least one block in the lesson is prose.`,
  `A block is an object with a "kind". Kinds, with every key and limit:`,
  `{"kind":"prose","text":string 1-${LESSON_LIMITS.prose}} markdown: paragraphs, lists, **bold**, \`inline code\` and fenced code. No links, images or HTML.`,
  `{"kind":"callout","tone":"key-idea"|"misconception"|"watch-out","text":string 1-600}`,
  `{"kind":"code","language":"python"|"typescript"|"javascript"|"sql"|"bash"|"text","code":string 1-${LESSON_LIMITS.code} characters and at most 80 lines,"caption"?:string up to 160,"highlight"?:[up to 12 distinct 1-based line numbers inside the code]}`,
  `{"kind":"diagram","alt":string 1-240 saying what the picture shows,"caption"?:string up to 160,"nodes":[2-${LESSON_LIMITS.nodes} of {"id":string (same pattern as a section id, unique),"label":string 1-48,"col":integer 0-5,"row":integer 0-5,"tone"?:"plain"|"accent"|"good"|"bad"}],"edges":[up to ${LESSON_LIMITS.edges} of {"from":node id,"to":node id,"label"?:string up to 32}]} Two nodes never share a col and row; an edge never joins a node to itself. The app lays the boxes out on the grid and draws the arrows.`,
  `{"kind":"table","caption"?:string up to 160,"columns":[2-5 strings of 1-40],"rows":[1-10 rows, each an array with exactly one string of up to 160 characters per column]}`,
  `{"kind":"steps","alt":string 1-240,"caption"?:string up to 160,"code"?:string (same limits as a code block, no language),"frames":[${LESSON_LIMITS.frames[0]}-${LESSON_LIMITS.frames[1]} of {"caption":string 1-240,"line"?:integer line of code this frame is on (only when code is present),"vars"?:[up to 8 of {"name":string 1-24,"value":string up to 40}],"cells"?:[up to 14 strings of up to 12 characters],"pointers"?:[up to 4 of {"name":string 1-16,"index":integer index into cells}],"marked"?:[up to 14 distinct indices into cells]}]} Every frame is a whole snapshot of the state at that point; nothing is computed for the learner. pointers and marked need cells.`,
  `{"kind":"predict","prompt":string 1-400,"options":[2-4 of {"id":string (same pattern as a section id, unique),"text":string 1-200}],"correctId":an option id,"explanation":string 1-800}`,
  `{"kind":"recall","prompt":string 1-400,"exemplar":string 1-1000}`,
  `Every string is plain text: no control characters other than newline and tab, no bidirectional override characters, no HTML. An optional block that breaks a rule is dropped from the lesson; a prose block or a core field that breaks one makes the whole lesson unusable. The whole lesson is at most ${LESSON_LIMITS.bytes} bytes of JSON and a section holds at most ${LESSON_LIMITS.blocksPerSection} blocks.`,
].join("\n");

const ID = /^[a-z][a-z0-9-]{0,31}$/;
const TOPLEVEL = ["v", "title", "summary", "minutes", "sections"];
const FORBIDDEN = [
  "knowledge",
  "complete",
  "outcome",
  "help",
  "mastery",
  "findings",
  "closes",
  "resolved",
];
const CODE_LANGUAGES = [
  "python",
  "typescript",
  "javascript",
  "sql",
  "bash",
  "text",
];
const CALLOUT_TONES = ["key-idea", "misconception", "watch-out"];
const NODE_TONES = ["plain", "accent", "good", "bad"];
const MAX_LINES = 80;
// C0 controls except tab and newline (carriage return is normalised away
// first), DEL and the C1 controls.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const BIDI = /[‪-‮⁦-⁩]/;
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const bad = (message) => new Error(message);
const plain = (value) => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};
/** An own property only: a prototype can never supply a field. */
const own = (object, key) =>
  Object.hasOwn(object, key) ? object[key] : undefined;

/**
 * One string, cleaned and checked. `line` collapses every run of whitespace
 * to one space; `block` trims; `code` drops leading blank lines and trailing
 * whitespace and keeps indentation. Length limits apply to the cleaned text.
 */
function text(value, label, min, max, mode = "line") {
  if (typeof value !== "string") throw bad(`${label} must be a string`);
  if (value.length > max * 4 + 200) throw bad(`${label} is too long`);
  const source = value.replace(/\r\n?/g, "\n");
  if (CONTROL.test(source)) throw bad(`${label} has a control character`);
  if (BIDI.test(source))
    throw bad(`${label} has a bidirectional override character`);
  if (LONE_SURROGATE.test(source)) throw bad(`${label} is not valid text`);
  const cleaned =
    mode === "line"
      ? source.replace(/\s+/g, " ").trim()
      : mode === "code"
        ? source.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "")
        : source.trim();
  if (cleaned.length < min || cleaned.length > max)
    throw bad(
      `${label} must be ${min === max ? min : `${min}-${max}`} characters`,
    );
  return cleaned;
}
/** An optional string: absent or empty after cleaning is left out. */
function optionalText(value, label, max, mode = "line") {
  if (value === undefined) return undefined;
  const cleaned = text(value, label, 0, max, mode);
  return cleaned === "" ? undefined : cleaned;
}
function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max)
    throw bad(`${label} must be an integer ${min}-${max}`);
  return value + 0;
}
function oneOf(value, label, allowed) {
  if (typeof value !== "string" || !allowed.includes(value))
    throw bad(`${label} must be one of ${allowed.join(", ")}`);
  return value;
}
function identifier(value, label) {
  if (typeof value !== "string" || !ID.test(value))
    throw bad(`${label} must be lowercase letters, digits and hyphens`);
  return value;
}
/** An array of a known size, checked before anything iterates it. */
function list(value, label, min, max) {
  if (!Array.isArray(value)) throw bad(`${label} must be an array`);
  if (value.length < min || value.length > max)
    throw bad(`${label} must hold ${min}-${max} items`);
  return value;
}
function item(value, label) {
  if (!plain(value)) throw bad(`${label} must be an object`);
  return value;
}
/** Distinct integers each within [low, high]. */
function distinctIntegers(value, label, max, low, high) {
  const out = [];
  for (const entry of list(value, label, 0, max)) {
    const n = integer(entry, `${label} entry`, low, high);
    if (out.includes(n)) throw bad(`${label} repeats ${n}`);
    out.push(n);
  }
  return out;
}
function codeText(value, label) {
  const code = text(value, label, 1, LESSON_LIMITS.code, "code");
  const lines = code.split("\n").length;
  if (lines > MAX_LINES) throw bad(`${label} has more than ${MAX_LINES} lines`);
  return { code, lines };
}

function prose(block) {
  return {
    kind: "prose",
    text: text(
      own(block, "text"),
      "prose text",
      1,
      LESSON_LIMITS.prose,
      "block",
    ),
  };
}
function callout(block) {
  return {
    kind: "callout",
    tone: oneOf(own(block, "tone"), "callout tone", CALLOUT_TONES),
    text: text(own(block, "text"), "callout text", 1, 600, "block"),
  };
}
function code(block) {
  const { code: source, lines } = codeText(own(block, "code"), "code");
  const out = {
    kind: "code",
    language: oneOf(own(block, "language"), "code language", CODE_LANGUAGES),
    code: source,
  };
  const caption = optionalText(own(block, "caption"), "code caption", 160);
  if (caption !== undefined) out.caption = caption;
  const highlight = own(block, "highlight");
  if (highlight !== undefined) {
    const lineNumbers = distinctIntegers(highlight, "highlight", 12, 1, lines);
    if (lineNumbers.length) out.highlight = lineNumbers;
  }
  return out;
}
function diagram(block) {
  const out = {
    kind: "diagram",
    alt: text(own(block, "alt"), "diagram alt", 1, 240),
  };
  const caption = optionalText(own(block, "caption"), "diagram caption", 160);
  if (caption !== undefined) out.caption = caption;
  const ids = new Set();
  const cells = new Set();
  out.nodes = list(own(block, "nodes"), "nodes", 2, LESSON_LIMITS.nodes).map(
    (raw) => {
      const node = item(raw, "node");
      const id = identifier(own(node, "id"), "node id");
      if (ids.has(id)) throw bad(`node id ${id} is repeated`);
      ids.add(id);
      const col = integer(own(node, "col"), "node col", 0, 5);
      const row = integer(own(node, "row"), "node row", 0, 5);
      if (cells.has(`${col},${row}`))
        throw bad(`two nodes share column ${col}, row ${row}`);
      cells.add(`${col},${row}`);
      const clean = {
        id,
        label: text(own(node, "label"), "node label", 1, 48),
        col,
        row,
      };
      const tone = own(node, "tone");
      if (tone !== undefined) clean.tone = oneOf(tone, "node tone", NODE_TONES);
      return clean;
    },
  );
  const rawEdges = own(block, "edges");
  out.edges =
    rawEdges === undefined
      ? []
      : list(rawEdges, "edges", 0, LESSON_LIMITS.edges).map((raw) => {
          const edge = item(raw, "edge");
          const from = own(edge, "from");
          const to = own(edge, "to");
          if (typeof from !== "string" || !ids.has(from))
            throw bad("an edge starts at a node that does not exist");
          if (typeof to !== "string" || !ids.has(to))
            throw bad("an edge ends at a node that does not exist");
          if (from === to) throw bad("an edge joins a node to itself");
          const clean = { from, to };
          const label = optionalText(own(edge, "label"), "edge label", 32);
          if (label !== undefined) clean.label = label;
          return clean;
        });
  return out;
}
function table(block) {
  const out = { kind: "table" };
  const caption = optionalText(own(block, "caption"), "table caption", 160);
  if (caption !== undefined) out.caption = caption;
  out.columns = list(own(block, "columns"), "columns", 2, 5).map((name) =>
    text(name, "column name", 1, 40),
  );
  out.rows = list(own(block, "rows"), "rows", 1, 10).map((row) =>
    list(row, "row", out.columns.length, out.columns.length).map((cell) =>
      text(cell, "table cell", 0, 160),
    ),
  );
  return out;
}
function frame(raw, lines) {
  const entry = item(raw, "frame");
  const out = { caption: text(own(entry, "caption"), "frame caption", 1, 240) };
  const line = own(entry, "line");
  if (line !== undefined) {
    if (lines === undefined)
      throw bad("a frame has a line but the figure has no code");
    out.line = integer(line, "frame line", 1, lines);
  }
  const vars = own(entry, "vars");
  if (vars !== undefined) {
    const clean = list(vars, "vars", 0, 8).map((raw) => {
      const variable = item(raw, "var");
      return {
        name: text(own(variable, "name"), "var name", 1, 24),
        value: text(own(variable, "value"), "var value", 0, 40),
      };
    });
    if (clean.length) out.vars = clean;
  }
  const rawCells = own(entry, "cells");
  const cells =
    rawCells === undefined
      ? undefined
      : list(rawCells, "cells", 0, 14).map((cell) => text(cell, "cell", 0, 12));
  if (cells !== undefined) out.cells = cells;
  const pointers = own(entry, "pointers");
  if (pointers !== undefined) {
    const raws = list(pointers, "pointers", 0, 4);
    if (raws.length && cells === undefined)
      throw bad("a frame has pointers but no cells");
    const clean = raws.map((raw) => {
      const pointer = item(raw, "pointer");
      return {
        name: text(own(pointer, "name"), "pointer name", 1, 16),
        index: integer(
          own(pointer, "index"),
          "pointer index",
          0,
          cells.length - 1,
        ),
      };
    });
    if (clean.length) out.pointers = clean;
  }
  const marked = own(entry, "marked");
  if (marked !== undefined) {
    const raws = list(marked, "marked", 0, 14);
    if (raws.length && cells === undefined)
      throw bad("a frame marks cells but has none");
    const clean = distinctIntegers(
      raws,
      "marked",
      14,
      0,
      (cells?.length ?? 0) - 1,
    );
    if (clean.length) out.marked = clean;
  }
  return out;
}
function steps(block) {
  const out = {
    kind: "steps",
    alt: text(own(block, "alt"), "steps alt", 1, 240),
  };
  const caption = optionalText(own(block, "caption"), "steps caption", 160);
  if (caption !== undefined) out.caption = caption;
  let lines;
  const source = own(block, "code");
  if (source !== undefined) {
    const parsed = codeText(source, "steps code");
    out.code = parsed.code;
    lines = parsed.lines;
  }
  out.frames = list(
    own(block, "frames"),
    "frames",
    LESSON_LIMITS.frames[0],
    LESSON_LIMITS.frames[1],
  ).map((raw) => frame(raw, lines));
  return out;
}
function predict(block) {
  const out = {
    kind: "predict",
    prompt: text(own(block, "prompt"), "predict prompt", 1, 400, "block"),
  };
  const ids = new Set();
  out.options = list(own(block, "options"), "options", 2, 4).map((raw) => {
    const option = item(raw, "option");
    const id = identifier(own(option, "id"), "option id");
    if (ids.has(id)) throw bad(`option id ${id} is repeated`);
    ids.add(id);
    return { id, text: text(own(option, "text"), "option text", 1, 200) };
  });
  const correct = own(block, "correctId");
  if (typeof correct !== "string" || !ids.has(correct))
    throw bad("correctId does not name an option");
  out.correctId = correct;
  out.explanation = text(
    own(block, "explanation"),
    "predict explanation",
    1,
    800,
    "block",
  );
  return out;
}
function recall(block) {
  return {
    kind: "recall",
    prompt: text(own(block, "prompt"), "recall prompt", 1, 400, "block"),
    exemplar: text(own(block, "exemplar"), "recall exemplar", 1, 1000, "block"),
  };
}
const BLOCKS = {
  prose,
  callout,
  code,
  diagram,
  table,
  steps,
  predict,
  recall,
};
/** Names a block's kind for a dropped-block note without echoing the model. */
const kindLabel = (kind) =>
  typeof kind === "string"
    ? kind.replace(/[^\w-]/g, "?").slice(0, 24)
    : "unknown";

function section(raw, index, dropped, seen) {
  const where = `section ${index + 1}`;
  const entry = item(raw, where);
  const id = identifier(own(entry, "id"), `${where} id`);
  if (seen.has(id)) throw bad(`section id ${id} is repeated`);
  seen.add(id);
  const title = text(own(entry, "title"), `section ${id} title`, 1, 80);
  const rawBlocks = own(entry, "blocks");
  if (!Array.isArray(rawBlocks))
    throw bad(`section ${id} blocks must be an array`);
  if (rawBlocks.length > LESSON_LIMITS.blocksPerSection)
    throw bad(
      `section ${id} has more than ${LESSON_LIMITS.blocksPerSection} blocks`,
    );
  const blocks = [];
  rawBlocks.forEach((rawBlock, at) => {
    const kind = plain(rawBlock) ? own(rawBlock, "kind") : undefined;
    const note = (reason) =>
      dropped.push(`${id}/${at}:${kindLabel(kind)}: ${reason}`);
    if (typeof kind !== "string" || !Object.hasOwn(BLOCKS, kind))
      return note(plain(rawBlock) ? "unknown block kind" : "not a block");
    try {
      blocks.push(BLOCKS[kind](rawBlock));
    } catch (error) {
      // Prose carries the lesson: a broken one is not something to drop.
      if (kind === "prose")
        throw bad(`section ${id} block ${at} (prose): ${error.message}`);
      note(error.message);
    }
  });
  if (!blocks.length) throw bad(`section ${id} has no usable block`);
  return { id, title, blocks };
}

export function normalizeLesson(value) {
  if (!plain(value)) throw bad("The lesson must be a JSON object");
  const keys = Object.keys(value);
  const forbidden = keys.find((key) => FORBIDDEN.includes(key));
  if (forbidden !== undefined)
    throw bad(
      `The lesson must not contain "${forbidden}": a lesson teaches and never records knowledge, completion, an outcome, help, mastery, findings or a closed gap`,
    );
  const unknown = keys.find((key) => !TOPLEVEL.includes(key));
  if (unknown !== undefined)
    throw bad(
      `The lesson has an unknown top-level key (allowed: ${TOPLEVEL.join(", ")})`,
    );
  if (own(value, "v") !== 1) throw bad("v must be 1");
  const title = text(own(value, "title"), "title", 3, 100);
  const summary = text(own(value, "summary"), "summary", 0, 300);
  const minutes = integer(own(value, "minutes"), "minutes", 2, 20);
  const rawSections = list(
    own(value, "sections"),
    "sections",
    LESSON_LIMITS.sections[0],
    LESSON_LIMITS.sections[1],
  );
  const dropped = [];
  const seen = new Set();
  const sections = rawSections.map((raw, index) =>
    section(raw, index, dropped, seen),
  );
  if (!sections.some((s) => s.blocks.some((block) => block.kind === "prose")))
    throw bad("The lesson needs at least one prose block");
  const lesson = { v: 1, title, summary, minutes, sections };
  if (
    new TextEncoder().encode(JSON.stringify(lesson)).length >
    LESSON_LIMITS.bytes
  )
    throw bad(`The lesson is larger than ${LESSON_LIMITS.bytes} bytes`);
  return { lesson, dropped };
}

export function lessonBlockKey(sectionId, index) {
  return `${sectionId}/${index}`;
}

const fence = (language, code) => `\`\`\`${language}\n${code}\n\`\`\``;
function blockText(block) {
  switch (block.kind) {
    case "prose":
      return block.text;
    case "callout":
      return `[${block.tone.replace("-", " ")}] ${block.text}`;
    case "code":
      return [
        fence(block.language, block.code),
        block.caption ? `Caption: ${block.caption}` : "",
        block.highlight?.length
          ? `Highlighted lines: ${block.highlight.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "diagram": {
      const label = new Map(block.nodes.map((node) => [node.id, node.label]));
      const joined = new Set(block.edges.flatMap((e) => [e.from, e.to]));
      const alone = block.nodes.filter((node) => !joined.has(node.id));
      return [
        `Diagram: ${block.alt}`,
        block.caption ? `Caption: ${block.caption}` : "",
        ...block.edges.map(
          (e) =>
            `${label.get(e.from)} -> ${label.get(e.to)}${e.label ? ` (${e.label})` : ""}`,
        ),
        alone.length
          ? `Also shown: ${alone.map((n) => n.label).join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    }
    case "table":
      return [
        block.caption ? `Table: ${block.caption}` : "Table:",
        block.columns.join(" | "),
        ...block.rows.map((row) => row.join(" | ")),
      ].join("\n");
    case "steps":
      return [
        `Steps: ${block.alt}`,
        block.caption ? `Caption: ${block.caption}` : "",
        block.code ? fence("", block.code) : "",
        ...block.frames.map((f, i) => {
          const state = [
            f.line !== undefined ? `line ${f.line}` : "",
            ...(f.vars ?? []).map((v) => `${v.name} = ${v.value}`),
            f.cells ? `cells [${f.cells.join(", ")}]` : "",
            ...(f.pointers ?? []).map((p) => `${p.name} at ${p.index}`),
            f.marked?.length ? `marked ${f.marked.join(", ")}` : "",
          ].filter(Boolean);
          return `${i + 1}. ${f.caption}${state.length ? ` (${state.join("; ")})` : ""}`;
        }),
      ]
        .filter(Boolean)
        .join("\n");
    case "predict": {
      const correct = block.options.find((o) => o.id === block.correctId);
      return [
        `Predict: ${block.prompt}`,
        ...block.options.map((o) => `- ${o.id}: ${o.text}`),
        `Correct option: ${correct ? `${correct.id}: ${correct.text}` : block.correctId}`,
        `Explanation: ${block.explanation}`,
      ].join("\n");
    }
    case "recall":
      return `Recall: ${block.prompt}\nExemplar: ${block.exemplar}`;
    default:
      return "";
  }
}

export function lessonPlainText(lesson, maxChars = 24_000) {
  const out = [];
  for (const sectionEntry of lesson.sections)
    out.push(
      [
        `## ${sectionEntry.id}: ${sectionEntry.title}`,
        ...sectionEntry.blocks.map(blockText),
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  const full = out.join("\n\n");
  if (full.length <= maxChars) return full;
  const cut = full.slice(0, Math.max(0, maxChars - 1));
  // Never end on half a surrogate pair.
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`.slice(
    0,
    maxChars,
  );
}
