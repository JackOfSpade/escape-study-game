/**
 * Escape game preparation and loop endings (docs/ESCAPE_REDESIGN.md sections 3, 10, 11).
 *
 * These functions talk to the Claude bridge but never depend on it: every
 * request is caught and falls back to the deterministic offline data already
 * on the game, so a disconnected bridge cannot break a loop.
 */
import { bridgeRequest } from "./bridge-client";
import { validateCatastrophe } from "./catastrophe";
import {
  epiloguePacket,
  fallbackEpilogue,
  logEvent,
  validateEpilogue,
} from "./escape-log";
import type { CatastropheSpec, EscapeState } from "./escape-types";
import type { Game } from "./model";
import { isRecord } from "./records";

/** One bridge call: the operation name, its payload, and the raw answer. */
export type EscapeRequest = (
  operation: string,
  payload: unknown,
) => Promise<unknown>;

const defaultRequest: EscapeRequest = (operation, payload) =>
  bridgeRequest(operation, payload);

let escapeRequest: EscapeRequest = defaultRequest;

/** Swap the bridge request function. Exported for tests; the game keeps the default. */
export function setEscapeRequest(fn?: EscapeRequest): void {
  escapeRequest = fn ?? defaultRequest;
}

/** Restore the real bridge request function. */
export function resetEscapeRequest(): void {
  escapeRequest = defaultRequest;
}

type EndOutcome = "escaped" | "died" | "restarted" | "quit";

/** Background epilogue writes, so New game can await one without re-requesting. */
const pendingEpilogues = new WeakMap<Game, Promise<void>>();

const text = (value: unknown): string =>
  typeof value === "string" ? value : "";

/** Generate the sealed catastrophe for a new game (AI, falling back to an offline spec). */
export async function prepareCatastrophe(g: Game): Promise<void> {
  const escape: EscapeState | undefined = g.escape;
  if (!escape) return;
  const design = g.design?.design;
  const areaIds = Object.keys(escape.areas.areas);
  try {
    const answer = await escapeRequest("escape-catastrophe", {
      requestId: `cat-${g.id}`,
      setting: {
        title: text(design && "title" in design ? design.title : ""),
        premise: text(design && "premise" in design ? design.premise : ""),
        opening: text(design && "opening" in design ? design.opening : ""),
      },
      persona: escape.persona,
      areaIds,
    });
    if (!isRecord(answer) || !("spec" in answer)) return;
    if (validateCatastrophe(answer.spec, areaIds).length > 0) return;
    escape.catastrophe = answer.spec as CatastropheSpec;
  } catch {
    // Offline or malformed answer: keep the catastrophe already on the game.
  }
}

const packetOutcome = (outcome: EndOutcome): "escaped" | "died" | "quit" =>
  outcome === "escaped" ? "escaped" : outcome === "died" ? "died" : "quit";

/** Build the packet and write the epilogue once, in the background. */
function startEpilogue(g: Game, outcome: EndOutcome): Promise<void> {
  const escape = g.escape;
  if (!escape) return Promise.resolve();
  const loop = escape.loop;
  const packet = epiloguePacket({
    spec: escape.catastrophe,
    log: escape.log,
    areas: escape.areas,
    persona: escape.persona,
    outcome: packetOutcome(outcome),
    endedAt: g.time,
  });
  const write = (async () => {
    let written: string | undefined;
    try {
      const answer = await escapeRequest("escape-epilogue", {
        requestId: `epi-${g.id}-${loop}`,
        ...packet,
      });
      written = isRecord(answer) ? validateEpilogue(answer.text) : undefined;
    } catch {
      written = undefined;
    }
    escape.epilogue = {
      loop,
      text: written ?? fallbackEpilogue(packet),
      writtenAt: g.time,
    };
  })();
  pendingEpilogues.set(g, write);
  return write;
}

/** The current loop ended. Records the player's end and writes the epilogue in the background. */
export function endLoop(g: Game, outcome: EndOutcome): void {
  const escape = g.escape;
  if (!escape) return;
  if (escape.log.some((event) => event.kind === "player-end")) return;
  logEvent(escape.log, {
    at: g.time,
    kind: "player-end",
    areaId: escape.areas.current,
    text: outcome,
  });
  void startEpilogue(g, outcome);
}

const readEpilogue = (g: Game) => g.escape?.epilogue;

/** The newest completed loop's epilogue, writing it now if it is missing. Shown only on New game. */
export async function epilogueForNewGame(g: Game): Promise<string | undefined> {
  if (!g.escape) return undefined;
  const stored = readEpilogue(g);
  if (stored) return stored.text;
  const pending = pendingEpilogues.get(g);
  if (pending) await pending;
  const afterPending = readEpilogue(g);
  if (afterPending) return afterPending.text;
  await startEpilogue(g, "quit");
  return readEpilogue(g)?.text;
}
