/**
 * Escape game preparation and loop endings (docs/ESCAPE_REDESIGN.md sections 3, 10, 11).
 *
 * These functions talk to the Claude bridge but never depend on it: every
 * request is caught and falls back to the deterministic offline data already
 * on the game, so a disconnected bridge cannot break a loop.
 */
import { fallbackTruth, parseTruthSheet } from "./escape-plan";
import { bridgeRequest } from "./bridge-client";
import { validateCatastrophe } from "./catastrophe";
import {
  recentCatastrophes,
  rememberCatastrophe,
  repeatsRecent,
  summarizeCatastrophe,
} from "./catastrophe-history";
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
type EscapeRequest = (
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

const words = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

/** Distinct, sorted region kinds of an authored outdoor plan. */
function regionKinds(regions: unknown): string[] {
  if (!Array.isArray(regions)) return [];
  const kinds = new Set<string>();
  for (const region of regions) {
    const kind = isRecord(region) ? words(region.kind, 24) : undefined;
    if (kind) kinds.add(kind);
  }
  return [...kinds].sort().slice(0, 24);
}

/** The physical place the threat has to fit, read defensively: an old save or
 * a design from before `setting.outdoors` may lack any of it. */
function physicalSetting(design: unknown): Record<string, unknown> {
  const setting =
    isRecord(design) && isRecord(design.setting) ? design.setting : undefined;
  if (!setting) return {};
  const place: Record<string, unknown> = {};
  const venue = words(setting.venue, 40),
    form = words(setting.form, 40);
  if (venue) place.venue = venue;
  if (form) place.form = form;
  if (isRecord(setting.surroundings)) {
    const around = setting.surroundings,
      surroundings: Record<string, string> = {};
    for (const key of ["ground", "neighbors", "weather"] as const) {
      const value = words(around[key], 40);
      if (value) surroundings[key] = value;
    }
    if (Object.keys(surroundings).length) place.surroundings = surroundings;
  }
  if (isRecord(setting.outdoors)) {
    const plan = setting.outdoors,
      outdoors: Record<string, unknown> = {};
    const enclosure = words(plan.enclosure, 24),
      backdrop = words(plan.backdrop, 24),
      ground = words(plan.ground, 40),
      kinds = regionKinds(plan.regions);
    if (enclosure) outdoors.enclosure = enclosure;
    if (backdrop) outdoors.backdrop = backdrop;
    if (ground) outdoors.ground = ground;
    if (kinds.length) outdoors.regionKinds = kinds;
    if (Object.keys(outdoors).length) place.outdoors = outdoors;
  }
  return place;
}

/** Why a catastrophe request produced no usable spec. */
type CatastropheFailure = "request-failed" | "malformed" | "invalid";
/** How a new game's catastrophe was prepared, for the local run log. */
interface CatastrophePreparation {
  /** `offline` means the deterministic fallback already on the game stayed. */
  source: "ai" | "offline";
  /** Model requests made (2 when a repeat of a recent threat was re-asked). */
  requests: number;
  /** 1 when the first answer repeated a recent catastrophe. */
  repeated: number;
  failure?: CatastropheFailure;
  /** The transport error or first validator problem, bounded. */
  detail?: string;
}
type CatastropheAnswer =
  | { spec: CatastropheSpec }
  | { spec?: undefined; failure: CatastropheFailure; detail: string };

/** One catastrophe request: the spec when it is valid, otherwise why not. */
async function requestCatastrophe(
  payload: Record<string, unknown>,
  areaIds: string[],
): Promise<CatastropheAnswer> {
  try {
    const answer = await escapeRequest("escape-catastrophe", payload);
    if (!isRecord(answer) || !("spec" in answer))
      return { failure: "malformed", detail: "answer has no spec" };
    const problems = validateCatastrophe(answer.spec, areaIds);
    if (problems.length > 0)
      return {
        failure: "invalid",
        detail: `${problems.length} problem(s): ${String(problems[0])}`.slice(
          0,
          200,
        ),
      };
    return { spec: answer.spec as CatastropheSpec };
  } catch (error) {
    return { failure: "request-failed", detail: String(error).slice(0, 200) };
  }
}

/** Generate the sealed catastrophe for a new game (AI, falling back to an
 * offline spec). Called only when a new game is generated, never on Restart,
 * so each accepted catastrophe is recorded in the player's history once.
 * The returned report says which of the two the game ended up with and why. */
export async function prepareCatastrophe(
  g: Game,
): Promise<CatastrophePreparation> {
  const escape: EscapeState | undefined = g.escape;
  if (!escape)
    return {
      source: "offline",
      requests: 0,
      repeated: 0,
      failure: "request-failed",
      detail: "game has no escape state",
    };
  const design = g.design?.design;
  const areaIds = Object.keys(escape.areas.areas);
  const recent = recentCatastrophes();
  const payload: Record<string, unknown> = {
    requestId: `cat-${g.id}`,
    setting: {
      title: text(design && "title" in design ? design.title : ""),
      premise: text(design && "premise" in design ? design.premise : ""),
      opening: text(design && "opening" in design ? design.opening : ""),
      ...physicalSetting(design),
    },
    persona: escape.persona,
    areaIds,
    recent,
  };
  const answer = await requestCatastrophe(payload, areaIds);
  // Offline or malformed: keep the catastrophe already on the game.
  if (!answer.spec)
    return {
      source: "offline",
      requests: 1,
      repeated: 0,
      failure: answer.failure,
      detail: answer.detail,
    };
  let spec = answer.spec;
  const report: CatastrophePreparation = {
    source: "ai",
    requests: 1,
    repeated: 0,
  };
  const first = summarizeCatastrophe(spec);
  if (repeatsRecent(first, recent)) {
    // The same threat under a new name: ask once more and take that answer.
    report.requests = 2;
    report.repeated = 1;
    const second = await requestCatastrophe(
      { ...payload, requestId: `cat-${g.id}-2`, repeated: first },
      areaIds,
    );
    if (second.spec) spec = second.spec;
    else {
      // The first answer stays; the log still says the re-ask failed.
      report.failure = second.failure;
      report.detail = second.detail;
    }
  }
  escape.catastrophe = spec;
  rememberCatastrophe(spec);
  return report;
}

/**
 * Write the game's sealed truth sheet once its catastrophe is settled: which
 * ways out work, which are closed and what is not as it seems. Called only
 * for a newly generated game. A missing or malformed answer leaves the
 * deterministic sheet from the seed, so every game has one.
 */
export async function prepareTruth(g: Game): Promise<"ai" | "offline"> {
  const escape = g.escape;
  if (!escape) return "offline";
  const design = g.design?.design;
  let sheet: ReturnType<typeof parseTruthSheet>;
  try {
    const answer = await escapeRequest("escape-truth", {
      requestId: `truth-${g.id}`,
      setting: {
        title: text(design && "title" in design ? design.title : ""),
        premise: text(design && "premise" in design ? design.premise : ""),
        opening: text(design && "opening" in design ? design.opening : ""),
        ...physicalSetting(design),
      },
      persona: escape.persona,
      // The one prompt besides the epilogue that may read the sealed spec.
      catastrophe: escape.catastrophe,
    });
    sheet = isRecord(answer) ? parseTruthSheet(answer.sheet) : undefined;
  } catch {
    sheet = undefined;
  }
  escape.truth = sheet ?? fallbackTruth(g.seed);
  return sheet ? "ai" : "offline";
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
