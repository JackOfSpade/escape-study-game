import {
  COLUMN_SIZE,
  DECK_THICKNESS,
  exteriorStructure,
  GUARD_HEIGHT,
  stairAccessPortals,
  type ExteriorStructure,
} from "./exterior-structure";
import { fieldPassable } from "./force-fields";
import {
  CONFIG,
  devPass,
  type Actor,
  type Floor,
  type Game,
  type Point,
} from "./model";
import { floorZone } from "./office-art";
import { BODY_RADIUS } from "./physics";
import { FLOOR_HEIGHT } from "./stair-route";
import { furnitureHeightOf } from "./view3d/furniture-height";

export const ELEVATED_HEIGHT = 1.7;
export const ELEVATED_STEP = 0.3;
export const ELEVATED_SNAP = 0.3;
export const ELEVATED_GRAVITY = 20;
export const ELEVATED_JUMP_APEX = 1.1;
const EPS = 1e-7;
const AIR_ACCELERATION = 6;

export interface ElevatedSurface {
  kind:
    | "plate"
    | "ground"
    | "slab"
    | "furniture"
    | "wall"
    | "guard"
    | "column"
    | "city";
  height: number;
  floor: number;
  /** True only inside the usable building footprint, not its outer well. */
  inside: boolean;
}

interface Interval extends ElevatedSurface {
  bottom: number;
}
interface Rectangle {
  x: number;
  y: number;
  ux: number;
  uy: number;
  halfLength: number;
  halfWidth: number;
  bottom: number;
  height: number;
  kind: ElevatedSurface["kind"];
  floor: number;
  /** Guards follow the flight slope, unlike its individual stair treads. */
  rise?: number;
}
export interface ElevatedStep {
  surface?: ElevatedSurface;
  landed?: { surface: ElevatedSurface; drop: number };
}

/** The shared footprint is gameplay data; no renderer dependency is needed. */
export function insideFootprint(f: Floor, p: Point) {
  const b = f.boundary;
  if (!b)
    return (
      p.y >= 0 &&
      p.y < f.tiles.length &&
      p.x >= 0 &&
      p.x < (f.tiles[0]?.length ?? 0)
    );
  const row = b.rows[Math.floor(p.y)];
  return (
    !!row &&
    p.y >= b.top &&
    p.y < b.bottom &&
    p.x >= row.left &&
    p.x < row.right
  );
}

function perimeterWall(f: Floor, x: number, y: number) {
  if (
    !f.boundary ||
    !f.tiles[y]?.[x] ||
    insideFootprint(f, { x: x + 0.5, y: y + 0.5 })
  )
    return false;
  for (let dy = -1; dy <= 1; dy++)
    for (let dx = -1; dx <= 1; dx++)
      if (
        (dx || dy) &&
        insideFootprint(f, { x: x + dx + 0.5, y: y + dy + 0.5 })
      )
        return true;
  return false;
}

function carvedWell(f: Floor, x: number, y: number) {
  const b = f.boundary;
  return (
    !!b &&
    x >= 21 &&
    x <= 22 &&
    ((f.index < CONFIG.floors && y >= b.top - 2 && y < b.top) ||
      (f.index > 0 && y >= b.bottom && y < b.bottom + 2))
  );
}

/** Capsule footprint against an oriented rectangle, including rounded corners. */
function touches(
  p: Point,
  r: Pick<Rectangle, "x" | "y" | "ux" | "uy" | "halfLength" | "halfWidth">,
) {
  const dx = p.x - r.x,
    dy = p.y - r.y,
    along = Math.abs(dx * r.ux + dy * r.uy) - r.halfLength,
    across = Math.abs(-dx * r.uy + dy * r.ux) - r.halfWidth;
  return (
    Math.max(0, along) ** 2 + Math.max(0, across) ** 2 < BODY_RADIUS ** 2 - EPS
  );
}

const geometryCache = new WeakMap<ExteriorStructure, Rectangle[]>();
function exteriorRectangles(structure: ExteriorStructure) {
  const cached = geometryCache.get(structure);
  if (cached) return cached;
  const result: Rectangle[] = [];
  for (const s of structure.slabs) {
    const run = (s.halfLength * 2) / s.steps;
    for (let i = 0; i < s.steps; i++) {
      const distance = -s.halfLength + run * (i + 0.5),
        height = s.top + (s.rise * (i + 1)) / s.steps;
      result.push({
        x: s.x + s.ux * distance,
        y: s.y + s.uy * distance,
        ux: s.ux,
        uy: s.uy,
        halfLength: run / 2,
        halfWidth: s.halfWidth,
        bottom: s.solidToGround ? 0 : height - DECK_THICKNESS,
        height,
        kind: "slab",
        floor: Math.round(height / FLOOR_HEIGHT),
      });
    }
  }
  for (const b of structure.guards) {
    const dx = b.x2 - b.x1,
      dy = b.y2 - b.y1,
      length = Math.hypot(dx, dy);
    if (!b.broken)
      result.push({
        x: (b.x1 + b.x2) / 2,
        y: (b.y1 + b.y2) / 2,
        ux: dx / length,
        uy: dy / length,
        halfLength: length / 2,
        halfWidth: 0.025,
        bottom: (b.base1 + b.base2) / 2 - DECK_THICKNESS,
        height: (b.base1 + b.base2) / 2 + GUARD_HEIGHT,
        rise: b.base2 - b.base1,
        kind: "guard",
        floor: b.level,
      });
    // A storm removes the glass and handrail, never the surviving end posts.
    if (!b.corner)
      for (const [x, y, base] of [
        [b.x1, b.y1, b.base1],
        [b.x2, b.y2, b.base2],
      ])
        result.push({
          x,
          y,
          ux: 1,
          uy: 0,
          halfLength: 0.0275,
          halfWidth: 0.0275,
          bottom: base,
          height: base + 1.16,
          kind: "guard",
          floor: b.level,
        });
  }
  for (const c of structure.columns)
    result.push({
      x: c.x,
      y: c.y,
      ux: 1,
      uy: 0,
      halfLength: COLUMN_SIZE / 2,
      halfWidth: COLUMN_SIZE / 2,
      bottom: 0,
      height: c.top,
      kind: "column",
      floor: Math.floor(c.top / FLOOR_HEIGHT),
    });
  geometryCache.set(structure, result);
  return result;
}

/** Each support, wall and overhead obstacle is the same vertical interval.
 * Keeping these queries together prevents an invisible floor or ceiling from
 * disagreeing with a horizontal contact. */
function intervals(
  g: Game,
  a: Actor,
  p: Point,
  structure: Rectangle[],
): Interval[] {
  const result: Interval[] = [];
  for (const f of g.floors) {
    const base = f.index * FLOOR_HEIGHT;
    for (
      let y = Math.floor(p.y - BODY_RADIUS);
      y <= Math.floor(p.y + BODY_RADIUS);
      y++
    )
      for (
        let x = Math.floor(p.x - BODY_RADIUS);
        x <= Math.floor(p.x + BODY_RADIUS);
        x++
      ) {
        if (
          f.tiles[y]?.[x] === undefined ||
          !touches(p, {
            x: x + 0.5,
            y: y + 0.5,
            ux: 1,
            uy: 0,
            halfLength: 0.5,
            halfWidth: 0.5,
          })
        )
          continue;
        const cell = { x: x + 0.5, y: y + 0.5 },
          inside = insideFootprint(f, cell),
          open = f.tiles[y][x] === 0 || carvedWell(f, x, y);
        if (open) {
          result.push({
            kind: "plate",
            height: base,
            bottom: base - DECK_THICKNESS,
            floor: f.index,
            inside: insideFootprint(f, p),
          });
          const finish = floorZone(f, x, y),
            ownsFinish = !f.boundary || inside || (f.index > 0 && open);
          if (
            f.index < CONFIG.floors &&
            ownsFinish &&
            finish !== "concrete" &&
            finish !== "roof"
          )
            result.push({
              kind: "plate",
              bottom: base + 2.82,
              height: base + 3.4,
              floor: f.index,
              inside: insideFootprint(f, p),
            });
        } else if (inside || perimeterWall(f, x, y)) {
          const height =
            f.index === CONFIG.floors ? (inside ? 2.8 : 1) : FLOOR_HEIGHT;
          result.push({
            kind: "wall",
            bottom: base,
            height: base + height,
            floor: f.index,
            inside: insideFootprint(f, p),
          });
        }
      }
    for (const o of f.furniture) {
      if (
        o.destroyed ||
        (o.open && !o.door) ||
        (o.kind === "gate" && o.turning < 0) ||
        (o.field && fieldPassable(o, a))
      )
        continue;
      const angle = o.angle ?? 0;
      if (
        touches(p, {
          x: o.x,
          y: o.y,
          ux: Math.cos(angle),
          uy: Math.sin(angle),
          halfLength: o.w / 2,
          halfWidth: o.h / 2,
        })
      )
        result.push({
          kind: "furniture",
          bottom: base,
          height: base + (o.field ? FLOOR_HEIGHT : furnitureHeightOf(o)),
          floor: f.index,
          inside: insideFootprint(f, p),
        });
    }
  }
  for (const r of structure) {
    if (!touches(p, r)) continue;
    const u = Math.max(
        -0.5,
        Math.min(
          0.5,
          ((p.x - r.x) * r.ux + (p.y - r.y) * r.uy) / (r.halfLength * 2),
        ),
      ),
      slope = (r.rise ?? 0) * u;
    result.push({
      kind: r.kind,
      bottom: r.bottom + slope,
      height: r.height + slope,
      floor: r.floor,
      inside: false,
    });
  }
  const ground = g.floors[0],
    city = ground?.city;
  if (!city || !insideFootprint(ground, p))
    result.push({
      kind: "ground",
      bottom: -Infinity,
      height: 0,
      floor: 0,
      inside: false,
    });
  if (city) {
    const b = city.bounds;
    if (
      p.x - BODY_RADIUS < b.left ||
      p.x + BODY_RADIUS > b.right ||
      p.y - BODY_RADIUS < b.top ||
      p.y + BODY_RADIUS > b.bottom
    )
      result.push({
        kind: "city",
        bottom: 0,
        height: Infinity,
        floor: 0,
        inside: false,
      });
    for (const o of city.obstacles)
      if (
        o.kind !== "stair-base" &&
        touches(p, {
          x: o.x,
          y: o.y,
          ux: 1,
          uy: 0,
          halfLength: o.w / 2,
          halfWidth: o.h / 2,
        })
      )
        result.push({
          kind: "city",
          bottom: 0,
          height: o.height,
          floor: 0,
          inside: false,
        });
  }
  return result;
}

function support(
  volumes: Interval[],
  maximum: number,
): ElevatedSurface | undefined {
  let best: Interval | undefined;
  for (const v of volumes)
    if (
      v.height <= maximum + EPS &&
      (!best ||
        v.height > best.height + EPS ||
        (Math.abs(v.height - best.height) <= EPS && v.kind === "plate"))
    )
      best = v;
  return (
    best && {
      kind: best.kind,
      height: best.height,
      floor: best.floor,
      inside: best.inside,
    }
  );
}

export function surfaceBelow(g: Game, a: Actor, p: Point, maxHeight: number) {
  return support(
    intervals(g, a, p, exteriorRectangles(exteriorStructure(g))),
    maxHeight,
  );
}

export function ceilingAbove(g: Game, a: Actor, p: Point, minHeight: number) {
  let height = Infinity;
  for (const v of intervals(g, a, p, exteriorRectangles(exteriorStructure(g))))
    if (v.bottom >= minHeight - EPS) height = Math.min(height, v.bottom);
  return height;
}

/** Body state is plain JSON and carries the existing horizontal momentum. */
export function startElevated(
  g: Game,
  a: Actor,
  feet = a.floor * FLOOR_HEIGHT,
) {
  if (a.elevated) return a.elevated;
  const surface = surfaceBelow(g, a, a, feet);
  a.elevated = {
    feet,
    vx: a.physics?.x ?? 0,
    vy: a.physics?.y ?? 0,
    vz: 0,
    peak: feet,
    grounded: !!surface && Math.abs(surface.height - feet) <= EPS,
  };
  delete a.physics;
  return a.elevated;
}

export function jumpElevated(g: Game, a: Actor) {
  const b = startElevated(g, a);
  if (!b.grounded) return false;
  b.vz = Math.sqrt(2 * ELEVATED_GRAVITY * ELEVATED_JUMP_APEX);
  b.grounded = false;
  b.peak = b.feet;
  delete a.grip;
  delete a.handling;
  return true;
}

function obstructed(volumes: Interval[], feet: number) {
  return volumes.some(
    (v) => v.height > feet + EPS && v.bottom < feet + ELEVATED_HEIGHT - EPS,
  );
}

function portalBlocks(g: Game, a: Actor, from: Point, to: Point, feet: number) {
  if (devPass(a)) return false;
  return stairAccessPortals(g).some((p) => {
    if (
      a.access.includes(p.floor) ||
      feet >= p.base + p.height ||
      feet + ELEVATED_HEIGHT <= p.base
    )
      return false;
    const along = p.axis === "x" ? "y" : "x",
      before = (from[p.axis] - p[p.axis]) * p.direction,
      after = (to[p.axis] - p[p.axis]) * p.direction;
    return (
      after > before + EPS &&
      before < BODY_RADIUS &&
      after > -BODY_RADIUS &&
      Math.max(from[along], to[along]) > p[along] - p.width / 2 - BODY_RADIUS &&
      Math.min(from[along], to[along]) < p[along] + p.width / 2 + BODY_RADIUS
    );
  });
}

/** Free two-dimensional motion with short capsule sweeps. The caller owns
 * stair arrival and damage; physics reports the actual contacted surface. */
export function stepElevated(
  g: Game,
  a: Actor,
  input: Point,
  dt: number,
): ElevatedStep {
  const b = startElevated(g, a),
    geometry = exteriorRectangles(exteriorStructure(g)),
    magnitude = Math.hypot(input.x, input.y),
    scale = magnitude > 1 ? 1 / magnitude : 1,
    desiredX = input.x * scale * a.speed,
    desiredY = input.y * scale * a.speed;
  if (b.grounded) {
    b.vx = desiredX;
    b.vy = desiredY;
  } else {
    const dx = desiredX - b.vx,
      dy = desiredY - b.vy,
      change = Math.hypot(dx, dy),
      blend = change ? Math.min(1, (AIR_ACCELERATION * dt) / change) : 0;
    b.vx += dx * blend;
    b.vy += dy * blend;
  }
  const count = Math.max(
      1,
      Math.ceil((Math.hypot(b.vx, b.vy) * dt) / 0.08),
      Math.ceil(dt / (1 / 60)),
    ),
    tick = dt / count;
  const result: ElevatedStep = {};
  for (let i = 0; i < count; i++) {
    const attempt = (x: number, y: number) => {
      const p = { x, y };
      if (portalBlocks(g, a, a, p, b.feet)) return false;
      const volumes = intervals(g, a, p, geometry),
        below = b.grounded
          ? support(volumes, b.feet + ELEVATED_STEP)
          : undefined,
        canSnap = below && below.height >= b.feet - ELEVATED_SNAP - EPS,
        feet = canSnap ? below.height : b.feet;
      if (obstructed(volumes, feet)) return false;
      a.x = x;
      a.y = y;
      if (b.grounded) {
        b.feet = feet;
        b.grounded = !!canSnap;
        if (canSnap) {
          b.peak = feet;
          result.surface = below;
        }
      }
      return true;
    };
    const dx = b.vx * tick,
      dy = b.vy * tick;
    if (!attempt(a.x + dx, a.y + dy)) {
      if (Math.abs(dx) > EPS && !attempt(a.x + dx, a.y)) b.vx = 0;
      if (Math.abs(dy) > EPS && !attempt(a.x, a.y + dy)) b.vy = 0;
    }
    const volumes = intervals(g, a, a, geometry);
    if (b.grounded) {
      const below = support(volumes, b.feet);
      if (below && b.feet - below.height <= ELEVATED_SNAP + EPS) {
        b.feet = below.height;
        b.peak = b.feet;
        b.vz = 0;
        result.surface = below;
        continue;
      }
      b.grounded = false;
    }
    delete result.surface;
    let next = b.feet + b.vz * tick - (ELEVATED_GRAVITY * tick * tick) / 2;
    const nextVelocity = b.vz - ELEVATED_GRAVITY * tick;
    if (b.vz > 0) {
      let ceiling = Infinity;
      for (const v of volumes)
        if (v.bottom >= b.feet + ELEVATED_HEIGHT - EPS)
          ceiling = Math.min(ceiling, v.bottom);
      if (next + ELEVATED_HEIGHT >= ceiling) {
        next = ceiling - ELEVATED_HEIGHT;
        b.vz = 0;
      } else {
        if (nextVelocity < 0)
          b.peak = Math.max(
            b.peak,
            b.feet + (b.vz * b.vz) / (2 * ELEVATED_GRAVITY),
          );
        b.vz = nextVelocity;
      }
    } else b.vz = nextVelocity;
    b.peak = Math.max(b.peak, next);
    const below = support(volumes, b.feet);
    if (b.vz <= 0 && below && next <= below.height + EPS) {
      result.landed = {
        surface: below,
        drop: Math.max(0, b.peak - below.height),
      };
      result.surface = below;
      b.feet = below.height;
      b.vz = 0;
      b.grounded = true;
      b.peak = b.feet;
    } else b.feet = next;
  }
  return result;
}
