/**
 * Shared contracts for the escape redesign (docs/ESCAPE_REDESIGN.md).
 *
 * Every module of the redesign imports its data shapes from here so the
 * pieces can be built and tested independently. All of it is plain JSON data
 * stored on `Game.escape` and saved with the game.
 */

/* ------------------------------------------------------------------ */
/* Catastrophe (sealed from the player and from every NPC prompt)      */
/* ------------------------------------------------------------------ */

export type BehaviourKind =
  "hunter" | "hazard" | "perception-rule" | "collapse";

export interface HunterBehaviour {
  kind: "hunter";
  /** Shown only through the body: colour, size and silhouette. */
  body: {
    color: string; // #rrggbb
    scale: number; // 0.6..2.2 relative to a person
    silhouette: "humanoid" | "quadruped" | "serpentine" | "swarm" | "amorphous";
  };
  count: number; // 1..40 alive at once
  speed: number; // 0.4..1.6 x player walking speed
  sightRange: number; // tiles 2..14
  hearingWeight: number; // 0..1, how strongly sound draws it
  doors: "break" | "open" | "blocked";
  damage: number; // hp per strike 4..60
  spawn: "single" | "breeding" | "waves";
}

export interface HazardBehaviour {
  kind: "hazard";
  medium: "fire" | "smoke" | "water" | "gas" | "vacuum" | "cold";
  /** Tiles per second the front advances, 0.02..1.5. */
  spreadRate: number;
  damagePerSecond: number; // 0.5..40 while standing in it
  /** Closed latched doors stop it when true. */
  blockedByClosedDoors: boolean;
  /** 0 = clear, 1 = opaque (smoke). Multiplies sight range. */
  obscures: number;
}

export type PerceptionTrigger =
  "sees-own-reflection" | "makes-sound" | "in-darkness" | "looks-at-entity";

export interface PerceptionRuleBehaviour {
  kind: "perception-rule";
  trigger: PerceptionTrigger;
  /** Sound threshold for makes-sound, 0..10 on the actor noise scale. */
  threshold?: number;
  effect: "damage" | "instant-death";
  damagePerSecond?: number; // required when effect is "damage", 1..60
  /** A tell that precedes the effect, so the rule is learnable. */
  warning: "none" | "whisper" | "frost" | "flicker" | "ringing";
}

export interface CollapseBehaviour {
  kind: "collapse";
  targets: ("power" | "doors" | "structure" | "life-support")[];
  /** Seconds between failures once active, 10..600. */
  cadence: number;
}

export type Behaviour =
  | HunterBehaviour
  | HazardBehaviour
  | PerceptionRuleBehaviour
  | CollapseBehaviour;

export type PhaseName = "omens" | "onset" | "spread" | "peak";

export interface CatastrophePhase {
  name: PhaseName;
  /** Seconds after game start (after the grace period for onset onward). */
  at: number;
  /** Behaviour indexes active from this phase on. */
  behaviours: number[];
  /** 0..1 intensity multiplier on behaviour parameters. */
  intensity: number;
}

export interface Omen {
  id: string;
  /** What a witness can perceive; never names the catastrophe. */
  text: string;
  at: number; // seconds after start
  areaId: string;
  roomHint?: string;
  /** Optional world effect applied when the omen happens. */
  effect?: "flicker" | "alarm" | "lockdown" | "noise" | "none";
}

export interface CatastropheSpec {
  id: string;
  title: string;
  /** The truth, in prose. Used only for the epilogue. */
  premise: string;
  origin: { areaId: string; roomHint?: string };
  behaviours: Behaviour[];
  timeline: { graceSeconds: number; phases: CatastrophePhase[] };
  omens: Omen[];
  /** What officials say over the PA once it is undeniable. */
  publicStory: string;
}

/* ------------------------------------------------------------------ */
/* Fact ledger and journal                                             */
/* ------------------------------------------------------------------ */

export type FactVisibility =
  | "public"
  | "hidden"
  | `npc:${string}`
  | `role:${string}`
  | `document:${string}`
  | `area:${string}`;

export type FactSource =
  | "design"
  | "director"
  | "pa"
  | "npc"
  | "document"
  | "observation"
  | "catastrophe";

export interface Fact {
  id: string;
  /** Plain sentence, at most 280 characters. */
  text: string;
  subject: {
    kind: "area" | "object" | "npc" | "system" | "route" | "task";
    id: string;
  };
  source: FactSource;
  visibility: FactVisibility[];
  /** Game time it was committed. */
  at: number;
  /** A later fact that changes the *state* this fact described. History is never rewritten. */
  supersededBy?: string;
  /** Loop it was committed in. */
  loop?: number;
  /**
   * World facts (how things are: "the hatch needs a badge") stay true in every
   * loop and NPCs who would know them keep knowing them. Event facts ("the PA
   * announced an outage") belong to the loop they happened in. Default: false.
   */
  durable?: boolean;
}

export interface JournalEntry {
  factId: string;
  /** Short line the player sees, e.g. "Rocket hatch: flight-crew badge (Ortiz has one?)". */
  line: string;
  learnedAt: number;
  /** How the player learned it. */
  via: "conversation" | "document" | "pa" | "observation" | "attempt";
}

export interface FactLedger {
  facts: Fact[];
  journal: JournalEntry[];
  seq: number;
}

/* ------------------------------------------------------------------ */
/* Tasks mapped onto study checkpoints                                 */
/* ------------------------------------------------------------------ */

export interface EscapeTask {
  id: string;
  /** "Loosen the hatch bolts". */
  title: string;
  /** Unit label for the counter: "bolts", "wires". */
  unit: string;
  steps: number; // 1..8, chosen to make sense in the story
  done: number;
  /** Furniture/station id the task is performed at. */
  objectId: string;
  areaId: string;
  /** Fact ids that created this task. */
  fromFacts: string[];
  state: "available" | "in-progress" | "complete" | "abandoned";
  /** Fact committed when the task completes. */
  onComplete?: string;
  /** The study station the task is performed at (created on the object when needed). */
  stationId?: string;
}

/* ------------------------------------------------------------------ */
/* Areas                                                               */
/* ------------------------------------------------------------------ */

export interface AreaPortal {
  id: string;
  from: string;
  to: string;
  /** Diegetic transition that hides generation. */
  transition: "airlock" | "hatch" | "lift" | "vehicle" | "door" | "walk";
  /** Where the portal sits in the `from` area. */
  at: { floor: number; x: number; y: number };
  /** The world object the player walks into or uses (hatch, door, vehicle). */
  objectId?: string;
  label: string;
}

export interface AreaStub {
  id: string;
  name: string;
  /** One-paragraph description the generator expands. */
  brief: string;
  state: "stub" | "queued" | "generating" | "ready" | "failed";
  /** The AI expansion of the brief (escape-area answer), kept across loops so the area rebuilds identically. */
  plan?: {
    name: string;
    premise: string;
    rooms: { name: string; purpose: string }[];
    people: { name: string; role: string; activity: string }[];
  };
  /** Seed for deterministic regeneration of the procedural parts. */
  seed: number;
  /** Reaching this area means the player got away (a vehicle ride out, a launch). */
  exit?: boolean;
  /**
   * Continuous world: "site" = a nearby building stamped into the same world
   * (walk there); "region" = a far place with its own world, reached by
   * travel behind a loading screen. Absent on older saves means "region".
   */
  kind?: "site" | "region";
  /** For a site: its world origin (plot), fixed when the place is registered. */
  origin?: { x: number; y: number };
  /** For a site: true once its building is stamped into the world. */
  stamped?: boolean;
  /**
   * The accepted AI design of this area's building, saved with the game so a
   * reload or a Restart rebuilds the same place fresh from it.
   */
  design?: import("./run-design-contract.mjs").SavedRunDesign;
}

export interface AreaGraph {
  start: string;
  current: string;
  areas: Record<string, AreaStub>;
  portals: AreaPortal[];
}

/* ------------------------------------------------------------------ */
/* NPC social simulation                                               */
/* ------------------------------------------------------------------ */

export type AwarenessKind =
  | "pa"
  | "scream"
  | "running"
  | "body"
  | "threat-seen"
  | "hazard-seen"
  | "told"
  | "suspicious-act"
  | "alarm";

export interface AwarenessEvent {
  kind: AwarenessKind;
  at: number;
  /** Plain description the NPC may mention. */
  text: string;
  /** How much this raised alarm, 0..1. */
  weight: number;
  sourceId?: string;
}

export interface InteractionRecord {
  at: number;
  kind:
    | "asked"
    | "offered"
    | "lied"
    | "promised"
    | "helped"
    | "walked-off"
    | "freed"
    | "escaped-detention"
    | "suspicious"
    | "persuaded"
    | "refused";
  text: string;
}

export interface NpcSocial {
  /** 0 calm .. 1 panicking. Derived from awareness. */
  alarm: number;
  awareness: AwarenessEvent[];
  /** What this NPC believes about the player. */
  player: {
    relationship:
      "colleague" | "friend" | "stranger" | "superior" | "subordinate";
    suspicion: number; // 0..1
    history: InteractionRecord[];
  };
  /** Authority to detain the player. */
  canDetain: boolean;
  /** Has a radio for remote reporting. */
  hasRadio: boolean;
  /** Personality knob for leading: seconds between check-backs. */
  checkBackSeconds: number;
  goal?: SocialGoal;
}

export type SocialGoal =
  | {
      kind: "lead";
      target: { floor: number; x: number; y: number };
      label: string;
      nextCheck: number;
      missingSince?: number;
      stage: "leading" | "looking" | "calling" | "returning";
    }
  | { kind: "follow"; since: number; nerve: number }
  | {
      kind: "escort";
      to: { floor: number; x: number; y: number };
      roomDoorId: string;
    }
  | {
      kind: "report";
      about: string;
      lastSeen: { floor: number; x: number; y: number; at: number };
      via: "radio" | "walk";
      to?: string;
    }
  | {
      kind: "detain";
      lastSeen: { floor: number; x: number; y: number; at: number };
      searchUntil: number;
    }
  | { kind: "unlock"; doorId: string };

/** Structured outcome an NPC reply carries. The game validates it before applying. */
export type NpcOutcome =
  | { kind: "none" }
  | { kind: "share-fact"; factId: string }
  | { kind: "lead"; targetId: string }
  | { kind: "follow" }
  | { kind: "stop-following" }
  | { kind: "refuse" }
  | { kind: "ask-for-proof" }
  | { kind: "agree-with-conditions"; condition: string }
  | { kind: "report" }
  | { kind: "watch" }
  | { kind: "intervene" }
  | { kind: "detain" }
  | { kind: "unlock"; doorId: string }
  | { kind: "alarm"; delta: number };

/* ------------------------------------------------------------------ */
/* Conversation                                                        */
/* ------------------------------------------------------------------ */

export interface Utterance {
  id: string;
  speakerId: string; // "human", an NPC id, or "pa"
  text: string;
  at: number;
  floor: number;
  x: number;
  y: number;
  /** Resolved addressee, or undefined for a general remark. */
  addressee?: string;
  /** Actor ids that heard it at playback. */
  heardBy: string[];
}

/* ------------------------------------------------------------------ */
/* PA system                                                           */
/* ------------------------------------------------------------------ */

export type AnnouncementKind =
  "routine" | "incident" | "borderline" | "escalation";

export interface Announcement {
  id: string;
  at: number;
  kind: AnnouncementKind;
  text: string;
  areaId: string;
  /** World state the announcement asserts and the game applies. */
  effect?:
    | { kind: "power"; roomId: string; power: "lit" | "dim" | "outage" }
    | { kind: "lockdown"; roomId: string }
    | { kind: "evacuate" }
    | { kind: "none" };
  factId?: string;
}

/* ------------------------------------------------------------------ */
/* Voices                                                              */
/* ------------------------------------------------------------------ */

export type VoiceGender = "male" | "female";

export interface VoiceIdentity {
  playerGender: VoiceGender;
  /** Voice slot keys from the speech service (see src/npc-voice.ts). */
  player: string;
  pa: string;
  /** Actor id -> slot, fixed when the NPC is first created. */
  npcs: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/* Event log and epilogue                                              */
/* ------------------------------------------------------------------ */

export type EscapeEventKind =
  | "phase"
  | "omen"
  | "pa"
  | "report"
  | "report-lost"
  | "report-delivered"
  | "death"
  | "alarm"
  | "evacuation"
  | "departure"
  | "detained"
  | "freed"
  | "task"
  | "player-end";

export interface EscapeEvent {
  at: number;
  kind: EscapeEventKind;
  areaId: string;
  floor?: number;
  room?: string;
  actorId?: string;
  text: string;
  /** Catastrophe phase in effect when it happened. */
  phase?: PhaseName | "calm";
}

/* ------------------------------------------------------------------ */
/* Everything stored on the game                                       */
/* ------------------------------------------------------------------ */

export interface EscapeState {
  version: 1;
  /** Who the player is, as told to them. */
  persona: { name: string; role: string; backstory: string };
  catastrophe: CatastropheSpec;
  ledger: FactLedger;
  tasks: EscapeTask[];
  areas: AreaGraph;
  voices: VoiceIdentity;
  announcements: Announcement[];
  /** Index of the loop; 0 for the first attempt, +1 per Restart. */
  loop: number;
  /** Event log of the current loop only. */
  log: EscapeEvent[];
  /** Written when a loop ends; shown only on New game. */
  epilogue?: { loop: number; text: string; writtenAt: number };
  /** Areas the player is not in, frozen exactly as they were left. */
  areaStore: Record<string, ParkedArea>;
  /** NPC lines the social runtime wants spoken (greet, question the player, react). The speech system consumes them. */
  prompts: { npcId: string; reason: string; at: number }[];
  /** Mutable room power keyed `${floor}:${roomId}`; overrides the seeded default. Reset each loop. */
  roomPower: Record<string, "lit" | "dim" | "outage">;
}

/** An inactive area. The active area's floors live in `Game.floors`. */
export interface ParkedArea {
  /**
   * The whole parked area as its own game, without `study` and `escape`
   * (those always live on the active game and move with the player).
   */
  game: Omit<import("./model").Game, "study" | "escape">;
  /** Game time it was parked. */
  parkedAt: number;
}
