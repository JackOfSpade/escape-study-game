/**
 * A lesson is data, never markup: the model returns this document and trusted
 * app code draws every block. Nothing here can carry HTML, a URL, a style, a
 * colour or a coordinate in pixels.
 */
export type LessonTone = "plain" | "accent" | "good" | "bad";
export interface ProseBlock {
  kind: "prose";
  /** Rendered by the app's markdown renderer (no links, images or HTML). */
  text: string;
}
export interface CalloutBlock {
  kind: "callout";
  tone: "key-idea" | "misconception" | "watch-out";
  text: string;
}
export interface CodeBlock {
  kind: "code";
  language: "python" | "typescript" | "javascript" | "sql" | "bash" | "text";
  code: string;
  caption?: string;
  /** 1-based line numbers to emphasise. */
  highlight?: number[];
}
/** A static picture: boxes on a small grid joined by arrows. The app draws it. */
export interface DiagramBlock {
  kind: "diagram";
  /** One sentence saying what the picture shows, for screen readers. */
  alt: string;
  caption?: string;
  nodes: {
    id: string;
    label: string;
    /** Grid column 0..5 and row 0..5; two nodes never share a cell. */
    col: number;
    row: number;
    tone?: LessonTone;
  }[];
  edges: { from: string; to: string; label?: string }[];
}
export interface TableBlock {
  kind: "table";
  caption?: string;
  columns: string[];
  rows: string[][];
}
/** A step-through figure the learner advances by hand. Every frame is a whole
 * snapshot; nothing is computed in the page. */
export interface StepsBlock {
  kind: "steps";
  alt: string;
  caption?: string;
  /** Code the frames walk through, when the figure traces code. */
  code?: string;
  frames: {
    caption: string;
    /** 1-based line of `code` this frame is on. */
    line?: number;
    /** Named values at this frame, in display order. */
    vars?: { name: string; value: string }[];
    /** A row of cells (an array, a queue, a stack) at this frame. */
    cells?: string[];
    /** Named pointers into `cells`, by index. */
    pointers?: { name: string; index: number }[];
    /** Indices of `cells` to emphasise. */
    marked?: number[];
  }[];
}
/** The learner commits to an answer before the explanation is shown. */
export interface PredictBlock {
  kind: "predict";
  prompt: string;
  options: { id: string; text: string }[];
  correctId: string;
  explanation: string;
}
/** Close-the-book recall: the learner writes, then compares with an exemplar. */
export interface RecallBlock {
  kind: "recall";
  prompt: string;
  exemplar: string;
}
export type LessonBlock =
  | ProseBlock
  | CalloutBlock
  | CodeBlock
  | DiagramBlock
  | TableBlock
  | StepsBlock
  | PredictBlock
  | RecallBlock;
export interface LessonSection {
  /** /^[a-z][a-z0-9-]{0,31}$/, unique in the lesson. */
  id: string;
  title: string;
  blocks: LessonBlock[];
}
export interface LessonDoc {
  v: 1;
  title: string;
  summary: string;
  /** Reading time, 2..20. */
  minutes: number;
  sections: LessonSection[];
}
export const LESSON_LIMITS: {
  /** Whole lesson as JSON, in bytes. */
  bytes: number;
  sections: [min: number, max: number];
  blocksPerSection: number;
  prose: number;
  code: number;
  frames: [min: number, max: number];
  nodes: number;
  edges: number;
  chatText: number;
};
export const LESSON_BLOCK_KINDS: readonly LessonBlock["kind"][];
/** The schema as the model is told it. */
export const LESSON_FORMAT: string;
/**
 * Checks an untrusted value and returns a clean copy holding only known keys.
 * Throws an Error with a learner-safe reason when the lesson cannot be used at
 * all (wrong shape, no usable prose, too large, a forbidden key such as
 * `knowledge`, `complete`, `outcome`, `help` or `mastery` anywhere at the top
 * level). An optional block (diagram, table, steps, predict, recall, callout,
 * code) that is invalid on its own is left out and named in `dropped`, as
 * `"<sectionId>/<index>:<kind>: <reason>"`, and the lesson is kept.
 */
export function normalizeLesson(value: unknown): {
  lesson: LessonDoc;
  dropped: string[];
};
/** The lesson as plain text for the tutor beside it, sections in order, each
 * opening with `## <id>: <title>`. At most `maxChars` characters. */
export function lessonPlainText(lesson: LessonDoc, maxChars?: number): string;
/** Stable key for a block's saved response: `<sectionId>/<index>`. */
export function lessonBlockKey(sectionId: string, index: number): string;
