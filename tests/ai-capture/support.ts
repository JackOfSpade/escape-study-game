/**
 * Shared plumbing for the manual capture driver. Nothing here mocks the
 * network: it only observes the page, reads encounter state and waits.
 */
import type { Page, Request } from "@playwright/test";
import type { CaptureQuestion } from "./learner";

export interface BridgeCounter {
  /** operation → number of /api/bridge POSTs the page made. */
  counts(): Record<string, number>;
  /** Calls still in flight. */
  inflight(): number;
  stop(): void;
}

/** Observe (never intercept) every bridge call the page makes. */
export function countBridgeCalls(page: Page): BridgeCounter {
  const counts: Record<string, number> = {};
  const pending = new Set<Request>();
  const onRequest = (request: Request) => {
    if (!request.url().includes("/api/bridge")) return;
    if (request.method() !== "POST") return;
    let operation: unknown;
    try {
      operation = (request.postDataJSON() as { operation?: unknown })
        ?.operation;
    } catch {
      return;
    }
    if (typeof operation !== "string") return;
    counts[operation] = (counts[operation] ?? 0) + 1;
    pending.add(request);
  };
  const settle = (request: Request) => pending.delete(request);
  page.on("request", onRequest);
  page.on("requestfinished", settle);
  page.on("requestfailed", settle);
  return {
    counts: () => ({ ...counts }),
    inflight: () => pending.size,
    stop() {
      page.off("request", onRequest);
      page.off("requestfinished", settle);
      page.off("requestfailed", settle);
    },
  };
}

/** Wait until no bridge call is in flight, so tutor/assess answers landed. */
export async function waitForBridgeIdle(
  page: Page,
  counter: BridgeCounter,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  while (Date.now() < deadline) {
    if (counter.inflight() === 0) {
      quiet++;
      // Two consecutive quiet samples avoid racing a not-yet-issued request.
      if (quiet >= 2) return;
    } else quiet = 0;
    await page.waitForTimeout(250);
  }
  throw Error(`bridge calls still in flight after ${timeoutMs}ms`);
}

interface EncounterSnapshot {
  title: string;
  prompt: string;
  starter: string;
  tutorLength: number;
  lastTutor: string;
  tutorPending: boolean;
  submission: string;
  accepted: boolean;
}

function snapshot(page: Page, id: string) {
  return page.evaluate((encounter): EncounterSnapshot => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[encounter],
      submissions = e.submissions ?? [],
      last = e.tutor.at(-1);
    return {
      title: e.problem?.title ?? "",
      prompt: e.problem?.prompt ?? "",
      starter: e.problem?.starter ?? "",
      tutorLength: e.tutor.length,
      lastTutor: last && last.kind === "tutor" ? last.text : "",
      tutorPending: (e.tutorRequests ?? []).some(
        (request: any) => request.state === "pending",
      ),
      submission: submissions.at(-1)?.status ?? "",
      accepted: e.state === "consumed" || e.accepted === true,
    };
  }, id);
}

/** The question the real `generate` call produced for this encounter. */
export async function readQuestion(
  page: Page,
  id: string,
): Promise<CaptureQuestion> {
  // The real generate call can finish after the terminal opens.
  await page
    .waitForFunction(
      (encounter) => {
        const problem = (window as any).__deadAir.game.encounters[encounter]
          ?.problem;
        return !!(problem?.title && problem?.prompt);
      },
      id,
      { timeout: 10 * 60_000 },
    )
    .catch(() => {});
  const state = await snapshot(page, id);
  if (!state.title || !state.prompt)
    throw Error(`encounter ${id} has no generated question`);
  return {
    title: state.title,
    prompt: state.prompt,
    ...(state.starter ? { starter: state.starter } : {}),
  };
}

/** Type one learner message into the real composer and send it. */
export async function sendChat(page: Page, text: string): Promise<void> {
  const input = page.locator("#chat-input");
  await input.fill(text);
  await input.press("Enter");
}

/**
 * Wait for the tutor's answer to a message we just sent: the pending request
 * has to appear, then clear, and a new tutor message must be visible.
 */
export async function waitForTutorReply(
  page: Page,
  id: string,
  previousCount: number,
  timeoutMs: number,
): Promise<string> {
  await page.waitForFunction(
    ({ encounter, count }) => {
      const e = (window as any).__deadAir.game.encounters[encounter],
        pending = (e.tutorRequests ?? []).some(
          (request: any) => request.state === "pending",
        );
      return pending || e.tutor.length > count;
    },
    { encounter: id, count: previousCount },
    { timeout: Math.min(60_000, timeoutMs) },
  );
  await page.waitForFunction(
    ({ encounter, count }) => {
      const e = (window as any).__deadAir.game.encounters[encounter],
        pending = (e.tutorRequests ?? []).some(
          (request: any) => request.state === "pending",
        );
      return !pending && e.tutor.length > count;
    },
    { encounter: id, count: previousCount },
    { timeout: timeoutMs },
  );
  const state = await snapshot(page, id);
  return state.lastTutor;
}

/** Tutor/assistant turns recorded so far, for transcript building. */
export async function tutorMessages(
  page: Page,
  id: string,
): Promise<{ role: "tutor"; text: string }[]> {
  const state = await page.evaluate((encounter) => {
    const e = (window as any).__deadAir.game.encounters[encounter];
    return (e.tutor as { kind: string; text: string }[])
      .filter((message) => message.kind === "tutor")
      .map((message) => message.text);
  }, id);
  return state.map((text) => ({ role: "tutor" as const, text }));
}

export const tutorTurnCount = async (page: Page, id: string) =>
  (await snapshot(page, id)).tutorLength;

export const questionAccepted = async (page: Page, id: string) =>
  (await snapshot(page, id)).accepted;

/** Wait until the submission check settles (accepted or rejected). */
export async function waitForSubmissionSettled(
  page: Page,
  id: string,
  timeoutMs: number,
): Promise<"complete" | "needs-work" | "error"> {
  await page.waitForFunction(
    (encounter) => {
      const e = (window as any).__deadAir.game.encounters[encounter],
        status = e.submissions.at(-1)?.status;
      return (
        status === "complete" || status === "needs-work" || status === "error"
      );
    },
    id,
    { timeout: timeoutMs },
  );
  const state = await snapshot(page, id);
  return state.submission as "complete" | "needs-work" | "error";
}
