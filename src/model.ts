import type { LearnerLedger, ScopeDefinition } from "./learning-model";
import type { Sector } from "./floor-plan";
export type Track = "PY" | "PE";
/** A connected AI provider; development practice has no provider. */
export type Provider = "study-mode" | "chatgpt-handoff" | "claude-cli";
export const PROVIDERS: readonly string[] = [
  "study-mode",
  "chatgpt-handoff",
  "claude-cli",
];
export interface Objective {
  id: string;
  target: number;
  cells: string[];
  route: string;
  refs: string;
  reviewDue: string | null;
  scope: string;
}
export interface Roadmap {
  resume?: {
    ratioPosition?: number;
    issues: string[];
    reviews?: Record<string, import("./learning-model").ReviewRecord>;
    identifierCounters?: import("./roadmap-identifiers").IdentifierCounters;
  };
  documentId: string;
  revision: number;
  sourceHash: string;
  raw: string;
  sharedProgress: string;
  tracks: Record<
    Track,
    {
      tier: number;
      lap?: number;
      cleared?: number;
      suspended?: {
        tier: number;
        phase: string;
        lap?: number;
        queue: string[];
      }[];
      phase: string;
      remaining: string[];
      rotation: string[];
      objectives: Objective[];
      topics: Record<string, string>;
      progress: string;
      curriculum: string;
    }
  >;
}
export interface Contract {
  /** Legacy objectiveIds also carries track-qualified topic/integration IDs for final work. */
  kind?: "checkpoint" | "transfer" | "integration";
  id: string;
  track: Track;
  objectiveIds: string[];
  scopes: string[];
  depth: number;
  phase: string;
  review: boolean;
  ledgerVersion: number;
  priorEvidence: string[];
  scheduleNote?: string;
  /** A variety terminal: probes and records knowledge, never the formal visit. */
  practice?: boolean;
  missingFacets?: string[];
  preservedFacets?: string[];
  historicalScope?: {
    sourceHash: string;
    gaps: {
      id: string;
      objectiveId: string;
      depth: number;
      kind: string;
      preserved: string;
      missing: string;
      evidenceRefs: string;
      status: string;
      nextCheck: string;
      revisit: string;
    }[];
    evidenceRows: string[];
  };
}
export interface StudyState {
  /** One finished question waiting for whichever new room opens next. Unused,
   * it touches no schedule, scope or door health. */
  preparedQuestion?: {
    provider: Provider;
    contract: Contract;
    problem: Problem;
  };
  /** Free-form AI impressions; separate from verified curriculum credit. */
  topicAssessments?: Record<
    string,
    import("./topic-assessment").TopicAssessmentRecord
  >;
  roadmapReconciliations?: import("./roadmap-adoption-types").RoadmapReconciliationJob[];
  roadmapAdoptionBackups?: import("./roadmap-adoption-types").RoadmapAdoptionBackup[];
  environmentReviews?: import("./environment-review").EnvironmentReviewJob[];
  environmentObservations?: import("./environment-observations").EnvironmentObservation[];
  roadmapExport?: import("./roadmap-export").RoadmapExport;
  /** Learner-declared gaps conceded at terminals; carried across runs, never mastery. */
  knowledgeGaps?: import("./knowledge-probe").KnowledgeGapRecord[];
  /** Facets established at terminals (answered or implied); carried across runs, never mastery. */
  knowledgeEstablished?: import("./knowledge-probe").KnowledgeEstablishedRecord[];
  /** Topic spawn variety: disabled topics and recent spawns; carried across runs. */
  topicSpawn?: import("./topic-spawn").TopicSpawn;
  profile?: "development" | "live";
  careerFocus?: "product-feature-owner" | "full";
  learner?: LearnerLedger;
  version: number;
  cycle: number;
  cycleOffset?: number;
  /** Completed human questions drive track balance separately from academic visits. */
  studyTurnPosition?: number;
  queues: Record<Track, string[]>;
  phases: Record<Track, string>;
  reviewsServed: string[];
  visits: { id: string; contract: Contract; encounter: string; at: string }[];
  pending?: { contract: Contract; encounter: string };
  session?: string;
  assessments: Assessment[];
  archives: Encounter[];
}
export interface Finding {
  objectiveId: string;
  facet: string;
  outcome: "independent" | "assisted" | "unknown" | "contradicted";
  depth?: number;
  execution?: "not-run" | "executed";
  evidence: number[];
  completeCheckpointScope: boolean;
  rationale: string;
}
export interface Assessment {
  /** Immutable provider request retained until an explicit retry succeeds. */
  request?: { provider: Provider; payloadJson: string };
  historicalMappings?: import("./learning-model").HistoricalFacetMapping[];
  id: string;
  encounter: string;
  sourceVersion: number;
  findings: Finding[];
  status: "pending" | "review-required" | "applied";
  provenance: string;
  evidenceCutoffSequence?: number;
  visitOutcome?: "usable" | "unresolved" | "invalid";
  scopeReviews?: {
    id: string;
    /** Whether the registered criteria cover the curriculum, not current learner mastery. */
    completeCoverage: boolean;
    rationale: string;
    definitionIssue?: {
      sourceHash: string;
      sourceQuote: string;
      missingCriterion: string;
    };
  }[];
  helpAttributions?: {
    messageId: string;
    facets: string[];
    rationale: string;
  }[];
}
export interface Point {
  x: number;
  y: number;
}
export interface PhysicsMotion {
  x: number;
  y: number;
  angular: number;
  awake: boolean;
  radius?: number;
}
export interface DoorState {
  frame: { x: number; y: number; w: number; h: number };
  hinge: Point;
  latched: boolean;
  release?: number;
  swung: boolean;
  side: -1 | 0 | 1;
}
export interface Actor extends Point {
  keys?: number;
  physics?: PhysicsMotion;
  /** Human-only vertical body, retained as plain data across saves. */
  elevated?: {
    feet: number;
    vx: number;
    vy: number;
    vz: number;
    peak: number;
    grounded: boolean;
  };
  technical?: import("./npc-cognition").NpcProfile;
  id: string;
  name: string;
  floor: number;
  hp: number;
  alive: boolean;
  escaped: boolean;
  heading: Point;
  speed: number;
  access: number[];
  inventory: Item[];
  target?: Point;
  navTarget?: Point;
  bodyTrail?: Point[];
  bodyTrailFloor?: number;
  bodyYield?: { points: Point[]; until: number };
  doorTraffic?: import("./door-traffic").DoorTraffic;
  trafficPass?: { side: -1 | 1; until: number; floor: number };
  routeGeometry?: string;
  fieldRouteSignature?: string;
  closingDoor?: { id: string; until: number; pushing?: boolean };
  doorCloseAttempt?: string;
  station?: string;
  noiseUntil?: number;
  noiseLevel?: number;
  blockedTime?: number;
  /** Net progress toward the current waypoint: its position, best distance and time of last improvement. */
  routeProgress?: { x: number; y: number; best: number; at: number };
  threatMemory?: import("./npc-threat-memory").ThreatMemory;
  studyLoop?: import("./npc-study-loop").StudyLoop;
  studyLoopCheckAt?: number;
  studyLoopBlockedSince?: number;
  fleeTarget?: Point;
  fleeUntil?: number;
  fleeFloor?: number;
  fleeRouteThreats?: string[];
  pickupTrip?: number;
  activity?:
    "exploring" | "defending" | "studying" | "fleeing" | "climbing" | "waiting";
  path: import("./navigation").NavStep[];
  repath: number;
  cooldown: number;
  intent?: string;
  taskSearch?: { floor: number; seen: number; after: number; station?: string };
  furnitureYield?: { floor: number; target: Point; until: number };
  thought: number;
  milestone: number;
  skill: number;
  risk: number;
  social: number;
  role: string;
  handling?: string;
  grip?: { object: string; local: Point; length?: number };
  pullingDoor?: { id: string; until: number; inside: -1 | 1 };
  defensePlan?: {
    encounter: string;
    object: string;
    target: Point;
    route: Point[];
    idle: number;
    bestDistance?: number;
    bestApproach?: number;
    exit?: Point;
  };
  defenseRetryAt?: number;
  exploringDoor?: { id: string; floor: number; goal: Point };
  exploreStall?: number;
  exploreProgress?: { target: Point; best: number };
  failedExplore?: { point: Point; floor: number; until: number }[];
  stairTravel?: import("./stair-travel").StairTravel;
  /** The staircase the survivor currently stands in; a flight starts only on walking in. */
  stairwell?: "up" | "down";
  vault?: {
    from: Point;
    to: Point;
    left: number;
    duration: number;
    obstacle?: string;
    obstacles?: string[];
  };
  seen: string[];
}
export interface Zombie extends Point {
  /** Physical city route retained across saves until the zombie reaches the door. */
  cityApproach?: import("./city-invasion").CityApproachState;
  bloodStep?: Point & { floor: number; right?: boolean };
  physics?: PhysicsMotion;
  id: string;
  floor: number;
  hp: number;
  path: Point[];
  repath: number;
  cooldown: number;
  target?: Point;
  memory: number;
  stagger: number;
  origin: "outside";
  stairUntil?: number;
  /** This zombie's own recent search, retained across checkpoints. */
  search?: {
    floor: number;
    trail: number[];
    heading: Point;
    decisions: number;
  };
}
export type FurnitureKind =
  | "chair"
  | "desk"
  | "sofa"
  | "fridge"
  | "shelf"
  | "gate"
  | "door"
  | "officeChair"
  | "table"
  | "cabinet"
  | "cooler"
  | "plant"
  | "printer"
  | "whiteboard"
  | "partition"
  | "coffeeMaker"
  | "microwave"
  | "vending"
  | "cafeTable"
  | "coffeeTable"
  | "reception"
  | "screen"
  | "box"
  | "drawers"
  | "armchair";
/** How a door looks; collision, access and health stay with the engine. */
export interface DoorStyle {
  material: "wood" | "steel" | "glass" | "fire" | "security";
  color: string;
  accent: string;
  window: "none" | "slit" | "half" | "full";
  label: string;
}
export interface Furniture extends Point {
  /** Immutable authored presentation; pose, damage and destruction stay native. */
  appearance?: {
    color: string;
    condition: import("./scene-catalog.mjs").SceneCondition;
    label?: string;
    owner: string | null;
    room: number;
    designId: string;
  };
  field?: {
    publicEntry?: boolean;
    touchVersion?: 1;
    authorized: string[];
    crossing: string[];
    sides: Record<string, number>;
    used: number;
    limit?: number;
    direction?: number;
    exit: boolean;
    visitors?: string[];
    /** Present only while the leaf is moving or held open. */
    leaf?: { open: number; side: number; hold: number };
  };
  doorStyle?: DoorStyle;
  physics?: PhysicsMotion;
  door?: DoorState;
  lastMoveTick?: number;
  initial?: { x: number; y: number; w: number; h: number; angle?: number };
  angle?: number;
  id: string;
  floor: number;
  kind: FurnitureKind;
  w: number;
  h: number;
  hp: number;
  maxHp: number;
  speed: number;
  rotation: number;
  destroyed: boolean;
  movers: string[];
  moved: number;
  credited: string[];
  lastBy?: string;
  turning: number;
  open?: boolean;
}
export interface Station extends Point {
  id: string;
  encounter: string;
}
/** Office function of a furnished room; it decides which objects it may hold. */
export type OfficeRoomType =
  "break" | "cubicles" | "meeting" | "storage" | "reception" | "manager";
/** The usable envelope, chosen once for a building. Right/bottom are exclusive.
 * Rows use world coordinates; partitions and furnishings never change this mask. */
export interface BuildingFootprint {
  version: 1;
  shape: "rectangle" | "chamfered" | "stepped" | "waisted";
  width: number;
  depth: number;
  top: number;
  bottom: number;
  rows: { left: number; right: number }[];
}
export interface Floor {
  /** This floor's exact accepted surfaces/entries and shared fragments. Its
   * fingerprint identifies the full canonical run inventory in Game.design. */
  environment?: import("./environment-contract.mjs").EnvironmentManifest;
  /** Resolved object anchors, retained with the run rather than rerolled on load. */
  scene?: import("./authored-scene").ResolvedScene;
  /** Frozen authored choices; shared by rendering, collisions and NPC facts. */
  design?: import("./run-design-contract.mjs").RunFloorDesign;
  /** Authored neighbourhood signs and skyline, stored on the ground floor. */
  exteriorDesign?: import("./run-design-contract.mjs").RunExteriorDesign;
  /** Persisted physical ground-level streets and urban obstacles for fresh runs. */
  city?: import("./city-layout").CityPlan;
  boundary?: BuildingFootprint;
  /** Room functions chosen when the floor was furnished (generation only). */
  office?: { zone: string; type: OfficeRoomType }[];
  blood?: (string | undefined)[];
  layout?: "gallery" | "archive" | "switchback" | "pursuit";
  rooms?: {
    index: number;
    side: "left" | "right";
    innerMouth?: Point;
    forwardExit?: Point;
    forwardEntry?: Point;
  }[];
  generation?: {
    version: 2 | 3 | 4 | 5;
    upperDivider: number;
    lowerDivider: number;
    stages?: { room: number; rear: number; front: number }[];
    /** Version 5 office floor plans: six chain sectors, entry to lobby. */
    sectors?: Sector[];
    /** Version 5 plan family chosen for this floor. */
    family?: "stack" | "columns" | "serpentine";
  };
  index: number;
  tiles: number[][];
  stations: Station[];
  furniture: Furniture[];
  dark: number;
  name: string;
  doors: Point[];
  stairs: Point;
  entry: Point;
}
export interface Artifact {
  executionId?: string;
  wallTime?: string;
  delta?: { prefix: number; removed: string; inserted: string };
  seq: number;
  author: string;
  kind:
    | "edit"
    | "reasoning"
    | "test"
    | "defense"
    | "npc-thought"
    | "npc-proposal"
    | "workspace-view"
    | "source-view"
    | "validation"
    | "activity"
    | "tutor"
    | "completion"
    | "starter"
    | "execution"
    | "chat";
  text: string;
  at: number;
  revision: number;
  refs?: string[];
  presented?: number;
}
export interface Message {
  sourceRefs?: number[];
  requestId?: string;
  id: string;
  author: string;
  kind: "human" | "npc" | "tutor" | "system";
  text: string;
  seq: number;
  worldTime: number;
  presented?: number;
  provenance: string;
}
export interface Submission {
  dialogueRequestId?: string;
  completionRequest?: {
    provider: Provider;
    payloadJson: string;
  };
  id: string;
  revision: number;
  author: string;
  content: string;
  status: "pending" | "complete" | "needs-work" | "error";
  feedback: string;
  seq: number;
}
export interface Problem {
  /** Generation-time typical active solve duration; local policy owns HP. */
  estimatedSolveSeconds?: number;
  runtime?: {
    language: "python" | "typescript";
    environment?: "react";
    steps?: import("../scripts/browser-runner/spec.mjs").BrowserStep[];
  };
  title: string;
  prompt: string;
  rubric: string[];
  starter: string;
  provenance: "development" | Provider;
  validation?: { kind: "trace"; answer: number };
  contract: Contract;
  scopeDefinitions?: ScopeDefinition[];
}
export interface TutorRequest {
  transportPhase?: import("./bridge-client").HandoffProgress;
  /** When transportPhase last changed (Date.now()); drives waiting hints. */
  transportPhaseAt?: number;
  id: string;
  provider: Provider;
  payloadJson: string;
  questionSequence: number;
  state: "pending" | "interrupted" | "applied" | "superseded";
  error?: string;
  responseMessageId?: string;
}
export interface DirectStudySession {
  id: string;
  createdAt?: number;
  responseReceivedAt?: number;
  appliedAt?: number;
  provider: Provider;
  payloadJson: string;
  questionFingerprint: string;
  state: "pending" | "interrupted" | "paused" | "applied" | "superseded";
  responseDigest?: string;
  error?: string;
  transportPhase?: import("./bridge-client").HandoffProgress;
  transportPhaseAt?: number;
}
export interface Encounter {
  /** Standalone learning task: no physical station or survival reward. */
  studyOnly?: boolean;
  /** Once-only human completion receipt for track balance, independent of rewards. */
  studyTurnRecorded?: boolean;
  directStudy?: DirectStudySession;
  chatDraft?: string;
  /** One question per room; answers, ownership and rewards remain per station. */
  questionRoom?: string;
  tutorRequests?: TutorRequest[];
  /** Terminal AI knowledge probe: facets, per-turn findings and answer signals. */
  probe?: import("./knowledge-probe").KnowledgeProbe;
  groupRequests?: (Omit<TutorRequest, "responseMessageId" | "state"> & {
    state: "pending" | "interrupted" | "applied" | "superseded";
  })[];
  simulatedOutcome?: import("./npc-outcome").SimulatedOutcome;
  outcomeInspection?: import("./npc-outcome").OutcomeInspection;
  outcomeNotice?: string;
  humanEngaged?: boolean;
  materializations?: import("./npc-materialization").Materialization[];
  materializationNotice?: string;
  proposals?: import("./workspace-proposals").WorkspaceProposal[];
  catchups?: import("./chat-catchup").CatchupBatch[];
  catchupNotice?: string;
  npcWork?: import("./npc-cognition").NpcWork[];
  groupRequest?: string;
  executions?: import("./execution").WorkspaceExecution[];
  runId?: string;
  problemPresentedSequence?: number;
  pendingGeneration?: {
    /** Legacy saved generation requests were always ChatGPT handoffs. */
    provider?: Provider;
    requestId: string;
    payload: Record<string, unknown>;
  };
  id: string;
  floor: number;
  mode: "solo" | "shared";
  reward: "stairs" | "loot";
  state: "available" | "in-progress" | "submitted" | "consumed";
  owner?: string;
  problem?: Problem;
  workspace: string;
  workspaceBase?: string;
  revision: number;
  history: Artifact[];
  group: Message[];
  tutor: Message[];
  submissions: Submission[];
  contributors: string[];
  accepted?: string;
  chatCursor: number;
  chatOpen: boolean;
  recentSpeakers: string[];
  npcProgress: number;
  loot: Item[];
  scroll: number;
  selection: [number, number];
  generation?: string;
  error?: string;
}
export interface Item {
  id: string;
  kind:
    "medkit" | "bubble" | "flare" | "repulsor" | "weapon" | "decoy" | "battery";
  weight: number;
  charges: number;
}
export interface WorldEvent {
  stairContact?: boolean;
  position?: Point;
  seq: number;
  at: number;
  type: string;
  actor?: string;
  floor: number;
  text: string;
  encounter?: string;
}
export interface Surge {
  state: "calm" | "warning" | "active";
  anchor: number;
  quietDelay: number;
  started: number;
  duration: number;
  lastDeath: number;
  lastEnd: number;
}
export interface Settings {
  /** Older saves use the first-person view when this preference is omitted. */
  view?: "first-person" | "top-down";
  /** Interface and world magnification; omitted by older saves (100%). */
  displayScale?: number;
  /** Local preference only; server release and capability are also required. */
  handoffAutonomous?: boolean;
  /** Temporary contextual computer speech; no clips are included in saves. */
  npcVoices?: boolean;
  /** Developer playtesting switch mirrored into DEV.passAllDoors. */
  passAllDoors?: boolean;
  volume: number;
  captions: boolean;
  reducedFlash: boolean;
}
export interface Game {
  /** First-start preview awaiting a completed, reviewed AI design. */
  preparingRun?: boolean;
  /** Accepted AI blueprint and provenance. Loading never requests a replacement. */
  design?: import("./run-design-contract.mjs").SavedRunDesign;
  /** Study workspace freezes the saved world while native study continues. */
  studyWorkspace?: { enabled: boolean; wasPaused: boolean; encounter?: string };
  fieldPacing?: import("./field-pacing").FieldPacing;
  rules?: "force-fields";
  tick?: number;
  schema: 1;
  id: string;
  seed: number;
  rng: number;
  time: number;
  seq: number;
  status: "ready" | "playing" | "dead" | "escaped";
  /** World time when the human died or escaped; captured once, world continues. */
  endedAt?: number;
  /** Undefined keeps historical timing; fresh playable runs use "study". */
  pacing?: "study" | "legacy";
  paused?: boolean;
  /** Last question actually opened by the human; stable across page reload. */
  lastStudyEncounter?: string;
  floors: Floor[];
  survivors: Actor[];
  zombies: Zombie[];
  encounters: Record<string, Encounter>;
  events: WorldEvent[];
  surge: Surge;
  nextSpawn: number;
  spawned: number;
  helicopter: {
    trip: number;
    next: number;
    until: number;
    passengers: string[];
  };
  effects: {
    kind: string;
    floor: number;
    x: number;
    y: number;
    until: number;
    radius: number;
  }[];
  study: StudyState;
  settings: Settings;
  stats: { breaches: number; rescued: number; deaths: number };
  notice: string;
}
export const W = 44,
  H = 34;
/** Developer switches for manual playtesting, driven by the settings panel. */
export const DEV = {
  /** The player passes every red force field and climbs every staircase
   * without a key or terminal credential. NPCs and zombies are unaffected.
   * Mirrors Game.settings.passAllDoors every frame. */
  passAllDoors: false,
};
/** Whether DEV mode lets this actor through any locked door or staircase. */
export const devPass = (a: Pick<Actor, "id">) =>
  DEV.passAllDoors && a.id === "human";
export const CONFIG = {
  floors: 4,
  npcs: 19,
  zombieSpeed: 2.05,
  spawnGraceSeconds: 10,
  playerSpeed: 3.3,
  npcSpeed: 2.9,
  quietMin: 420,
  quietMax: 720,
  warning: 12,
  surgeMin: 60,
  surgeMax: 120,
  stairSeconds: 2,
  helicopterInterval: 105,
  boardingWindow: 24,
  capacity: 6,
  spawnInterval: 8,
  openingHorde: 90,
  openingBatch: 3,
  reinforcementBatch: 1,
};
/** `resist` is the static floor friction (solver force units) an unheld object
 * offers before it slides. One pressing zombie supplies ZOMBIE_PUSH (30), so a
 * chair yields to one zombie while a fridge or shelf holds against a crowd. */
export const FURNITURE: Record<
  FurnitureKind,
  { w: number; h: number; hp: number; speed: number; resist: number }
> = {
  chair: { w: 0.8, h: 0.8, hp: 95, speed: 1.7, resist: 20 },
  desk: { w: 2.2, h: 1, hp: 850, speed: 0.8, resist: 160 },
  sofa: { w: 2.7, h: 1, hp: 1400, speed: 0.55, resist: 230 },
  fridge: { w: 1.1, h: 1.1, hp: 2100, speed: 0.38, resist: 340 },
  shelf: { w: 2.8, h: 1, hp: 3200, speed: 0.32, resist: 380 },
  gate: { w: 2, h: 0.7, hp: 600, speed: 0, resist: 0 },
  door: { w: 1, h: 3, hp: 240, speed: 0, resist: 0 },
  officeChair: { w: 0.7, h: 0.7, hp: 80, speed: 1.9, resist: 8 },
  table: { w: 3, h: 1.4, hp: 1000, speed: 0.5, resist: 210 },
  cabinet: { w: 0.9, h: 0.7, hp: 1300, speed: 0.5, resist: 270 },
  cooler: { w: 0.6, h: 0.6, hp: 160, speed: 1.1, resist: 40 },
  plant: { w: 0.7, h: 0.7, hp: 60, speed: 1.4, resist: 25 },
  printer: { w: 1.1, h: 0.8, hp: 450, speed: 0.75, resist: 120 },
  whiteboard: { w: 2, h: 0.35, hp: 220, speed: 1.1, resist: 45 },
  partition: { w: 2, h: 0.25, hp: 420, speed: 0.7, resist: 110 },
  // Break room counter units, vending machine and cafe furniture.
  coffeeMaker: { w: 0.9, h: 0.65, hp: 500, speed: 0.7, resist: 140 },
  microwave: { w: 0.9, h: 0.65, hp: 500, speed: 0.7, resist: 140 },
  vending: { w: 1, h: 0.85, hp: 2400, speed: 0.3, resist: 420 },
  cafeTable: { w: 0.9, h: 0.9, hp: 200, speed: 1.2, resist: 35 },
  // Reception and lounge seating.
  coffeeTable: { w: 1.2, h: 0.6, hp: 220, speed: 1.1, resist: 35 },
  reception: { w: 2.4, h: 0.9, hp: 1500, speed: 0.4, resist: 300 },
  armchair: { w: 0.9, h: 0.85, hp: 300, speed: 0.9, resist: 70 },
  // Meeting wall screen on a stand, archive boxes and desk pedestals.
  screen: { w: 1.6, h: 0.3, hp: 120, speed: 1, resist: 40 },
  box: { w: 0.55, h: 0.45, hp: 40, speed: 1.6, resist: 10 },
  drawers: { w: 0.45, h: 0.55, hp: 300, speed: 1, resist: 60 },
};
export const HELIPAD: Point = { x: 21.5, y: 10.5 };
export const HELIPAD_RADIUS = 2.8;

export function rand(g: { rng: number }) {
  let t = (g.rng += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  g.rng >>>= 0;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export type Rng = { rng: number };
export const between = (r: Rng, lo: number, hi: number) =>
  lo + Math.floor(rand(r) * (hi - lo + 1));
export function shuffle<T>(r: Rng, items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand(r) * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}
export const distance = (a: Point, b: Point) =>
  Math.hypot(a.x - b.x, a.y - b.y);
export function event(
  g: Game,
  type: string,
  text: string,
  floor = 0,
  actor?: string,
  encounter?: string,
): WorldEvent {
  const e = { seq: ++g.seq, at: g.time, type, text, floor, actor, encounter };
  g.events.push(e);
  if (g.events.length > 3000) g.events.splice(0, g.events.length - 3000);
  return e;
}
