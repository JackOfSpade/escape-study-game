import { soundConnectivity } from "./acoustics";
import { canReachStation } from "./engine";
import { floorSectors, inRect } from "./floor-plan";
import { fieldAllows, fieldBetween } from "./force-fields";
import {
  type Actor,
  type Encounter,
  type Floor,
  type Game,
  type Point,
  CONFIG,
  distance,
  furnitureName,
} from "./model";
import { npcProfile } from "./npc-cognition";
import { npcCanHearSpeech } from "./npc-hearing";
import { isOpenSite } from "./open-site";
import { rememberedThreats, THREAT_MEMORY } from "./npc-threat-memory";
import {
  buildInteriorLighting,
  lightAt,
  type InteriorLighting,
} from "./interior-lighting";
import { isRecord } from "./records";
import { canSee, sightRadius } from "./visibility";
import { observableSceneDetails } from "./scene-observations";
import { NPC_DIALOGUE_GENERATION_INSTRUCTION } from "../scripts/lib/npc-dialogue-policy.mjs";

export const NPC_CHATTER_RANGE = 10;
export const NPC_CHATTER_CONTEXT_SECONDS = 120;
export type NpcChatterDelivery = "calm" | "urgent" | "whisper" | "relieved";
export type NpcChatterThreatBand =
  "clear" | "watchful" | "nearby" | "immediate";
type HealthBand = "healthy" | "hurt" | "critical";
export interface NpcChatterRecentLine {
  /** Identity of the exact utterance that actually started playing. */
  id?: string;
  actorId: string;
  speakerName?: string;
  text: string;
  at: number;
  delivery?: NpcChatterDelivery;
  conversationId?: string;
  turn?: number;
  /** Recorded recipients at playback, never inferred from later positions. */
  heardBy?: string[];
  /** Local repetition key; it is never included in an AI packet. */
  contextKey?: string;
}
export interface NpcChatterConversation {
  id: string;
  replyTo: string;
  sourceActorId: string;
  turn: number;
  maxTurns: number;
  expiresAt: number;
  heard?: {
    addressed: "self" | "other" | "none";
    act: import("./npc-reply-chance").NpcSpeechAct;
    distance: number;
  };
}
export interface NpcChatterConversationIntent {
  intent: "invite" | "continue" | "close";
  replyTo?: string;
}

/** Current speech uses its immutable utterance ID. Historical receipts without
 * one retain their actor/tick identity for compatibility. */
export function npcSpeechFactId(line: NpcChatterRecentLine) {
  return `speech:${line.id ?? `${line.actorId}:${Math.round(line.at * 30)}`}`;
}
export interface NpcDialogueFact {
  id: string;
  kind:
    | "setting"
    | "self"
    | "place"
    | "light"
    | "person"
    | "threat"
    | "memory"
    | "object"
    | "event"
    | "task";
  text: string;
  key: string;
  expiresAt?: number;
}
interface RelativePosition {
  distance: number;
  dx: number;
  dy: number;
}
interface ChatterTask {
  encounterId: string;
  stationId: string;
  mode: Encounter["mode"];
  state: Encounter["state"];
  sourceRevision: number;
  milestone: number;
  problem?: {
    id: string;
    title: string;
    prompt: string;
    depth: number;
    track: string;
    objectives: string[];
    rubric: string[];
  };
  workspace: string;
  ownWork: {
    id: string;
    stage: string;
    focus: string;
    at: number;
    validated: false;
    execution: "not-run";
  }[];
  ownPublicNotes: { kind: string; text: string; at: number }[];
  publicTeamMessages: { author: string; text: string }[];
}
export interface NpcChatterRequest {
  version: 1;
  requestId: string;
  runId: string;
  actorId: string;
  capturedAt: number;
  setting: string;
  self: {
    id: string;
    name: string;
    role: string;
    activity: NonNullable<Actor["activity"]>;
    intent?: string;
    station?: string;
    healthBand: HealthBand;
    hp: number;
    keys: number;
    personalStairAccess: boolean;
    personality: {
      risk: number;
      social: number;
      confidence: number;
      strengths: ReturnType<typeof npcProfile>["strengths"];
      topics: Record<string, number>;
    };
    inventory: { kind: string; charges?: number }[];
    facing?: Point;
    goal?: Point;
  };
  location: {
    floor: number;
    name: string;
    position: Point;
    sector?: string;
    room?: string;
    roomId?: string;
  };
  task?: ChatterTask;
  perception: {
    threatBand: NpcChatterThreatBand;
    people: {
      id: string;
      name: string;
      activity: string;
      healthBand: HealthBand;
      position: RelativePosition;
    }[];
    visibleThreats: {
      id: string;
      position: RelativePosition;
      behindForceField: boolean;
    }[];
    rememberedThreats: {
      id: string;
      lastSeenAt: number;
      secondsAgo: number;
      position: RelativePosition;
    }[];
    objects: {
      id: string;
      kind: string;
      healthBand: HealthBand;
      position: RelativePosition;
      destroyed: boolean;
      door?: "latched" | "released";
      personalFieldAccess?: boolean;
    }[];
    knownStations: {
      id: string;
      visibleNow: boolean;
      position: RelativePosition;
    }[];
    recentEvents: {
      seq: number;
      at: number;
      kind: string;
      secondsAgo: number;
      source: "self" | "heard";
      position?: RelativePosition;
    }[];
  };
  recentLines: NpcChatterRecentLine[];
  conversation?: NpcChatterConversation;
  dialogue?: {
    version: 1;
    facts: NpcDialogueFact[];
    feedback?: { previousText: string; issues: string[]; note: string };
  };
  instruction: string;
}
export interface NpcChatterReply {
  requestId: string;
  actorId: string;
  text: string;
  delivery?: NpcChatterDelivery;
  conversation?: NpcChatterConversationIntent;
}

const bounded = (text: string, length: number) => text.slice(0, length);
/** What the survivors are climbing: the authored venue and building name when
 * the run has a setting, otherwise the historical office building. */
function buildingPhrase(g: Game) {
  const floor = g.floors[0];
  const name = floor?.exteriorDesign?.buildingName;
  if (floor?.setting?.venue === "custom")
    return name ? `a building called ${bounded(name, 60)}` : "a building";
  if (floor?.setting?.venue !== "broadcast") return "an office building";
  return `a broadcast station${name ? ` (${bounded(name, 60)})` : ""}`;
}
/** Open ground has no rooftop: name the place the crew gathers on instead of a
 * building they would climb. */
function openGroundPhrase(g: Game) {
  const floor = g.floors[0];
  const name = floor?.exteriorDesign?.buildingName;
  return floor?.setting?.venue === "custom" && name
    ? `the open ground at ${bounded(name, 60)}`
    : "the open ground";
}
const round = (n: number) => Math.round(n * 10) / 10;
const health = (ratio: number): HealthBand =>
  ratio <= 0.3 ? "critical" : ratio < 0.75 ? "hurt" : "healthy";
const activity = (a: Actor) => a.activity ?? "exploring";
function relative(a: Point, b: Point): RelativePosition {
  return {
    distance: round(distance(a, b)),
    dx: round(b.x - a.x),
    dy: round(b.y - a.y),
  };
}
function place(floor: Floor, a: Point) {
  const sector = floorSectors(floor).find((s) =>
      s.blocks.some((r) => inRect(r, Math.floor(a.x), Math.floor(a.y))),
    ),
    room = sector?.rooms.find((r) =>
      inRect(r.rect, Math.floor(a.x), Math.floor(a.y)),
    );
  return {
    ...(sector ? { sector: sector.id } : {}),
    ...(room ? { room: room.kind, roomId: room.id } : {}),
  };
}
function carriedItems(a: Actor): NpcChatterRequest["self"]["inventory"] {
  return a.inventory.slice(0, 8).map((i) => ({
    kind: i.kind,
    ...(i.charges === undefined ? {} : { charges: i.charges }),
  }));
}
function inventoryKey(items: NpcChatterRequest["self"]["inventory"]) {
  return items
    .map((i) => JSON.stringify([i.kind, i.charges ?? null]))
    .sort()
    .join("|");
}
function active(g: Game) {
  const h = g.survivors[0];
  return (
    g.status === "playing" &&
    !g.paused &&
    !g.studyWorkspace?.enabled &&
    !!h &&
    h.alive &&
    !h.escaped &&
    !h.stairTravel
  );
}

/** A nearby person can be selected only through the listener's real sight or
 * an open acoustic path. This never searches other floors or hidden minds. */
export function npcChatterCandidates(g: Game): Actor[] {
  if (!active(g)) return [];
  const h = g.survivors[0],
    f = g.floors[h.floor];
  if (!f) return [];
  const nearby = g.survivors.filter(
    (a) =>
      a !== h &&
      a.id !== "human" &&
      a.alive &&
      !a.escaped &&
      !a.stairTravel &&
      a.floor === h.floor &&
      distance(h, a) <= NPC_CHATTER_RANGE,
  );
  if (!nearby.length) return [];
  const connected = soundConnectivity(f);
  return nearby
    .filter(
      (a) =>
        canSee(f, h, a, Math.min(NPC_CHATTER_RANGE, sightRadius(f))) ||
        connected(h, a),
    )
    .sort(
      (a, b) => distance(h, a) - distance(h, b) || a.id.localeCompare(b.id),
    );
}

const utteranceId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,120}$/.test(value);

/** A turn is an opportunity to answer one specific heard utterance. The
 * captured request no longer exposes recipient metadata, so rechecks trust
 * its original receipt while still requiring a live acoustic conversation. */
function conversationSource(
  g: Game,
  a: Actor,
  conversation: NpcChatterConversation,
  recentLines: readonly NpcChatterRecentLine[],
  requireReceipt: boolean,
  completingPlayback = false,
) {
  if (
    !utteranceId(conversation.id) ||
    !utteranceId(conversation.replyTo) ||
    !utteranceId(conversation.sourceActorId) ||
    conversation.sourceActorId === "human" ||
    conversation.sourceActorId === a.id ||
    !Number.isInteger(conversation.turn) ||
    conversation.turn < 2 ||
    conversation.turn > 4 ||
    conversation.maxTurns !== 4 ||
    (conversation.heard !== undefined &&
      (!isRecord(conversation.heard) ||
        Object.keys(conversation.heard).some(
          (key) => !["addressed", "act", "distance"].includes(key),
        ) ||
        !["self", "other", "none"].includes(conversation.heard.addressed) ||
        !["question", "request", "warning", "statement"].includes(
          conversation.heard.act,
        ) ||
        !Number.isFinite(conversation.heard.distance) ||
        conversation.heard.distance < 0 ||
        conversation.heard.distance > 20)) ||
    !Number.isFinite(conversation.expiresAt) ||
    (!completingPlayback && g.time >= conversation.expiresAt) ||
    a.stairTravel
  )
    return;
  const line = recentLines.find(
    (line) =>
      line.id === conversation.replyTo &&
      line.actorId === conversation.sourceActorId &&
      line.conversationId === conversation.id &&
      line.turn === conversation.turn - 1 &&
      line.at <= g.time &&
      g.time - line.at < 90 &&
      conversation.expiresAt <= line.at + 90 &&
      (!requireReceipt || line.heardBy?.includes(a.id)),
  );
  if (!line) return;
  const source = g.survivors.find(
    (source) => source.id === conversation.sourceActorId,
  );
  return source &&
    source !== g.survivors[0] &&
    npcCanHearSpeech(g, a, source, line.delivery)
    ? line
    : undefined;
}

function localThreats(g: Game, a: Actor) {
  const f = g.floors[a.floor],
    range = Math.min(9, sightRadius(f));
  const visible = g.zombies
    .filter((z) => z.hp > 0 && z.floor === a.floor && canSee(f, a, z, range))
    .sort((b, c) => distance(a, b) - distance(a, c))
    .slice(0, 6)
    .map((z) => ({
      id: z.id,
      position: relative(a, z),
      behindForceField: fieldBetween(f, a, z),
    }));
  const seen = new Set(visible.map((z) => z.id));
  // Do not look up a remembered zombie: hidden movement and hidden deaths do
  // not update an NPC's copied last sighting.
  const remembered = rememberedThreats(g, a)
    .filter((p) => !seen.has(p.id))
    .slice(0, 8)
    .map((p) => ({
      id: p.id,
      lastSeenAt: p.at,
      secondsAgo: round(g.time - p.at),
      position: relative(a, p),
    }));
  const exposed = visible.filter((z) => !z.behindForceField);
  const band: NpcChatterThreatBand = exposed.some(
    (z) => z.position.distance <= 3.5,
  )
    ? "immediate"
    : exposed.length
      ? "nearby"
      : visible.length || remembered.length
        ? "watchful"
        : "clear";
  return { band, visible, remembered };
}

function currentTask(g: Game, a: Actor): ChatterTask | undefined {
  const f = g.floors[a.floor],
    station = f.stations.find((s) => s.id === a.station),
    e = station && g.encounters[station.encounter];
  if (
    !station ||
    !e ||
    e.id !== a.intent ||
    e.floor !== a.floor ||
    (e.runId !== undefined && e.runId !== g.id) ||
    activity(a) !== "studying" ||
    (e.mode === "solo" && e.owner !== a.id) ||
    !canReachStation(g, a, station)
  )
    return;
  const privateSequences = new Set(e.tutor.map((m) => m.seq));
  return {
    encounterId: e.id,
    stationId: station.id,
    mode: e.mode,
    state: e.state,
    sourceRevision: e.revision,
    milestone: a.milestone,
    ...(e.problem
      ? {
          problem: {
            id: e.problem.contract.id,
            title: bounded(e.problem.title, 140),
            prompt: bounded(e.problem.prompt, 1800),
            depth: e.problem.contract.depth,
            track: e.problem.contract.track,
            objectives: e.problem.contract.objectiveIds.slice(0, 8),
            rubric: e.problem.rubric.slice(0, 6).map((r) => bounded(r, 220)),
          },
        }
      : {}),
    workspace: bounded(e.workspace, 1800),
    ownWork: (e.npcWork ?? [])
      .filter((w) => w.actor === a.id && w.at <= g.time)
      .slice(-4)
      .map((w) => ({
        id: w.id,
        stage: w.stage,
        focus: w.focus,
        at: w.at,
        validated: false,
        execution: "not-run",
      })),
    ownPublicNotes: e.history
      .filter(
        (h) =>
          h.author === a.id &&
          h.at <= g.time &&
          !privateSequences.has(h.seq) &&
          ["npc-thought", "npc-proposal", "defense"].includes(h.kind),
      )
      .slice(-3)
      .map((h) => ({ kind: h.kind, text: bounded(h.text, 600), at: h.at })),
    publicTeamMessages:
      e.mode === "shared"
        ? e.group
            .filter(
              (m) =>
                ["human", "npc"].includes(m.kind) &&
                m.worldTime <= g.time &&
                !privateSequences.has(m.seq),
            )
            .slice(-4)
            .map((m) => ({ author: m.author, text: bounded(m.text, 500) }))
        : [],
  };
}

const ownEvents = new Set([
  "survivor-hit",
  "survivor-stairs",
  "climb",
  "vault",
  "door",
  "field-key",
  "item",
  "loot",
]);
const audibleEvents = new Set([
  "breach",
  "barricade-hit",
  "survivor-hit",
  "entrance-close",
  "helicopter",
]);

const lightingPlans = new WeakMap<
  Floor,
  {
    seed: number;
    dark: number;
    tiles: Floor["tiles"];
    generation: Floor["generation"];
    plan: InteriorLighting;
  }
>();
function lightingObservation(g: Game, a: Actor) {
  const floor = g.floors[a.floor],
    b = floor.boundary,
    row = b?.rows[Math.floor(a.y)],
    outside =
      b &&
      (!row ||
        a.y < b.top ||
        a.y >= b.bottom ||
        a.x < row.left ||
        a.x >= row.right);
  // An open site has no ceilings to light: its ground layer is outdoors too.
  if (outside || floor.open === true || floor.index >= CONFIG.floors)
    return {
      key: "exterior",
      text: "You are outside the building's ceiling-light circuits.",
    };
  let cached = lightingPlans.get(floor);
  if (
    !cached ||
    cached.seed !== g.seed ||
    cached.dark !== floor.dark ||
    cached.tiles !== floor.tiles ||
    cached.generation !== floor.generation
  ) {
    cached = {
      seed: g.seed,
      dark: floor.dark,
      tiles: floor.tiles,
      generation: floor.generation,
      plan: buildInteriorLighting(floor, g.seed),
    };
    lightingPlans.set(floor, cached);
  }
  const level = lightAt(cached.plan, a);
  return level < 0.2
    ? {
        key: "outage",
        text: "The ceiling lights in your current area are out.",
      }
    : level < 0.5
      ? {
          key: "dim",
          text: "The ceiling lighting in your current area is dim.",
        }
      : {
          key: "lit",
          text: "Working ceiling lights illuminate your current area.",
        };
}

/** Keys describe observable status, not time passing or hidden engine state.
 * Large owned workspaces are fingerprinted without truncating their content. */
function factKey(value: unknown) {
  const text = JSON.stringify(value) ?? "null";
  if (text.length <= 512) return text;
  let first = 2166136261,
    second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    first = Math.imul(first ^ text.charCodeAt(i), 16777619);
    second = Math.imul(second ^ text.charCodeAt(i), 0x85ebca6b);
  }
  return `${text.length}/${(first >>> 0).toString(16)}/${(second >>> 0).toString(16)}`;
}
function proximity(position: RelativePosition) {
  return position.distance <= 2
    ? "very close"
    : position.distance <= 4
      ? "close"
      : "nearby";
}
function woundDescription(band: HealthBand) {
  return band === "critical"
    ? "badly hurt"
    : band === "hurt"
      ? "hurt"
      : "not visibly hurt";
}
const COMPASS = [
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
  "north",
  "northeast",
];
const RELATIVE_BEARING = [
  "ahead of you",
  "ahead and to your right",
  "to your right",
  "behind and to your right",
  "behind you",
  "behind and to your left",
  "to your left",
  "ahead and to your left",
];
function octant(angle: number) {
  return ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8;
}
function facingDirection(facing: Point) {
  return Math.hypot(facing.x, facing.y) > 1e-6
    ? COMPASS[octant(Math.atan2(facing.y, facing.x))]
    : "unknown";
}
function bearing(position: RelativePosition, facing: Point) {
  if (Math.hypot(position.dx, position.dy) < 0.15)
    return { key: "same-position", text: "at your position" };
  const angle = Math.atan2(position.dy, position.dx),
    world = COMPASS[octant(angle)];
  if (facingDirection(facing) === "unknown")
    return { key: `${world}/unknown-facing`, text: `toward the ${world}` };
  const relative =
    RELATIVE_BEARING[octant(angle - Math.atan2(facing.y, facing.x))];
  return { key: `${world}/${relative}`, text: `${relative} (${world})` };
}

function dialogueFacts(
  g: Game,
  a: Actor,
  request: NpcChatterRequest,
): NpcDialogueFact[] {
  const facts: NpcDialogueFact[] = [],
    add = (
      id: string,
      kind: NpcDialogueFact["kind"],
      text: string,
      key: unknown,
      expiresAt?: number,
    ) => {
      if (
        facts.length >= 40 ||
        facts.some((fact) => fact.id === id) ||
        (expiresAt !== undefined && expiresAt <= request.capturedAt)
      )
        return;
      facts.push({
        id,
        kind,
        text: bounded(
          text
            .normalize("NFC")
            .replace(/[\u0000-\u001f\u007f]/g, " ")
            .replace(/\s+/g, " ")
            .trim(),
          180,
        ),
        key: factKey(key),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    },
    self = request.self,
    f = g.floors[a.floor],
    light = lightingObservation(g, a),
    facing = self.facing ?? { x: 0, y: 0 },
    direction = facingDirection(facing);
  add(
    "setting.outbreak",
    "setting",
    request.setting,
    "outbreak-rooftop-evacuation-v1",
  );
  // The accepted run design is real shared history for this crew, so it is
  // grounded knowledge rather than something the speaker has to invent.
  const design = g.design?.design;
  if (design) {
    const { title, premise } = design;
    if (title && premise)
      add("setting.premise", "setting", `This escape, "${title}": ${premise}`, [
        "premise",
        title,
        premise,
      ]);
    const relationships =
      "relationships" in design && Array.isArray(design.relationships)
        ? design.relationships
        : [];
    relationships
      .map((relationship, index) => ({ relationship, index }))
      .filter(
        ({ relationship }) =>
          relationship &&
          (relationship.from === a.name || relationship.to === a.name),
      )
      .slice(0, 3)
      .forEach(({ relationship, index }) => {
        const other =
          relationship.from === a.name ? relationship.to : relationship.from;
        if (!other || !relationship.kind || !relationship.detail) return;
        add(
          `relationship:${index}`,
          "person",
          `${other} is your ${relationship.kind}: ${relationship.detail}`,
          [
            relationship.from,
            relationship.to,
            relationship.kind,
            relationship.detail,
          ],
        );
      });
  }
  add(
    "self.health",
    "self",
    `You are ${woundDescription(self.healthBand)}.`,
    self.healthBand,
  );
  add("self.activity", "self", `Your current activity is ${self.activity}.`, [
    self.activity,
    self.intent,
    self.station,
  ]);
  add(
    "self.access",
    "self",
    `You have ${self.keys} key${self.keys === 1 ? "" : "s"}. Your personal stair access on this floor is ${self.personalStairAccess ? "granted" : "not granted"}.`,
    [self.keys, self.personalStairAccess],
  );
  add(
    "self.inventory",
    "self",
    self.inventory.length
      ? `Your carried equipment: ${self.inventory.map((i) => `${i.kind}${i.charges === undefined ? "" : ` (${i.charges} charges)`}`).join(", ")}.`
      : "You are carrying no equipment.",
    inventoryKey(self.inventory),
  );
  add(
    "location",
    "place",
    `You are on ${request.location.name}${request.location.room ? `, in a ${request.location.room}` : ""}.`,
    [
      request.location.floor,
      request.location.name,
      request.location.sector,
      request.location.room,
      request.location.roomId,
    ],
  );
  add(
    "self.facing",
    "self",
    direction === "unknown"
      ? "Your facing direction is not established."
      : `You are facing ${direction}.`,
    direction,
  );
  add("environment.light", "light", light.text, [
    request.location.floor,
    light.key,
  ]);
  if (request.task) {
    const task = request.task;
    add(
      "task.current",
      "task",
      task.state === "consumed"
        ? "The task at your current terminal has been completed. This is not evidence of learning."
        : `You are working at a ${task.mode} terminal${task.problem ? ` on ${task.problem.title}` : ""}. Your work remains tentative.`,
      task,
    );
  }
  for (const threat of request.perception.visibleThreats) {
    const direction = bearing(threat.position, facing);
    add(
      `threat:${threat.id}`,
      "threat",
      `You can see a zombie ${proximity(threat.position)}, ${direction.text}${threat.behindForceField ? ", beyond a closed door" : ", with nothing between you"}.`,
      [
        threat.id,
        proximity(threat.position),
        direction.key,
        threat.behindForceField,
      ],
    );
  }
  for (const event of request.perception.recentEvents) {
    const duration = ["survivor-hit", "barricade-hit"].includes(event.kind)
      ? 5
      : 10;
    add(
      `event:${event.seq}`,
      "event",
      event.source === "self"
        ? `You recently experienced this event yourself: ${event.kind}.`
        : `You recently heard this nearby event: ${event.kind}.`,
      [event.seq, event.kind, event.source],
      event.at + duration,
    );
  }
  for (const line of request.recentLines.filter(
    (line) => line.actorId !== a.id,
  ))
    add(
      npcSpeechFactId(line),
      "event",
      `You heard ${line.speakerName ?? "someone nearby"} ${line.delivery === "whisper" ? "whisper" : line.delivery === "urgent" ? "call out" : "say"}: ${line.text}`,
      [
        line.id,
        line.actorId,
        line.speakerName,
        line.at,
        line.text,
        line.delivery ?? "calm",
      ],
      line.at + 90,
    );
  for (const person of request.perception.people) {
    const direction = bearing(person.position, facing);
    add(
      `person:${person.id}`,
      "person",
      `You can see ${person.id === "human" ? "the player" : person.name} ${proximity(person.position)}, ${direction.text}, ${woundDescription(person.healthBand)} and ${person.activity}.`,
      [
        person.id,
        person.name,
        person.healthBand,
        person.activity,
        proximity(person.position),
        direction.key,
      ],
    );
  }
  // A visible body is knowledge; a remote roster death is not. The cause,
  // victim's private life and unseen earlier events remain unknown.
  for (const dead of g.survivors
    .filter(
      (b) =>
        b !== a &&
        !b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        canSee(f, a, b, sightRadius(f)),
    )
    .sort((b, c) => distance(a, b) - distance(a, c))
    .slice(0, 3))
    add(
      `person:${dead.id}`,
      "person",
      `You can currently see ${bounded(dead.name, 80)}'s body. They are dead; you do not know the cause from this observation alone.`,
      [dead.id, bounded(dead.name, 80), "dead", proximity(relative(a, dead))],
    );
  for (const memory of request.perception.rememberedThreats)
    add(
      `memory:${memory.id}`,
      "memory",
      `You recently saw a threat ${proximity(memory.position)}. That is a last-seen memory, not its current position.`,
      [memory.id, memory.lastSeenAt, proximity(memory.position)],
      memory.lastSeenAt + THREAT_MEMORY.seconds,
    );
  for (const object of request.perception.objects) {
    const direction = bearing(object.position, facing);
    add(
      `object:${object.id}`,
      "object",
      `You can see a ${object.kind} ${proximity(object.position)}, ${direction.text}: ${object.destroyed ? "destroyed" : object.healthBand === "critical" ? "badly damaged" : object.healthBand === "hurt" ? "damaged" : "not visibly damaged"}${object.door ? `, ${object.door}` : ""}${object.personalFieldAccess === undefined ? "" : `, personal field passage ${object.personalFieldAccess ? "allowed" : "not allowed"}`}.`,
      [
        object.kind,
        object.healthBand,
        object.destroyed,
        object.door,
        object.personalFieldAccess,
        proximity(object.position),
        direction.key,
      ],
    );
  }
  // Optional environmental reading follows immediate survival/task facts.
  for (const detail of observableSceneDetails(g, a, 3))
    add(
      detail.id,
      "object",
      `You can currently read "${detail.title}": ${detail.text}`,
      [request.location.floor, detail.title, detail.text],
    );
  // The opening scene is shared history too, but it is added last so a full
  // fact budget is spent on the immediate situation instead.
  const opening = design?.opening;
  if (opening) add("setting.opening", "setting", opening, ["opening", opening]);
  return facts;
}

/** A bounded detached snapshot of this NPC's own knowledge. It deliberately
 * has no learner ledger, private tutoring, global enemy state or future timers. */
export function buildNpcChatterContext(
  g: Game,
  a: Actor,
  requestId: string,
  recentLines: readonly NpcChatterRecentLine[] = [],
  conversation?: NpcChatterConversation,
): NpcChatterRequest {
  if (
    !g.survivors.includes(a) ||
    a === g.survivors[0] ||
    a.id === "human" ||
    !a.alive ||
    a.escaped ||
    !g.floors[a.floor]
  )
    throw Error("Chatter context requires a living survivor in this world");
  const replySource = conversation
    ? conversationSource(g, a, conversation, recentLines, true)
    : undefined;
  if (conversation && !replySource)
    throw Error("Conversation requires a current, actually heard source turn");
  const f = g.floors[a.floor],
    profile = npcProfile(a),
    range = sightRadius(f),
    threats = localThreats(g, a),
    location = place(f, a),
    connected = soundConnectivity(f),
    task = currentTask(g, a);
  const recentEvents: NpcChatterRequest["perception"]["recentEvents"] = [];
  for (const e of g.events.slice().reverse()) {
    if (e.at > g.time || g.time - e.at > 10 || e.floor !== a.floor) continue;
    if (e.actor === a.id && ownEvents.has(e.type))
      recentEvents.push({
        seq: e.seq,
        at: e.at,
        kind: e.type,
        secondsAgo: round(g.time - e.at),
        source: "self",
      });
    else if (audibleEvents.has(e.type)) {
      if (e.type === "helicopter" && !e.position)
        recentEvents.push({
          seq: e.seq,
          at: e.at,
          kind: e.type,
          secondsAgo: round(g.time - e.at),
          source: "heard",
        });
      else if (
        e.position &&
        distance(a, e.position) <= 12 &&
        connected(a, e.position)
      )
        recentEvents.push({
          seq: e.seq,
          at: e.at,
          kind: e.type,
          secondsAgo: round(g.time - e.at),
          source: "heard",
          position: relative(a, e.position),
        });
    }
    if (recentEvents.length >= 4) break;
  }
  const result: NpcChatterRequest = {
    version: 1,
    requestId,
    runId: g.id,
    actorId: a.id,
    capturedAt: g.time,
    setting: isOpenSite(g)
      ? `A zombie outbreak has overrun the surrounding city. Survivors are gathering at the ground pickup on ${openGroundPhrase(g)}.`
      : `A zombie outbreak has overrun the surrounding city. Survivors are climbing ${buildingPhrase(g)} toward rooftop extraction.`,
    self: {
      id: a.id,
      name: bounded(a.name, 80),
      role: bounded(a.role, 80),
      activity: activity(a),
      ...(a.intent ? { intent: a.intent } : {}),
      ...(a.station ? { station: a.station } : {}),
      healthBand: health(a.hp / 100),
      hp: a.hp,
      keys: a.keys ?? 0,
      personalStairAccess: a.access.includes(a.floor),
      personality: {
        risk: a.risk,
        social: a.social,
        confidence: profile.confidence,
        strengths: { ...profile.strengths },
        topics: Object.fromEntries(Object.entries(profile.topics).slice(0, 48)),
      },
      inventory: carriedItems(a),
      facing: { x: a.heading.x, y: a.heading.y },
      ...(a.fleeTarget || a.target
        ? {
            goal: {
              x: (a.fleeTarget ?? a.target!).x,
              y: (a.fleeTarget ?? a.target!).y,
            },
          }
        : {}),
    },
    location: {
      floor: a.floor,
      name: bounded(f.name, 120),
      position: { x: a.x, y: a.y },
      ...location,
    },
    ...(task ? { task } : {}),
    perception: {
      threatBand: threats.band,
      people: g.survivors
        .filter(
          (b) =>
            b !== a &&
            b.floor === a.floor &&
            b.alive &&
            !b.escaped &&
            !b.stairTravel &&
            canSee(f, a, b, range),
        )
        .sort((b, c) => distance(a, b) - distance(a, c))
        .slice(0, 6)
        .map((b) => ({
          id: b.id,
          name: bounded(b.name, 80),
          activity: activity(b),
          healthBand: health(b.hp / 100),
          position: relative(a, b),
        })),
      visibleThreats: threats.visible,
      rememberedThreats: threats.remembered,
      objects: f.furniture
        .filter((o) => canSee(f, a, o, range, o.id))
        .sort((b, c) => distance(a, b) - distance(a, c))
        .slice(0, 8)
        .map((o) => ({
          id: o.id,
          // A composed object is described by its own name, never "custom".
          kind: furnitureName(o),
          healthBand: health(o.hp / Math.max(1, o.maxHp)),
          position: relative(a, o),
          destroyed: o.destroyed,
          ...(o.door
            ? {
                door: o.door.latched
                  ? ("latched" as const)
                  : ("released" as const),
              }
            : {}),
          ...(o.field ? { personalFieldAccess: fieldAllows(o, a) } : {}),
        })),
      knownStations: f.stations
        .filter((s) => a.seen.includes(s.id) || canSee(f, a, s, range))
        .sort((b, c) => distance(a, b) - distance(a, c))
        .slice(0, 6)
        .map((s) => ({
          id: s.id,
          visibleNow: canSee(f, a, s, range),
          position: relative(a, s),
        })),
      recentEvents,
    },
    recentLines: [
      ...recentLines
        .filter(
          (line) =>
            line.actorId === a.id &&
            line.at <= g.time &&
            g.time - line.at <= 180,
        )
        .slice(-3),
      ...recentLines
        .filter(
          (line) =>
            line.actorId !== a.id &&
            line.heardBy?.includes(a.id) &&
            line.at <= g.time &&
            g.time - line.at <= 90,
        )
        .slice(-3),
      ...(replySource ? [replySource] : []),
    ]
      .filter(
        (line, index, all) =>
          all.findIndex((other) =>
            line.id !== undefined
              ? other.id === line.id
              : other.actorId === line.actorId &&
                other.at === line.at &&
                other.text === line.text,
          ) === index,
      )
      .sort((b, c) => b.at - c.at)
      .map((line) => ({
        ...(line.id ? { id: line.id } : {}),
        actorId: line.actorId,
        ...(line.speakerName
          ? { speakerName: bounded(line.speakerName, 80) }
          : {}),
        text: bounded(line.text, 180),
        at: line.at,
        ...(line.delivery === undefined ? {} : { delivery: line.delivery }),
        ...(line.conversationId ? { conversationId: line.conversationId } : {}),
        ...(line.turn === undefined ? {} : { turn: line.turn }),
      })),
    ...(conversation ? { conversation: { ...conversation } } : {}),
    instruction: NPC_DIALOGUE_GENERATION_INSTRUCTION,
  };
  result.dialogue = { version: 1, facts: dialogueFacts(g, a, result) };
  return structuredClone(result);
}

export function parseNpcChatterReply(
  request: NpcChatterRequest,
  value: unknown,
): NpcChatterReply {
  if (
    !isRecord(value) ||
    value.requestId !== request.requestId ||
    value.actorId !== request.actorId ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    value.text.length > 180 ||
    /[\u0000-\u001f\u007f<>]|\[\[|\]\]|```|https?:\/\/|file:|data:|www\./i.test(
      value.text,
    ) ||
    (value.delivery !== undefined &&
      (typeof value.delivery !== "string" ||
        !["calm", "urgent", "whisper", "relieved"].includes(value.delivery))) ||
    Object.keys(value).some(
      (k) => !["requestId", "actorId", "text", "delivery"].includes(k),
    )
  )
    throw Error("Malformed or mismatched NPC chatter reply");
  return {
    requestId: request.requestId,
    actorId: request.actorId,
    text: value.text.normalize("NFC").replace(/\s+/g, " ").trim(),
    ...(value.delivery === undefined
      ? {}
      : { delivery: value.delivery as NpcChatterDelivery }),
  };
}

/** Delay is acceptable while the captured situation still applies. Check
 * coarse meaningful facts, rather than replacing the request with future data. */
export function npcChatterStillRelevant(
  g: Game,
  request: NpcChatterRequest,
  completingPlayback = false,
) {
  if (
    g.id !== request.runId ||
    g.time < request.capturedAt ||
    g.time - request.capturedAt > NPC_CHATTER_CONTEXT_SECONDS
  )
    return false;
  const a = npcChatterCandidates(g).find((a) => a.id === request.actorId);
  if (
    !a ||
    a.floor !== request.location.floor ||
    bounded(a.name, 80) !== request.self.name ||
    bounded(a.role, 80) !== request.self.role ||
    activity(a) !== request.self.activity ||
    a.intent !== request.self.intent ||
    a.station !== request.self.station ||
    health(a.hp / 100) !== request.self.healthBand ||
    localThreats(g, a).band !== request.perception.threatBand
  )
    return false;
  if (
    request.conversation &&
    !conversationSource(
      g,
      a,
      request.conversation,
      request.recentLines,
      false,
      completingPlayback,
    )
  )
    return false;
  const floor = g.floors[a.floor],
    location = place(floor, a);
  if (
    location.sector !== request.location.sector ||
    location.room !== request.location.room ||
    location.roomId !== request.location.roomId ||
    (a.keys ?? 0) !== request.self.keys ||
    a.access.includes(a.floor) !== request.self.personalStairAccess ||
    inventoryKey(carriedItems(a)) !== inventoryKey(request.self.inventory)
  )
    return false;
  for (const observed of request.perception.objects) {
    const current = floor.furniture.find((o) => o.id === observed.id);
    // Hidden state is not new knowledge. Only re-observe an object that the
    // NPC can currently see before checking its condition or personal access.
    if (!current || !canSee(floor, a, current, sightRadius(floor), current.id))
      continue;
    const door = current.door
        ? current.door.latched
          ? "latched"
          : "released"
        : undefined,
      fieldAccess = current.field ? fieldAllows(current, a) : undefined;
    if (
      current.kind !== observed.kind ||
      current.destroyed !== observed.destroyed ||
      health(current.hp / Math.max(1, current.maxHp)) !== observed.healthBand ||
      door !== observed.door ||
      fieldAccess !== observed.personalFieldAccess
    )
      return false;
  }
  const task = currentTask(g, a);
  return (
    task?.encounterId === request.task?.encounterId &&
    task?.problem?.id === request.task?.problem?.id &&
    task?.problem?.title === request.task?.problem?.title &&
    task?.problem?.prompt === request.task?.problem?.prompt
  );
}

/** Revalidate the actual observations used by a proposed line. An unchanged
 * coarse threat band is not proof that its particular attacker/ally/event
 * still applies. Hidden changes never supply replacement knowledge. */
export function npcDialogueFactsStillRelevant(
  g: Game,
  request: NpcChatterRequest,
  evidenceIds: readonly string[],
) {
  if (
    !request.dialogue ||
    !Array.isArray(evidenceIds) ||
    evidenceIds.length > 40 ||
    new Set(evidenceIds).size !== evidenceIds.length ||
    !npcChatterStillRelevant(g, request)
  )
    return false;
  const captured = new Map(
    request.dialogue.facts.map((fact) => [fact.id, fact]),
  );
  for (const id of evidenceIds) {
    const fact = captured.get(id);
    if (
      !fact ||
      (fact.expiresAt !== undefined &&
        (!Number.isFinite(fact.expiresAt) || g.time >= fact.expiresAt))
    )
      return false;
  }
  if (!evidenceIds.length) return true;
  const a = g.survivors.find((actor) => actor.id === request.actorId);
  if (!a) return false;
  // Heard lines in this trusted captured packet already passed recipient
  // filtering. Preserve that actual hearing receipt when rechecking them;
  // never infer hearing from where either person happens to stand now.
  const heard = request.recentLines.map((line) => ({
    ...line,
    ...(line.actorId === a.id ? {} : { heardBy: [a.id] }),
  }));
  const current = buildNpcChatterContext(
      g,
      a,
      request.requestId,
      heard,
      request.conversation,
    ),
    available = new Map(current.dialogue!.facts.map((fact) => [fact.id, fact]));
  return evidenceIds.every(
    (id) => available.get(id)?.key === captured.get(id)?.key,
  );
}
