import {
  CONFIG,
  H,
  W,
  rand,
  type BuildingFootprint,
  type Floor,
  type Game,
} from "./model";
import { carveStairwells } from "./stairwell";
import type { RunDesign } from "./run-design-contract.mjs";

/** Domain-separated streams: adding a floor/layout roll cannot change the
 * building shell, another floor, loot, population or simulation randomness. */
export function layoutRandom(seed: number, domain: number, floor = 0) {
  let value = (seed ^ domain ^ Math.imul(floor + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return { rng: (value ^ (value >>> 15)) >>> 0 };
}

export function createBuildingFootprint(
  seed: number,
  design?: RunDesign["footprint"],
): BuildingFootprint {
  const random = layoutRandom(seed, 0x7368656c);
  // The seeded fallback keeps its historical four shapes so undesigned runs
  // and old seeds build exactly the same shell.
  const shapes = ["rectangle", "chamfered", "stepped", "waisted"] as const;
  const shape =
    design?.shape ?? shapes[Math.floor(rand(random) * shapes.length)];
  const width = design?.width ?? 36 + 2 * Math.floor(rand(random) * 3);
  const top = design?.top ?? 2 + Math.floor(rand(random) * 3),
    bottom = 28;
  const left = 22 - width / 2,
    right = 22 + width / 2;
  const inset = design?.inset ?? 2 + Math.floor(rand(random) * 3);
  const mirrored = design?.mirrored ?? rand(random) < 0.5;
  const shoulder = design?.shoulder ?? top + 8 + Math.floor(rand(random) * 7);
  const rows = Array.from({ length: H }, (_, y) => {
    if (y < top || y >= bottom) return { left: 22, right: 22 };
    let l = left,
      r = right;
    if (shape === "chamfered") {
      const cut = Math.max(0, inset - Math.min(y - top, bottom - 1 - y));
      l += cut;
      r -= cut;
    } else if (
      shape === "stepped" &&
      (mirrored ? y < shoulder : y >= shoulder)
    ) {
      if (mirrored) l += inset;
      else r -= inset;
    } else if (shape === "waisted" && y >= shoulder - 3 && y < shoulder + 3) {
      l += inset;
      r -= inset;
    } else if (shape === "tapered") {
      // Full width at the entrance front, narrowing by inset toward the back.
      const cut = Math.round((inset * (bottom - 1 - y)) / (bottom - 1 - top));
      l += cut;
      r -= cut;
    } else if (
      shape === "notched" &&
      (y < top + inset || y >= bottom - inset)
    ) {
      l += inset;
      r -= inset;
    } else if (shape === "tee" && y >= shoulder) {
      l += inset;
      r -= inset;
    }
    return { left: l, right: r };
  });
  return { version: 1, shape, width, depth: bottom - top, top, bottom, rows };
}

export function footprintTiles(boundary: BuildingFootprint) {
  return boundary.rows.map(({ left, right }) =>
    Array.from({ length: W }, (_, x) => (x >= left && x < right ? 0 : 1)),
  );
}

/** Roof uses the exact same shell, including its wings and recesses. Keep the
 * extraction pad and the approach from the shared arrival shaft unobstructed. */
export function buildingRoof(f: Floor) {
  if (!f.boundary) return;
  f.tiles = footprintTiles(f.boundary);
  const row = f.boundary.rows[22];
  for (let x = row.left; x < row.right; x++)
    if (x < 21 || x > 23) f.tiles[22][x] = 1;
  carveStairwells(f);
}

/** Ids of stamped extra sites are `${siteId}:`-prefixed, so an id alone tells
 * the start site's own content from a stamped building's. */
export function stampedId(id: string, sites?: readonly { id: string }[]) {
  const colon = id.indexOf(":");
  return colon > 0 && !!sites?.some((s) => s.id === id.slice(0, colon));
}

/** True for furniture, stations or scene props a stamped extra site owns. */
export function stampedBySite<T extends { id: string; site?: string }>(
  o: T,
  sites?: readonly { id: string }[],
) {
  return o.site !== undefined || stampedId(o.id, sites);
}

/** True when a footprint covers tile (x, y); rows are indexed by absolute y. */
function coversCell(boundary: BuildingFootprint, x: number, y: number) {
  const span =
    y >= boundary.top && y < boundary.bottom ? boundary.rows?.[y] : undefined;
  return !!span && x >= span.left && x < span.right;
}
/** Footprints of the stamped extra sites standing on this floor. */
function stampedFootprints(g: Game, floor: number) {
  return (g.sites ?? [])
    .filter((s) => s.boundary && s.floors?.includes(floor))
    .map((s) => s.boundary);
}

/** Check the stored design against actual geometry. Portal cells are explicit:
 * wells occupy the two boundary-wall rows; only ground level has an outside lane.
 * With stamped extra sites only the start site's own region is checked. */
export function buildingLayoutErrors(g: Game): string[] {
  const first = g.floors[0]?.boundary;
  if (!first) return ["missing building boundary"];
  const expected = JSON.stringify(first);
  const errors: string[] = [];
  const extra = g.sites ?? [];
  for (const f of g.floors) {
    // Extra sites can add storeys above the start building's roof; those
    // floors carry their own site's layout, not the start site's shell.
    if (extra.length && f.index > CONFIG.floors) continue;
    if (JSON.stringify(f.boundary) !== expected) {
      errors.push(`floor ${f.index} has a different building boundary`);
      continue;
    }
    if (f.entry.x !== 22 && f.index > 0)
      errors.push(`floor ${f.index} arrival shaft is misaligned`);
    if (f.index > 0 && f.entry.y !== first.bottom + 1)
      errors.push(`floor ${f.index} arrival shaft depth is misaligned`);
    if (
      f.index < CONFIG.floors &&
      (f.stairs.x !== 22 || f.stairs.y !== first.top - 1)
    )
      errors.push(`floor ${f.index} ascending shaft is misaligned`);
    const shells = extra.length ? stampedFootprints(g, f.index) : [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        // A stamped site's own interior and shell are validated by its site.
        if (shells.some((b) => coversCell(b, x, y))) continue;
        const row = first.rows[y];
        const inside = x >= row.left && x < row.right;
        const well =
          (x === 21 || x === 22) &&
          ((f.index < CONFIG.floors && y >= first.top - 2 && y < first.top) ||
            (f.index > 0 && y >= first.bottom && y < first.bottom + 2));
        const entrance =
          f.index === 0 &&
          ((y === first.bottom && x >= 20 && x < 24) ||
            (y > first.bottom && x >= 18 && x <= 25));
        if (!f.tiles[y]?.[x] && !inside && !well && !entrance)
          errors.push(`floor ${f.index} opens outside boundary at ${x},${y}`);
        if ((well || entrance) && f.tiles[y]?.[x] !== 0)
          errors.push(`floor ${f.index} has a blocked portal at ${x},${y}`);
      }
  }
  return errors;
}
