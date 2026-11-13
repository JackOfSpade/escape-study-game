import { CONFIG, type Game, H, type Point, W } from "./model";
import { extractionFloor, human } from "./engine";
import { isOpenSite } from "./open-site";
/** A free-look over the live building after the human's run ends: which floor is
 * shown, where the camera is centred, and how far it is zoomed. The view is
 * page state only; it is never saved with the game. */
export interface SpectatorView {
  floor: number;
  focus: Point;
  zoom: number;
}
export const SPECTATOR_ZOOM = { min: 0.5, max: 2.5, step: 1.15 };
/** Spectating starts when the run ends, by death or extraction. */
export function spectating(g: Game) {
  return g.status === "dead" || g.status === "escaped";
}
/** Highest level a free-look may show: an enclosed building keeps every storey,
 * an open site has only ground level above its solid upper layers. */
function topFloor(g?: Pick<Game, "floors">) {
  if (!g) return CONFIG.floors;
  let top = 0;
  for (const f of g.floors)
    if (f.index === 0 || f.open !== true) top = Math.max(top, f.index);
  return top;
}
export function clampView(
  view: SpectatorView,
  g?: Pick<Game, "floors">,
): SpectatorView {
  // NaN falls back to a sensible value; infinities clamp like any overshoot.
  const num = (v: number, fallback: number) => (Number.isNaN(v) ? fallback : v);
  const bound = (v: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, v));
  return {
    floor: bound(Math.round(num(view.floor, 0)), 0, topFloor(g)),
    zoom: bound(num(view.zoom, 1), SPECTATOR_ZOOM.min, SPECTATOR_ZOOM.max),
    focus: {
      x: bound(num(view.focus.x, W / 2), 0, W),
      y: bound(num(view.focus.y, H / 2), 0, H),
    },
  };
}
/** The view opens on the player's last position. */
export function initialView(g: Game): SpectatorView {
  const a = human(g);
  return clampView({ floor: a.floor, focus: { x: a.x, y: a.y }, zoom: 1 }, g);
}
/**
 * Label for a level. The run's pickup is the extraction level whatever the
 * site form: a building's rooftop, an open site's ground pad.
 */
export function floorTitle(floor: number, g?: Game) {
  if (g && isOpenSite(g))
    return floor === extractionFloor(g)
      ? "GROUND PAD / EXTRACTION"
      : `SOLID LAYER ${floor}`;
  return floor === (g ? extractionFloor(g) : CONFIG.floors)
    ? "ROOFTOP / EXTRACTION"
    : `FLOOR ${String(floor + 1).padStart(2, "0")} / ${topFloor(g)}`;
}
/** Buttons for every level, ground floor first, rooftop last. */
export function spectatorFloors(g?: Game) {
  if (g && isOpenSite(g))
    return [{ floor: 0, label: "GROUND", title: floorTitle(0, g) }];
  const top = topFloor(g);
  return Array.from({ length: top + 1 }, (_, floor) => ({
    floor,
    label: floor === top ? "ROOF" : String(floor + 1),
    title: floorTitle(floor, g),
  }));
}
