export type ScenePropKind =
  | "mug"
  | "book"
  | "papers"
  | "pen"
  | "photo"
  | "note"
  | "plant"
  | "bottle"
  | "phone"
  | "box"
  | "lamp"
  | "trophy"
  | "headphones"
  | "record"
  | "cassette";
export type SceneFurnitureKind = Exclude<
  import("./model").FurnitureKind,
  "gate" | "door"
>;
export type SceneSurfaceKind =
  | "desk"
  | "table"
  | "cafeTable"
  | "coffeeTable"
  | "reception"
  | "cabinet"
  | "shelf"
  | "drawers"
  | "mixingConsole"
  | "recordShelf";
export type SceneCondition = "intact" | "worn" | "damaged";
export interface ScenePropDesign {
  id: string;
  kind: ScenePropKind;
  at: { x: number; y: number };
  angle: number;
  scale: number;
  color: string;
  accent: string;
  condition: SceneCondition;
  owner: string | null;
  label: string;
  text: string;
}
export interface SceneFurnitureDesign {
  id: string;
  kind: SceneFurnitureKind;
  at: { x: number; y: number };
  angle: number;
  color: string;
  condition: SceneCondition;
  owner: string | null;
  label: string;
  props: ScenePropDesign[];
}
export interface SceneRoomDesign {
  room: number;
  title: string;
  description: string;
  owner: string | null;
  palette: { surface: string; metal: string; accent: string };
  condition: "kept" | "worn" | "ransacked";
  furniture: SceneFurnitureDesign[];
}
export interface SceneFloorDesign {
  version: 1;
  rooms: SceneRoomDesign[];
}
export type ScenePropStructure = Omit<ScenePropDesign, "label" | "text">;
export interface SceneFurnitureStructure extends Omit<
  SceneFurnitureDesign,
  "label" | "props"
> {
  props: ScenePropStructure[];
}
export interface SceneRoomStructure extends Omit<SceneRoomDesign, "furniture"> {
  furniture: SceneFurnitureStructure[];
}
export interface SceneFloorStructure {
  version: 2;
  rooms: SceneRoomStructure[];
}
export const PROP_CATALOG: Readonly<
  Record<ScenePropKind, Readonly<{ w: number; d: number; h: number }>>
>;
export const SCENE_FURNITURE_KINDS: readonly SceneFurnitureKind[];
export const SCENE_SURFACE_KINDS: readonly SceneSurfaceKind[];
export const SCENE_LIMITS: Readonly<{ furniture: 16; props: 48 }>;
export function parseSceneDesign(
  value: unknown,
  rosterNames: readonly string[],
  path?: string,
): SceneFloorDesign;
export function parseSceneStructure(
  value: unknown,
  rosterNames: readonly string[],
  path?: string,
): SceneFloorStructure;
