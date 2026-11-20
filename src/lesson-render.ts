/**
 * The trusted lesson renderer, and the security boundary for model text.
 *
 * A lesson is data. `lessonTree` turns a validated LessonDoc into a plain tree
 * of nodes (pure, testable in node), `assertSafeTree` refuses any tag,
 * attribute or markup outside a fixed allowlist, and `mountLesson` draws the
 * tree with createElement and textContent. Model text reaches the page only as
 * textContent, or as the output of markdownToHtml (which escapes first and
 * allows no links, images or raw HTML) on a prose node. Attribute values are
 * class names, numbers and ids the app builds itself.
 *
 * Nothing here touches the learner's saved record: answers go out through the
 * caller's `onResponse` and nowhere else.
 */
import { lessonBlockKey } from "../scripts/lib/lesson-schema.mjs";
import {
  codeRuns,
  rich,
  codePanel,
  diagramSvg,
  diagramTextVersion,
  n,
  pointerText,
  prepareSteps,
  stepCount,
  stepsFigure,
  type LessonNode,
  type PreparedSteps,
} from "./lesson-figures";
import type { LessonBlock, LessonDoc } from "./lesson-types";
import { markdownToHtml } from "./markdown";

export type { LessonNode } from "./lesson-figures";

export const LESSON_NOTICE =
  "Written by AI and may contain errors. Reading it gives no credit: this gap stays open until a question shows you have it.";

// ---------------------------------------------------------------------------
// Allowlists and the safety check
// ---------------------------------------------------------------------------

export const HTML_TAGS: ReadonlySet<string> = new Set(
  "div section article header p h2 h3 ul ol li pre code span button details summary table thead tbody tr th td textarea label figure figcaption nav".split(
    " ",
  ),
);
export const SVG_TAGS: ReadonlySet<string> = new Set(
  "svg g rect line path text title desc defs marker circle".split(" "),
);
const COMMON_ATTRS = new Set(["class", "id", "role", "tabindex", "hidden"]);
const HTML_ATTRS = new Set([
  "type",
  "disabled",
  "rows",
  "for",
  "name",
  "value",
  "scope",
]);
export const SVG_ATTRS: ReadonlySet<string> = new Set(
  "x y x1 y1 x2 y2 width height d viewBox points transform marker-end rx ry cx cy r text-anchor dominant-baseline markerWidth markerHeight refX refY orient markerUnits".split(
    " ",
  ),
);
export const ON_NAMES: ReadonlySet<string> = new Set([
  "section-go",
  "step-prev",
  "step-next",
  "step-reset",
  "predict-choose",
  "predict-reveal",
  "recall-reveal",
  "recall-input",
]);
const ROLES = new Set(["img", "note", "group", "status", "region"]);
/** Only prose nodes may carry `html`. */
export const PROSE_CLASSES: readonly string[] = [
  "lesson-prose",
  "lesson-callout-body",
  "lesson-explanation",
];
/** Letters, digits, space, and the punctuation of ids, numbers, paths and url(#id). */
const VALUE_CHARS = /^[\w\s.,:#()/%-]*$/;
const ID_LIKE = /^[A-Za-z][\w-]*$/;
const PROSE_TAGS = new Set("p br strong em code pre ul ol li h4".split(" "));

/** Throws unless `html` is what markdownToHtml produces: a few formatting tags
 * with no attributes (an ordered list may carry a numeric start). */
function assertProseHtml(html: string) {
  let tags = 0;
  for (const match of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const tag = match[2].toLowerCase();
    const attrs = match[3].trim();
    const okAttrs =
      attrs === "" ||
      (tag === "ol" && !match[1] && /^start="\d{1,6}"$/.test(attrs));
    if (!PROSE_TAGS.has(tag) || !okAttrs)
      throw new Error(
        `Lesson prose holds markup that is not allowed: <${tag}>`,
      );
    tags++;
  }
  // Every "<" the renderer escapes is "&lt;" and each checked tag holds exactly
  // one, so any other "<" is a defect.
  if (html.split("<").length - 1 !== tags)
    throw new Error("Lesson prose holds a stray <.");
}

function assertAttr(
  tag: string,
  ns: string | undefined,
  name: string,
  value: unknown,
) {
  const svg = ns === "svg";
  const allowed =
    COMMON_ATTRS.has(name) ||
    /^aria-[a-z]+$/.test(name) ||
    /^data-[a-z][a-z0-9-]*$/.test(name) ||
    (svg ? SVG_ATTRS.has(name) : HTML_ATTRS.has(name));
  if (!allowed || /^on/i.test(name))
    throw new Error(`Lesson attribute not allowed: ${name}`);
  if (typeof value !== "string")
    throw new Error(`Lesson attribute ${name} is not text`);
  if (
    /^\s*javascript:/i.test(value) ||
    /javascript:/i.test(value) ||
    value.includes("<")
  )
    throw new Error(`Lesson attribute ${name} holds a script or markup`);
  if (!VALUE_CHARS.test(value))
    throw new Error(
      `Lesson attribute ${name} holds characters that are not allowed`,
    );
  if (name === "value" && tag !== "button")
    throw new Error("Lesson attribute value is only for buttons");
  if (name === "role" && !ROLES.has(value))
    throw new Error(`Lesson role not allowed: ${value}`);
  if (name === "type" && value !== "button")
    throw new Error("Lesson button type must be button");
  if ((name === "hidden" || name === "disabled") && value !== "")
    throw new Error(`Lesson attribute ${name} must be empty`);
  if (name === "tabindex" && !/^-?\d$/.test(value))
    throw new Error("Lesson tabindex is not a number");
  if (name === "rows" && !/^\d{1,2}$/.test(value))
    throw new Error("Lesson rows is not a number");
  if (name === "scope" && value !== "col" && value !== "row")
    throw new Error("Lesson scope not allowed");
  if (
    (name === "id" || name === "for" || name === "name") &&
    !ID_LIKE.test(value)
  )
    throw new Error(`Lesson attribute ${name} is not an id`);
}

/** Walks a tree and throws if any tag, attribute, interaction name or html
 * field is off the allowlist. */
export function assertSafeTree(node: LessonNode): void {
  const svg = node.ns === "svg";
  if (node.ns !== undefined && node.ns !== "svg")
    throw new Error("Lesson namespace not allowed");
  if (!(svg ? SVG_TAGS : HTML_TAGS).has(node.tag))
    throw new Error(`Lesson tag not allowed: ${node.tag}`);
  for (const [name, value] of Object.entries(node.attrs ?? {}))
    assertAttr(node.tag, node.ns, name, value);
  if (node.on !== undefined && !ON_NAMES.has(node.on))
    throw new Error(`Lesson interaction not allowed: ${node.on}`);
  if (node.html !== undefined) {
    const classes = (node.attrs?.class ?? "").split(/\s+/);
    if (svg || !PROSE_CLASSES.some((c) => classes.includes(c)))
      throw new Error("Lesson html is only for prose nodes");
    assertProseHtml(node.html);
  }
  for (const child of node.children ?? []) assertSafeTree(child);
}

// ---------------------------------------------------------------------------
// The pure tree
// ---------------------------------------------------------------------------

const SECTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MIN_RECALL = 20;
const LANGUAGES = new Set([
  "python",
  "typescript",
  "javascript",
  "sql",
  "bash",
  "text",
]);
const CALLOUTS: Record<string, { label: string; cls: string }> = {
  "key-idea": { label: "Key idea", cls: "is-key-idea" },
  misconception: { label: "Common mistake", cls: "is-misconception" },
  "watch-out": { label: "Watch out", cls: "is-watch-out" },
};

/** Recall's comparison unlocks once the learner has written enough to compare. */
export const recallReady = (text: string) => text.trim().length >= MIN_RECALL;

type Of<K extends LessonBlock["kind"]> = Extract<LessonBlock, { kind: K }>;

/** What a predict block shows once an option is chosen. Words are neutral. */
export function predictOutcome(
  block: Of<"predict">,
  chosenId: string | undefined,
) {
  const index =
    chosenId === undefined
      ? -1
      : block.options.findIndex((o) => o.id === chosenId);
  if (index < 0) return undefined;
  const matches = block.options[index].id === block.correctId;
  const answer = block.options.find((o) => o.id === block.correctId);
  return {
    index,
    matches,
    text: matches
      ? "That matches the lesson's answer."
      : `The lesson's answer is: ${answer ? answer.text : "shown in the explanation"}.`,
  };
}

const hiddenIf = (hide: boolean): Record<string, string> =>
  hide ? { hidden: "" } : {};

function predictNode(
  block: Of<"predict">,
  at: Place,
  response: string | undefined,
): LessonNode {
  const outcome = predictOutcome(block, response);
  const answered = outcome !== undefined;
  const options = block.options.map((option, i) => {
    const chosen = outcome?.index === i;
    return n(
      "button",
      {
        type: "button",
        class: `lesson-option${chosen ? " is-chosen" : ""}${answered ? " is-locked" : ""}`,
        "aria-pressed": chosen ? "true" : "false",
        ...(answered ? { "aria-disabled": "true" } : {}),
        "data-option": String(i),
      },
      { ...rich(option.text), on: "predict-choose" },
    );
  });
  return n(
    "div",
    {
      class: `lesson-predict${answered ? " is-answered" : ""}`,
      "data-section": String(at.section),
      "data-block": String(at.block),
    },
    {
      children: [
        n("p", { class: "lesson-prompt" }, rich(block.prompt)),
        n(
          "div",
          { class: "lesson-options", role: "group" },
          { children: options },
        ),
        n(
          "p",
          {
            class: "lesson-predict-result",
            "aria-live": "polite",
            ...hiddenIf(!answered),
          },
          { text: outcome?.text ?? "" },
        ),
        n(
          "div",
          { class: "lesson-explanation", ...hiddenIf(!answered) },
          { html: markdownToHtml(block.explanation) },
        ),
      ],
    },
  );
}

function recallNode(block: Of<"recall">, at: Place, saved: string): LessonNode {
  const uid = `lesson-recall-${at.section}-${at.block}`;
  const ready = recallReady(saved);
  return n(
    "div",
    {
      class: "lesson-recall",
      "data-section": String(at.section),
      "data-block": String(at.block),
    },
    {
      children: [
        n("p", { class: "lesson-prompt" }, rich(block.prompt)),
        n(
          "label",
          { class: "lesson-recall-label", for: `${uid}-input` },
          { text: "Your answer, from memory" },
        ),
        n(
          "textarea",
          { class: "lesson-recall-input", id: `${uid}-input`, rows: "5" },
          { text: saved, on: "recall-input" },
        ),
        n(
          "p",
          { class: "lesson-note" },
          { text: "Stays on this device. Nothing here is graded." },
        ),
        n(
          "div",
          { class: "lesson-recall-actions" },
          {
            children: [
              n(
                "button",
                {
                  type: "button",
                  class: "lesson-button lesson-recall-reveal",
                  "aria-controls": `${uid}-compare`,
                  "aria-expanded": "false",
                  ...(ready ? {} : { disabled: "" }),
                },
                { text: "Show the lesson's version", on: "recall-reveal" },
              ),
              n(
                "span",
                { class: "lesson-recall-hint", ...hiddenIf(ready) },
                { text: `Write at least ${MIN_RECALL} characters to compare.` },
              ),
            ],
          },
        ),
        n(
          "div",
          { class: "lesson-recall-compare", id: `${uid}-compare`, hidden: "" },
          {
            children: [
              n(
                "div",
                { class: "lesson-compare-col" },
                {
                  children: [
                    n(
                      "p",
                      { class: "lesson-compare-label" },
                      { text: "What you wrote" },
                    ),
                    n(
                      "p",
                      { class: "lesson-compare-written lesson-compare-text" },
                      { text: saved },
                    ),
                  ],
                },
              ),
              n(
                "div",
                { class: "lesson-compare-col" },
                {
                  children: [
                    n(
                      "p",
                      { class: "lesson-compare-label" },
                      { text: "The lesson's version" },
                    ),
                    n(
                      "p",
                      { class: "lesson-compare-text" },
                      rich(block.exemplar),
                    ),
                  ],
                },
              ),
            ],
          },
        ),
      ],
    },
  );
}

interface Place {
  section: number;
  block: number;
}

function blockNode(
  block: LessonBlock,
  at: Place,
  key: string,
  responses: Record<string, string>,
): LessonNode | undefined {
  const uid = `lesson-b-${at.section}-${at.block}`;
  switch (block.kind) {
    case "prose":
      return n(
        "div",
        { class: "lesson-prose" },
        { html: markdownToHtml(block.text) },
      );
    case "callout": {
      const tone = CALLOUTS[block.tone] ?? { label: "Note", cls: "is-note" };
      return n(
        "div",
        { class: `lesson-callout ${tone.cls}`, role: "note" },
        {
          children: [
            n("p", { class: "lesson-callout-label" }, { text: tone.label }),
            n(
              "div",
              { class: "lesson-callout-body" },
              { html: markdownToHtml(block.text) },
            ),
          ],
        },
      );
    }
    case "code": {
      const kids = [
        n(
          "div",
          { class: "lesson-figure-body" },
          { children: [codePanel(block.code, block.highlight ?? [])] },
        ),
      ];
      if (block.caption) kids.push(n("figcaption", {}, rich(block.caption)));
      const lang = LANGUAGES.has(block.language) ? block.language : "text";
      return n(
        "figure",
        { class: `lesson-figure lesson-code-figure language-${lang}` },
        { children: kids },
      );
    }
    case "table": {
      const head = n(
        "thead",
        {},
        {
          children: [
            n(
              "tr",
              {},
              {
                children: block.columns.map((c) =>
                  n("th", { scope: "col" }, rich(c)),
                ),
              },
            ),
          ],
        },
      );
      const body = n(
        "tbody",
        {},
        {
          children: block.rows.map((row) =>
            n(
              "tr",
              {},
              { children: row.map((cell) => n("td", {}, rich(cell))) },
            ),
          ),
        },
      );
      const kids = [
        n(
          "div",
          { class: "lesson-figure-body", tabindex: "0" },
          {
            children: [
              n("table", { class: "lesson-table" }, { children: [head, body] }),
            ],
          },
        ),
      ];
      if (block.caption) kids.push(n("figcaption", {}, rich(block.caption)));
      return n(
        "figure",
        { class: "lesson-figure lesson-table-figure" },
        { children: kids },
      );
    }
    case "diagram":
      return n(
        "figure",
        { class: "lesson-figure lesson-diagram" },
        {
          children: [
            n(
              "div",
              { class: "lesson-figure-body", tabindex: "0" },
              { children: [diagramSvg(block, uid)] },
            ),
            n("figcaption", {}, rich(block.caption || block.alt)),
            diagramTextVersion(block),
          ],
        },
      );
    case "steps":
      return stepsFigure(block, at, uid)?.node;
    case "predict":
      return predictNode(block, at, responses[key]);
    case "recall":
      return recallNode(block, at, responses[key] ?? "");
    default:
      return undefined;
  }
}

/** The whole lesson as a safe tree. `responses` holds saved answers by block
 * key; a saved predict answer comes back already chosen. Throws if a section
 * id is not in its validated form or if anything off the allowlist is built. */
export function lessonTree(
  lesson: LessonDoc,
  responses: Record<string, string>,
): LessonNode {
  const minutes = Number.isFinite(lesson.minutes)
    ? Math.max(1, Math.round(lesson.minutes))
    : 1;
  const rail = lesson.sections.map((section, i) =>
    n(
      "button",
      {
        type: "button",
        class: "lesson-rail-button",
        "data-section": String(i),
      },
      { text: section.title, on: "section-go" },
    ),
  );
  const sections = lesson.sections.map((section, si) => {
    if (!SECTION_ID.test(section.id))
      throw new Error("A lesson section id is not valid.");
    const blocks = section.blocks.flatMap((block, bi) => {
      const made = blockNode(
        block,
        { section: si, block: bi },
        lessonBlockKey(section.id, bi),
        responses,
      );
      return made ? [made] : [];
    });
    return n(
      "section",
      { class: "lesson-section", id: `lesson-section-${section.id}` },
      {
        children: [
          n(
            "h3",
            { class: "lesson-section-title", tabindex: "-1" },
            { text: section.title },
          ),
          ...blocks,
        ],
      },
    );
  });
  const tree = n(
    "div",
    { class: "lesson" },
    {
      children: [
        n(
          "header",
          { class: "lesson-header" },
          {
            children: [
              n("h2", { class: "lesson-title" }, { text: lesson.title }),
              n("p", { class: "lesson-summary" }, rich(lesson.summary)),
              n(
                "p",
                { class: "lesson-minutes" },
                { text: `About ${minutes} min` },
              ),
              n(
                "p",
                { class: "lesson-notice", role: "note" },
                { text: LESSON_NOTICE },
              ),
            ],
          },
        ),
        n(
          "nav",
          { class: "lesson-rail", "aria-label": "Sections" },
          { children: rail },
        ),
        ...sections,
      ],
    },
  );
  assertSafeTree(tree);
  return tree;
}

// ---------------------------------------------------------------------------
// The DOM layer
// ---------------------------------------------------------------------------

const SVG_NS = "http://www.w3.org/2000/svg";

export interface MountOptions {
  /** Saved answers by block key, read once at mount. */
  responses: Record<string, string>;
  /** Called with a block key and the learner's answer. */
  onResponse(key: string, value: string): void;
  reducedMotion(): boolean;
}

export interface MountedLesson {
  destroy(): void;
  scrollToSection(id: string): boolean;
}

/** Draws one node. This is the only place in the app that sets innerHTML for a
 * lesson, and only for a prose node whose html assertSafeTree has checked. */
function build(node: LessonNode, actions: Map<Element, LessonNode>): Element {
  const el =
    node.ns === "svg"
      ? document.createElementNS(SVG_NS, node.tag)
      : document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs ?? {}))
    el.setAttribute(name, value);
  if (node.text !== undefined) el.textContent = node.text;
  if (node.html !== undefined) el.innerHTML = node.html;
  for (const child of node.children ?? [])
    el.appendChild(build(child, actions));
  if (node.on) actions.set(el, node);
  return el;
}

const setText = (el: Element | null | undefined, text: string) => {
  if (el && el.textContent !== text) el.textContent = text;
};

/** setText for a plain-text field that may hold `code` spans (see rich). */
const setRich = (el: Element | null | undefined, text: string) => {
  const runs = codeRuns(text);
  if (!el || el.textContent === runs.join("")) return;
  el.replaceChildren(
    ...runs.flatMap((run, i) => {
      if (run === "") return [];
      const part = document.createElement(i % 2 ? "code" : "span");
      part.textContent = run;
      return [part];
    }),
  );
};

/** Steps one figure through its frames by changing the nodes it already has. */
class StepsView {
  private frame = 0;
  private readonly lines: Element[];
  private readonly cells: Element[];
  private readonly vars: Element[];
  private readonly caption: Element | null;
  private readonly count: Element | null;
  private readonly prev: Element | null;
  private readonly next: Element | null;

  constructor(
    figure: Element,
    private readonly steps: PreparedSteps,
  ) {
    const all = (selector: string) => [...figure.querySelectorAll(selector)];
    this.lines = all(".lesson-steps-code .lesson-line");
    this.cells = all(".lesson-cell");
    this.vars = all(".lesson-var");
    this.caption = figure.querySelector(".lesson-steps-caption");
    this.count = figure.querySelector(".lesson-steps-count");
    const buttons = all(".lesson-steps-controls button");
    this.prev = buttons[0] ?? null;
    this.next = buttons[1] ?? null;
  }

  go(to: number) {
    const last = this.steps.frames.length - 1;
    this.frame = Math.max(0, Math.min(last, to));
    const frame = this.steps.frames[this.frame];
    this.lines.forEach((line, i) => {
      const current = i + 1 === frame.line;
      line.classList.toggle("is-current", current);
      if (current) line.setAttribute("aria-current", "true");
      else line.removeAttribute("aria-current");
    });
    this.cells.forEach((cell, i) => {
      const used = i < frame.cells.length;
      (cell as HTMLElement).hidden = !used;
      cell.classList.toggle("is-marked", used && frame.marked[i]);
      const pointers = used ? pointerText(frame.pointers[i]) : "";
      const [, value, sr, pointer] = [...cell.children];
      setText(value, used ? frame.cells[i] : "");
      (sr as HTMLElement).hidden = !(used && frame.marked[i]);
      setText(pointer, pointers);
      (pointer as HTMLElement).hidden = pointers === "";
    });
    this.vars.forEach((item, i) => {
      const v = frame.vars[i];
      (item as HTMLElement).hidden = !v;
      const [name, , value] = [...item.children];
      setText(name, v ? v.name : "");
      setText(value, v ? v.value : "");
    });
    setRich(this.caption, frame.caption);
    setText(this.count, stepCount(this.frame, this.steps.frames.length));
    this.prev?.setAttribute("aria-disabled", String(this.frame === 0));
    this.next?.setAttribute("aria-disabled", String(this.frame === last));
  }

  step(by: number) {
    this.go(this.frame + by);
  }
}

/** Mounts the lesson once. After this every interaction edits existing nodes:
 * the app repaints often, and a rebuild would lose scroll, focus and selection. */
export function mountLesson(
  container: HTMLElement,
  lesson: LessonDoc,
  options: MountOptions,
): MountedLesson {
  const tree = lessonTree(lesson, options.responses);
  const actions = new Map<Element, LessonNode>();
  const root = build(tree, actions);
  container.textContent = "";
  container.appendChild(root);

  const sections = new Map<string, HTMLElement>();
  lesson.sections.forEach((section) => {
    const el = root.querySelector<HTMLElement>(`#lesson-section-${section.id}`);
    if (el) sections.set(section.id, el);
  });
  const steps = new Map<Element, StepsView>();
  root.querySelectorAll("figure.lesson-steps").forEach((figure) => {
    const block = blockOf(figure);
    if (block?.kind === "steps")
      steps.set(figure, new StepsView(figure, prepareSteps(block)));
  });

  /** The block (and its saved-answer key) an element belongs to. */
  function blockOf(el: Element) {
    const holder = el.closest("[data-block]");
    if (!holder) return undefined;
    const section =
      lesson.sections[Number(holder.getAttribute("data-section"))];
    const index = Number(holder.getAttribute("data-block"));
    const block = section?.blocks[index];
    return block;
  }
  function keyOf(el: Element) {
    const holder = el.closest("[data-block]");
    const section =
      lesson.sections[Number(holder?.getAttribute("data-section"))];
    return section
      ? lessonBlockKey(section.id, Number(holder?.getAttribute("data-block")))
      : "";
  }

  function scrollToSection(id: string) {
    const el = sections.get(id);
    if (!el) return false;
    el.scrollIntoView({
      behavior: options.reducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    el.querySelector<HTMLElement>(".lesson-section-title")?.focus({
      preventScroll: true,
    });
    return true;
  }

  function choose(button: Element) {
    const block = blockOf(button);
    if (block?.kind !== "predict") return;
    const figure = button.closest(".lesson-predict");
    if (!figure || figure.classList.contains("is-answered")) return;
    const option = block.options[Number(button.getAttribute("data-option"))];
    const outcome = option && predictOutcome(block, option.id);
    if (!option || !outcome) return;
    figure.classList.add("is-answered");
    figure.querySelectorAll("button.lesson-option").forEach((b, i) => {
      b.classList.add("is-locked");
      b.classList.toggle("is-chosen", i === outcome.index);
      b.setAttribute("aria-pressed", String(i === outcome.index));
      b.setAttribute("aria-disabled", "true");
    });
    const result = figure.querySelector<HTMLElement>(".lesson-predict-result");
    setText(result, outcome.text);
    if (result) result.hidden = false;
    const explanation = figure.querySelector<HTMLElement>(
      ".lesson-explanation",
    );
    if (explanation) explanation.hidden = false;
    options.onResponse(keyOf(button), option.id);
  }

  const recallParts = (el: Element) => {
    const recall = el.closest(".lesson-recall");
    return {
      input: recall?.querySelector<HTMLTextAreaElement>("textarea"),
      reveal: recall?.querySelector<HTMLButtonElement>(".lesson-recall-reveal"),
      hint: recall?.querySelector<HTMLElement>(".lesson-recall-hint"),
      compare: recall?.querySelector<HTMLElement>(".lesson-recall-compare"),
      written: recall?.querySelector(".lesson-compare-written"),
    };
  };

  function actionAt(target: EventTarget | null) {
    for (
      let el = target instanceof Element ? target : null;
      el && el !== root;
      el = el.parentElement
    ) {
      const node = actions.get(el);
      if (node) return { el, on: node.on };
    }
    return undefined;
  }

  const onClick = (event: Event) => {
    const hit = actionAt(event.target);
    if (!hit) return;
    const figure = hit.el.closest("figure.lesson-steps");
    const view = figure ? steps.get(figure) : undefined;
    switch (hit.on) {
      case "section-go": {
        const section =
          lesson.sections[Number(hit.el.getAttribute("data-section"))];
        if (section) scrollToSection(section.id);
        break;
      }
      case "step-prev":
        view?.step(-1);
        break;
      case "step-next":
        view?.step(1);
        break;
      case "step-reset":
        view?.go(0);
        break;
      case "predict-choose":
        choose(hit.el);
        break;
      case "recall-reveal": {
        const parts = recallParts(hit.el);
        if (!parts.input || !recallReady(parts.input.value)) break;
        setText(parts.written, parts.input.value);
        if (parts.compare) parts.compare.hidden = false;
        hit.el.setAttribute("aria-expanded", "true");
        break;
      }
    }
  };
  const onInput = (event: Event) => {
    const hit = actionAt(event.target);
    if (hit?.on !== "recall-input") return;
    const parts = recallParts(hit.el);
    const value = (hit.el as HTMLTextAreaElement).value;
    options.onResponse(keyOf(hit.el), value);
    const ready = recallReady(value);
    if (parts.reveal) parts.reveal.disabled = !ready;
    if (parts.hint) parts.hint.hidden = ready;
    if (parts.compare && !parts.compare.hidden) setText(parts.written, value);
  };
  const onKey = (raw: Event) => {
    const event = raw as KeyboardEvent;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target instanceof Element ? event.target : null;
    const figure = target?.closest("figure.lesson-steps");
    const view = figure ? steps.get(figure) : undefined;
    if (!view) return;
    event.preventDefault();
    view.step(event.key === "ArrowRight" ? 1 : -1);
  };

  root.addEventListener("click", onClick);
  root.addEventListener("input", onInput);
  root.addEventListener("keydown", onKey);

  return {
    scrollToSection,
    destroy() {
      root.removeEventListener("click", onClick);
      root.removeEventListener("input", onInput);
      root.removeEventListener("keydown", onKey);
      steps.clear();
      sections.clear();
      actions.clear();
      container.textContent = "";
    },
  };
}
