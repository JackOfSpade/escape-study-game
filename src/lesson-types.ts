/**
 * Lessons teach a recorded knowledge gap. They live in their own browser
 * database, never in the learner's saved record, and nothing in a lesson, its
 * checks or its chat is evidence of mastery: a gap closes only when a question
 * shows the learner has it.
 */
import type { LessonDoc } from "../scripts/lib/lesson-schema.mjs";

export type {
  LessonBlock,
  LessonDoc,
  LessonSection,
} from "../scripts/lib/lesson-schema.mjs";

/** One message in the chat beside a lesson. */
export interface LessonMessage {
  id: string;
  role: "learner" | "tutor";
  text: string;
  at: string;
  /** A learner message is `pending` until its reply arrives. */
  state: "sent" | "pending" | "failed";
  error?: string;
  /** Section the tutor pointed at, already checked against the lesson. */
  section?: string;
}

/** Everything kept for one gap's lesson. Keyed by the gap record's id. */
export interface LessonRecord {
  key: string;
  state: "pending" | "ready" | "failed" | "interrupted";
  /** Identity of the generation request, renewed when the app refuses a reply. */
  requestId: string;
  attempt: number;
  error?: string;
  lesson?: LessonDoc;
  /** Optional blocks left out of the lesson because they were invalid. */
  dropped?: string[];
  createdAt: string;
  /** Set by "Done reading". Display only. */
  readAt?: string;
  /** The learner's local answers to predict and recall blocks, by block key. */
  responses: Record<string, string>;
  chat: LessonMessage[];
  /** Counts chat requests so their ids never repeat. */
  chatSeq: number;
  /** The gap's description, kept so chat works after a reload with no record. */
  gapDescription?: string;
}

/** What a lesson needs to know about the gap it teaches. */
export interface LessonGap {
  id: string;
  track: string;
  objectiveIds: string[];
  depth: number;
  facet: { id: string; description: string };
  partOf?: { id: string; description: string };
  /** The learner's own words when the gap was recorded. */
  statement: string;
  resolved: boolean;
}
