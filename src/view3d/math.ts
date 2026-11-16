import type { Point } from "../model";

export const MAX_PITCH = (85 * Math.PI) / 180;

export function clampPitch(pitch: number) {
  return Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));
}

/** Y-up view direction; yaw uses the simulation's east/south heading. */
export function lookDirection(yaw: number, pitch: number) {
  const elevation = clampPitch(pitch),
    horizontal = Math.cos(elevation);
  return {
    x: horizontal * Math.cos(yaw),
    y: Math.sin(elevation),
    z: horizontal * Math.sin(yaw),
  };
}

/** Camera-relative movement stays on the floor, with unit-length diagonals. */
export function movementInput(
  yaw: number,
  right: number,
  forward: number,
): Point {
  const length = Math.max(1, Math.hypot(right, forward)),
    x = right / length,
    y = forward / length;
  return {
    x: Math.cos(yaw) * y - Math.sin(yaw) * x,
    y: Math.sin(yaw) * y + Math.cos(yaw) * x,
  };
}

const ARROW_TURN_SPEED = 2.6;
export const ARROW_PITCH_SPEED = 1.4;

/** Arrow turning is separate from translation; positive yaw turns right. */
export function arrowTurn(
  yaw: number,
  left: boolean,
  right: boolean,
  dt: number,
) {
  if (!Number.isFinite(dt) || dt <= 0) return yaw;
  return (
    (yaw + (Number(right) - Number(left)) * ARROW_TURN_SPEED * dt) %
    (Math.PI * 2)
  );
}

/** Vertical arrows tilt the camera; positive pitch looks up. */
export function arrowPitch(
  pitch: number,
  up: boolean,
  down: boolean,
  dt: number,
) {
  if (!Number.isFinite(dt) || dt <= 0) return pitch;
  return clampPitch(
    pitch + (Number(up) - Number(down)) * ARROW_PITCH_SPEED * dt,
  );
}

/** Unconfined cursor edges turn at rad/s, with the same signs as mouse look. */
export function edgeTurnRate(
  x: number,
  y: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  if (
    ![x, y, rect.left, rect.top, rect.width, rect.height].every(
      Number.isFinite,
    ) ||
    rect.width <= 0 ||
    rect.height <= 0
  )
    return { yaw: 0, pitch: 0 };
  const horizontal = Math.max(24, 0.06 * rect.width),
    vertical = Math.max(24, 0.06 * rect.height),
    strength = (distance: number, band: number) =>
      Math.max(0, Math.min(1, 1 - distance / band));
  return {
    yaw:
      (strength(rect.left + rect.width - x, horizontal) -
        strength(x - rect.left, horizontal)) *
      2.4,
    pitch:
      (strength(y - rect.top, vertical) -
        strength(rect.top + rect.height - y, vertical)) *
      1.2,
  };
}

/** First-person WASD moves on the floor; arrows control only the camera. */
export function firstPersonInput(
  yaw: number,
  keys: ReadonlySet<string>,
): Point {
  return movementInput(
    yaw,
    Number(keys.has("KeyD")) - Number(keys.has("KeyA")),
    Number(keys.has("KeyW")) - Number(keys.has("KeyS")),
  );
}
