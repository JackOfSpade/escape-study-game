import type { Furniture, FurnitureKind } from "../model";
import type { RunCustomObject } from "../setting-catalog.mjs";
import { surfaceTop } from "../setting-catalog.mjs";

const HEIGHT: Partial<Record<FurnitureKind, number>> = {
  chair: 0.48,
  officeChair: 0.48,
  armchair: 0.46,
  sofa: 0.46,
  desk: 0.8,
  table: 0.8,
  cafeTable: 0.76,
  coffeeTable: 0.42,
  reception: 1.05,
  fridge: 1.9,
  vending: 1.95,
  shelf: 1.8,
  cabinet: 1.15,
  drawers: 0.7,
  door: 2.35,
  gate: 2.4,
  whiteboard: 1.65,
  partition: 1.4,
  screen: 1.7,
  printer: 0.85,
  cooler: 0.9,
  coffeeMaker: 0.8,
  microwave: 0.8,
  plant: 0.42,
  box: 0.45,
  mixingConsole: 0.95,
  micStand: 1.55,
  recordShelf: 1.75,
  turntable: 0.95,
  studioMonitor: 1.3,
  equipmentRack: 1.95,
  soundPanel: 1.85,
  onAirLight: 2.1,
  reelToReel: 1.15,
};

/** Visible furniture height shared by meshes and target placement. */
export function furnitureHeight(kind: FurnitureKind) {
  return HEIGHT[kind] ?? 0.8;
}

/** Actual rendered top face for surface dressing, including tabletop thickness. */
export function furnitureSurfaceHeight(kind: FurnitureKind) {
  const height = furnitureHeight(kind);
  if (kind === "shelf") return height + 0.115;
  // Prop hosts: the flat fader deck and the top board between the side panels.
  if (kind === "mixingConsole") return 0.7;
  if (kind === "recordShelf") return height;
  if (["desk", "table", "cafeTable", "coffeeTable", "reception"].includes(kind))
    return height + 0.05;
  return height;
}

/** Shelves fit between side panels; their upper board does not span the full body. */
export function furnitureSurfaceBounds(
  kind: FurnitureKind,
  w: number,
  d: number,
) {
  if (kind === "mixingConsole") return { w: w * 0.96, d: d * 0.6 };
  if (kind === "recordShelf") return { w: w - 0.09, d };
  return { w: kind === "shelf" ? w * 0.84 : w, d };
}

type Instance = Pick<Furniture, "kind" | "object">;

/** Height of one placed object; a composed object carries its own envelope. */
export function furnitureHeightOf(o: Instance) {
  return o.kind === "custom" && o.object
    ? o.object.size.h
    : furnitureHeight(o.kind);
}

/** The prop-hosting part of a composed object: the widest flat top. */
export function surfacePart(object: RunCustomObject) {
  const top = surfaceTop(object);
  if (top === null) return undefined;
  let best: RunCustomObject["parts"][number] | undefined;
  for (const part of object.parts)
    if (
      (part.shape === "box" || part.shape === "cylinder") &&
      Math.abs(part.z + part.h - top) < 1e-6 &&
      (!best || part.w * part.d > best.w * best.d)
    )
      best = part;
  return best;
}

/** Instance-aware counterpart of furnitureSurfaceHeight. */
export function furnitureSurfaceHeightOf(o: Instance) {
  if (o.kind !== "custom" || !o.object) return furnitureSurfaceHeight(o.kind);
  return surfaceTop(o.object) ?? o.object.size.h;
}

/** Instance-aware counterpart of furnitureSurfaceBounds. */
export function furnitureSurfaceBoundsOf(o: Instance, w: number, d: number) {
  if (o.kind !== "custom" || !o.object)
    return furnitureSurfaceBounds(o.kind, w, d);
  const part = surfacePart(o.object);
  return part ? { w: part.w, d: part.d } : { w, d };
}
