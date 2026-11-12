/**
 * Escape redesign state: creation defaults and the restart (time-loop) rules
 * (docs/ESCAPE_REDESIGN.md sections 2, 11 and 12 "Restart").
 *
 * `Game.escape` is plain saved JSON. Everything here is pure: it builds a
 * fresh state or a reset copy and never touches the game it reads.
 */
import { fallbackCatastrophe } from "./catastrophe";
import type { Game } from "./model";
import { resetTasksForLoop } from "./escape-tasks";
import type { AreaGraph, EscapeState, VoiceGender } from "./escape-types";
import { emptyLedger } from "./fact-ledger";
import {
  drawVoiceIdentity,
  isVoiceIdentity,
  keepVoicesOnRestart,
} from "./voice-identity";

/** Used when the run has no authored design to draw a persona from. */
const GENERIC_BACKSTORY =
  "You started work in this building a week ago. You know the corridors you walk every day and nothing else.";
const GENERIC_AREA_NAME = "the building";
const GENERIC_AREA_BRIEF = "The building you are standing in.";

type DesignText = { title?: string; premise?: string; opening?: string };

function designText(g: Game): DesignText | undefined {
  const design = g.design?.design as DesignText | undefined;
  if (!design || typeof design !== "object") return undefined;
  return design;
}

function personaOf(g: Game): EscapeState["persona"] {
  const human = g.survivors?.find((a) => a.id === "human") ?? g.survivors?.[0];
  const name =
    typeof human?.name === "string" && human.name.trim() ? human.name : "You";
  const role =
    typeof human?.role === "string" && human.role.trim() ? human.role : "crew";
  const design = designText(g);
  const opening =
    typeof design?.opening === "string" ? design.opening.trim() : "";
  const premise =
    typeof design?.premise === "string" ? design.premise.trim() : "";
  const backstory = [opening, premise].filter(Boolean).join(" ").trim();
  return { name, role, backstory: backstory || GENERIC_BACKSTORY };
}

function startAreaOf(g: Game, seed: number): AreaGraph {
  const design = designText(g);
  const name =
    typeof design?.title === "string" && design.title.trim()
      ? design.title
      : GENERIC_AREA_NAME;
  const brief =
    typeof design?.premise === "string" && design.premise.trim()
      ? design.premise
      : GENERIC_AREA_BRIEF;
  return {
    start: "start",
    current: "start",
    areas: {
      start: { id: "start", name, brief, state: "ready", seed },
    },
    portals: [],
  };
}

/** The first loop of a new game, before `prepareCatastrophe` replaces the spec. */
export function createEscapeState(
  g: Game,
  opts: { gender: VoiceGender; seed: number },
): EscapeState {
  const seed = Number.isFinite(opts.seed) ? opts.seed : g.seed;
  return {
    version: 1,
    persona: personaOf(g),
    catastrophe: fallbackCatastrophe(seed, "start"),
    ledger: emptyLedger(),
    tasks: [],
    areas: startAreaOf(g, seed),
    voices: drawVoiceIdentity(opts.gender, seed),
    announcements: [],
    loop: 0,
    log: [],
    areaStore: {},
    prompts: [],
    roomPower: {},
  };
}

/**
 * A restart replays the same world in a new loop: the plan, the catastrophe,
 * what the player knows, the journal and the voices survive; progress and the
 * last loop's noise do not.
 */
export function loopReset(prev: EscapeState): EscapeState {
  // Stubs keep their designs and their stamped flags: `restampSites` rebuilds
  // every place the last loop had reached in the fresh world.
  const areas = structuredClone(prev.areas);
  areas.current = areas.start;
  const next: EscapeState = {
    version: 1,
    persona: { ...prev.persona },
    catastrophe: structuredClone(prev.catastrophe),
    ledger: structuredClone(prev.ledger),
    tasks: resetTasksForLoop(structuredClone(prev.tasks)),
    areas,
    voices: keepVoicesOnRestart(prev.voices),
    announcements: [],
    loop: prev.loop + 1,
    log: [],
    areaStore: {},
    prompts: [],
    roomPower: {},
  };
  if (prev.epilogue) next.epilogue = { ...prev.epilogue };
  return next;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return Boolean(x) && typeof x === "object" && !Array.isArray(x);
}

/** Light shape guard for a saved `Game.escape`; deep validation is the runtime's job. */
export function isEscapeState(x: unknown): x is EscapeState {
  if (!isRecord(x)) return false;
  if (x.version !== 1) return false;
  const persona = x.persona;
  if (!isRecord(persona)) return false;
  if (
    typeof persona.name !== "string" ||
    typeof persona.role !== "string" ||
    typeof persona.backstory !== "string"
  )
    return false;
  if (!isRecord(x.catastrophe)) return false;
  const ledger = x.ledger;
  if (!isRecord(ledger)) return false;
  if (
    !Array.isArray(ledger.facts) ||
    !Array.isArray(ledger.journal) ||
    typeof ledger.seq !== "number"
  )
    return false;
  if (!Array.isArray(x.tasks)) return false;
  const areas = x.areas;
  if (!isRecord(areas)) return false;
  if (
    typeof areas.start !== "string" ||
    typeof areas.current !== "string" ||
    !isRecord(areas.areas) ||
    !Array.isArray(areas.portals)
  )
    return false;
  if (!isVoiceIdentity(x.voices)) return false;
  if (!Array.isArray(x.announcements)) return false;
  if (typeof x.loop !== "number" || !Number.isFinite(x.loop)) return false;
  if (!Array.isArray(x.log)) return false;
  if (!isRecord(x.areaStore)) return false;
  if (!Array.isArray(x.prompts)) return false;
  if (!isRecord(x.roomPower)) return false;
  if (x.epilogue !== undefined) {
    if (!isRecord(x.epilogue)) return false;
    if (
      typeof x.epilogue.loop !== "number" ||
      typeof x.epilogue.text !== "string" ||
      typeof x.epilogue.writtenAt !== "number"
    )
      return false;
  }
  return true;
}
