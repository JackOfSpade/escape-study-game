/**
 * PA system: broadcast timing, content choice, offline fallback text,
 * validation and the small bookkeeping helpers the game loop needs.
 *
 * Everything here is pure data logic. Randomness arrives only through an
 * injected `rng`, so a fixed rng always produces the same announcement.
 */
import type { Announcement, AnnouncementKind, PhaseName } from "./escape-types";

/** Seconds between announcements. Shared by the director and the tests. */
export const PA_TIMING = Object.freeze({
  /** Before onset the PA is sparse: 150..420 s between announcements. */
  routineBeforeOnset: Object.freeze({ min: 150, max: 420 }),
  /** After onset it is busy: 60..150 s between announcements. */
  routineAfterOnset: Object.freeze({ min: 60, max: 150 }),
  /** The first announcement lands 40..90 s after the game starts. */
  first: Object.freeze({ min: 40, max: 90 }),
});

/** Normalised rng output in [0, 1], tolerant of a sloppy generator. */
function unit(rng: () => number): number {
  const value = rng();
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value >= 1 ? 1 : value;
}

/** Index into a non-empty list, never out of bounds for rng values of 1. */
function pickIndex(length: number, rng: () => number): number {
  return Math.min(length - 1, Math.floor(unit(rng) * length));
}

function between(
  range: { min: number; max: number },
  rng: () => number,
): number {
  return Math.round(range.min + unit(rng) * (range.max - range.min));
}

/**
 * When the next announcement should fire. `now <= 0` means the game has just
 * started, which uses the shorter first-announcement window.
 */
export function nextAnnouncementAt(
  now: number,
  onset: boolean,
  rng: () => number,
): number {
  const range =
    now <= 0
      ? PA_TIMING.first
      : onset
        ? PA_TIMING.routineAfterOnset
        : PA_TIMING.routineBeforeOnset;
  return now + between(range, rng);
}

/** Input for {@link chooseKind}. */
interface ChooseKindInput {
  phase: PhaseName | "calm";
  onset: boolean;
  recentKinds: readonly AnnouncementKind[];
}

/** The calm rotation, in the order the anti-repetition guard walks it. */
const CALM_ORDER: readonly AnnouncementKind[] = [
  "routine",
  "incident",
  "borderline",
];

function pickWeighted(
  r: number,
  onset: boolean,
  borderlineAllowed: boolean,
): AnnouncementKind {
  if (onset) {
    if (r < 0.6) return "escalation";
    if (r < 0.85) return "incident";
    return "routine";
  }
  if (borderlineAllowed) {
    if (r < 0.7) return "routine";
    if (r < 0.9) return "incident";
    return "borderline";
  }
  // Borderline is locked until the omens phase: its share goes to routine.
  return r < 0.8 ? "routine" : "incident";
}

/** The next kind in the calm order; escalation falls back to routine. */
function nextInOrder(kind: AnnouncementKind): AnnouncementKind {
  const index = CALM_ORDER.indexOf(kind);
  return CALM_ORDER[(index + 1) % CALM_ORDER.length];
}

/**
 * Weighted kind choice. Before onset the mix is routine 70%, incident 20%,
 * borderline 10%, with borderline's share folded into routine until the omens
 * phase. After onset it is escalation 60%, incident 25%, routine 15%.
 * Three identical kinds in a row are never returned: the third pick advances
 * to the next kind in the calm order instead.
 */
export function chooseKind(
  input: ChooseKindInput,
  rng: () => number,
): AnnouncementKind {
  const borderlineAllowed = input.phase !== "calm";
  let kind = pickWeighted(unit(rng), input.onset, borderlineAllowed);
  const recent = input.recentKinds;
  const last = recent[recent.length - 1];
  const beforeLast = recent[recent.length - 2];
  for (let guard = 0; guard <= CALM_ORDER.length; guard += 1) {
    if (!(kind === last && kind === beforeLast)) return kind;
    kind = nextInOrder(kind);
  }
  return kind;
}

/** Input for {@link fallbackAnnouncement}. */
interface FallbackInput {
  kind: AnnouncementKind;
  areaId: string;
  areaName: string;
  rooms: readonly { id: string; name: string }[];
  publicStory: string;
  now: number;
  seq: number;
}

interface TemplateContext {
  areaName: string;
  roomName: string;
  roomId?: string;
  publicStory: string;
}

interface TemplateResult {
  text: string;
  effect?: Announcement["effect"];
}

type Template = (context: TemplateContext) => TemplateResult;

/** Longest text the game accepts, in characters. */
const MAX_TEXT = 220;

/**
 * Setting-neutral routine chatter. Only the area and room names come from the
 * world, so the same list works for a station, a ship or an office.
 */
const ROUTINE_TEMPLATES: readonly Template[] = [
  (c) => ({
    text: `Attention: conditions around the ${c.areaName} remain steady. Interior readings are within the normal range and no change is expected this hour.`,
  }),
  (c) => ({
    text: `Schedule change: the briefing for the ${c.areaName} moves to ${c.roomName} this afternoon. Please check the posted times before you set out.`,
  }),
  (c) => ({
    text: `Maintenance window today in the ${c.areaName}. Work is scheduled in ${c.roomName} and may cause brief noise and a short detour.`,
  }),
  (c) => ({
    text: `Lost property: a small bag was handed in at ${c.roomName}. The owner can collect it from any staff member on duty in the ${c.areaName}.`,
  }),
  (c) => ({
    text: `Shift change in fifteen minutes. Incoming staff in the ${c.areaName} please report to ${c.roomName} for handover and sign the sheet.`,
  }),
  (c) => ({
    text: `Supply notice: ${c.roomName} has been restocked. Drinks and rations are available to all staff working in the ${c.areaName}.`,
  }),
  (c) => ({
    text: `Reminder: please carry your pass at all times in the ${c.areaName}. Doors near ${c.roomName} close automatically outside working hours.`,
  }),
];

/**
 * Incidents that are real but unrelated to the catastrophe. Two of them assert
 * world state, which the game applies (and the validator checks against rooms).
 */
const INCIDENT_TEMPLATES: readonly Template[] = [
  (c) => ({
    text: `Power outage reported in ${c.roomName}. Emergency lighting is active nearby and technicians are on their way. Avoid the area until power is restored.`,
    effect: c.roomId
      ? { kind: "power", roomId: c.roomId, power: "outage" }
      : { kind: "none" },
  }),
  (c) => ({
    text: `Notice: ${c.roomName} is under a precautionary lockdown while staff deal with a routine issue. Movement through that room is paused.`,
    effect: c.roomId
      ? { kind: "lockdown", roomId: c.roomId }
      : { kind: "none" },
  }),
  (c) => ({
    text: `Water leak reported in ${c.roomName}. The cleaning crew is responding and the floor near the ${c.areaName} entrance may be slippery.`,
  }),
  (c) => ({
    text: `A sensor alarm sounded in ${c.roomName} and has been cleared. No action is needed from staff in the ${c.areaName}.`,
  }),
  (c) => ({
    text: `Delivery delay: the drop-off point at ${c.roomName} stays closed for the next hour. Please hold deliveries for the ${c.areaName}.`,
  }),
];

/** Announcements that border on the truth and may mislead. */
const BORDERLINE_TEMPLATES: readonly Template[] = [
  (c) => ({
    text: `Unusual readings were logged near ${c.roomName}. Staff are asked not to investigate personally and to report anything out of the ordinary.`,
  }),
  (c) => ({
    text: `Staff are asked to avoid ${c.roomName} until further notice and to use the other route through the ${c.areaName}.`,
  }),
];

/** Post-onset escalation: the official story, then an outright evacuation. */
const ESCALATION_TEMPLATES: readonly Template[] = [
  (c) => ({
    text: `Attention all staff: ${c.publicStory} Follow staff instructions and stay clear of ${c.roomName}.`,
  }),
  (c) => ({
    text: `${c.publicStory} This affects all of the ${c.areaName}. Remain calm and await further instructions.`,
  }),
  (c) => ({
    text: `Emergency. ${c.publicStory} All staff evacuate the ${c.areaName} immediately. This is not a drill.`,
    effect: { kind: "evacuate" },
  }),
];

const TEMPLATES: Record<AnnouncementKind, readonly Template[]> = {
  routine: ROUTINE_TEMPLATES,
  incident: INCIDENT_TEMPLATES,
  borderline: BORDERLINE_TEMPLATES,
  escalation: ESCALATION_TEMPLATES,
};

function clampText(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_TEXT
    ? trimmed
    : trimmed.slice(0, MAX_TEXT).trim();
}

/**
 * Deterministic offline text used when the AI is unavailable. Always returns a
 * valid announcement: ids are `pa<seq>`, `at` is `now`, and every asserted room
 * comes from the supplied rooms list.
 */
export function fallbackAnnouncement(
  input: FallbackInput,
  rng: () => number,
): Announcement {
  const templates = TEMPLATES[input.kind];
  const room =
    input.rooms.length > 0
      ? input.rooms[pickIndex(input.rooms.length, rng)]
      : undefined;
  const context: TemplateContext = {
    areaName: input.areaName,
    roomName: room ? `the ${room.name}` : "the main corridor",
    publicStory: input.publicStory,
  };
  if (room) context.roomId = room.id;
  const result = templates[pickIndex(templates.length, rng)](context);
  const announcement: Announcement = {
    id: `pa${input.seq}`,
    at: input.now,
    kind: input.kind,
    text: clampText(result.text),
    areaId: input.areaId,
  };
  if (result.effect) announcement.effect = result.effect;
  return announcement;
}

const ANNOUNCEMENT_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "at",
  "kind",
  "text",
  "areaId",
  "effect",
  "factId",
]);

const KINDS: readonly AnnouncementKind[] = [
  "routine",
  "incident",
  "borderline",
  "escalation",
];

const EFFECT_FIELDS: Record<string, ReadonlySet<string>> = {
  power: new Set(["kind", "roomId", "power"]),
  lockdown: new Set(["kind", "roomId"]),
  evacuate: new Set(["kind"]),
  none: new Set(["kind"]),
};

function roomIdProblem(
  roomId: unknown,
  rooms: readonly { id: string }[],
): string | undefined {
  if (typeof roomId !== "string" || roomId.length === 0)
    return "effect roomId must be a non-empty string";
  return rooms.some((room) => room.id === roomId)
    ? undefined
    : `effect roomId is not a known room: ${roomId}`;
}

function validateEffect(
  effect: unknown,
  rooms: readonly { id: string }[],
): string[] {
  if (!effect || typeof effect !== "object" || Array.isArray(effect))
    return ["effect must be an object"];
  const record = effect as Record<string, unknown>;
  const kind = typeof record.kind === "string" ? record.kind : "";
  const allowed = EFFECT_FIELDS[kind];
  if (!allowed)
    return ["effect kind must be power, lockdown, evacuate or none"];
  const problems: string[] = [];
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) problems.push(`unknown effect field: ${key}`);
  }
  if (kind === "power" || kind === "lockdown") {
    const roomProblem = roomIdProblem(record.roomId, rooms);
    if (roomProblem) problems.push(roomProblem);
  }
  if (
    kind === "power" &&
    record.power !== "lit" &&
    record.power !== "dim" &&
    record.power !== "outage"
  ) {
    problems.push("power effect must be lit, dim or outage");
  }
  return problems;
}

/**
 * Checks an untrusted announcement against the Announcement contract.
 * Returns the problems found; an empty array means it is valid.
 */
export function validateAnnouncement(
  a: unknown,
  rooms: readonly { id: string }[],
): string[] {
  if (!a || typeof a !== "object" || Array.isArray(a))
    return ["announcement must be an object"];
  const record = a as Record<string, unknown>;
  const problems: string[] = [];

  for (const key of Object.keys(record)) {
    if (!ANNOUNCEMENT_FIELDS.has(key)) problems.push(`unknown field: ${key}`);
  }
  if (typeof record.id !== "string" || record.id.trim().length === 0) {
    problems.push("id must be a non-empty string");
  }
  if (typeof record.areaId !== "string" || record.areaId.trim().length === 0) {
    problems.push("areaId must be a non-empty string");
  }
  if (
    typeof record.kind !== "string" ||
    !KINDS.includes(record.kind as AnnouncementKind)
  ) {
    problems.push("kind is not a valid announcement kind");
  }
  if (typeof record.text !== "string") {
    problems.push("text must be a string");
  } else if (record.text !== record.text.trim()) {
    problems.push("text must be trimmed");
  } else if (record.text.length < 1 || record.text.length > MAX_TEXT) {
    problems.push("text must be 1..220 characters");
  }
  if (typeof record.at !== "number" || !Number.isFinite(record.at)) {
    problems.push("at must be a finite number");
  }
  if (
    record.factId !== undefined &&
    (typeof record.factId !== "string" || record.factId.trim().length === 0)
  ) {
    problems.push("factId must be a non-empty string");
  }
  if (record.effect !== undefined)
    problems.push(...validateEffect(record.effect, rooms));
  return problems;
}

/**
 * Ids of the actors that can hear a broadcast in `areaId`: alive, indoors, in
 * that area, on a floor that has at least one speaker in that area. Sorted.
 */
export function paListeners(
  actors: readonly {
    id: string;
    floor: number;
    x: number;
    y: number;
    alive: boolean;
    indoor: boolean;
    areaId: string;
  }[],
  speakers: readonly { areaId: string; floor: number }[],
  areaId: string,
): string[] {
  const floors = new Set(
    speakers
      .filter((speaker) => speaker.areaId === areaId)
      .map((speaker) => speaker.floor),
  );
  return actors
    .filter(
      (actor) =>
        actor.alive &&
        actor.indoor &&
        actor.areaId === areaId &&
        floors.has(actor.floor),
    )
    .map((actor) => actor.id)
    .sort();
}

const WEIGHTS: Record<AnnouncementKind, number> = {
  routine: 0.02,
  incident: 0.12,
  borderline: 0.2,
  escalation: 0.7,
};

/** How much alarm an announcement carries for NPCs that hear it. */
export function announcementWeight(a: Announcement): number {
  return a.effect?.kind === "evacuate" ? 0.9 : WEIGHTS[a.kind];
}

/** How many announcements the game keeps. */
const MAX_RECORDED = 64;

/** Appends an announcement and keeps only the newest {@link MAX_RECORDED}. */
export function recordAnnouncement(
  list: Announcement[],
  a: Announcement,
): void {
  list.push(a);
  if (list.length > MAX_RECORDED) list.splice(0, list.length - MAX_RECORDED);
}
