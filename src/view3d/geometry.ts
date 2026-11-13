import type { Floor } from "../model";

export interface WallRectangle {
  x: number;
  y: number;
  w: number;
  h: number;
}

type FloorGeometry = Pick<Floor, "tiles" | "index" | "stairs" | "entry">;

/** One allocation-free occupancy snapshot for the active floor. Tile writers
 * can edit rows in place, so identity alone cannot safely cache wall geometry.
 * Nonzero tile kinds have the same rendered geometry and do not invalidate it. */
export class GeometryChangeCache {
  private floor?: FloorGeometry;
  private rows = new Uint32Array(0);
  private walls = new Uint8Array(0);
  /** Raster extent of the snapshot; grows when a floor's raster grows. */
  private cols = -1;
  private gridRows = -1;
  private index = NaN;
  private stairsX = NaN;
  private stairsY = NaN;
  private entryX = NaN;
  private entryY = NaN;

  changed(floor: FloorGeometry) {
    const tiles = floor.tiles;
    let count = 0,
      changed = this.floor !== floor;
    for (let y = 0; y < tiles.length; y++) count += tiles[y].length;
    const cols = tiles[0]?.length ?? 0;
    if (this.cols !== cols || this.gridRows !== tiles.length) {
      this.cols = cols;
      this.gridRows = tiles.length;
      changed = true;
    }
    if (this.rows.length !== tiles.length || this.walls.length !== count) {
      this.rows = new Uint32Array(tiles.length);
      this.walls = new Uint8Array(count);
      changed = true;
    }
    let offset = 0;
    for (let y = 0; y < tiles.length; y++) {
      const row = tiles[y];
      if (this.rows[y] !== row.length) {
        this.rows[y] = row.length;
        changed = true;
      }
      for (let x = 0; x < row.length; x++, offset++) {
        const wall = row[x] === 0 ? 0 : 1;
        if (this.walls[offset] !== wall) {
          this.walls[offset] = wall;
          changed = true;
        }
      }
    }
    if (
      this.index !== floor.index ||
      this.stairsX !== floor.stairs.x ||
      this.stairsY !== floor.stairs.y ||
      this.entryX !== floor.entry.x ||
      this.entryY !== floor.entry.y
    ) {
      this.index = floor.index;
      this.stairsX = floor.stairs.x;
      this.stairsY = floor.stairs.y;
      this.entryX = floor.entry.x;
      this.entryY = floor.entry.y;
      changed = true;
    }
    this.floor = floor;
    return changed;
  }
}

/** Value-based cache key also detects tile edits made in place. */
export function geometrySignature(tiles: number[][]) {
  return tiles
    .map(
      (row) =>
        `${row.length}:${row.map((tile) => (tile === 0 ? 0 : 1)).join("")}`,
    )
    .join(";");
}

/** Merge matching horizontal wall runs on successive rows, preserving gaps. */
export function wallRectangles(tiles: number[][]): WallRectangle[] {
  const rectangles: WallRectangle[] = [];
  let previous = new Map<string, WallRectangle>();
  for (let y = 0; y < tiles.length; y++) {
    const row = tiles[y],
      current = new Map<string, WallRectangle>();
    let x = 0;
    while (x < row.length) {
      if (row[x] === 0) {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] !== 0) x++;
      const w = x - start,
        key = `${start}/${w}`,
        old = previous.get(key);
      if (old) {
        old.h++;
        current.set(key, old);
      } else {
        const rectangle = { x: start, y, w, h: 1 };
        rectangles.push(rectangle);
        current.set(key, rectangle);
      }
    }
    previous = current;
  }
  return rectangles;
}
