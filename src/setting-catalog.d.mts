export type RunVenue = "office" | "broadcast" | "custom";
export type RunRoomFunction =
  "reception" | "break" | "cubicles" | "meeting" | "storage" | "manager";
export type RunObjectWeight = "light" | "medium" | "heavy";
export type RunObjectShape =
  | "box"
  | "cylinder"
  | "cone"
  | "sphere"
  | "wedge"
  | "torus"
  | "dome"
  | "capsule"
  | "hexprism"
  | "pyramid";
export type RunObjectRole =
  | "seat"
  | "surface"
  | "storage"
  | "equipment"
  | "display"
  | "divider"
  | "bed"
  | "decor"
  | "light";
export type RunObjectFinish = "matte" | "metal" | "glass" | "glow";
export type RunObjectAxis = "up" | "across" | "along";
/** One axis-aligned primitive in the object's local frame, in metres: x across
 * its width, y from back (-) to front (+), z up from the floor (part bottom). */
export interface RunObjectPart {
  shape: RunObjectShape;
  /** Cylinder/cone direction: up (z), across (x) or along (y). A wedge's slope
   * rises toward the back (up), +x (across) or the front (along); a torus
   * lies flat (up) or stands facing the front (along) or sideways (across). */
  axis: RunObjectAxis;
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  finish: RunObjectFinish;
  /** Tilt in degrees: pitch turns about x (tips toward the front), roll
   * about y (tips sideways). */
  pitch: number;
  roll: number;
  motion: RunObjectMotion;
  /** Cycles per second for the motion. */
  rate: number;
}
export type RunObjectMotion =
  "none" | "spin" | "bob" | "sway" | "pulse" | "flicker";
/** A small composed tabletop prop, placed by id as a scene prop kind. */
export interface RunCustomProp {
  id: string;
  name: string;
  size: { w: number; d: number; h: number };
  parts: RunObjectPart[];
}
export type RunGround =
  | "asphalt"
  | "cobble"
  | "sand"
  | "snow"
  | "grass"
  | "rock"
  | "regolith"
  | "seabed"
  | "ice"
  | "moss"
  | "mud"
  | "tile";
export type RunNeighborStyle =
  | "buildings"
  | "ruins"
  | "rocks"
  | "trees"
  | "ice"
  | "coral"
  | "dunes"
  | "crystals"
  | "tents"
  | "hedges";
export type RunWeather =
  | "none"
  | "rain"
  | "snow"
  | "bubbles"
  | "dust"
  | "embers"
  | "spores"
  | "ash"
  | "leaves"
  | "fireflies"
  | "petals";
/** The world around the building; streets and blocks keep their gameplay
 * shape and only change how they look. */
export interface RunSurroundings {
  ground: RunGround;
  groundColor: string;
  pathColor: string;
  sky: { zenith: string; horizon: string };
  fog: { color: string; density: number };
  neighbors: RunNeighborStyle;
  neighborColor: string;
  weather: RunWeather;
  /** Composed object ids scattered outside as visual scenery. */
  scenery: string[];
}
/** An AI-composed furniture type. Collision is its w×d footprint; health,
 * push resistance and drag speed come from OBJECT_WEIGHTS[weight]. */
export interface RunCustomObject {
  id: string;
  name: string;
  /** What the piece is for; the furnishing planner arranges by role. */
  role: RunObjectRole;
  weight: RunObjectWeight;
  size: { w: number; d: number; h: number };
  surface: boolean;
  parts: RunObjectPart[];
}
export type RunFloorFinish =
  | "carpet"
  | "studioCarpet"
  | "parquet"
  | "terrazzo"
  | "rubber"
  | "polished"
  | "lino"
  | "planks"
  | "flagstone"
  | "checker"
  | "grating"
  | "earth"
  | "mosaic";
export type RunFacade =
  | "concrete"
  | "brick"
  | "glass"
  | "stucco"
  | "metal"
  | "clapboard"
  | "stone"
  | "timber";
/** Interior wall surface; plaster is the plain painted wall. */
export type RunWallFinish =
  "plaster" | "brick" | "stone" | "wood" | "metal" | "tile";
export type RunWindowStyle = "punched" | "strip" | "ribbon" | "slit";
/** Enclosed is a building with four stacked floors; open is an open-air place
 * (a street market, a plaza, a campsite) with one ground-level floor. */
export type RunSiteForm = "enclosed" | "open";
export type RunCanopyStyle = "flat" | "gabled" | "marquee" | "none";
export type RunRoofFeatureKind =
  | "mast"
  | "dish"
  | "beacon"
  | "watertank"
  | "chimney"
  | "solar"
  | "vent"
  | "billboard";
export interface RunRoofFeature {
  /** A built-in roof kind or the id of one of setting.objects. */
  kind: RunRoofFeatureKind | (string & {});
  /** Normalized across the building's bounding box; resolved by the builder. */
  x: number;
  y: number;
}
export type RunTerminalStyle =
  "desk" | "console" | "lectern" | "pedestal" | "kiosk" | "altar" | "cabinet";
export interface RunTerminal {
  style: RunTerminalStyle;
  /** Main material colour. */
  body: string;
  /** Trim and secondary parts. */
  accent: string;
  /** The glowing face of the terminal. */
  screen: string;
}
export interface RunSetting {
  venue: RunVenue;
  /** What kind of place this is; optional so older saved designs stay valid,
   * where absent means "enclosed". */
  form?: RunSiteForm;
  interior: {
    roomFloor: RunFloorFinish;
    hallFloor: RunFloorFinish;
    roomTint: string;
    hallTint: string;
    wall: string;
    trim: string;
    /** Optional so older saved designs stay valid; plaster is the default. */
    wallFinish?: RunWallFinish;
    /** Ceiling light colour; absent is the current warm #f2d7a3. */
    light?: string;
  };
  exterior: {
    facade: RunFacade;
    facadeColor: string;
    trimColor: string;
    windows: RunWindowStyle;
    canopy: RunCanopyStyle;
    canopyGlow: string;
    roofFeatures: RunRoofFeature[];
  };
  /** The look of the study terminals, in the place's own idiom. */
  terminal: RunTerminal;
  objects: RunCustomObject[];
  props: RunCustomProp[];
  surroundings: RunSurroundings;
  /** The AI-drawn ground around the building (src/outdoor-plan.mjs). Absent
   * on older designs, which keep the engine's street grid. */
  outdoors?: import("./outdoor-plan.mjs").OutdoorPlan;
  /** For venue custom: furniture names (built-in kinds or object ids) that
   * furnish each room function the designer does not furnish itself. */
  filler: Record<RunRoomFunction, string[]> | null;
}
export const VENUES: readonly RunVenue[];
export const SITE_FORMS: readonly RunSiteForm[];
export const ROOM_FUNCTIONS: readonly RunRoomFunction[];
export const OBJECT_WEIGHTS: Readonly<
  Record<
    RunObjectWeight,
    Readonly<{ hp: number; speed: number; resist: number }>
  >
>;
export const OBJECT_SHAPES: readonly RunObjectShape[];
export const OBJECT_FINISHES: readonly RunObjectFinish[];
export const OBJECT_AXES: readonly RunObjectAxis[];
export const OBJECT_ROLES: readonly RunObjectRole[];
export const BUILTIN_ROLES: Readonly<Record<string, RunObjectRole>>;
export function furnitureRole(
  kind: string,
  object?: RunCustomObject | null,
): RunObjectRole;
export const OBJECT_LIMITS: Readonly<{
  objects: number;
  parts: number;
  totalParts: number;
  size: Readonly<{
    w: [number, number];
    d: [number, number];
    h: [number, number];
  }>;
  minPart: number;
  part: Readonly<
    Record<"x" | "y" | "z" | "w" | "d" | "h", readonly [number, number]>
  >;
}>;
export function surfaceTop(o: RunCustomObject): number | null;
export function parseCustomObject(o: unknown, path: string): RunCustomObject;
export function parseCustomProp(o: unknown, path: string): RunCustomProp;
/** Space a part can occupy in any pose (tilt and motion), object frame. */
export function partReach(part: RunObjectPart): {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
};
export const OBJECT_MOTIONS: readonly RunObjectMotion[];
export const MOTION_LIMITS: Readonly<{
  bob: number;
  sway: number;
  rate: readonly [number, number];
  tilt: number;
}>;
export const PROP_OBJECT_LIMITS: Readonly<{
  props: number;
  parts: number;
  totalParts: number;
  size: number;
}>;
export const GROUNDS: readonly RunGround[];
export const NEIGHBOR_STYLES: readonly RunNeighborStyle[];
export const WEATHERS: readonly RunWeather[];
export const SCENERY_LIMIT: number;
export const FLOOR_FINISHES: readonly RunFloorFinish[];
export const FACADES: readonly RunFacade[];
export const WALL_FINISHES: readonly RunWallFinish[];
export const WINDOW_STYLES: readonly RunWindowStyle[];
export const CANOPY_STYLES: readonly RunCanopyStyle[];
export const ROOF_FEATURE_KINDS: readonly RunRoofFeatureKind[];
export const ROOF_FEATURE_LIMIT: number;
export const TERMINAL_STYLES: readonly RunTerminalStyle[];
export const VENUE_ROOM_MEANINGS: Readonly<
  Record<
    Exclude<RunVenue, "custom">,
    Readonly<
      Record<
        "reception" | "break" | "cubicles" | "meeting" | "storage" | "manager",
        string
      >
    >
  >
>;
export function parseSetting(value: unknown, path?: string): RunSetting;
export const SETTING_GUIDANCE: string;
