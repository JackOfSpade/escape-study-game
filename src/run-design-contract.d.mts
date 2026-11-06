import type {
  QualityRunDesignRequest,
  QualityRunDesignReply,
} from "./run-quality-contract.mjs";
export * from "./run-quality-contract.mjs";
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
  | "permanent-marker";
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
  { family: string; fallback: string }
>;
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
    shape: "rectangle" | "chamfered" | "stepped" | "waisted";
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
export interface RunFloorStructureV3 extends Omit<
  LegacyRunFloorDesign,
  "stories" | "scene"
> {
  scene: SceneFloorStructure;
}
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
  version: 3;
  floors: RunFloorStructureV3[];
  exterior: RunExteriorStructureV3;
  relationships: RunRelationship[];
}
export interface RunDesignV3 extends RunStructureV3 {
  environment: EnvironmentManifest;
}
export type RunDesign = LegacyRunDesign | RunDesignV3;
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
  repair?: { candidate: RunStructureV3; errors: string[] };
}
export interface ContentRunDesignRequest {
  version: 2;
  designVersion: 3;
  phase: "content";
  requestId: string;
  generationId: string;
  seed: number;
  structure: RunStructureV3;
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
  structure: RunStructureV3;
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
export function parseRunStructure(value: unknown): RunStructureV3;
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
export function summarizeRunDesign(
  design: RunDesign | RunStructureV3,
): RunDesignSummary;
export function runDesignNoveltyErrors(
  design: RunDesign | RunStructureV3,
  recent: RunDesignSummary[],
): string[];
export function runDesignFingerprint(design: unknown): string;
export function runStructureFingerprint(design: RunStructureV3): string;
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
