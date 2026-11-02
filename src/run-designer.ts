import {
  bridgeRequest,
  discardRunDesign,
  isHandoffReceipt,
  status,
  type HandoffProgress,
  type HandoffReceipt,
} from "./bridge-client";
import {
  parseRunDesignRequest,
  parseRunDesignReply,
  runDesignFingerprint,
  runDesignNoveltyErrors,
  summarizeRunDesign,
  parseRunStructureReply,
  parseRunContentReply,
  parseRunContentRepairCandidate,
  parseSavedRunDesign,
  parseEnvironmentSummaries,
  type EnvironmentSummary,
  type RunStructureV3,
  type StructureRunDesignRequest,
  type ContentRunDesignRequest,
  type RunDesignRequest,
  type RunDesignSummary,
  type SavedRunDesign,
} from "./run-design-contract.mjs";
import type { ProvisionalRun } from "./world";
import {
  createQualityDraft,
  parseQualityDraft,
  prepareQualityRun,
  retryQualityDraft,
  type QualityDesignDraft,
} from "./run-quality-designer";
import { summarizeQualityEnvironment } from "./environment-history";
import type { RunDesignActivity } from "./run-design-progress";

type LegacyRequest = Extract<RunDesignRequest, { version: 1 }>;
interface DraftIdentity {
  targetRunId: string;
  chatCode: string;
  receipt?: HandoffReceipt & { requestId: string };
}
export interface LegacyDesignDraft extends DraftIdentity {
  version: 1;
  request: LegacyRequest;
}
export interface AuthoredDesignDraft extends DraftIdentity {
  version: 2;
  request: StructureRunDesignRequest | ContentRunDesignRequest;
  /** Exact history captured before the first model request. */
  recentContent: EnvironmentSummary[];
  attempts: { structure: number; content: number };
  /** A saved repair awaits an explicit Retry after exhausting a phase's budget. */
  exhausted: boolean;
}
export type DesignDraft =
  LegacyDesignDraft | AuthoredDesignDraft | QualityDesignDraft;
const DRAFT_KEY = "dead-air-run-design-draft-v1";
const HISTORY_KEY = "dead-air-run-design-history-v1";
const CONTENT_HISTORY_KEY = "dead-air-environment-history-v1";
export const DESIGN_ATTEMPTS = 3;

export function parseDesignDraft(value: unknown): DesignDraft {
  if ((value as { version?: unknown } | null)?.version === 3)
    return parseQualityDraft(value);
  const d = value as DesignDraft;
  if (
    !d ||
    (d.version !== 1 && d.version !== 2) ||
    typeof d.targetRunId !== "string" ||
    d.targetRunId.length > 128 ||
    !/^[A-Z0-9]{6,16}$/.test(d.chatCode)
  )
    throw Error("Invalid saved run-design request");
  const request = parseRunDesignRequest(d.request);
  if (request.version !== d.version)
    throw Error("Saved design phase does not match its request version");
  if (
    d.receipt !== undefined &&
    (!isHandoffReceipt(d.receipt) || d.receipt.requestId !== request.requestId)
  )
    throw Error("Invalid saved run-design receipt");
  const identity = {
    targetRunId: d.targetRunId,
    chatCode: d.chatCode,
    ...(d.receipt
      ? {
          receipt: {
            requestId: request.requestId,
            id: d.receipt.id,
            hash: d.receipt.hash,
          },
        }
      : {}),
  };
  if (d.version === 1 && request.version === 1)
    return { ...identity, version: 1, request };
  if (d.version !== 2 || request.version !== 2)
    throw Error("Invalid saved design phase");
  if (
    !d.attempts ||
    !Number.isInteger(d.attempts.structure) ||
    !Number.isInteger(d.attempts.content) ||
    d.attempts.structure < 1 ||
    d.attempts.structure > DESIGN_ATTEMPTS ||
    d.attempts.content < 0 ||
    d.attempts.content > DESIGN_ATTEMPTS ||
    (request.phase === "structure" && d.attempts.content !== 0) ||
    (request.phase === "content" && d.attempts.content < 1) ||
    typeof d.exhausted !== "boolean"
  )
    throw Error("Invalid saved design attempt budget");
  const recentContent = parseEnvironmentSummaries(d.recentContent);
  if (
    request.phase === "content" &&
    JSON.stringify(request.recentContent) !== JSON.stringify(recentContent)
  )
    throw Error("Saved design content history changed");
  return {
    ...identity,
    version: 2,
    request,
    recentContent,
    attempts: { ...d.attempts },
    exhausted: d.exhausted,
  };
}

export function recentEnvironment(): EnvironmentSummary[] {
  try {
    return parseEnvironmentSummaries(
      JSON.parse(localStorage.getItem(CONTENT_HISTORY_KEY) ?? "[]"),
    );
  } catch {
    return [];
  }
}
export function recentDesigns(): RunDesignSummary[] {
  try {
    const recent = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
    return parseRunDesignRequest({
      version: 1,
      requestId: "design-history",
      generationId: "design-history",
      seed: 0,
      recent,
    }).recent;
  } catch {
    return [];
  }
}
export function readDesignDraft(targetRunId: string): DesignDraft | undefined {
  const raw = localStorage.getItem(DRAFT_KEY);
  if (!raw) return;
  const draft = parseDesignDraft(JSON.parse(raw));
  return draft.targetRunId === targetRunId ? draft : undefined;
}
export function saveDesignDraft(draft: DesignDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(parseDesignDraft(draft)));
}
export function clearDesignDraft(targetRunId: string) {
  try {
    const draft = readDesignDraft(targetRunId);
    if (draft) localStorage.removeItem(DRAFT_KEY);
  } catch {
    // Explicit cancellation can discard an unreadable design draft.
    // This key contains fictional generation requests, never a game or learner save.
    localStorage.removeItem(DRAFT_KEY);
  }
}
/** A settled request may still be queued; explicit dismissal cancels its receipt. */
export async function cancelDesignDraft(draft: DesignDraft | undefined) {
  if (draft?.receipt) {
    const current = parseDesignDraft(draft);
    await discardRunDesign(current.receipt!);
  }
}
export function rememberDesign(saved: SavedRunDesign) {
  const next = summarizeRunDesign(saved.design);
  const recent = recentDesigns().filter((d) => d.title !== next.title);
  localStorage.setItem(
    HISTORY_KEY,
    JSON.stringify([next, ...recent].slice(0, 5)),
  );
  if (saved.design.version === 3) {
    const summary = summarizeQualityEnvironment(saved.design.environment);
    localStorage.setItem(
      CONTENT_HISTORY_KEY,
      JSON.stringify(
        [
          summary,
          ...recentEnvironment().filter(
            (s) => s.fingerprint !== summary.fingerprint,
          ),
        ].slice(0, 5),
      ),
    );
  }
}
/** Historical two-phase drafts remain supported without upgrading their packets. */
export function newAuthoredDesignDraft(
  targetRunId: string,
  seed: number,
  recent = recentDesigns(),
  recentContent = recentEnvironment(),
): AuthoredDesignDraft {
  const generationId = `design-${crypto.randomUUID()}`;
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chatCode = Array.from(
    crypto.getRandomValues(new Uint8Array(8)),
    (n) => alphabet[n % alphabet.length],
  ).join("");
  return {
    version: 2,
    targetRunId,
    chatCode,
    request: parseRunDesignRequest({
      version: 2,
      designVersion: 3,
      phase: "structure",
      requestId: `${generationId}-1`,
      generationId,
      seed,
      recent,
    }) as StructureRunDesignRequest,
    recentContent: parseEnvironmentSummaries(recentContent),
    attempts: { structure: 1, content: 0 },
    exhausted: false,
  };
}
export function newDesignDraft(
  targetRunId: string,
  seed: number,
  recent = recentDesigns(),
  recentContent = recentEnvironment(),
): QualityDesignDraft {
  const identity = newAuthoredDesignDraft(
    targetRunId,
    seed,
    recent,
    recentContent,
  );
  return createQualityDraft({
    targetRunId,
    chatCode: identity.chatCode,
    generationId: identity.request.generationId,
    seed,
    recent,
    recentContent,
  });
}
/** Only an explicit UI retry starts another bounded repair cycle. */
export function retryDesignDraft(draft: DesignDraft) {
  if (draft.version === 3) return retryQualityDraft(draft);
  if (draft.version === 2 && draft.exhausted) {
    draft.attempts[draft.request.phase] = 1;
    draft.exhausted = false;
  }
}
export interface DesignOptions<
  T,
  R extends RunDesignRequest = RunDesignRequest,
> {
  build: (seed: number, design: SavedRunDesign) => T;
  capture: (draft: DesignDraft) => void | Promise<void>;
  signal: AbortSignal;
  progress?: (text: string) => void;
  activity?: (activity: RunDesignActivity) => void;
  preview?: (seed: number, structure: RunStructureV3) => ProvisionalRun;
  finalize?: (candidate: ProvisionalRun, saved: SavedRunDesign) => T;
  send?: (
    request: R,
    draft: DesignDraft,
    signal: AbortSignal,
    progress: (phase: HandoffProgress) => void,
  ) => Promise<unknown>;
}
const designSource = () =>
  status().mode === "claude-cli" ? "claude-cli" : "chatgpt-handoff";
/** Builds an isolated candidate. The caller alone commits it to the active run. */
export async function prepareDesignedRun<T>(
  draft: DesignDraft,
  options: DesignOptions<T>,
) {
  const send =
    options.send ??
    ((request, current, signal, progress) => {
      if (
        (status().mode !== "chatgpt-handoff" &&
          status().mode !== "claude-cli") ||
        !status().capabilities.includes("design-run")
      )
        throw Error(
          "AI run design is unavailable. Connect or update the ChatGPT bridge, then retry. Your current run stays saved.",
        );
      return bridgeRequest("design-run", request, progress, {
        signal,
        chatCode: current.chatCode,
        onQueued: async (receipt) => {
          // A delayed receipt must not recreate a draft that Cancel just removed.
          if (signal.aborted) return;
          current.receipt = { ...receipt, requestId: request.requestId };
          await options.capture(current);
        },
        nativeScope: { runId: request.generationId, encounterId: "run-design" },
        isActive: () => !signal.aborted,
      });
    });
  if (draft.version === 3) return prepareQualityRun(draft, options, send);
  if (draft.version === 2) return prepareAuthoredRun(draft, options, send);
  for (let attempt = 0; attempt < DESIGN_ATTEMPTS; attempt++) {
    options.signal.throwIfAborted();
    await options.capture(draft);
    options.signal.throwIfAborted();
    const activity = (state: HandoffProgress) =>
      options.activity?.({
        stage: "design",
        state,
        detail: "Designing your escape…",
      });
    activity("queued");
    const reply = await send(draft.request, draft, options.signal, (phase) => {
      activity(phase);
      options.progress?.(
        phase === "working"
          ? "ChatGPT is designing your escape…"
          : phase === "stalled"
            ? "No recent activity from ChatGPT. Check the connected chat and ask it to continue if it stopped. Your exact request is saved."
            : phase === "queued"
              ? "Waiting for ChatGPT. Connect a chat with the request below to continue."
              : "Waiting for the bridge to reconnect. Your exact request is saved.",
      );
    });
    options.signal.throwIfAborted();
    const { design } = parseRunDesignReply(reply, draft.request);
    const saved: SavedRunDesign = {
      version: 1,
      source: designSource(),
      requestId: draft.request.requestId,
      generationId: draft.request.generationId,
      fingerprint: runDesignFingerprint(design),
      design,
    };
    let errors = runDesignNoveltyErrors(design, draft.request.recent);
    if (!errors.length) {
      options.progress?.(
        "Checking routes, terminal space, stair access and saved design…",
      );
      options.activity?.({
        stage: "review",
        state: "checking",
        detail: "Checking your escape…",
      });
      try {
        const game = options.build(draft.request.seed, saved);
        options.signal.throwIfAborted();
        return { seed: draft.request.seed, saved, game };
      } catch (error) {
        options.signal.throwIfAborted();
        errors = [error instanceof Error ? error.message : String(error)];
      }
    }
    // The previous reply stays immutable. A repair is a new, correlated job.
    delete draft.receipt;
    draft.request = parseRunDesignRequest({
      ...draft.request,
      requestId: `design-${crypto.randomUUID()}`,
      repair: {
        candidate: design,
        errors: errors
          .slice(0, 20)
          .map((e) => e.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400)),
      },
    });
    await options.capture(draft);
    if (attempt + 1 === DESIGN_ATTEMPTS)
      throw Error(
        "This design still needs repair after three attempts. Your request is saved; retry with ChatGPT or cancel.",
      );
    options.progress?.(
      "The design needs changes. Asking ChatGPT to repair it while keeping this run’s theme…",
    );
  }
  throw Error("Run design did not complete");
}

async function prepareAuthoredRun<T>(
  draft: AuthoredDesignDraft,
  options: DesignOptions<T>,
  send: NonNullable<DesignOptions<T>["send"]>,
) {
  options.signal.throwIfAborted();
  if (!options.preview || !options.finalize)
    throw Error(
      "This client cannot prepare individual environmental writing. Update the game before retrying.",
    );
  if (draft.exhausted)
    throw Error(
      "This design needs more changes after three attempts. Choose Retry to continue the saved request or Cancel.",
    );
  let candidate: ProvisionalRun | undefined;
  const rebuild = (request: ContentRunDesignRequest) => {
    options.activity?.({
      stage: "design",
      state: "checking",
      detail: "Checking the building…",
    });
    const preview = options.preview!(request.seed, request.structure);
    if (
      preview.structureFingerprint !== request.structureFingerprint ||
      preview.surfaceFingerprint !== request.surfaceFingerprint ||
      preview.builderVersion !== request.builderVersion ||
      JSON.stringify(preview.surfaces) !== JSON.stringify(request.surfaces)
    )
      throw Error(
        "The saved object inventory no longer matches this game version. Cancel this design and start a new one; its writing will not be rebound to different objects.",
      );
    return preview;
  };
  // Recreate only the private candidate. The captured request and object IDs
  // remain immutable across reloads and exact transport retries.
  if (draft.request.phase === "content") candidate = rebuild(draft.request);
  for (;;) {
    options.signal.throwIfAborted();
    await options.capture(draft);
    options.signal.throwIfAborted();
    const request = draft.request;
    const activity = (state: HandoffProgress) =>
      options.activity?.({
        stage: request.phase === "structure" ? "design" : "details",
        state,
        detail:
          request.phase === "structure"
            ? "Designing the building…"
            : "Writing room details…",
      });
    activity("queued");
    const reply = await send(request, draft, options.signal, (phase) => {
      activity(phase);
      options.progress?.(
        phase === "working"
          ? request.phase === "structure"
            ? "ChatGPT is designing the building and its occupants…"
            : "ChatGPT is writing and illustrating the objects in this building…"
          : phase === "stalled"
            ? "No recent activity from ChatGPT. Check the connected chat and ask it to continue if it stopped. Your exact request is saved."
            : phase === "queued"
              ? "Waiting for ChatGPT. Continue in the connected chat to finish this run."
              : "Waiting for the bridge to reconnect. Your exact request is saved.",
      );
    });
    options.signal.throwIfAborted();
    let repair: unknown;
    let errors: string[] = [];
    if (request.phase === "structure") {
      const { structure } = parseRunStructureReply(reply, request);
      repair = structure;
      errors = runDesignNoveltyErrors(structure, request.recent);
      if (!errors.length) {
        try {
          options.progress?.(
            "Checking routes and identifying the objects that need writing and artwork…",
          );
          options.activity?.({
            stage: "design",
            state: "checking",
            detail: "Checking the building…",
          });
          candidate = options.preview(request.seed, structure);
          options.signal.throwIfAborted();
          const contentRequest = parseRunDesignRequest({
            version: 2,
            designVersion: 3,
            phase: "content",
            requestId: `design-${crypto.randomUUID()}`,
            generationId: request.generationId,
            seed: request.seed,
            structure,
            structureFingerprint: candidate.structureFingerprint,
            builderVersion: candidate.builderVersion,
            surfaces: candidate.surfaces,
            surfaceFingerprint: candidate.surfaceFingerprint,
            recentContent: draft.recentContent,
          }) as ContentRunDesignRequest;
          delete draft.receipt;
          draft.request = contentRequest;
          draft.attempts.content = 1;
          await options.capture(draft);
          options.signal.throwIfAborted();
          continue;
        } catch (error) {
          options.signal.throwIfAborted();
          // A failed durable phase capture is not a geometry rejection. Keep
          // the exact content packet for retry and release no further request.
          if (draft.request.phase === "content") throw error;
          errors = [error instanceof Error ? error.message : String(error)];
        }
      }
    } else {
      let content;
      try {
        content = parseRunContentReply(reply, request).content;
      } catch (error) {
        options.signal.throwIfAborted();
        // Retain only strictly bounded content data for a semantic repair.
        // Unknown fields and unsafe drawing shapes never enter a repair packet.
        repair = parseRunContentRepairCandidate(reply, request);
        errors = [error instanceof Error ? error.message : String(error)];
      }
      if (content)
        try {
          repair = content;
          const design = {
            ...request.structure,
            environment: { ...content, surfaces: request.surfaces },
          };
          const saved = parseSavedRunDesign({
            version: 1,
            source: designSource(),
            requestId: request.requestId,
            generationId: request.generationId,
            fingerprint: runDesignFingerprint(design),
            design,
          });
          options.progress?.(
            "Checking the writing, artwork and saved object bindings…",
          );
          const finalCandidate = candidate ?? rebuild(request);
          options.activity?.({
            stage: "review",
            state: "checking",
            detail: "Checking your escape…",
          });
          const game = options.finalize(finalCandidate, saved);
          options.signal.throwIfAborted();
          return { seed: request.seed, saved, game };
        } catch (error) {
          options.signal.throwIfAborted();
          errors = [error instanceof Error ? error.message : String(error)];
        }
    }
    delete draft.receipt;
    const phase = request.phase;
    draft.request = parseRunDesignRequest({
      ...request,
      requestId: `design-${crypto.randomUUID()}`,
      repair: {
        candidate: repair,
        errors: errors
          .slice(0, 20)
          .map((e) => e.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 400)),
      },
    }) as AuthoredDesignDraft["request"];
    if (draft.attempts[phase] >= DESIGN_ATTEMPTS) draft.exhausted = true;
    else draft.attempts[phase]++;
    await options.capture(draft);
    options.signal.throwIfAborted();
    if (draft.exhausted)
      throw Error(
        "This design still needs changes after three attempts. Your exact repair request is saved; choose Retry or Cancel.",
      );
    options.progress?.(
      "Asking ChatGPT to repair this design while keeping its setting and object bindings…",
    );
  }
}

export function designChatPrompt(draft: DesignDraft) {
  const purpose =
    draft.version === 3
      ? "Prioritize creative quality and meaningful variety over startup speed. Follow each captured concept, selection, authoring or review stage; make evidence-based improvements until the game's review process finishes."
      : "Return the requested structure or object writing and artwork.";
  return `Design my new zombie-escape-study-game run. Call get_current_study_question with chat: "${draft.chatCode}" and use this chat code on every fetch in this chat. Follow the game's captured design contract. ${purpose} Submit each captured stage with finish_study_preparation. Follow any bound next design phase or repair continuation; stop when the game has no further design request. This is fictional world design, not a study conversation. Do not fetch another chat's work. If the tools lack the chat argument, ask me to refresh the zombie-escape-study-game plugin tools.`;
}
