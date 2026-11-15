import type {
  QualityRunDesignRequest,
  QualityRunDesignReply,
} from "./run-quality-contract.mjs";
export * from "./run-quality-contract.mjs";
export type { RunSetting, RunSiteForm } from "./setting-catalog.mjs";
export type RunFootprintShape =
  | "rectangle"
  | "chamfered"
  | "stepped"
  | "waisted"
  | "tapered"
  | "notched"
  | "tee";
export declare const FOOTPRINT_SHAPES: readonly RunFootprintShape[];
export type RunRoomType =
  "break" | "cubicles" | "meeting" | "storage" | "reception" | "manager";
export type RunPower = "lit" | "dim" | "outage";
export interface RunStory {
  title: string;
  lines: string[];
}
export interface RunDoorDesign {
  material: "wood" | "steel" | "glass" | "fire" | "security";
  color: string;
  accent: string;
  window: "none" | "slit" | "half" | "full";
  label: string;
  health: number;
}
export interface LegacyRunFloorDesign {
  doors?: RunDoorDesign[];
  /** Required for version 2 designs; absent from historical version 1 data. */
  scene?: SceneFloorDesign;
  name: string;
  family: "stack" | "columns" | "serpentine";
  roomOrder: number[];
  layoutSeed: number;
  roomTypes: RunRoomType[];
  subroomKinds: ("office" | "meeting" | "storage" | "break")[];
  furnitureDensity: number;
  fieldQuotas: number[];
  power: RunPower[];
  stories: RunStory[];
  brokenGuard: { segment: 3 | 4; bay: 1 | 2 };
}
export interface LegacyRunExteriorDesign {
  buildingName: string;
  buildingSubtitle: string;
  quarantineTitle: string;
  quarantineSubtitle: string;
  streetLabels: string[];
  skyline: { minHeight: number; maxHeight: number; damageRate: number };
}
export type RunTitleCardFontGroup =
  | "sans"
  | "condensed"
  | "serif"
  | "display"
  | "mono"
  | "techno"
  | "handwritten"
  | "horror";
export type RunTitleCardFont =
  | "space-grotesk"
  | "dm-sans"
  | "archivo-black"
  | "oswald"
  | "bebas-neue"
  | "playfair-display"
  | "cormorant-garamond"
  | "libre-baskerville"
  | "special-elite"
  | "courier-prime"
  | "ibm-plex-mono"
  | "vt323"
  | "creepster"
  | "caveat"
  | "permanent-marker"
  | "inter"
  | "manrope"
  | "work-sans"
  | "rubik"
  | "josefin-sans"
  | "anton"
  | "league-gothic"
  | "barlow-condensed"
  | "big-shoulders-display"
  | "eb-garamond"
  | "crimson-pro"
  | "lora"
  | "spectral"
  | "old-standard-tt"
  | "im-fell-english"
  | "dm-serif-display"
  | "cinzel"
  | "bitter"
  | "abril-fatface"
  | "bodoni-moda"
  | "limelight"
  | "poiret-one"
  | "monoton"
  | "rye"
  | "bungee"
  | "black-ops-one"
  | "stardos-stencil"
  | "alfa-slab-one"
  | "jetbrains-mono"
  | "space-mono"
  | "share-tech-mono"
  | "major-mono-display"
  | "orbitron"
  | "audiowide"
  | "press-start-2p"
  | "homemade-apple"
  | "reenie-beanie"
  | "kalam"
  | "shadows-into-light"
  | "rock-salt"
  | "patrick-hand"
  | "nosifer"
  | "eater"
  | "unifrakturmaguntia"
  | "pirata-one"
  | "metal-mania";
export interface RunTitleCardStyle {
  font: RunTitleCardFont;
  color: string;
  size: number;
}
/** Designer-chosen typography for the black opening screen. */
export interface RunTitleCard {
  title: RunTitleCardStyle;
  story: RunTitleCardStyle;
}
export declare const TITLE_CARD_FONTS: Record<
  RunTitleCardFont,
  { family: string; fallback: string; group: RunTitleCardFontGroup }
>;
export declare const TITLE_CARD_FONT_GROUPS: readonly RunTitleCardFontGroup[];
export declare const TITLE_CARD_SIZES: {
  title: [number, number];
  story: [number, number];
};
export interface LegacyRunDesign {
  mainDoor?: RunDoorDesign;
  titleCard?: RunTitleCard;
  version: 1 | 2;
  title: string;
  premise: string;
  opening: string;
  footprint: {
    shape: RunFootprintShape;
    width: 36 | 38 | 40;
    top: number;
    inset: number;
    mirrored: boolean;
    shoulder: number;
  };
  floors: LegacyRunFloorDesign[];
  roofName: string;
  roster: {
    name: string;
    role: "builder" | "analyst" | "rusher" | "medic" | "skeptic";
    skill: number;
    risk: number;
    social: number;
  }[];
  city: {
    roadWidth: number;
    boulevardOffset: number;
    districtSize: number;
    buildingHeightMin: number;
    buildingHeightMax: number;
    damageRate: number;
    palette: string[];
  };
  exterior: LegacyRunExteriorDesign;
  pacing: {
    swarmInterval: number;
    swarmBatch: number;
    swarmCap: number;
    npcThinkingScale: number;
    firstHelicopter: number;
    helicopterInterval: number;
  };
}
export type RunRoomShape = "rect" | "chamfered" | "rounded" | "octagon";
export declare const ROOM_SHAPES: readonly RunRoomShape[];
export type RunHallSide = "n" | "s" | "e" | "w";
/** One large room in place of two or three gated study rooms (floors[].hall).
 * Heights are metres; the engine turns every level change into steps. */
export interface RunHall {
  /** The merged study rooms (two or three of 0, 1, 3), adjacent in roomOrder. */
  rooms: number[];
  /** The wall the hall faces: its stage, screen or altar side. */
  focus: RunHallSide;
  seating: "rows" | "none";
  stage: { depth: number; height: number } | null;
  /** Rise of the floor from the focus side to the far side. */
  rake: number;
  pit: { width: number; length: number; drop: number } | null;
  platforms: {
    side: RunHallSide;
    width: number;
    depth: number;
    height: number;
  }[];
}
export declare const HALL_LIMITS: {
  readonly sides: readonly RunHallSide[];
  readonly seating: readonly ("rows" | "none")[];
  readonly stage: { depth: [number, number]; height: [number, number] };
  readonly rake: [number, number];
  readonly pit: {
    width: [number, number];
    length: [number, number];
    drop: [number, number];
  };
  readonly platforms: number;
  readonly platform: {
    width: [number, number];
    depth: [number, number];
    height: [number, number];
  };
};
/** A hall's features without the merged-room list: a drawn room's own. */
export type RunHallFeatures = Omit<RunHall, "rooms">;
/** How a drawn room's own furniture list is arranged (version 4). */
export type RunRoomPattern =
  | "rows"
  | "clusters"
  | "counter"
  | "lounge"
  | "table"
  | "shelving"
  | "display"
  | "bays"
  | "desk"
  | "open";
export declare const ROOM_PATTERNS: readonly RunRoomPattern[];
/** How a version 4 structure draws its floors (part of RUN_DESIGN_GUIDANCE). */
export declare const DRAWN_FLOOR_GUIDANCE: string;
export declare const FREE_PLAN_LIMITS: {
  readonly rooms: [number, number];
  readonly size: [number, number];
  readonly doors: [number, number];
  readonly work: [number, number];
  readonly floorWork: [number, number];
  readonly filler: [number, number];
};
export interface RunFurnishing {
  pattern: RunRoomPattern;
  /** Built-in furniture kinds or setting.objects ids, signature piece first. */
  filler: string[];
}
/** One room of a version 4 floor, drawn in building cells (interior). */
export interface RunFreeRoom extends RunFurnishing {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape: RunRoomShape;
  power: RunPower;
  /** Two-cell doorways: the wall and the position along it (0..1). */
  doors: {
    side: RunHallSide;
    at: number;
    /** A hinged door opened by hand, or null for an open doorway. */
    door: RunDoorDesign | null;
  }[];
  /** Study work points the engine places in this room. */
  work: number;
  hall: RunHallFeatures | null;
}
/** One storey of a version 4 design: walled rooms in an open concourse. */
export interface RunFreeFloor {
  name: string;
  furnitureDensity: number;
  concourse: RunFurnishing;
  rooms: RunFreeRoom[];
  scene: SceneFloorStructure;
}
export interface RunFloorStructureV3 extends Omit<
  LegacyRunFloorDesign,
  "stories" | "scene"
> {
  scene: SceneFloorStructure;
  /** Per study room 0..3; absent means rectangular as before. */
  roomShapes?: RunRoomShape[];
  /** A hall in place of several study rooms; absent or null means none. */
  hall?: RunHall | null;
}
/** A chain floor's design. A version 4 floor (RunFreeFloor) is stored in the
 * same Floor.design slot; read it through isFreePlan() in src/free-plan.ts. */
export type RunFloorDesign = LegacyRunFloorDesign | RunFloorStructureV3;
export type RunExteriorStructureV3 = Omit<
  LegacyRunExteriorDesign,
  "streetLabels"
>;
export type RunExteriorDesign =
  LegacyRunExteriorDesign | RunExteriorStructureV3;
export interface RunRelationship {
  from: string;
  to: string;
  kind: "colleague" | "friend" | "relative" | "mentor" | "rival";
  detail: string;
}
export interface RunStructureV3 extends Omit<
  LegacyRunDesign,
  "version" | "floors" | "exterior"
> {
  mainDoor?: RunDoorDesign;
  /** Venue, finishes and exterior style; absent on designs made before it. */
  setting?: import("./setting-catalog.mjs").RunSetting;
  version: 3;
  floors: RunFloorStructureV3[];
  exterior: RunExteriorStructureV3;
  relationships: RunRelationship[];
}
export interface RunDesignV3 extends RunStructureV3 {
  environment: EnvironmentManifest;
}
/** Version 4: a version 3 structure whose floors are drawn freely. */
export interface RunStructureV4 extends Omit<
  RunStructureV3,
  "version" | "floors" | "setting"
> {
  version: 4;
  setting: import("./setting-catalog.mjs").RunSetting;
  floors: RunFreeFloor[];
}
export interface RunDesignV4 extends RunStructureV4 {
  environment: EnvironmentManifest;
}
/** A structure proposal of either current version. */
export type RunStructure = RunStructureV3 | RunStructureV4;
/** Versions 1 to 3. A version 4 design travels through the same slots
 * (SavedRunDesign.design, Game.design); narrow it with isDrawnDesign(). */
export type RunDesign = LegacyRunDesign | RunDesignV3;
/** Version 3 and later (a version 4 design shares the version 3 slots): each
 * writing surface is its own inventory entry and the design has an
 * environment manifest. */
export function isInventoryDesign(design: unknown): design is RunDesignV3;
export function isDrawnDesign(
  design: unknown,
): design is RunStructureV4 | RunDesignV4;
export interface SavedRunDesign {
  version: 1;
  source: "chatgpt-handoff" | "claude-cli" | "fixture";
  requestId: string;
  generationId: string;
  fingerprint: string;
  design: RunDesign;
}
export interface RunDesignSummary {
  title: string;
  premise: string;
  spatial: string;
  atmosphere: string;
  cast: string;
  tempo: string;
}
export interface LegacyRunDesignRequest {
  version: 1;
  /** Absent on retained version 1 requests; never inserted during retry. */
  designVersion?: 2;
  requestId: string;
  generationId: string;
  seed: number;
  recent: RunDesignSummary[];
  repair?: { candidate: LegacyRunDesign; errors: string[] };
}
export interface LegacyRunDesignReply {
  requestId: string;
  design: LegacyRunDesign;
}
export interface StructureRunDesignRequest {
  version: 2;
  designVersion: 3;
  phase: "structure";
  requestId: string;
  generationId: string;
  seed: number;
  recent: RunDesignSummary[];
  repair?: { candidate: RunStructure; errors: string[] };
}
export interface ContentRunDesignRequest {
  version: 2;
  designVersion: 3;
  phase: "content";
  requestId: string;
  generationId: string;
  seed: number;
  structure: RunStructure;
  structureFingerprint: string;
  builderVersion: string;
  surfaces: SurfaceSlot[];
  surfaceFingerprint: string;
  recentContent: EnvironmentSummary[];
  repair?: { candidate: EnvironmentContent; errors: string[] };
}
export type RunDesignRequest =
  | LegacyRunDesignRequest
  | StructureRunDesignRequest
  | ContentRunDesignRequest
  | QualityRunDesignRequest;
export interface RunStructureReply {
  requestId: string;
  structure: RunStructure;
}
export interface RunContentReply {
  requestId: string;
  content: EnvironmentContent;
}
export type RunDesignReply =
  | LegacyRunDesignReply
  | RunStructureReply
  | RunContentReply
  | QualityRunDesignReply;
export const RUN_DESIGN_GUIDANCE: string;
export function parseRunDesign(value: LegacyRunDesign): LegacyRunDesign;
export function parseRunDesign(value: RunDesignV3): RunDesignV3;
export function parseRunDesign(value: unknown): RunDesign;
export function parseRunStructure(value: unknown): RunStructure;
export function parseRunDesignRequest(value: {
  version: 1;
  [key: string]: unknown;
}): LegacyRunDesignRequest;
export function parseRunDesignRequest(value: {
  version: number;
  phase?: never;
  [key: string]: unknown;
}): LegacyRunDesignRequest;
export function parseRunDesignRequest(value: {
  version: 2;
  phase: "structure";
  [key: string]: unknown;
}): StructureRunDesignRequest;
export function parseRunDesignRequest(value: {
  version: 2;
  phase: "content";
  [key: string]: unknown;
}): ContentRunDesignRequest;
export function parseRunDesignRequest(value: {
  version: 3;
  [key: string]: unknown;
}): QualityRunDesignRequest;
export function parseRunDesignRequest(value: unknown): RunDesignRequest;
export function parseRunDesignReply(
  value: unknown,
  request: LegacyRunDesignRequest,
): LegacyRunDesignReply;
export function parseRunDesignReply(
  value: unknown,
  request: StructureRunDesignRequest,
): RunStructureReply;
export function parseRunDesignReply(
  value: unknown,
  request: ContentRunDesignRequest,
): RunContentReply;
export function parseRunDesignReply(
  value: unknown,
  request: QualityRunDesignRequest,
): QualityRunDesignReply;
export function parseRunDesignReply(
  value: unknown,
  request: RunDesignRequest,
): RunDesignReply;
export function parseRunStructureReply(
  value: unknown,
  request: StructureRunDesignRequest,
): RunStructureReply;
export function parseRunContentReply(
  value: unknown,
  request: ContentRunDesignRequest,
): RunContentReply;
export function parseRunContentRepairCandidate(
  value: unknown,
  request: ContentRunDesignRequest,
): EnvironmentContent;
/** The longest spatial, atmosphere, cast or tempo text a request accepts. */
export declare const RUN_DESIGN_SUMMARY_LIMIT: number;
export function summarizeRunDesign(
  design: RunDesign | RunStructure,
): RunDesignSummary;
export function runDesignNoveltyErrors(
  design: RunDesign | RunStructure,
  recent: RunDesignSummary[],
): string[];
export function titleCardSpoilerErrors(
  design: RunDesign | RunStructure,
): string[];
export function runDesignFingerprint(design: unknown): string;
export function runStructureFingerprint(design: RunStructure): string;
export function parseSavedRunDesign(value: unknown): SavedRunDesign;
import type {
  SceneFloorDesign,
  SceneFloorStructure,
} from "./scene-catalog.mjs";
import type {
  SurfaceSlot,
  EnvironmentManifest,
  EnvironmentContent,
  EnvironmentSummary,
} from "./environment-contract.mjs";
export {
  parseEnvironmentManifest,
  parseEnvironmentContent,
  parseEnvironmentSurfaces,
  parseEnvironmentSummaries,
  environmentSurfaceFingerprint,
  summarizeEnvironment,
} from "./environment-contract.mjs";
export type {
  SurfaceSlot,
  SurfaceContent,
  EnvironmentManifest,
  EnvironmentContent,
  EnvironmentSummary,
} from "./environment-contract.mjs";
