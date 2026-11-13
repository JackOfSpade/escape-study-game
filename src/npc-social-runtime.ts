/**
 * NPC social runtime for the escape redesign (docs/ESCAPE_REDESIGN.md section 7).
 *
 * World-level awareness, suspicion from visible task work, social goals
 * (lead, follow, report, detain, escort, unlock), panic and outcome
 * application. Everything is a no-op without `g.escape`; the catastrophe is
 * never read.
 */
import {
  H,
  W,
  distance,
  rand,
  type Actor,
  type Furniture,
  type Game,
  type Point,
} from "./model";
import { canSee } from "./visibility";
import { doorFrame, latchDoor, lockDoor, unlockDoor } from "./doors";
import {
  AWARENESS_WEIGHTS,
  actionPlausibility,
  advanceLead,
  alarmAt,
  createSocial,
  noticeSuspicion,
  observe,
  recordInteraction,
  type LeadGoal,
} from "./npc-social";
import { announcementWeight } from "./pa-system";
import { factsVisibleTo } from "./fact-ledger";
import type { NpcOutcome, NpcSocial, SocialGoal } from "./escape-types";

/** Movement the engine lends a social goal for one tick. */
export interface SocialMotor {
  /** Walk toward a point on a floor using the engine's normal routing. */
  walkTo(target: Point & { floor: number }): void;
  /** Stand still this tick. */
  stop(): void;
  /** Turn to face a point without moving. */
  face(target: Point): void;
}

interface WorldCursor {
  events: number;
  announcements: number;
}

interface NpcTimers {
  threatSeen: number;
  running: number;
  suspicion: number;
  reportStarted: number;
  leadCalledFor?: number;
}

const cursors = new WeakMap<Game, WorldCursor>();
const timers = new WeakMap<Game, Map<string, NpcTimers>>();

const DEATH_EVENT = /lost|death/;
const HAZARD_EVENT = /hazard|breach|collapse|warning/;
const THREAT_SECONDS = 10;
const RUNNING_SECONDS = 15;
const SUSPICION_SECONDS = 8;
const SUSPICION_TILES = 8;
const THREAT_TILES = 9;
const HAZARD_TILES = 10;
const BODY_TILES = 12;
const RADIO_DELAY_SECONDS = 5;
const PANIC_ALARM = 0.7;
const FOLLOW_ALARM = 0.85;
const DETAIN_SECONDS = 60;
const DETAIN_TILES = 3;
/** How close an NPC must be to a door frame to use it. */
const DOOR_REACH_TILES = 1.5;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function cursorFor(g: Game): WorldCursor {
  let cursor = cursors.get(g);
  if (!cursor) {
    cursor = { events: 0, announcements: 0 };
    cursors.set(g, cursor);
  }
  return cursor;
}

function timersFor(g: Game, id: string): NpcTimers {
  let map = timers.get(g);
  if (!map) {
    map = new Map();
    timers.set(g, map);
  }
  let entry = map.get(id);
  if (!entry) {
    entry = {
      threatSeen: -Infinity,
      running: -Infinity,
      suspicion: -Infinity,
      reportStarted: -1,
    };
    map.set(id, entry);
  }
  return entry;
}

function onBuildingFloor(g: Game, a: Actor): boolean {
  return a.floor >= 0 && a.floor < g.floors.length;
}

function sameRoleWord(a: string, b: string): boolean {
  const words = new Set(
    (a.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(Boolean),
  );
  return (b.toLowerCase().match(/[a-z]{4,}/g) ?? []).some((word) =>
    words.has(word),
  );
}

function ensureSocial(g: Game, a: Actor): NpcSocial {
  if (a.socialState) return a.socialState;
  const escape = g.escape;
  const relationship =
    escape && sameRoleWord(a.role ?? "", escape.persona?.role ?? "")
      ? "colleague"
      : "stranger";
  a.socialState = createSocial(
    { role: a.role ?? "", risk: a.risk ?? 0.5, social: a.social ?? 0.5 },
    relationship,
  );
  return a.socialState;
}

function humanOf(g: Game): Actor | undefined {
  return g.survivors.find((a) => a.id === "human");
}

function positionOf(a: { floor: number; x: number; y: number }): {
  floor: number;
  x: number;
  y: number;
} {
  return { floor: a.floor, x: a.x, y: a.y };
}

function lastSeenOf(g: Game, a: Actor) {
  const human = humanOf(g);
  const seen = human ?? a;
  return {
    floor: seen.floor,
    x: seen.x,
    y: seen.y,
    at: g.time,
  };
}

function eventKind(event: unknown): string {
  const record = event as { kind?: unknown; type?: unknown };
  const value = record.kind ?? record.type ?? "";
  return String(value).toLowerCase();
}

function eventText(event: unknown, fallback: string): string {
  const value = (event as { text?: unknown }).text;
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function eventAt(event: unknown, now: number): number {
  const value = (event as { at?: unknown }).at;
  return typeof value === "number" && Number.isFinite(value) ? value : now;
}

function eventFloor(event: unknown, fallback: number): number {
  const value = (event as { floor?: unknown }).floor;
  return typeof value === "number" ? value : fallback;
}

function eventPoint(event: unknown): Point | undefined {
  const value = (event as { position?: unknown }).position;
  if (!value || typeof value !== "object") return undefined;
  const point = value as { x?: unknown; y?: unknown };
  if (typeof point.x !== "number" || typeof point.y !== "number") {
    return undefined;
  }
  return { x: point.x, y: point.y };
}

function pushPrompt(g: Game, npcId: string, reason: string): void {
  const escape = g.escape;
  if (!escape) return;
  (escape.prompts ??= []).push({ npcId, reason, at: g.time });
}

/** Lifts alarm on every living NPC on a floor of the current building. */
function broadcastAwareness(
  g: Game,
  kind: "pa" | "scream" | "body",
  text: string,
  weight: number,
  at: number,
  floor?: number,
  point?: Point,
  range = Infinity,
): void {
  for (const a of g.survivors) {
    if (!a.alive || a.escaped || a.id === "human") continue;
    if (!onBuildingFloor(g, a)) continue;
    if (floor !== undefined && a.floor !== floor) continue;
    const social = ensureSocial(g, a);
    if (point && distance(positionOf(a), point) > range) continue;
    observe(social, { kind, at, text, weight }, g.time);
  }
}

function suspicionTag(title: string): string {
  if (/hotwire|wire|ignition/i.test(title)) return "hotwire";
  if (/force|pry|wrench|break/i.test(title)) return "force-door";
  if (/bolt|panel|repair|fix/i.test(title)) return "repair";
  if (/tamper|override|bypass/i.test(title)) return "tamper";
  if (/launch|fuel/i.test(title)) return "launch";
  if (/unlock|lock/i.test(title)) return "unlock";
  if (/read|file|record/i.test(title)) return "read-restricted";
  return "take";
}

/** Called once per world step, before the NPC loop. */
export function socialWorldTick(g: Game, dt: number): void {
  const escape = g.escape;
  if (!escape) return;
  void dt;

  for (const a of g.survivors) {
    if (!a.alive || a.escaped || a.id === "human") continue;
    ensureSocial(g, a);
  }

  const cursor = cursorFor(g);
  if (g.events.length < cursor.events) cursor.events = 0;
  const freshEvents = g.events.slice(cursor.events);
  cursor.events = g.events.length;

  for (const raw of freshEvents) {
    const kind = eventKind(raw);
    const text = eventText(raw, kind);
    const at = eventAt(raw, g.time);
    const floor = eventFloor(raw, -1);
    const point = eventPoint(raw);
    if (DEATH_EVENT.test(kind)) {
      const awareness = /death/.test(kind) ? "body" : "scream";
      broadcastAwareness(
        g,
        awareness === "body" ? "body" : "scream",
        text,
        AWARENESS_WEIGHTS[awareness === "body" ? "body" : "scream"],
        at,
        floor >= 0 ? floor : undefined,
        point,
        BODY_TILES,
      );
      continue;
    }
    if (HAZARD_EVENT.test(kind) && point) {
      for (const a of g.survivors) {
        if (!a.alive || a.escaped || a.id === "human") continue;
        if (!onBuildingFloor(g, a) || a.floor !== floor) continue;
        if (distance(positionOf(a), point) > HAZARD_TILES) continue;
        if (!canSee(g.floors[a.floor], a, point)) continue;
        observe(
          ensureSocial(g, a),
          {
            kind: "hazard-seen",
            at,
            text,
            weight: AWARENESS_WEIGHTS["hazard-seen"],
          },
          g.time,
        );
      }
    }
  }

  for (const a of g.survivors) {
    if (!a.alive || a.escaped || a.id === "human") continue;
    if (!onBuildingFloor(g, a)) continue;
    const social = ensureSocial(g, a);
    const timer = timersFor(g, a.id);
    const floor = g.floors[a.floor];
    if (!floor) continue;
    if (g.time - timer.threatSeen >= THREAT_SECONDS) {
      const hunter = g.zombies.find(
        (z) =>
          z.hp > 0 &&
          z.floor === a.floor &&
          distance(positionOf(a), { x: z.x, y: z.y }) <= THREAT_TILES &&
          canSee(floor, a, { x: z.x, y: z.y }),
      );
      if (hunter) {
        timer.threatSeen = g.time;
        observe(
          social,
          {
            kind: "threat-seen",
            at: g.time,
            text: "Something hunting is close by.",
            weight: AWARENESS_WEIGHTS["threat-seen"],
            sourceId: (hunter as { id?: string }).id,
          },
          g.time,
        );
      }
    }
    if (g.time - timer.running >= RUNNING_SECONDS) {
      const runner = g.survivors.find(
        (other) =>
          other !== a &&
          other.id !== "human" &&
          other.alive &&
          !other.escaped &&
          other.activity === "fleeing" &&
          other.floor === a.floor &&
          canSee(floor, a, other),
      );
      if (runner) {
        timer.running = g.time;
        observe(
          social,
          {
            kind: "running",
            at: g.time,
            text: `${runner.name ?? "Someone"} is running.`,
            weight: AWARENESS_WEIGHTS.running,
            sourceId: runner.id,
          },
          g.time,
        );
      }
    }
  }

  // PA announcements: alarm for everyone in the building, plus at most two
  // NPCs asked to react out loud.
  const announcements = escape.announcements ?? [];
  if (announcements.length < cursor.announcements) cursor.announcements = 0;
  const freshAnnouncements = announcements.slice(cursor.announcements);
  cursor.announcements = announcements.length;
  for (const announcement of freshAnnouncements) {
    const text = typeof announcement.text === "string" ? announcement.text : "";
    const at = typeof announcement.at === "number" ? announcement.at : g.time;
    const rawWeight = announcementWeight(announcement);
    const weight = Number.isFinite(rawWeight)
      ? rawWeight
      : AWARENESS_WEIGHTS.pa;
    for (const a of g.survivors) {
      if (!a.alive || a.escaped || a.id === "human") continue;
      if (!onBuildingFloor(g, a)) continue;
      observe(ensureSocial(g, a), { kind: "pa", at, text, weight }, g.time);
    }
    const pool = g.survivors.filter(
      (a) => a.alive && !a.escaped && a.id !== "human" && a.socialState,
    );
    for (let count = 0; count < 2 && pool.length > 0; count++) {
      const index = Math.min(
        pool.length - 1,
        Math.floor(rand(g) * pool.length),
      );
      const [chosen] = pool.splice(index, 1);
      pushPrompt(g, chosen.id, `react to the PA announcement: ${text}`);
    }
  }

  // Suspicion from visible work on the player's current task station.
  const human = humanOf(g);
  if (human && human.alive && !human.escaped && human.station !== undefined) {
    const task = (escape.tasks ?? []).find(
      (t) => t.state === "in-progress" && t.stationId === human.station,
    );
    if (task) {
      const tag = suspicionTag(task.title ?? "");
      const plausibility = actionPlausibility(escape.persona?.role ?? "", tag);
      const lastSeen = lastSeenOf(g, human);
      for (const a of g.survivors) {
        if (!a.alive || a.escaped || a.id === "human") continue;
        if (a.floor !== human.floor || !onBuildingFloor(g, a)) continue;
        if (distance(positionOf(a), human) > SUSPICION_TILES) continue;
        if (!canSee(g.floors[a.floor], a, human)) continue;
        const timer = timersFor(g, a.id);
        if (g.time - timer.suspicion < SUSPICION_SECONDS) continue;
        timer.suspicion = g.time;
        const social = ensureSocial(g, a);
        const response = noticeSuspicion(social, {
          plausibility,
          witnessed: "seen",
          now: g.time,
          panicking: social.alarm >= PANIC_ALARM,
        });
        if (response === "question") {
          pushPrompt(
            g,
            a.id,
            `question the player about what they are doing: ${task.title}`,
          );
          continue;
        }
        if (response === "report") {
          social.goal = {
            kind: "report",
            about: task.title,
            lastSeen,
            via: social.hasRadio ? "radio" : "walk",
          };
          timer.reportStarted = g.time;
          continue;
        }
        if (response === "intervene" || response === "detain") {
          social.goal = {
            kind: "detain",
            lastSeen,
            searchUntil: g.time + DETAIN_SECONDS,
          };
        }
      }
    }
  }
}

function logEvent(
  g: Game,
  kind: "report-lost" | "report-delivered" | "detained" | "freed",
  text: string,
): void {
  const escape = g.escape;
  if (!escape) return;
  escape.log.push({
    at: g.time,
    kind,
    areaId: escape.areas?.current ?? "start",
    text,
  });
}

function nearestAuthority(
  g: Game,
  floor: number | undefined,
  from: Point,
): Actor | undefined {
  let best: Actor | undefined;
  let bestDistance = Infinity;
  for (const other of g.survivors) {
    if (other.id === "human" || !other.alive || other.escaped) continue;
    if (floor !== undefined && other.floor !== floor) continue;
    const social = ensureSocial(g, other);
    if (!social.canDetain) continue;
    const d = distance(from, other);
    if (d < bestDistance) {
      bestDistance = d;
      best = other;
    }
  }
  return best;
}

function doorAxis(o: Furniture): "x" | "y" {
  const frame = doorFrame(o);
  return frame.w >= frame.h ? "x" : "y";
}

function doorSide(o: Furniture, p: Point): number {
  const frame = doorFrame(o);
  return Math.sign(p[doorAxis(o)] - frame[doorAxis(o)]);
}

function escortPoint(
  o: Furniture,
  npc: Point,
): { floor: number; x: number; y: number } {
  const frame = doorFrame(o);
  const axis = doorAxis(o);
  const npcSide = doorSide(o, npc) || 1;
  const farSide = -npcSide;
  const point = { floor: o.floor, x: frame.x, y: frame.y };
  point[axis] = frame[axis] + farSide * 1.5;
  return point;
}

function nearestDoor(
  g: Game,
  floor: number,
  from: Point,
): Furniture | undefined {
  if (floor < 0 || floor >= g.floors.length) return undefined;
  let best: Furniture | undefined;
  let bestDistance = Infinity;
  for (const o of g.floors[floor].furniture) {
    if (!o.door) continue;
    const d = distance(from, doorFrame(o));
    if (d < bestDistance) {
      bestDistance = d;
      best = o;
    }
  }
  return best;
}

function panicStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
): boolean {
  if (social.goal?.kind === "report") {
    logEvent(g, "report-lost", "A report was abandoned in the panic.");
    delete social.goal;
  }
  let hunter: { x: number; y: number } | undefined;
  let bestDistance = Infinity;
  for (const z of g.zombies) {
    if (z.hp <= 0 || z.floor !== a.floor) continue;
    if (z.hunter === undefined) continue;
    const d = distance(a, { x: z.x, y: z.y });
    if (d < bestDistance) {
      bestDistance = d;
      hunter = { x: z.x, y: z.y };
    }
  }
  let dx = 1;
  let dy = 0;
  if (hunter) {
    dx = a.x - hunter.x;
    dy = a.y - hunter.y;
  } else {
    const human = humanOf(g);
    if (human) {
      dx = a.x - human.x;
      dy = a.y - human.y;
    }
  }
  const length = Math.hypot(dx, dy) || 1;
  motor.walkTo({
    floor: a.floor,
    x: clamp(a.x + (dx / length) * 6, 1, W - 2),
    y: clamp(a.y + (dy / length) * 6, 1, H - 2),
  });
  return true;
}

function leadStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
  goal: LeadGoal,
): boolean {
  const human = humanOf(g);
  if (!human) {
    delete social.goal;
    return false;
  }
  const floor = g.floors[a.floor];
  const playerVisible =
    a.floor === human.floor && floor !== undefined && canSee(floor, a, human);
  const advanced = advanceLead(goal, {
    now: g.time,
    playerDistance: distance(a, human),
    playerVisible,
    checkBackSeconds: social.checkBackSeconds,
  });
  social.goal = advanced.goal;
  if (advanced.event === "gave-up") {
    recordInteraction(social, {
      at: g.time,
      kind: "walked-off",
      text: "Gave up waiting for the player.",
    });
    delete social.goal;
    motor.stop();
    return false;
  }
  if (
    advanced.goal.stage === "leading" &&
    distance(positionOf(a), goal.target) <= 1.5
  ) {
    pushPrompt(g, a.id, "tell the player you are here");
    delete social.goal;
    motor.stop();
    return true;
  }
  switch (advanced.goal.stage) {
    case "looking":
      motor.face(human);
      motor.stop();
      break;
    case "calling": {
      const timer = timersFor(g, a.id);
      const missingSince = advanced.goal.missingSince ?? g.time;
      if (timer.leadCalledFor !== missingSince) {
        timer.leadCalledFor = missingSince;
        pushPrompt(g, a.id, "call out to the player who stopped following");
      }
      motor.face(human);
      motor.stop();
      break;
    }
    case "returning":
      motor.walkTo(positionOf(human));
      break;
    default:
      motor.walkTo(goal.target);
      break;
  }
  return true;
}

function followStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
): boolean {
  const alarm = alarmAt(social, g.time);
  if (alarm >= FOLLOW_ALARM) {
    delete social.goal;
    pushPrompt(g, a.id, "refuse to keep following");
    return true;
  }
  const human = humanOf(g);
  if (!human) {
    delete social.goal;
    return false;
  }
  const heading = typeof human.heading === "number" ? human.heading : 0;
  motor.walkTo({
    floor: human.floor,
    x: human.x - Math.cos(heading) * 1.5,
    y: human.y - Math.sin(heading) * 1.5,
  });
  return true;
}

function deliverReport(
  g: Game,
  social: NpcSocial,
  authority: Actor,
  goal: Extract<SocialGoal, { kind: "report" }>,
): void {
  const about = goal.about;
  delete social.goal;
  const target = ensureSocial(g, authority);
  target.goal = {
    kind: "detain",
    lastSeen: goal.lastSeen,
    searchUntil: g.time + DETAIN_SECONDS,
  };
  logEvent(
    g,
    "report-delivered",
    `A report about ${about} reached ${authority.name}.`,
  );
}

function reportStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
  goal: Extract<SocialGoal, { kind: "report" }>,
): boolean {
  const timer = timersFor(g, a.id);
  const authority = nearestAuthority(
    g,
    goal.via === "walk" ? a.floor : undefined,
    a,
  );
  if (!authority) {
    logEvent(
      g,
      "report-lost",
      `No one could take the report about ${goal.about}.`,
    );
    delete social.goal;
    return true;
  }
  if (goal.via === "radio") {
    if (timer.reportStarted < 0) timer.reportStarted = g.time;
    if (g.time - timer.reportStarted >= RADIO_DELAY_SECONDS) {
      timer.reportStarted = -1;
      deliverReport(g, social, authority, goal);
    } else {
      motor.stop();
    }
    return true;
  }
  if (distance(a, authority) <= 2) {
    deliverReport(g, social, authority, goal);
    return true;
  }
  motor.walkTo(positionOf(authority));
  return true;
}

function detainStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
  goal: Extract<SocialGoal, { kind: "detain" }>,
): boolean {
  if (g.time > goal.searchUntil) {
    delete social.goal;
    return true;
  }
  const human = humanOf(g);
  const floor = g.floors[a.floor];
  if (
    human &&
    human.alive &&
    !human.escaped &&
    floor !== undefined &&
    human.floor === a.floor &&
    distance(a, human) <= DETAIN_TILES &&
    canSee(floor, a, human)
  ) {
    const door = nearestDoor(g, a.floor, a);
    if (door) {
      human.escortedBy = a.id;
      social.goal = {
        kind: "escort",
        to: escortPoint(door, a),
        roomDoorId: door.id,
      };
      return true;
    }
  }
  motor.walkTo({
    floor: goal.lastSeen.floor,
    x: goal.lastSeen.x,
    y: goal.lastSeen.y,
  });
  return true;
}

function escortStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
  goal: Extract<SocialGoal, { kind: "escort" }>,
): boolean {
  const human = humanOf(g);
  const door =
    a.floor >= 0 && a.floor < g.floors.length
      ? g.floors[a.floor].furniture.find((o) => o.id === goal.roomDoorId)
      : undefined;
  if (!door) {
    if (human?.escortedBy === a.id) delete human.escortedBy;
    delete social.goal;
    return true;
  }
  const roomSide = doorSide(door, goal.to) || 1;
  const humanSide = human ? doorSide(door, human) : 0;
  const npcSide = doorSide(door, a);
  if (human && humanSide === roomSide && npcSide !== roomSide) {
    latchDoor(g, door);
    lockDoor(door, roomSide === 1 ? 1 : -1, a.id, g.time);
    delete human.escortedBy;
    logEvent(g, "detained", `${human.name ?? "The player"} was locked in.`);
    recordInteraction(social, {
      at: g.time,
      kind: "suspicious",
      text: "Detained the player.",
    });
    delete social.goal;
    return true;
  }
  const frame = doorFrame(door);
  motor.walkTo({ floor: a.floor, x: frame.x, y: frame.y });
  return true;
}

function unlockStep(
  g: Game,
  a: Actor,
  social: NpcSocial,
  motor: SocialMotor,
  goal: Extract<SocialGoal, { kind: "unlock" }>,
): boolean {
  let door: Furniture | undefined;
  for (const floor of g.floors) {
    door = floor.furniture.find((o) => o.id === goal.doorId);
    if (door) break;
  }
  if (!door) {
    delete social.goal;
    return true;
  }
  if (distance(a, doorFrame(door)) > DOOR_REACH_TILES) {
    const frame = doorFrame(door);
    motor.walkTo({ floor: door.floor, x: frame.x, y: frame.y });
    return true;
  }
  unlockDoor(door);
  logEvent(g, "freed", "A lock was released.");
  recordInteraction(social, {
    at: g.time,
    kind: "freed",
    text: "Unlocked the door for the player.",
  });
  delete social.goal;
  return true;
}

/** Called for each living NPC at the top of its decision chain. */
export function socialStep(
  g: Game,
  a: Actor,
  dt: number,
  motor: SocialMotor,
): boolean {
  const escape = g.escape;
  if (!escape) return false;
  const social = a.socialState;
  if (!social) return false;
  void dt;
  if (!a.alive || a.escaped) return false;

  const alarm = alarmAt(social, g.time);
  const goal = social.goal;
  if (
    alarm >= PANIC_ALARM &&
    goal?.kind !== "follow" &&
    goal?.kind !== "lead"
  ) {
    return panicStep(g, a, social, motor);
  }
  if (!goal) return false;

  switch (goal.kind) {
    case "lead":
      return leadStep(g, a, social, motor, goal);
    case "follow":
      return followStep(g, a, social, motor);
    case "report":
      return reportStep(g, a, social, motor, goal);
    case "detain":
      return detainStep(g, a, social, motor, goal);
    case "escort":
      return escortStep(g, a, social, motor, goal);
    case "unlock":
      return unlockStep(g, a, social, motor, goal);
    default:
      return false;
  }
}

function furnitureById(g: Game, id: string): Furniture | undefined {
  for (const floor of g.floors) {
    const found = floor.furniture.find((o) => o.id === id);
    if (found) return found;
  }
  return undefined;
}

/** What `validateOutcome` (src/npc-social.ts) needs to check a reply from this NPC. */
export function outcomeContext(
  g: Game,
  npcId: string,
): {
  canDetain: boolean;
  atDoorIds: string[];
  knownFactIds: string[];
  leadTargets: string[];
} {
  const escape = g.escape;
  const npc = g.survivors.find((a) => a.id === npcId);
  if (!escape || !npc) {
    return {
      canDetain: false,
      atDoorIds: [],
      knownFactIds: [],
      leadTargets: [],
    };
  }
  const social =
    npc.socialState ??
    createSocial(
      {
        role: npc.role ?? "",
        risk: npc.risk ?? 0.5,
        social: npc.social ?? 0.5,
      },
      "stranger",
    );
  const floor =
    npc.floor >= 0 && npc.floor < g.floors.length
      ? g.floors[npc.floor]
      : undefined;
  const atDoorIds = floor
    ? (floor.furniture ?? [])
        .filter(
          (o) => o.door && distance(npc, doorFrame(o)) <= DOOR_REACH_TILES,
        )
        .map((o) => o.id)
    : [];
  const knownFactIds = factsVisibleTo(escape.ledger, {
    npcId,
    role: npc.role,
    areaId: escape.areas?.current ?? "start",
  })
    .filter((fact) => fact.durable === true)
    .map((fact) => fact.id);
  const leadTargets = [
    ...(floor ? (floor.furniture ?? []).map((o) => o.id) : []),
    ...(escape.areas?.portals ?? []).map((portal) => portal.id),
  ];
  return {
    canDetain: social.canDetain,
    atDoorIds,
    knownFactIds,
    leadTargets,
  };
}

/** Apply a validated outcome of something this NPC said. */
export function applySocialOutcome(
  g: Game,
  npcId: string,
  outcome: NpcOutcome,
): void {
  const escape = g.escape;
  if (!escape) return;
  const npc = g.survivors.find((a) => a.id === npcId);
  if (!npc) return;
  const social = ensureSocial(g, npc);
  const lastSeen = lastSeenOf(g, npc);
  switch (outcome.kind) {
    case "lead": {
      const furniture = furnitureById(g, outcome.targetId);
      const portal = (escape.areas?.portals ?? []).find(
        (p) => p.id === outcome.targetId,
      );
      if (furniture) {
        social.goal = {
          kind: "lead",
          target: {
            floor: furniture.floor,
            x: doorFrame(furniture).x,
            y: doorFrame(furniture).y,
          },
          label: outcome.targetId,
          nextCheck: g.time + social.checkBackSeconds,
          stage: "leading",
        };
      } else if (portal) {
        social.goal = {
          kind: "lead",
          target: {
            floor: portal.at.floor,
            x: portal.at.x,
            y: portal.at.y,
          },
          label: outcome.targetId,
          nextCheck: g.time + social.checkBackSeconds,
          stage: "leading",
        };
      }
      return;
    }
    case "follow":
      social.goal = {
        kind: "follow",
        since: g.time,
        nerve: clamp(npc.social ?? 0.5, 0, 1),
      };
      return;
    case "stop-following":
      if (social.goal?.kind === "follow") delete social.goal;
      return;
    case "report":
      social.goal = {
        kind: "report",
        about: "the player",
        lastSeen,
        via: social.hasRadio ? "radio" : "walk",
      };
      timersFor(g, npc.id).reportStarted = -1;
      return;
    case "intervene":
    case "detain":
      social.goal = {
        kind: "detain",
        lastSeen,
        searchUntil: g.time + DETAIN_SECONDS,
      };
      return;
    case "watch":
      recordInteraction(social, {
        at: g.time,
        kind: "suspicious",
        text: "Watching the player.",
      });
      return;
    case "unlock":
      social.goal = { kind: "unlock", doorId: outcome.doorId };
      return;
    case "alarm":
      observe(
        social,
        {
          kind: "alarm",
          at: g.time,
          text: "The player raised the alarm.",
          weight: Math.max(0, outcome.delta),
        },
        g.time,
      );
      return;
    case "agree-with-conditions":
      recordInteraction(social, {
        at: g.time,
        kind: "persuaded",
        text: outcome.condition,
      });
      return;
    case "refuse":
      recordInteraction(social, {
        at: g.time,
        kind: "refused",
        text: "Refused the player.",
      });
      return;
    default:
      return;
  }
}
