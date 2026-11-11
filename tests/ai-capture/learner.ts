/**
 * Simulated learner for the manual capture driver. The learner is a real AI
 * call through the local `offload` CLI (DeepSeek Flash), so captured tutor and
 * assess prompts read like a real study session instead of fixtures.
 *
 * Every export here is pure except `askLearner`, which spawns the CLI.
 */
import { spawn } from "node:child_process";

export interface CaptureQuestion {
  title: string;
  prompt: string;
  starter?: string;
}

export interface TranscriptTurn {
  role: "learner" | "tutor";
  text: string;
}

export interface LearnerMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export type PersonaId =
  | "strong"
  | "partial"
  | "misconception"
  | "gap"
  | "presses"
  | "verbose"
  | "copier";

export interface Persona {
  id: PersonaId;
  label: string;
  /** Behavioural instructions the simulated student must follow. */
  style: string;
}

export const PERSONAS: readonly Persona[] = [
  {
    id: "strong",
    label: "confident and correct",
    style:
      "You understand the topic well. Give a correct, concise explanation (two or three sentences) that names the key point and one concrete step.",
  },
  {
    id: "partial",
    label: "half right",
    style:
      "You get roughly half of it right. State the part you are confident about, then guess at the rest and say which part is a guess.",
  },
  {
    id: "misconception",
    label: "confidently wrong",
    style:
      "You are confidently wrong about exactly one key point while the rest of your reasoning is fine. Do not back down unless the tutor gives a specific counter-example.",
  },
  {
    id: "gap",
    label: "honest gap",
    style:
      "You honestly do not know part of this. Say plainly which piece you do not know, describe what you do understand, and ask for a hint rather than the answer.",
  },
  {
    id: "presses",
    label: "wants the answer",
    style:
      "You keep pressing the tutor to just give you the full answer and the exact code or final result, with mild impatience.",
  },
  {
    id: "verbose",
    label: "rambling but mostly right",
    style:
      "You ramble. Your reasoning is mostly right but padded with tangents and restating the question; land on the right idea by the end.",
  },
  {
    id: "copier",
    label: "pasted a solution",
    style:
      "You paste a plausible solution you claim you found online, in your own words, and ask whether it is the right approach.",
  },
];

// Reasoning tokens count toward the cap; the reply itself stays short.
export const LEARNER_MAX_TOKENS = 4000;
/** Soft length ceiling for a single learner reply, in characters. */
export const LEARNER_MAX_CHARS = 700;
export const OFFLOAD_CALLER = "zombie-ai-capture";
export const OFFLOAD_ROUTE = "deepseek-flash";
export const OFFLOAD_TAG = "learner";

const SYSTEM_PROMPT = [
  "You are a student in a study game answering a terminal question.",
  "Reply with plain text, no markdown fences unless code is genuinely needed.",
  `Keep every reply at most ${LEARNER_MAX_CHARS} characters.`,
  "Stay in the persona described below for the whole conversation.",
  "Never mention being an AI, a model, a persona or a simulation.",
].join(" ");

export function personaById(id: PersonaId): Persona {
  const found = PERSONAS.find((persona) => persona.id === id);
  if (!found) throw Error(`Unknown learner persona: ${id}`);
  return found;
}

export function systemPrompt(persona: Persona): string {
  return `${SYSTEM_PROMPT}\nPersona: ${persona.label}. ${persona.style}`;
}

/** The first user turn carries the question and any starter text. */
export function questionContext(question: CaptureQuestion): string {
  const starter = question.starter?.trim();
  return [
    `Question title: ${question.title.trim()}`,
    `Question: ${question.prompt.trim()}`,
    ...(starter ? [`Starter text in the editor:\n${starter}`] : []),
  ].join("\n");
}

/**
 * Build the offload message array. The simulated learner is the assistant, so
 * transcript turns keep their chronological order and map as tutor→user,
 * learner→assistant.
 */
export function learnerMessages(
  persona: Persona,
  question: CaptureQuestion,
  transcript: readonly TranscriptTurn[],
): LearnerMessage[] {
  const messages: LearnerMessage[] = [
    { role: "system", content: systemPrompt(persona) },
    { role: "user", content: questionContext(question) },
  ];
  for (const turn of transcript) {
    messages.push({
      role: turn.role === "learner" ? "assistant" : "user",
      content: turn.text.trim(),
    });
  }
  return messages;
}

/** The exact offload request body: one JSON line on the CLI's stdin. */
export interface LearnerRequest {
  route: string;
  caller: string;
  tag: string;
  maxTokens: number;
  messages: LearnerMessage[];
}

export function learnerRequest(
  messages: readonly LearnerMessage[],
): LearnerRequest {
  return {
    route: OFFLOAD_ROUTE,
    caller: OFFLOAD_CALLER,
    tag: OFFLOAD_TAG,
    maxTokens: LEARNER_MAX_TOKENS,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  };
}

export interface OffloadReply {
  ok: boolean;
  text?: string;
  costUsd?: number;
  error?: { code?: string; message?: string };
}

/** Parse the single JSON line the offload CLI prints. */
export function readOffloadReply(raw: string): string {
  const line = raw
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part.startsWith("{"));
  if (!line)
    throw Error(`offload printed no JSON response: ${raw.slice(0, 400)}`);
  const reply = JSON.parse(line) as OffloadReply;
  if (!reply.ok)
    throw Error(
      `offload failed: ${reply.error?.code ?? "unknown"} ${
        reply.error?.message ?? ""
      }`.trim(),
    );
  const text = (reply.text ?? "").trim();
  if (!text) throw Error("offload returned an empty reply");
  return text;
}

export interface AskOptions {
  /** Binary from env OFFLOAD_BIN, default `offload` on PATH. */
  bin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Ask the simulated learner for its next message. */
export function askLearner(
  persona: Persona,
  question: CaptureQuestion,
  transcript: readonly TranscriptTurn[],
  options: AskOptions = {},
): Promise<string> {
  const bin = options.bin ?? process.env.OFFLOAD_BIN ?? "offload";
  const request = learnerRequest(
    learnerMessages(persona, question, transcript),
  );
  const timeoutMs = options.timeoutMs ?? 180_000;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["complete"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error(`offload timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(Error(`could not spawn ${bin}: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(Error(`${bin} exited ${code}: ${stderr.slice(0, 400)}`));
        return;
      }
      try {
        resolve(readOffloadReply(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}
