import { surfacePoint, worldPoint } from "./furniture-geometry";
import {
  type Floor,
  type Furniture,
  type Game,
  type Point,
  distance,
  event,
} from "./model";
import { canPlace, inFurniture, line } from "./spatial";
export const DOOR_SWING = Math.PI * (7 / 18);
/** A small hinge/end clearance lets the finite-thickness leaf swing inside its frame. */
export function ensureDoor(o: Furniture, floor?: Floor) {
  // Upgrade legacy entrance shutters without repairing damage or reviving them.
  if (o.id === "main-gate" && o.kind === "gate") {
    o.kind = "door";
    o.open = o.turning < 0;
    o.turning = 0;
  }
  if (o.kind !== "door" || o.door || o.field) return;
  const frame = { x: o.x, y: o.y, w: o.w, h: o.h },
    vertical = o.h >= o.w,
    span = Math.max(o.w, o.h),
    gap = Math.min(0.12, span * 0.12),
    length = span - 2 * gap,
    thickness = Math.min(0.12, Math.min(o.w, o.h));
  o.w = vertical ? thickness : length;
  o.h = vertical ? length : thickness;
  o.door = {
    frame,
    hinge: vertical
      ? { x: o.x, y: o.y - length / 2 }
      : { x: o.x - length / 2, y: o.y },
    latched: !o.open,
    swung: !!o.open,
    side: o.open ? 1 : 0,
  };
  o.angle = o.open ? DOOR_SWING : 0;
  if (floor && o.open) {
    // Older saves represented an open door without a leaf. Restore a free
    // hinged pose rather than inserting it through existing barricades.
    const angle = [DOOR_SWING, -DOOR_SWING, 0].find((angle) =>
      canPlace(floor, o, doorPose(o, angle), o.w, o.h, angle),
    );
    o.angle = angle ?? 0;
    o.door.side = o.angle > 0 ? 1 : o.angle < 0 ? -1 : 0;
    o.door.swung = o.angle !== 0;
  }
  Object.assign(o, doorPose(o, o.angle));
}
export function doorPose(
  o: Furniture,
  angle: number,
): Point & { angle: number } {
  const d = o.door!;
  const local = { x: d.frame.x - d.hinge.x, y: d.frame.y - d.hinge.y };
  return { ...worldPoint(local, { ...d.hinge, angle }), angle };
}
export function doorFrame(o: Furniture) {
  return o.door?.frame ?? o;
}
export function unlatchDoor(o: Furniture) {
  ensureDoor(o);
  if (!o.door || !o.door.latched) return false;
  o.door.latched = false;
  o.door.release = (o.door.release ?? 0) + 1;
  o.door.swung = false;
  o.door.side = 0;
  o.open = true;
  return true;
}
export function latchDoor(g: Game, o: Furniture) {
  const d = o.door;
  if (!d || d.latched || !d.swung) return false;
  const pose = doorPose(o, 0),
    closed = { ...o, ...pose, open: false };
  if (
    !canPlace(g.floors[o.floor], o, pose, o.w, o.h, 0, 0) ||
    g.survivors.some(
      (a) =>
        a.alive &&
        !a.escaped &&
        a.floor === o.floor &&
        inFurniture(a, closed, 0.26),
    ) ||
    g.zombies.some(
      (z) => z.hp > 0 && z.floor === o.floor && inFurniture(z, closed, 0.26),
    )
  )
    return false;
  Object.assign(o, pose);
  d.latched = true;
  d.side = 0;
  d.swung = false;
  o.open = false;
  for (const a of g.survivors)
    if (a.grip?.object === o.id) {
      delete a.grip;
      delete a.handling;
    }
  o.physics = { x: 0, y: 0, angular: 0, awake: false };
  const ev = event(
    g,
    "door-latch",
    "A door clicked into its closed latch.",
    o.floor,
  );
  ev.position = { ...d.frame };
  return true;
}

/** Stand on the face that produces torque back toward the closed frame. */
export function doorClosingMotion(o: Furniture) {
  const d = o.door!,
    sign = Math.sign(o.angle ?? 0) || 1,
    vertical = d.frame.h >= d.frame.w;
  const end = {
    x: d.hinge.x + 2 * (o.x - d.hinge.x),
    y: d.hinge.y + 2 * (o.y - d.hinge.y),
  };
  const push = vertical ? { x: sign, y: 0 } : { x: 0, y: -sign };
  const track = vertical ? { x: 0, y: -0.07 } : { x: -0.07, y: 0 };
  return {
    push,
    approach: {
      x: end.x - push.x * 0.6 + track.x,
      y: end.y - push.y * 0.6 + track.y,
    },
    target: {
      x: end.x + push.x * 0.3 + track.x,
      y: end.y + push.y * 0.3 + track.y,
    },
  };
}

/** A contact motor repositions behind the free end if it slips onto the opening face. */
export function doorClosingDrive(o: Furniture, a: Point) {
  const { push, approach, target } = doorClosingMotion(o),
    vertical = o.door!.frame.h >= o.door!.frame.w;
  const end = vertical ? target.y : target.x,
    along = vertical ? a.y : a.x;
  if (along > end + 0.02) return { x: approach.x - a.x, y: approach.y - a.y };
  return vertical
    ? { x: push.x, y: (end - a.y) * 5 }
    : { x: (end - a.x) * 5, y: push.y };
}

/** Continue contact with a released, still-opening leaf when its gap has not formed yet. */
export function doorPushDirection(
  f: Floor,
  a: Point,
  target: Point,
): Point | undefined {
  for (const o of f.furniture) {
    const d = o.door;
    if (
      !d ||
      d.latched ||
      o.destroyed ||
      Math.abs(o.angle ?? 0) >= DOOR_SWING - 0.04 ||
      distance(a, d.frame) > 1.9
    )
      continue;
    const vertical = d.frame.h >= d.frame.w,
      axis = vertical ? "x" : "y",
      sign = Math.sign(target[axis] - d.frame[axis]);
    if (
      !sign ||
      sign * (a[axis] - d.frame[axis]) > 0.8 ||
      (d.side && d.side !== (vertical ? -sign : sign))
    )
      continue;
    const contact = surfacePoint(a, o);
    if (distance(a, contact) > 0.7 || !line(f, a, contact, true, o.id))
      continue;
    const goal = { x: d.frame.x, y: d.frame.y };
    goal[axis] += sign * ((vertical ? d.frame.w : d.frame.h) / 2 + 0.8);
    if (!line(f, a, goal)) continue;
    const n = distance(a, goal) || 1;
    return { x: (goal.x - a.x) / n, y: (goal.y - a.y) / n };
  }
  return undefined;
}

export function doorHandle(o: Furniture): Point {
  return worldPoint(
    o.h >= o.w ? { x: 0, y: o.h / 2 - 0.025 } : { x: o.w / 2 - 0.025, y: 0 },
    o,
  );
}

/**
 * Escape redesign: lock a door so it cannot be opened from `side` (-1 or 1,
 * the same side convention as `DoorState.side`). CONTRACT STUB, implemented
 * with the world runtime.
 */
export function lockDoor(o: Furniture, side: -1 | 1, by: string, at: number) {
  o.lock = { side, by, at };
}

/** Escape redesign: anyone outside can unlock it. */
export function unlockDoor(o: Furniture) {
  if (!o.lock) return false;
  delete o.lock;
  return true;
}

/**
 * Which face of the door frame `p` stands on, using the same convention as
 * `DoorState.side` (the leaf's positive swing side).
 */
export function doorSideOf(o: Furniture, p: Point): -1 | 1 {
  const frame = doorFrame(o),
    vertical = frame.h >= frame.w;
  if (vertical) return p.x <= frame.x ? 1 : -1;
  return p.y >= frame.y ? 1 : -1;
}

/** A locked door refuses its locked face; the other face may unlock it. */
export function doorBlocksFrom(o: Furniture, p: Point) {
  return !!o.lock && doorSideOf(o, p) === o.lock.side;
}
