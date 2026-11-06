import { propWorldPose } from "./authored-scene";
import { type Actor, type Floor, type Game, type Point } from "./model";
import { rayBoxDistance, wallRayDistance } from "./visibility";
import { furnitureSurfaceHeightOf } from "./view3d/furniture-height";
import { FLOOR_HEIGHT } from "./stair-route";
import { surfaceWorldPose } from "./environment-surfaces";
import {
  expandContentText,
  type EnvironmentManifest,
} from "./environment-contract.mjs";

export interface SceneObservation extends Point {
  id: string;
  title: string;
  text: string;
  /** Metres above this floor; used for the line-of-sight check. */
  elevation: number;
}
const environmentReadings = new WeakMap<
  EnvironmentManifest,
  Map<string, { title: string; text: string }>
>();
function readings(environment: EnvironmentManifest) {
  let entries = environmentReadings.get(environment);
  if (!entries) {
    entries = new Map(
      environment.entries.map((entry) => [
        entry.surfaceId,
        {
          title: expandContentText(entry.title, environment.fragments),
          text: [
            expandContentText(entry.body, environment.fragments),
            entry.drawing && entry.description
              ? `Drawing: ${entry.description}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ]),
    );
    environmentReadings.set(environment, entries);
  }
  return entries;
}

/** Short-range reading respects opaque geometry, including the supporting desk.
 * A tabletop above the observer's eye cannot be read through its cabinet. */
function readable(
  floor: Floor,
  origin: Point,
  eye: number,
  target: SceneObservation,
) {
  const dx = target.x - origin.x,
    dy = target.y - origin.y,
    length = Math.hypot(dx, dy);
  if (length < 0.001) return true;
  const vx = dx / length,
    vy = dy / length;
  if (
    wallRayDistance(floor, origin, Math.atan2(dy, dx), length) <
    length - 0.04
  )
    return false;
  for (const object of floor.furniture) {
    if (object.destroyed || object.field) continue;
    const near = rayBoxDistance(origin, vx, vy, object);
    if (near >= length - 0.015) continue;
    const reverse = rayBoxDistance(target, -vx, -vy, object),
      far = Math.min(length - 0.015, length - reverse);
    if (!Number.isFinite(near) || far < near) continue;
    const entry = eye + (target.elevation - eye) * (near / length),
      exit = eye + (target.elevation - eye) * (far / length);
    if (
      Math.min(entry, exit) < furnitureSurfaceHeightOf(object) &&
      Math.max(entry, exit) > 0
    )
      return false;
  }
  return true;
}

/** Only nearby, currently visible inscriptions become knowledge. The complete
 * fictional room manifest is never disclosed as an NPC's unseen knowledge. */
export function observableSceneDetails(
  game: Game,
  actor: Actor,
  limit = 4,
): SceneObservation[] {
  const floor = game.floors[actor.floor];
  if (
    !floor ||
    (!floor.scene && !floor.environment) ||
    actor.stairTravel ||
    !actor.alive ||
    actor.escaped
  )
    return [];
  const eye =
      (actor.elevated?.feet ?? actor.floor * FLOOR_HEIGHT) -
      actor.floor * FLOOR_HEIGHT +
      1.6,
    candidates: SceneObservation[] = [];
  if (floor.environment) {
    const entries = readings(floor.environment);
    for (const slot of floor.environment.surfaces) {
      const pose = surfaceWorldPose(floor, slot),
        entry = entries.get(slot.id);
      if (
        !pose ||
        !entry ||
        Math.hypot(pose.x - actor.x, pose.y - actor.y) > 2.4
      )
        continue;
      const horizontal = Math.cos(pose.pitch),
        facing =
          (actor.x - pose.x) * -Math.sin(pose.yaw) * horizontal +
          (actor.y - pose.y) * Math.cos(pose.yaw) * horizontal +
          (eye - pose.z) * -Math.sin(pose.pitch);
      if (facing <= 0) continue;
      candidates.push({
        id: `scene.surface:${slot.id}`,
        x: pose.x,
        y: pose.y,
        elevation: pose.z,
        title: entry.title,
        text: entry.text,
      });
    }
  } else {
    for (const prop of floor.scene!.props) {
      const pose = propWorldPose(floor, prop);
      if (!pose || Math.hypot(pose.x - actor.x, pose.y - actor.y) > 2.4)
        continue;
      candidates.push({
        id: `scene.prop:${prop.id}`,
        x: pose.x,
        y: pose.y,
        elevation: pose.elevation + prop.h * 0.5,
        title: prop.label || prop.kind,
        text: [
          prop.text,
          prop.owner ? `Marked for ${prop.owner}.` : "",
          prop.condition !== "intact" ? `Condition: ${prop.condition}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
    for (const room of floor.scene!.rooms) {
      const p = room.plaque;
      if (
        Math.hypot(p.x - actor.x, p.y - actor.y) > 2.4 ||
        (actor.x - p.x) * p.nx + (actor.y - p.y) * p.ny <= 0
      )
        continue;
      candidates.push({
        id: `scene.room:${floor.index}:${room.room}`,
        x: p.x,
        y: p.y,
        elevation: 1.65,
        title: room.title,
        text: [
          room.description,
          room.owner ? `Name on the sign: ${room.owner}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      });
    }
  }
  return candidates
    .sort(
      (a, b) =>
        Math.hypot(a.x - actor.x, a.y - actor.y) -
          Math.hypot(b.x - actor.x, b.y - actor.y) || a.id.localeCompare(b.id),
    )
    .filter((item) => readable(floor, actor, eye, item))
    .slice(0, limit);
}
