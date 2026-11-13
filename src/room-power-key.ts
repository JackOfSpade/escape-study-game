import type { Game } from "./model";

/**
 * Key of a room's power override in `Game.escape.roomPower`. The start area
 * keeps the original `${floor}:${roomId}` form; other areas are prefixed so
 * their rooms never collide with the start area's.
 */
export function roomPowerKey(
  g: Pick<Game, "areaId" | "escape">,
  floor: number,
  roomId: string,
): string {
  const start = g.escape?.areas?.start ?? "start";
  const area = g.areaId ?? start;
  return area === start ? `${floor}:${roomId}` : `${area}/${floor}:${roomId}`;
}
