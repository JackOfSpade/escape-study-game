/**
 * Escape director runtime (docs/ESCAPE_REDESIGN.md sections 4-6 and 10).
 *
 * The director is the AI-facing half of the escape loop: PA schedule and
 * announcement effects, engagement answers (facts, tasks, discovered areas)
 * and intent prediction. Every request is fire-and-forget and caught, so a
 * disconnected bridge only ever costs a deterministic offline fallback.
 */
import { prefetchArea, regionEdgePoint, registerArea } from "./areas";
import { bridgeRequest } from "./bridge-client";
import { catastropheState } from "./catastrophe";
import { latchDoor, lockDoor } from "./doors";
import { commitFact, journalLines, learn, type FactInput } from "./fact-ledger";
import { logEvent } from "./escape-log";
import { createTask, taskIndicator } from "./escape-tasks";
import type {
  Announcement,
  AnnouncementKind,
  AreaPortal,
  AreaStub,
  CatastropheSpec,
  EscapeState,
  EscapeTask,
  FactVisibility,
} from "./escape-types";
import type { Engagement } from "./escape-runtime";
import {
  chooseKind,
  fallbackAnnouncement,
  nextAnnouncementAt,
  recordAnnouncement,
  validateAnnouncement,
} from "./pa-system";
import {
  rand,
  type Encounter,
  type Floor,
  type Furniture,
  type Game,
  type Station,
} from "./model";
import type { Readable } from "./readables";
import { isRecord } from "./records";
import { roomPowerKey } from "./room-power-key";
import { nextSiteOrigin } from "./site-stamp";

/** One bridge call: the operation name, its payload, and the raw answer. */
export type DirectorRequest = (
  operation: string,
  payload: unknown,
) => Promise<unknown>;

const defaultRequest: DirectorRequest = (operation, payload) =>
  bridgeRequest(operation, payload);

let directorRequest: DirectorRequest = defaultRequest;

/** Swap the bridge request function. Exported for tests; the game keeps the default. */
export function setDirectorRequest(fn?: DirectorRequest): void {
  directorRequest = fn ?? defaultRequest;
}

/** Restore the real bridge request function. */
export function resetDirectorRequest(): void {
  directorRequest = defaultRequest;
}

/** Seconds between intent predictions. */
const INTENT_INTERVAL = 90;

/** First PA: 40..90 s after the game starts. */
const FIRST_PA_MIN = 40;
const FIRST_PA_SPAN = 50;

/** How many journal lines the director shows the AI. */
const JOURNAL_WINDOW = 12;

/** Longest journal line a learned fact may carry. */
const LEARNED_LINE = 160;

/** A station within this distance of an object already serves it. */
const STATION_REACH = 1.2;

interface PaState {
  /** Game time the next announcement is due. */
  next: number;
  /** A request is in flight; no second one is sent. */
  pending: boolean;
  /** Announcement sequence, used for `pa<seq>` ids. */
  seq: number;
}

interface IntentState {
  next: number;
  pending: boolean;
  /** An engagement happened since the last prediction. */
  armed: boolean;
}

const paStates = new WeakMap<Game, PaState>();
const intentStates = new WeakMap<Game, IntentState>();
const engagementLabels = new WeakMap<Game, string[]>();

function paState(g: Game): PaState {
  let state = paStates.get(g);
  if (!state) {
    state = {
      next: g.time + FIRST_PA_MIN + rand(g) * FIRST_PA_SPAN,
      pending: false,
      seq: 0,
    };
    paStates.set(g, state);
  }
  return state;
}

function intentState(g: Game): IntentState {
  let state = intentStates.get(g);
  if (!state) {
    state = { next: g.time + INTENT_INTERVAL, pending: false, armed: false };
    intentStates.set(g, state);
  }
  return state;
}

function markEngagement(g: Game, label: string): void {
  const list = engagementLabels.get(g) ?? [];
  list.push(label);
  if (list.length > 5) list.splice(0, list.length - 5);
  engagementLabels.set(g, list);
  intentState(g).armed = true;
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/**
 * Send one request and always answer exactly once, swallowing both a
 * synchronous throw and a rejection. The callback's own errors are contained
 * so a malformed answer never escapes into the frame.
 */
function ask(
  operation: string,
  payload: unknown,
  onAnswer: (answer: unknown) => void,
): void {
  let pending: Promise<unknown>;
  try {
    pending = directorRequest(operation, payload);
  } catch {
    onAnswer(undefined);
    return;
  }
  const answer = (value: unknown) => {
    try {
      onAnswer(value);
    } catch {
      // A malformed answer must not break the caller.
    }
  };
  void pending.then(answer, () => answer(undefined));
}

/* ------------------------------------------------------------------ */
/* Rooms and areas                                                     */
/* ------------------------------------------------------------------ */

interface RoomRef {
  id: string;
  name: string;
  index: number;
  floor: number;
  /** Room centre in floor coordinates, when the floor records one. */
  centre?: { floor: number; x: number; y: number };
}

type RoomRecord = {
  id?: string;
  name?: string;
  index: number;
  side?: string;
  innerMouth?: { x: number; y: number };
  forwardExit?: { x: number; y: number };
  forwardEntry?: { x: number; y: number };
};

/** Every room of the active area, with a stable id and a friendly name. */
function worldRooms(g: Game): RoomRef[] {
  const out: RoomRef[] = [];
  g.floors.forEach((floor, floorIndex) => {
    const records = (floor.rooms ?? []) as RoomRecord[];
    for (const room of records) {
      const id =
        typeof room.id === "string" && room.id.length > 0
          ? room.id
          : `${floorIndex}:${room.index}`;
      const point = room.forwardExit ?? room.forwardEntry ?? room.innerMouth;
      out.push({
        id,
        name:
          typeof room.name === "string" && room.name.length > 0
            ? room.name
            : `room ${room.index + 1}`,
        index: room.index,
        floor: floorIndex,
        ...(point
          ? { centre: { floor: floorIndex, x: point.x, y: point.y } }
          : {}),
      });
    }
  });
  return out;
}

/** The floor a room id belongs to, found by scanning the world's rooms. */
function floorOfRoom(
  rooms: readonly RoomRef[],
  roomId: string,
): number | undefined {
  return rooms.find((room) => room.id === roomId)?.floor;
}

/**
 * `g.escape.roomPower` is keyed by a room id without its floor (the map adds
 * `${floor}:` itself), while anonymous world rooms carry a `0:0` style id.
 */
function bareRoomId(roomId: string, floor: number): string {
  const prefix = `${floor}:`;
  return roomId.startsWith(prefix) ? roomId.slice(prefix.length) : roomId;
}

function areaName(escape: EscapeState): string {
  const current = escape.areas.current;
  return escape.areas.areas[current]?.name ?? current;
}

function currentFloor(g: Game): number {
  const player =
    g.survivors.find((actor) => actor.alive && actor.id === "human") ??
    g.survivors.find((actor) => actor.alive);
  return player?.floor ?? 0;
}

function findFurniture(
  g: Game,
  objectId: string,
): { floor: Floor; object: Furniture } | undefined {
  for (const floor of g.floors) {
    const object = floor.furniture.find((item) => item.id === objectId);
    if (object) return { floor, object };
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* PA announcements                                                    */
/* ------------------------------------------------------------------ */

/** Post a PA: schedule, request, validate or fall back, apply and record. */
function framePa(g: Game, escape: EscapeState, spec: CatastropheSpec): void {
  const state = paState(g);
  if (state.pending || g.time < state.next) return;
  state.pending = true;
  const stateNow = catastropheState(spec, g.time);
  const recentKinds = escape.announcements
    .slice(-3)
    .map((announcement) => announcement.kind);
  const kind: AnnouncementKind = chooseKind(
    {
      phase: stateNow.phase,
      onset: stateNow.onset,
      recentKinds,
    },
    () => rand(g),
  );
  const seq = state.seq + 1;
  // Before onset the payload carries nothing from the sealed spec: the AI must
  // not be able to spoil the catastrophe it has not revealed yet.
  const payload = {
    requestId: `pa-${g.id}-${seq}`,
    kind,
    areaName: areaName(escape),
    rooms: worldRooms(g).map((room) => ({ id: room.id, name: room.name })),
    recent: escape.announcements
      .slice(-4)
      .map((announcement) => announcement.text),
    ...(stateNow.onset ? { publicStory: spec.publicStory } : {}),
  };
  ask("escape-pa", payload, (answer) => {
    applyPa(g, escape, state, stateNow, kind, seq, answer);
  });
}

/** Turn the answer (or the offline fallback) into an applied announcement. */
function applyPa(
  g: Game,
  escape: EscapeState,
  state: PaState,
  stateNow: ReturnType<typeof catastropheState>,
  kind: AnnouncementKind,
  seq: number,
  answer: unknown,
): void {
  state.pending = false;
  const rooms = worldRooms(g);
  const areaId = escape.areas.current;
  let announcement = answerAnnouncement(answer, g.time, kind, areaId, seq);
  if (!announcement || validateAnnouncement(announcement, rooms).length > 0) {
    announcement = fallbackAnnouncement(
      {
        kind,
        areaId,
        areaName: areaName(escape),
        rooms,
        publicStory: escape.catastrophe.publicStory,
        now: g.time,
        seq,
      },
      () => rand(g),
    );
  }
  recordAnnouncement(escape.announcements, announcement);
  const fact = commitFact(
    escape.ledger,
    {
      text: announcement.text,
      subject: { kind: "system", id: "pa" },
      source: "pa",
      visibility: [`area:${areaId}`],
      loop: escape.loop,
      durable: false,
    },
    g.time,
  );
  announcement.factId = fact.id;
  logEvent(escape.log, {
    at: g.time,
    kind: "pa",
    areaId,
    text: announcement.text,
    phase: stateNow.phase,
  });
  applyEffect(g, escape, rooms, announcement.effect);
  state.seq = seq;
  state.next = nextAnnouncementAt(g.time, stateNow.onset, () => rand(g));
}

/** The answer as an Announcement; undefined when it is not usable. */
function answerAnnouncement(
  answer: unknown,
  now: number,
  kind: AnnouncementKind,
  areaId: string,
  seq: number,
): Announcement | undefined {
  if (!isRecord(answer)) return undefined;
  const body = typeof answer.text === "string" ? answer.text.trim() : "";
  if (body.length === 0) return undefined;
  const announcement: Announcement = {
    id: `pa${seq}`,
    at: now,
    kind,
    text: body,
    areaId,
  };
  if (isRecord(answer.effect)) {
    announcement.effect = answer.effect as NonNullable<Announcement["effect"]>;
  }
  return announcement;
}

/** World state an announcement asserts; applied only when it names a real room. */
function applyEffect(
  g: Game,
  escape: EscapeState,
  rooms: readonly RoomRef[],
  effect: Announcement["effect"],
): void {
  if (!effect || effect.kind === "none") return;
  if (effect.kind === "power") {
    const floor = floorOfRoom(rooms, effect.roomId);
    if (floor === undefined) return;
    escape.roomPower[roomPowerKey(g, floor, bareRoomId(effect.roomId, floor))] =
      effect.power;
    return;
  }
  if (effect.kind === "lockdown") {
    const floor = floorOfRoom(rooms, effect.roomId);
    if (floor === undefined) return;
    const target = rooms.find(
      (room) => room.id === effect.roomId && room.centre,
    );
    const floorPlan = g.floors[floor];
    if (!target?.centre || !floorPlan) return;
    const door = nearestDoor(floorPlan, target.centre);
    if (!door) return;
    latchDoor(g, door);
    lockDoor(door, 1, "pa", g.time);
    return;
  }
  logEvent(escape.log, {
    at: g.time,
    kind: "evacuation",
    areaId: escape.areas.current,
    text: "Evacuation ordered over the public address system.",
  });
}

function nearestDoor(
  floor: Floor,
  at: { x: number; y: number },
): Furniture | undefined {
  let best: Furniture | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const object of floor.furniture) {
    if (object.kind !== "door" || object.destroyed) continue;
    const d = Math.hypot(object.x - at.x, object.y - at.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = object;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Intent prediction                                                   */
/* ------------------------------------------------------------------ */

function frameIntent(g: Game, escape: EscapeState): void {
  const state = intentState(g);
  if (state.pending) return;
  if (!state.armed && g.time < state.next) return;
  state.next = g.time + INTENT_INTERVAL;
  if (state.armed) state.next = g.time + INTENT_INTERVAL;
  state.armed = false;
  const areaIds = Object.values(escape.areas.areas)
    .filter((stub) => stub.state !== "ready")
    .map((stub) => stub.id);
  if (areaIds.length === 0) return;
  state.pending = true;
  const payload = {
    requestId: `intent-${g.id}-${Math.floor(g.time)}`,
    journal: journalLines(escape.ledger).slice(-JOURNAL_WINDOW),
    floor: currentFloor(g),
    recentEngagements: [...(engagementLabels.get(g) ?? [])],
    areaIds,
  };
  ask("escape-intent", payload, (answer) => {
    try {
      applyIntent(g, areaIds, answer);
    } finally {
      state.pending = false;
    }
  });
}

/** Prefetch the most confident goal, when it reaches the confidence floor. */
function applyIntent(
  g: Game,
  areaIds: readonly string[],
  answer: unknown,
): void {
  if (!isRecord(answer) || !Array.isArray(answer.goals)) return;
  let best: { areaId: string; confidence: number } | undefined;
  for (const raw of answer.goals) {
    if (!isRecord(raw)) continue;
    const areaId = text(raw.areaId);
    const confidence =
      typeof raw.confidence === "number" && Number.isFinite(raw.confidence)
        ? raw.confidence
        : 0;
    if (!areaId || !areaIds.includes(areaId) || confidence < 0.5) continue;
    if (!best || confidence > best.confidence) best = { areaId, confidence };
  }
  if (best) prefetchArea(g, best.areaId);
}

/* ------------------------------------------------------------------ */
/* Frame entry point                                                   */
/* ------------------------------------------------------------------ */

/** Once per frame: PA schedule, announcement effects and intent prediction. */
export function escapeFrame(g: Game, dt: number): void {
  void dt;
  const escape = g.escape;
  if (!escape) return;
  try {
    framePa(g, escape, escape.catastrophe);
  } catch {
    // A bad answer or missing world data never breaks the frame.
  }
  try {
    frameIntent(g, escape);
  } catch {
    // Prediction is optional; the deterministic fallbacks stay in charge.
  }
}

/* ------------------------------------------------------------------ */
/* Engagement                                                          */
/* ------------------------------------------------------------------ */

/** Objects and documents: the director always consumes the interaction. */
export function escapeInteract(g: Game, engagement: Engagement): boolean {
  const escape = g.escape;
  if (!escape) return false;
  // Nothing is entered through an object any more: F tries, uses or reads it.
  requestEngagement(g, escape, engagement);
  return true;
}

/**
 * Read a document, sign or screen in front of the player. Same engagement
 * path as an attempt, with kind 'read', the readable text in the payload and
 * facts learned `via: "document"`.
 */
export function escapeRead(g: Game, readable: Readable): boolean {
  const escape = g.escape;
  if (!escape || !readable) return false;
  const engagement: Engagement = {
    kind: "read",
    subjectId: readable.id,
    label: readable.label,
  };
  requestEngagement(g, escape, engagement, readable);
  return true;
}

function requestEngagement(
  g: Game,
  escape: EscapeState,
  engagement: Engagement,
  reading?: Readable,
): void {
  markEngagement(g, engagement.label);
  g.notice = `You look over the ${engagement.label}…`;
  const payload = {
    requestId: `engage-${g.id}-${escape.ledger.seq + 1}`,
    setting: escape.persona,
    engagement: reading ? { ...engagement, text: reading.text } : engagement,
    knownFacts: journalLines(escape.ledger).slice(-JOURNAL_WINDOW),
    area: areaName(escape),
  };
  const fallback = () => {
    if (reading) applyOfflineRead(g, escape, reading);
    else applyOfflineObservation(g, escape, engagement);
  };
  ask("escape-engage", payload, (answer) => {
    try {
      const committed = applyEngagement(
        g,
        escape,
        engagement,
        answer,
        reading ? "document" : "attempt",
      );
      // A read always leaves a journal line: even a usable answer that
      // committed nothing falls back to the page's own text.
      if (committed === false || (reading && committed === 0)) fallback();
    } catch {
      try {
        fallback();
      } catch {
        // The ledger rejected even the fallback: the fresh intent pass still runs.
      }
    }
    intentState(g).armed = true;
  });
}

/** Commit and learn one durable fact discovered by an engagement. */
function commitEngagementFact(
  g: Game,
  escape: EscapeState,
  raw: Record<string, unknown>,
  engagement: Engagement,
  via: "attempt" | "document" = "attempt",
): ReturnType<typeof commitFact> | undefined {
  const body = text(raw.text);
  if (!body) return undefined;
  const subject = isRecord(raw.subject)
    ? {
        kind: text(raw.subject.kind),
        id: text(raw.subject.id),
      }
    : undefined;
  const visibility = Array.isArray(raw.visibility)
    ? raw.visibility.filter(
        (entry): entry is FactVisibility =>
          typeof entry === "string" && entry.length > 0,
      )
    : [];
  const input: FactInput = {
    text: body,
    subject:
      subject && subject.id && subject.kind
        ? {
            kind: subject.kind as FactInput["subject"]["kind"],
            id: subject.id,
          }
        : { kind: "object", id: engagement.subjectId },
    source: "director",
    visibility: visibility.length > 0 ? visibility : ["public"],
    loop: escape.loop,
    durable: true,
  };
  const fact = commitFact(escape.ledger, input, g.time);
  learn(
    escape.ledger,
    fact.id,
    fact.text.length > LEARNED_LINE
      ? fact.text.slice(0, LEARNED_LINE)
      : fact.text,
    via,
    g.time,
  );
  return fact;
}

/** Apply an engagement answer. Returns the number of committed facts, or
 * false when the answer was unusable. */
function applyEngagement(
  g: Game,
  escape: EscapeState,
  engagement: Engagement,
  answer: unknown,
  via: "attempt" | "document" = "attempt",
): number | false {
  if (!isRecord(answer)) return false;
  const facts = Array.isArray(answer.facts) ? answer.facts : [];
  const committed: string[] = [];
  for (const raw of facts) {
    if (!isRecord(raw)) continue;
    try {
      const fact = commitEngagementFact(g, escape, raw, engagement, via);
      if (fact) committed.push(fact.id);
    } catch {
      // One unreadable fact never costs the rest of the answer.
    }
  }
  const reply = text(answer.reply);
  if (reply) g.notice = reply;
  if (isRecord(answer.task)) {
    try {
      createEngagementTask(g, escape, engagement, answer.task, committed);
    } catch {
      // An invalid task answer is dropped; the facts stay committed.
    }
  }
  if (isRecord(answer.area)) {
    try {
      registerEngagementArea(g, escape, engagement, answer.area);
    } catch {
      // An invalid area answer is dropped.
    }
  }
  return committed.length;
}

function createEngagementTask(
  g: Game,
  escape: EscapeState,
  engagement: Engagement,
  task: Record<string, unknown>,
  fromFacts: readonly string[],
): void {
  const stationId = ensureTaskStation(g, engagement.subjectId);
  const created: EscapeTask = createTask(
    {
      title: typeof task.title === "string" ? task.title : "",
      unit: typeof task.unit === "string" ? task.unit : "",
      steps: typeof task.steps === "number" ? task.steps : 1,
      objectId: engagement.subjectId,
      areaId: escape.areas.current,
      fromFacts: [...fromFacts],
    },
    `t${escape.tasks.length + 1}`,
  );
  if (stationId !== undefined) created.stationId = stationId;
  escape.tasks.push(created);
}

const TRANSITIONS: readonly AreaPortal["transition"][] = [
  "airlock",
  "hatch",
  "lift",
  "vehicle",
  "door",
  "walk",
];

/** A site's plot, matching the 44 x 34 stamp footprint. */
const SITE_WIDTH = 44;
const SITE_GAP = 12;

/**
 * The plot of the next near place: east of every stamped building and of the
 * sites already registered but not yet stamped, so planned plots never overlap.
 */
function nextSitePlot(g: Game, escape: EscapeState): { x: number; y: number } {
  let x = nextSiteOrigin(g).x;
  for (const stub of Object.values(escape.areas.areas)) {
    if (stub.kind !== "site" || !stub.origin || stub.stamped) continue;
    x = Math.max(x, stub.origin.x + SITE_WIDTH + SITE_GAP);
  }
  return { x, y: 0 };
}

function registerEngagementArea(
  g: Game,
  escape: EscapeState,
  engagement: Engagement,
  area: Record<string, unknown>,
): void {
  const name = text(area.name);
  if (!name) return;
  let n = Object.keys(escape.areas.areas).length + 1;
  while (escape.areas.areas[`a${n}`]) n += 1;
  const id = `a${n}`;
  const stub: AreaStub = {
    id,
    name,
    brief: text(area.brief) || name,
    state: "stub",
    seed: (g.seed * 31 + n) >>> 0,
    exit: area.exit === true,
  };
  const objectId = text(area.objectId) || engagement.subjectId;
  if (area.distance === "far") {
    // A far place is a region: it is reached by travelling to the world edge.
    stub.kind = "region";
    const transition = TRANSITIONS.includes(
      area.transition as AreaPortal["transition"],
    )
      ? (area.transition as AreaPortal["transition"])
      : "walk";
    const crossing: AreaPortal = {
      id: `p${n}`,
      from: escape.areas.current,
      to: id,
      transition,
      at: regionEdgePoint(g),
      label: name,
    };
    if (objectId) crossing.objectId = objectId;
    registerArea(g, stub, crossing);
    return;
  }
  // A near place is a building beside this one: there is nothing to enter.
  stub.kind = "site";
  stub.origin = nextSitePlot(g, escape);
  registerArea(g, stub);
}

/** Offline/failure fallback: the object is ordinary and the player learns it. */
function applyOfflineObservation(
  g: Game,
  escape: EscapeState,
  engagement: Engagement,
): void {
  const subjectId = engagement.subjectId;
  const fact = commitFact(
    escape.ledger,
    {
      text: `${engagement.label} looks ordinary.`,
      subject: { kind: "object", id: subjectId },
      source: "observation",
      visibility: ["public"],
      durable: true,
    },
    g.time,
  );
  learn(escape.ledger, fact.id, fact.text, "observation", g.time);
}

/**
 * Offline/failure fallback for a read: the page's own text becomes a durable
 * public fact and is learned, so the journal always records what was read.
 */
function applyOfflineRead(
  g: Game,
  escape: EscapeState,
  readable: Readable,
): void {
  const label = text(readable.label) || "writing";
  const body = text(readable.text).slice(0, 200);
  const line = `${label}: ${body}`.trim().slice(0, 280);
  const fact = commitFact(
    escape.ledger,
    {
      text: line,
      subject: { kind: "object", id: text(readable.id) || label },
      source: "observation",
      visibility: ["public"],
      durable: true,
    },
    g.time,
  );
  learn(
    escape.ledger,
    fact.id,
    fact.text.length > LEARNED_LINE
      ? fact.text.slice(0, LEARNED_LINE)
      : fact.text,
    "document",
    g.time,
  );
}

/* ------------------------------------------------------------------ */
/* Task stations                                                       */
/* ------------------------------------------------------------------ */

/** The station that serves `objectId`, creating one next to it when needed. */
export function ensureTaskStation(
  g: Game,
  objectId: string,
): string | undefined {
  const found = findFurniture(g, objectId);
  if (!found) return undefined;
  const { floor, object } = found;
  for (const station of floor.stations) {
    if (Math.hypot(station.x - object.x, station.y - object.y) <= STATION_REACH)
      return station.id;
  }
  const template =
    floor.stations[0] ?? g.floors.flatMap((plan) => plan.stations)[0];
  if (!template) return undefined;
  const original = Object.values(g.encounters).find(
    (encounter) => encounter.state !== "consumed",
  );
  const fallback = original ?? Object.values(g.encounters)[0];
  if (!fallback) return undefined;
  const encounterId = `${objectId}-task`;
  const spot = stationSpot(floor, object);
  const station: Station = {
    ...structuredClone(template),
    id: `${objectId}-task`,
    encounter: encounterId,
    x: spot.x,
    y: spot.y,
  };
  delete station.facing;
  const encounter: Encounter = {
    ...structuredClone(fallback),
    id: encounterId,
    floor: object.floor,
    mode: "solo",
    reward: "stairs",
    loot: [],
    state: original ? original.state : "available",
    history: [],
    group: [],
    tutor: [],
    submissions: [],
    contributors: [],
    chatCursor: 0,
    chatOpen: false,
    recentSpeakers: [],
    npcProgress: 0,
    scroll: 0,
    selection: [0, 0],
    revision: 0,
  };
  delete encounter.thread;
  delete encounter.problem;
  delete encounter.accepted;
  delete encounter.directStudy;
  delete encounter.owner;
  delete encounter.studyTurnRecorded;
  floor.stations.push(station);
  g.encounters[encounterId] = encounter;
  return station.id;
}

/** A free point 0.9 tiles from the object; falls back to its east side. */
function stationSpot(
  floor: Floor,
  object: Furniture,
): { x: number; y: number } {
  const offsets = [
    { x: 0.9, y: 0 },
    { x: -0.9, y: 0 },
    { x: 0, y: 0.9 },
    { x: 0, y: -0.9 },
    { x: 0.64, y: 0.64 },
    { x: -0.64, y: 0.64 },
    { x: 0.64, y: -0.64 },
    { x: -0.64, y: -0.64 },
  ];
  for (const offset of offsets) {
    const point = { x: object.x + offset.x, y: object.y + offset.y };
    if (isFreePoint(floor, point)) return point;
  }
  return { x: object.x + 0.9, y: object.y };
}

function isFreePoint(floor: Floor, point: { x: number; y: number }): boolean {
  const tx = Math.floor(point.x);
  const ty = Math.floor(point.y);
  const row = floor.tiles[ty];
  if (!row || row[tx] !== 0) return false;
  for (const object of floor.furniture) {
    if (object.destroyed) continue;
    if (
      Math.abs(point.x - object.x) < object.w / 2 + 0.25 &&
      Math.abs(point.y - object.y) < object.h / 2 + 0.25
    )
      return false;
  }
  for (const station of floor.stations) {
    if (Math.hypot(station.x - point.x, station.y - point.y) < 0.6)
      return false;
  }
  return true;
}

/** The task worked at a station, if the director created one there. */
export function taskForStation(
  g: Game,
  stationId: string,
): EscapeTask | undefined {
  return g.escape?.tasks.find((task) => task.stationId === stationId);
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

/** Journal lines, newest last, with every open task appended. */
export function escapeJournal(g: Game): string[] {
  const escape = g.escape;
  if (!escape) return [];
  const lines = journalLines(escape.ledger);
  for (const task of escape.tasks) {
    if (task.state === "available" || task.state === "in-progress")
      lines.push(`Task: ${taskIndicator(task)}`);
  }
  return lines;
}
