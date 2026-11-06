import { doorFrame } from "../doors";
import { canReachStation, human } from "../engine";
import { fieldAllows, fieldPassable } from "../force-fields";
import type { Box } from "../furniture-geometry";
import { canGrip } from "../handling";
import {
  distance,
  type Actor,
  type Furniture,
  type Game,
  type Item,
  type Point,
  type Station,
} from "../model";
import { objectName } from "../render";
import { canSee, rayDistance } from "../visibility";

/** Distance along a floor-plane ray to an oriented footprint. The ray is
 * normalized here so the result and reach are always in simulation metres. */
const footprintInterval = { near: 0, far: 0 };
export function rayFootprintDistance(
  origin: Point,
  dx: number,
  dy: number,
  box: Box,
) {
  return rayFootprintInterval(origin, dx, dy, box, footprintInterval)
    ? footprintInterval.near
    : Infinity;
}

/** The complete slab interval also supports height-aware presentation rays. */
export function rayFootprintInterval(
  origin: Point,
  dx: number,
  dy: number,
  box: Box,
  out: { near: number; far: number },
) {
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length === 0 || box.w <= 0 || box.h <= 0)
    return false;
  const c = Math.cos(box.angle ?? 0),
    s = Math.sin(box.angle ?? 0),
    ox = (origin.x - box.x) * c + (origin.y - box.y) * s,
    oy = -(origin.x - box.x) * s + (origin.y - box.y) * c,
    vx = (dx * c + dy * s) / length,
    vy = (-dx * s + dy * c) / length;
  let near = 0,
    far = Infinity;
  if (Math.abs(vx) < 1e-10) {
    if (Math.abs(ox) > box.w / 2) return false;
  } else {
    const a = (-box.w / 2 - ox) / vx,
      b = (box.w / 2 - ox) / vx;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (Math.abs(vy) < 1e-10) {
    if (Math.abs(oy) > box.h / 2) return false;
  } else {
    const a = (-box.h / 2 - oy) / vy,
      b = (box.h / 2 - oy) / vy;
    near = Math.max(near, Math.min(a, b));
    far = Math.min(far, Math.max(a, b));
  }
  if (near > far) return false;
  out.near = near;
  out.far = far;
  return true;
}

/** Shared desktop layout keeps the drawn loot and its crosshair footprint aligned. */
export function lootSlot(station: Point, index: number, out: Point): Point {
  out.x = station.x - 0.35 + (index % 4) * 0.23;
  out.y = station.y + 0.03 + Math.floor(index / 4) * 0.2;
  return out;
}

export interface ReachableFootprint<T> {
  footprint: Box;
  reach: number;
  /** Equal priorities retain nearest-hit ordering. */
  priority?: number;
  value: T;
}
/** Pure crosshair selection; callers supply only normally reachable objects.
 * Pitch intentionally does not change the simulation's floor-plane reach. */
export function targetFootprint<T>(
  origin: Point,
  yaw: number,
  candidates: readonly ReachableFootprint<T>[],
  obstruction = Infinity,
): T | undefined {
  let nearest = Infinity,
    priority = -Infinity,
    target: T | undefined;
  const dx = Math.cos(yaw),
    dy = Math.sin(yaw);
  for (const candidate of candidates) {
    const hit = rayFootprintDistance(origin, dx, dy, candidate.footprint),
      rank = candidate.priority ?? 0;
    if (
      hit <= candidate.reach &&
      hit <= obstruction + 1e-7 &&
      (rank > priority || (rank === priority && hit < nearest))
    ) {
      nearest = hit;
      priority = rank;
      target = candidate.value;
    }
  }
  return target;
}

export type LookTarget =
  | { kind: "station"; station: Station }
  | { kind: "door"; object: Furniture }
  | { kind: "grip"; object: Furniture }
  | { kind: "item"; encounter: string; item: Item };

/** Selection grants no extra reach or permissions: E still calls the real
 * engine APIs. This query is shared by E and the throttled HUD prompt. */
export function lookTarget(game: Game, yaw: number): LookTarget | undefined {
  const a = human(game),
    floor = game.floors[a.floor],
    dx = Math.cos(yaw),
    dy = Math.sin(yaw),
    obstruction = rayDistance(floor, a, yaw, 2),
    candidates: ReachableFootprint<LookTarget>[] = [];
  for (const o of floor.furniture) {
    if (o.destroyed || o.kind === "gate") continue;
    const hit = rayFootprintDistance(a, dx, dy, o);
    if (hit > 1.9 || hit > obstruction + 1e-7) continue;
    if (hit <= 1.05 && !o.field && o.turning <= 0 && canGrip(floor, a, o))
      candidates.push({
        footprint: o,
        reach: 1.05,
        priority: 1,
        value: { kind: "grip", object: o },
      });
    if (
      o.kind === "door" &&
      distance(a, doorFrame(o)) < 1.9 &&
      canSee(floor, a, doorFrame(o), 1.9, o.id)
    )
      candidates.push({
        footprint: o,
        reach: 1.9,
        priority: 2,
        value: { kind: "door", object: o },
      });
  }
  for (const station of floor.stations) {
    const e = game.encounters[station.encounter];
    if (
      canReachStation(game, a, station) &&
      !(e?.state === "consumed" && e.reward === "loot" && e.loot.length)
    )
      candidates.push({
        footprint: { ...station, w: 0.98, h: 0.65 },
        reach: 1.9,
        priority: 3,
        value: { kind: "station", station },
      });
    if (
      e?.state !== "consumed" ||
      e.reward !== "loot" ||
      !e.contributors.includes(a.id) ||
      !canReachStation(game, a, station, 2)
    )
      continue;
    for (let i = 0; i < e.loot.length; i++)
      candidates.push({
        footprint: {
          ...lootSlot(station, i, { x: 0, y: 0 }),
          w: 0.2,
          h: 0.18,
        },
        reach: 2,
        priority: 4,
        value: { kind: "item", encounter: e.id, item: e.loot[i] },
      });
  }
  return targetFootprint(a, yaw, candidates, obstruction);
}

/** An open door needs no prompt when it admits this person. */
export function accessDoorPrompt(o: Furniture, a: Actor) {
  if (fieldPassable(o, a)) return "";
  if (fieldAllows(o, a)) return "E · Open door";
  return (a.keys ?? 0) > 0
    ? "E · Use key to open door"
    : "Locked · needs a key or a solved terminal";
}

export function lookTargetPrompt(game: Game, target: LookTarget) {
  if (target.kind === "item")
    return `E · Take ${objectName(target.item.kind).toLowerCase()}`;
  if (target.kind === "grip")
    return `E · Grip ${objectName(target.object.kind, target.object.object).toLowerCase()}`;
  if (target.kind === "door") {
    if (target.object.field)
      return accessDoorPrompt(target.object, human(game));
    return target.object.door?.latched
      ? "E · Release door latch"
      : "Push to swing door";
  }
  const e = game.encounters[target.station.encounter],
    a = human(game);
  if (e?.state === "consumed") return "Terminal complete";
  if (e?.mode === "solo" && e.owner && e.owner !== a.id)
    return "Terminal in use";
  return "E · Open terminal";
}
