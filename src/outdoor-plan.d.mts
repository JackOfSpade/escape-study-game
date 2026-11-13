import type { RunGround } from "./setting-catalog.mjs";

export type OutdoorWalkableKind = "path" | "plaza";
export type OutdoorOpaqueKind =
  | "building"
  | "rocks"
  | "cliff"
  | "trees"
  | "ice"
  | "coral"
  | "dunes"
  | "crystals"
  | "tents"
  | "hedges"
  | "ruins"
  | "dome-wall"
  | "structure"
  | "vehicle";
export type OutdoorLowKind = "water" | "fence" | "low-wall";
export type OutdoorSolidKind = OutdoorOpaqueKind | OutdoorLowKind;
export type OutdoorRegionKind = OutdoorWalkableKind | OutdoorSolidKind;
export type OutdoorShape = "rect" | "disc" | "ring";
export type OutdoorEnclosure = "open-sky" | "dome" | "cavern";
export type OutdoorBackdrop =
  | "skyline"
  | "mountains"
  | "sea"
  | "dunes"
  | "forest"
  | "ice-field"
  | "stars"
  | "cavern-wall"
  | "none";

interface RegionBase {
  kind: OutdoorRegionKind;
  color: string;
  /** Solid kinds only: visual height in metres. */
  height?: number;
  /** Walkable kinds only: the surface of this path or plaza. */
  ground?: RunGround;
}
export interface OutdoorRectRegion extends RegionBase {
  shape: "rect";
  /** Centre and extents in metres, in the start site's frame. */
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OutdoorDiscRegion extends RegionBase {
  shape: "disc";
  x: number;
  y: number;
  r: number;
}
export interface OutdoorRingRegion extends RegionBase {
  shape: "ring";
  x: number;
  y: number;
  r: number;
  thickness: number;
  /** Openings, centred at `angle` degrees (0 = +x/east, 90 = +y/south). */
  gaps: { angle: number; width: number }[];
}
export type OutdoorRegion =
  OutdoorRectRegion | OutdoorDiscRegion | OutdoorRingRegion;

export interface OutdoorPlan {
  version: 1;
  bounds: { left: number; right: number; top: number; bottom: number };
  /** The walkable ground everywhere no region covers. */
  ground: RunGround;
  enclosure: OutdoorEnclosure;
  backdrop: OutdoorBackdrop;
  regions: OutdoorRegion[];
}

export interface OutdoorRectangle {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OutdoorSolid extends OutdoorRectangle {
  kind: OutdoorSolidKind;
  height: number;
  color: string;
  opaque: boolean;
  region: number;
}
export interface OutdoorSite {
  building: { left: number; right: number; top: number; bottom: number };
  entrance: { x: number; y: number };
  keepClear: OutdoorRectangle[];
}

export const OUTDOOR_VERSION: 1;
export const OUTDOOR_WALKABLE_KINDS: readonly OutdoorWalkableKind[];
export const OUTDOOR_OPAQUE_KINDS: readonly OutdoorOpaqueKind[];
export const OUTDOOR_LOW_KINDS: readonly OutdoorLowKind[];
export const OUTDOOR_REGION_KINDS: readonly OutdoorRegionKind[];
export const OUTDOOR_SHAPES: readonly OutdoorShape[];
export const OUTDOOR_ENCLOSURES: readonly OutdoorEnclosure[];
export const OUTDOOR_BACKDROPS: readonly OutdoorBackdrop[];
export const OUTDOOR_LIMITS: Readonly<{
  regions: number;
  compiled: number;
  reach: number;
  margin: number;
  size: [number, number];
  radius: [number, number];
  thickness: [number, number];
  height: [number, number];
  gaps: number;
  gapWidth: [number, number];
  minWalkable: number;
  apron: [number, number];
}>;
export function isWalkableKind(kind: string): kind is OutdoorWalkableKind;
export function isOpaqueKind(kind: string): kind is OutdoorOpaqueKind;
export function parseOutdoorPlan(value: unknown, path?: string): OutdoorPlan;
export function regionRectangles(region: OutdoorRegion): OutdoorRectangle[];
export function rectanglesOverlap(
  a: OutdoorRectangle,
  b: OutdoorRectangle,
  pad?: number,
): boolean;
export function subtractRectangle(
  a: OutdoorRectangle,
  b: OutdoorRectangle,
): OutdoorRectangle[];
export function outdoorSolids(plan: OutdoorPlan): OutdoorSolid[];
export function checkOutdoorGeometry(
  plan: OutdoorPlan,
  site: OutdoorSite,
): string[];
export function outdoorSummary(plan: OutdoorPlan): {
  enclosure: OutdoorEnclosure;
  backdrop: OutdoorBackdrop;
  ground: RunGround;
  kinds: OutdoorRegionKind[];
};
