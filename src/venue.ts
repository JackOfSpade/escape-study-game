import {
  HELIPAD,
  HELIPAD_RADIUS,
  type BuildingFootprint,
  type Floor,
} from "./model";
import type {
  RunRoofFeature,
  RunSetting,
  RunVenue,
} from "./setting-catalog.mjs";

/** The venue a floor is furnished as. Undesigned and older runs are offices. */
export function floorVenue(f: Pick<Floor, "setting">): RunVenue {
  return f.setting?.venue ?? "office";
}

export interface ResolvedRoofFeature {
  kind: RunRoofFeature["kind"];
  /** Cell centre on the roof's outer ring, in world units. */
  x: number;
  y: number;
  /** Unit vector pointing out of the building, toward the parapet edge. */
  outward: { x: number; y: number };
}

const SPACING = 2.5;

/** Roof features stand on the outermost ring of roof cells, never on the
 * helipad, its approach, the stair columns or the cover barrier row, so they
 * cannot hide or block anything the player uses. The nearest free ring cell to
 * each requested point is chosen in order; null marks a feature that has no
 * room left, which the builder rejects for repair rather than dropping. */
export function resolveRoofFeatures(
  boundary: BuildingFootprint,
  features: readonly RunRoofFeature[],
): (ResolvedRoofFeature | null)[] {
  const inside = (x: number, y: number) => {
    const row = boundary.rows[y];
    return !!row && x >= row.left && x < row.right;
  };
  const ring: { x: number; y: number; outward: { x: number; y: number } }[] =
    [];
  const minX = Math.min(...boundary.rows.map((r) => r.left));
  const maxX = Math.max(...boundary.rows.map((r) => r.right));
  for (let y = boundary.top; y < boundary.bottom; y++)
    for (let x = minX; x < maxX; x++) {
      if (!inside(x, y)) continue;
      let ox = 0,
        oy = 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ])
        if (!inside(x + dx, y + dy)) {
          ox += dx;
          oy += dy;
        }
      if (!ox && !oy) continue;
      const cx = x + 0.5,
        cy = y + 0.5;
      if (x >= 19 && x <= 25) continue; // stair wells and the arrival approach
      if (y >= 21 && y <= 23) continue; // cover barrier row and its gap
      if (Math.hypot(cx - HELIPAD.x, cy - HELIPAD.y) < HELIPAD_RADIUS + 1.2)
        continue;
      const length = Math.hypot(ox, oy);
      ring.push({ x: cx, y: cy, outward: { x: ox / length, y: oy / length } });
    }
  const width = maxX - minX,
    depth = boundary.bottom - boundary.top;
  const taken: ResolvedRoofFeature[] = [];
  return features.map((feature) => {
    const want = {
      x: minX + feature.x * width,
      y: boundary.top + feature.y * depth,
    };
    let best: (typeof ring)[number] | undefined,
      distance = Infinity;
    for (const cell of ring) {
      if (taken.some((t) => Math.hypot(t.x - cell.x, t.y - cell.y) < SPACING))
        continue;
      const d = Math.hypot(cell.x - want.x, cell.y - want.y);
      // Ties break on position so the choice never depends on scan quirks.
      if (
        d < distance - 1e-9 ||
        (Math.abs(d - distance) <= 1e-9 &&
          best &&
          (cell.y < best.y || (cell.y === best.y && cell.x < best.x)))
      ) {
        best = cell;
        distance = d;
      }
    }
    if (!best) return null;
    const resolved = { kind: feature.kind, ...best };
    taken.push(resolved);
    return resolved;
  });
}

/** An open site has no roof, so its authored roof features become ground
 * furniture along the inside of the perimeter fence: the nearest free walkable
 * cell to each authored position is chosen, in order. Cells on or beside the
 * extraction pad (`avoid`), on a wall, or next to a gate, door or other fixture
 * are never used, so no feature can sit on a route the player needs. A feature
 * that finds no free cell is skipped by the caller (visual only) rather than
 * rejected: an open floor has far less boundary than a roof ring. */
export function resolveGroundFeatures(
  floor: Pick<Floor, "boundary" | "tiles" | "furniture">,
  features: readonly RunRoofFeature[],
  avoid: readonly { x: number; y: number; radius: number }[] = [],
): (ResolvedRoofFeature | null)[] {
  const boundary = floor.boundary;
  if (!boundary) return features.map(() => null);
  const inside = (x: number, y: number) => {
      const row = boundary.rows[y];
      return !!row && x >= row.left && x < row.right;
    },
    solid = (x: number, y: number) => floor.tiles[y]?.[x] !== 0,
    minX = Math.min(...boundary.rows.map((r) => r.left)),
    maxX = Math.max(...boundary.rows.map((r) => r.right)),
    centre = { x: (minX + maxX) / 2, y: (boundary.top + boundary.bottom) / 2 },
    fixed = floor.furniture.filter(
      (o) => o.kind === "gate" || o.kind === "door" || o.field || o.door,
    ),
    ring: { x: number; y: number; outward: { x: number; y: number } }[] = [];
  for (let y = boundary.top; y < boundary.bottom; y++)
    for (let x = minX; x < maxX; x++) {
      if (!inside(x, y) || solid(x, y)) continue;
      // Only the strip just inside the fence is a perimeter cell.
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy++)
        for (let dx = -2; dx <= 2 && !edge; dx++)
          if (!inside(x + dx, y + dy)) edge = true;
      if (!edge) continue;
      const cx = x + 0.5,
        cy = y + 0.5;
      if (
        fixed.some((o) => Math.hypot(o.x - cx, o.y - cy) < 2.5) ||
        floor.furniture.some((o) => Math.hypot(o.x - cx, o.y - cy) < 1.2) ||
        avoid.some((a) => Math.hypot(a.x - cx, a.y - cy) < a.radius)
      )
        continue;
      const dx = cx - centre.x,
        dy = cy - centre.y,
        length = Math.hypot(dx, dy) || 1;
      ring.push({ x: cx, y: cy, outward: { x: dx / length, y: dy / length } });
    }
  const width = maxX - minX,
    depth = boundary.bottom - boundary.top,
    taken: ResolvedRoofFeature[] = [];
  return features.map((feature) => {
    const want = {
      x: minX + feature.x * width,
      y: boundary.top + feature.y * depth,
    };
    let best: (typeof ring)[number] | undefined,
      distance = Infinity;
    for (const cell of ring) {
      if (taken.some((t) => Math.hypot(t.x - cell.x, t.y - cell.y) < SPACING))
        continue;
      const d = Math.hypot(cell.x - want.x, cell.y - want.y);
      if (
        d < distance - 1e-9 ||
        (Math.abs(d - distance) <= 1e-9 &&
          best &&
          (cell.y < best.y || (cell.y === best.y && cell.x < best.x)))
      ) {
        best = cell;
        distance = d;
      }
    }
    if (!best) return null;
    const resolved = { kind: feature.kind, ...best };
    taken.push(resolved);
    return resolved;
  });
}

/** Builder check: every authored roof feature must find a free roof edge. */
export function settingErrors(
  setting: RunSetting | undefined,
  boundary: BuildingFootprint | undefined,
): string[] {
  if (!setting || !boundary) return [];
  return resolveRoofFeatures(boundary, setting.exterior.roofFeatures).flatMap(
    (feature, i) =>
      feature
        ? []
        : [
            `setting.exterior.roofFeatures[${i}] has no free roof edge; use fewer or more spread-out roof features`,
          ],
  );
}
