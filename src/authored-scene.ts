import { floorSectors, inRect, type Sector } from "./floor-plan";
import { stampedBySite } from "./building-layout";
import { boxBounds, boxesOverlap, worldPoint } from "./furniture-geometry";
import {
  H,
  W,
  furnitureSpec,
  type Floor,
  type Furniture,
  type FurnitureKind,
  type Point,
} from "./model";
import {
  surfaceTop,
  type RunCustomObject,
  type RunCustomProp,
} from "./setting-catalog.mjs";
import {
  blockedGrid,
  makeFurniture,
  markObject,
  reachable,
} from "./office-layout";
import {
  PROP_CATALOG,
  type ScenePropKind,
  type SceneFurnitureDesign,
  type ScenePropDesign,
  type SceneRoomDesign,
  type SceneFurnitureStructure,
  type ScenePropStructure,
} from "./scene-catalog.mjs";
import { canPlace, inFurniture, wall } from "./spatial";
import {
  furnitureSurfaceBounds,
  furnitureSurfaceHeight,
} from "./view3d/furniture-height";

export interface ResolvedSceneRoom extends Omit<SceneRoomDesign, "furniture"> {
  /** Wall face normal points into this room; visual center is 1.65m high. */
  plaque: Point & { nx: number; ny: number };
}
export interface ResolvedSceneFurniture {
  id: string;
  designId: string;
  room: number;
  kind: SceneFurnitureDesign["kind"];
}
export interface ResolvedSceneProp extends Omit<
  ScenePropStructure,
  "at" | "angle" | "kind"
> {
  /** A built-in prop kind, or the id of one of the design's setting.props. */
  kind: string;
  /** The composed recipe of a design-invented prop; always rebound from the
   * fingerprinted design on load. Absent for built-in kinds. */
  object?: RunCustomProp;
  /** Historical labels only; version 3 writing lives in its surface manifest. */
  label?: string;
  text?: string;
  designId: string;
  furnitureId: string;
  room: number;
  /** Local tabletop coordinates in metres; angle is radians. */
  x: number;
  y: number;
  top: number;
  w: number;
  d: number;
  h: number;
  angle: number;
}
export interface ResolvedScene {
  version: 1;
  catalogVersion: 1;
  rooms: ResolvedSceneRoom[];
  furniture: ResolvedSceneFurniture[];
  props: ResolvedSceneProp[];
}
const radians = (angle: number) => (angle * Math.PI) / 180;
const CONDITION_HP = { intact: 1, worn: 0.85, damaged: 0.45 } as const;
const SURFACE_MARGIN = 0.025;
const PROP_GAP = 0.014;

/** A scene furniture name is a built-in kind or one of the design's composed
 * objects; this resolves it to what the engine builds. */
function sceneKind(
  floor: Floor,
  name: string,
): { kind: FurnitureKind; object?: RunCustomObject } {
  const object = floor.setting?.objects.find((o) => o.id === name);
  return object ? { kind: "custom", object } : { kind: name as FurnitureKind };
}
/** Envelope (and recipe, for a design's own prop) behind a scene prop kind. */
function propSpec(
  floor: Floor,
  kind: string,
): { size: { w: number; d: number; h: number }; object?: RunCustomProp } {
  if (Object.hasOwn(PROP_CATALOG, kind))
    return { size: PROP_CATALOG[kind as ScenePropKind] };
  const object = floor.setting?.props?.find((o) => o.id === kind);
  if (!object) throw Error(`unknown prop ${kind}`);
  return { size: object.size, object };
}
/** Largest centred tabletop of a surface object, or of a built-in kind. */
function supportSurface(
  object: Pick<Furniture, "kind" | "object" | "w" | "h">,
) {
  const recipe = object.object;
  if (object.kind !== "custom" || !recipe)
    return {
      top: furnitureSurfaceHeight(object.kind),
      ...furnitureSurfaceBounds(object.kind, object.w, object.h),
    };
  const top = surfaceTop(recipe);
  const part = recipe.parts
    .filter(
      (p) =>
        (p.shape === "box" ||
          (p.shape === "cylinder" && (p.axis ?? "up") === "up")) &&
        Math.abs(p.z + p.h - (top ?? NaN)) < 1e-9,
    )
    .sort((a, b) => b.w * b.d - a.w * a.d)[0];
  // A round top only holds what fits in its inscribed rectangle, so a prop's
  // corners never hang past the rim.
  const inset = part?.shape === "cylinder" ? Math.SQRT1_2 : 1;
  return {
    top: top ?? 0,
    w: part ? Math.max(0, part.w * inset - 2 * Math.abs(part.x)) : 0,
    d: part ? Math.max(0, part.d * inset - 2 * Math.abs(part.y)) : 0,
  };
}

function failure(
  floor: Floor,
  room: number,
  id: string,
  reason: string,
): never {
  throw Error(
    `Authored scene floor ${floor.index}, room ${room}, item ${id}: ${reason}`,
  );
}
function furnitureId(floor: Floor, room: number, id: string) {
  return `f${floor.index}-scene-room${room}-${id}`;
}
function appearance(
  room: number,
  item: SceneFurnitureDesign | SceneFurnitureStructure,
): NonNullable<Furniture["appearance"]> {
  return {
    color: item.color,
    condition: item.condition,
    ...("label" in item ? { label: item.label } : {}),
    owner: item.owner,
    room,
    designId: item.id,
  };
}
function contains(sector: Sector, point: Point) {
  return sector.blocks.some((b) =>
    inRect(b, Math.floor(point.x), Math.floor(point.y)),
  );
}
function insideFootprint(floor: Floor, x: number, y: number) {
  const boundary = floor.boundary;
  if (!boundary) return x >= 1 && y >= 1 && x < W - 1 && y < H - 1;
  const row = boundary.rows[y];
  return (
    !!row &&
    y >= boundary.top &&
    y < boundary.bottom &&
    x >= row.left &&
    x < row.right
  );
}

function roomPlaque(floor: Floor, sector: Sector): ResolvedSceneRoom["plaque"] {
  const candidates: ResolvedSceneRoom["plaque"][] = [];
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      if (!floor.tiles[y][x] || !insideFootprint(floor, x, y)) continue;
      for (const [nx, ny] of [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ]) {
        const open = { x: x + nx + 0.5, y: y + ny + 0.5 };
        if (wall(floor, open.x, open.y) || !contains(sector, open)) continue;
        if (
          floor.furniture.some(
            (o) =>
              (o.field || o.door) &&
              Math.hypot(o.x - open.x, o.y - open.y) < 2.4,
          )
        )
          continue;
        candidates.push({
          x: x + 0.5 + nx * 0.514,
          y: y + 0.5 + ny * 0.514,
          nx,
          ny,
        });
      }
    }
  if (!candidates.length)
    failure(
      floor,
      sector.room!,
      "room-plaque",
      "no solid interior wall face clear of passages",
    );
  // A stable spatial choice: room identity is never attached to a random desk.
  return candidates[0];
}

function hasKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function validPlaque(
  floor: Floor,
  room: number,
  p: ResolvedSceneRoom["plaque"],
) {
  if (
    !hasKeys(p, ["x", "y", "nx", "ny"]) ||
    !Number.isFinite(p.x) ||
    !Number.isFinite(p.y) ||
    ![
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
    ].some(([nx, ny]) => p.nx === nx && p.ny === ny)
  )
    return false;
  const x = Math.round(p.x - p.nx * 0.514 - 0.5),
    y = Math.round(p.y - p.ny * 0.514 - 0.5),
    open = { x: x + p.nx + 0.5, y: y + p.ny + 0.5 },
    sector = floorSectors(floor).find((s) => s.room === room);
  return (
    !!sector &&
    Math.abs(p.x - (x + 0.5 + p.nx * 0.514)) < 1e-8 &&
    Math.abs(p.y - (y + 0.5 + p.ny * 0.514)) < 1e-8 &&
    insideFootprint(floor, x, y) &&
    !!floor.tiles[y]?.[x] &&
    !wall(floor, open.x, open.y) &&
    contains(sector, open) &&
    !floor.furniture.some(
      (o) =>
        (o.field || o.door) && Math.hypot(o.x - open.x, o.y - open.y) < 2.4,
    )
  );
}

function candidatePositions(
  floor: Floor,
  sector: Sector,
  item: SceneFurnitureDesign | SceneFurnitureStructure,
) {
  const x1 = Math.min(...sector.blocks.map((b) => b.x1)),
    y1 = Math.min(...sector.blocks.map((b) => b.y1)),
    x2 = Math.max(...sector.blocks.map((b) => b.x2)) + 1,
    y2 = Math.max(...sector.blocks.map((b) => b.y2)) + 1,
    wanted = { x: x1 + (x2 - x1) * item.at.x, y: y1 + (y2 - y1) * item.at.y },
    candidates: Point[] = [];
  // Half-metre steps offer meaningful authored placement without an unbounded search.
  for (let y = y1 + 0.25; y < y2; y += 0.5)
    for (let x = x1 + 0.25; x < x2; x += 0.5)
      if (!wall(floor, x, y) && contains(sector, { x, y }))
        candidates.push({ x, y });
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - wanted.x, a.y - wanted.y) -
        Math.hypot(b.x - wanted.x, b.y - wanted.y) ||
      a.y - b.y ||
      a.x - b.x,
  );
  return candidates.slice(0, 1200);
}
function withinSector(sector: Sector, object: Furniture) {
  // Cover every crossed cell, not just corners of a concave room union.
  const bounds = boxBounds(object);
  for (let y = object.y - bounds.h / 2; y <= object.y + bounds.h / 2; y += 0.2)
    for (
      let x = object.x - bounds.w / 2;
      x <= object.x + bounds.w / 2;
      x += 0.2
    )
      if (inFurniture({ x, y }, object, 0.01) && !contains(sector, { x, y }))
        return false;
  return true;
}

function sealGrid(floor: Floor, sealed: Furniture[]) {
  const seal = new Uint8Array(W * H);
  // Include all quota entries, including forward-oriented version 5 fields.
  const fields = floor.furniture.filter(
    (o) => o.field && !o.field.exit && o.field.limit !== undefined,
  );
  for (const o of new Set([...sealed, ...fields]))
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (inFurniture({ x: x + 0.5, y: y + 0.5 }, { ...o, field: undefined }))
          seal[y * W + x] = 1;
  return seal;
}

function placeFurniture(
  floor: Floor,
  sector: Sector,
  item: SceneFurnitureDesign | SceneFurnitureStructure,
  keepClear: Point[],
  from: Point,
  sealed: Furniture[],
) {
  const id = furnitureId(floor, sector.room!, item.id),
    resolved = sceneKind(floor, item.kind),
    object = makeFurniture(
      id,
      floor.index,
      resolved.kind,
      { x: 0, y: 0 },
      radians(item.angle),
      resolved.object,
    ),
    grid = blockedGrid(floor),
    before = reachable(grid, from),
    seal = sealGrid(floor, sealed),
    at = (p: Point) => Math.floor(p.y) * W + Math.floor(p.x);
  object.appearance = appearance(sector.room!, item);
  object.hp = object.maxHp * CONDITION_HP[item.condition];
  for (const candidate of candidatePositions(floor, sector, item)) {
    Object.assign(object, candidate);
    if (
      !withinSector(sector, object) ||
      floor.stations.some((s) => inFurniture(s, object, 0.8)) ||
      keepClear.some((p) => inFurniture(p, object, 1.6)) ||
      !canPlace(
        floor,
        object,
        object,
        object.w,
        object.h,
        object.angle ?? 0,
        0.6,
      )
    )
      continue;
    const next = grid.slice();
    markObject(next, object);
    const after = reachable(next, from),
      egress = reachable(
        next.map((value, i) => value | seal[i]),
        floor.stairs,
      );
    if (
      [...floor.stations, floor.stairs].some((s) => !after[at(s)]) ||
      floor.stations.some((s) => !egress[at(s)]) ||
      before.some((seen, i) => seen && !after[i] && !next[i])
    )
      continue;
    floor.furniture.push(object);
    return object;
  }
  const biggest = sector.blocks.reduce((best, b) =>
      (b.x2 - b.x1 + 1) * (b.y2 - b.y1 + 1) >
      (best.x2 - best.x1 + 1) * (best.y2 - best.y1 + 1)
        ? b
        : best,
    ),
    terminals = floor.stations.filter((s) =>
      sector.blocks.some((b) => inRect(b, s.x, s.y)),
    ).length;
  return failure(
    floor,
    sector.room!,
    item.id,
    `cannot place ${item.kind} (${object.w.toFixed(2)}×${object.h.toFixed(2)} m) at angle ${item.angle} while preserving terminals, passages and egress. This room's largest open block is about ${biggest.x2 - biggest.x1 + 1}×${biggest.y2 - biggest.y1 + 1} m and holds ${terminals} terminal(s) that need 0.8 m clearance plus 1.6 m around doorways and stairs. Choose a smaller piece, another angle or anchor nearer a wall, or move it to a roomier room`,
  );
}

function propBox(
  prop: Pick<ResolvedSceneProp, "x" | "y" | "w" | "d" | "angle">,
) {
  return { x: prop.x, y: prop.y, w: prop.w, h: prop.d, angle: prop.angle };
}
function propFits(
  prop: ResolvedSceneProp,
  width: number,
  depth: number,
  siblings: ResolvedSceneProp[],
  blockers: { x: number; y: number; w: number; h: number }[] = [],
) {
  const bounds = boxBounds(propBox(prop));
  return (
    Math.abs(prop.x) + bounds.w / 2 <= width / 2 - SURFACE_MARGIN + 1e-8 &&
    Math.abs(prop.y) + bounds.h / 2 <= depth / 2 - SURFACE_MARGIN + 1e-8 &&
    prop.top + prop.h <= 2.75 &&
    siblings.every(
      (other) => !boxesOverlap(propBox(prop), propBox(other), PROP_GAP),
    ) &&
    blockers.every((part) => !boxesOverlap(propBox(prop), part, PROP_GAP))
  );
}
/** Parts of a composed host that rise above its prop surface, as boxes in the
 * host's frame; props pack around them (a lectern's book rest, a hood). */
function raisedParts(object: Furniture, top: number) {
  return (object.object?.parts ?? [])
    .filter((p) => p.z + p.h > top + 0.005)
    .map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.d }));
}
function resolveProp(
  floor: Floor,
  room: number,
  object: Furniture,
  item: ScenePropDesign | ScenePropStructure,
  siblings: ResolvedSceneProp[],
) {
  let spec: ReturnType<typeof propSpec>;
  try {
    spec = propSpec(floor, item.kind);
  } catch {
    return failure(
      floor,
      room,
      item.id,
      `prop ${item.kind} is neither built in nor in setting.props`,
    );
  }
  const catalog = spec.size,
    support = supportSurface(object),
    { at, angle, ...details } = item,
    prop: ResolvedSceneProp = {
      ...details,
      ...(spec.object ? { object: structuredClone(spec.object) } : {}),
      id: `${object.id}-${item.id}`,
      designId: item.id,
      furnitureId: object.id,
      room,
      x: 0,
      y: 0,
      top: support.top + 0.002,
      w: catalog.w * item.scale,
      d: catalog.d * item.scale,
      h: catalog.h * item.scale,
      angle: radians(angle),
    },
    bounds = boxBounds(propBox(prop)),
    surface = support,
    halfX = (surface.w - bounds.w) / 2 - SURFACE_MARGIN,
    halfY = (surface.d - bounds.h) / 2 - SURFACE_MARGIN;
  if (halfX < 0 || halfY < 0)
    return failure(
      floor,
      room,
      item.id,
      `prop ${item.kind} is too large for ${object.kind}; use a smaller scale or larger support`,
    );
  const wanted = { x: at.x * halfX, y: at.y * halfY },
    candidates = [wanted];
  for (let iy = 0; iy <= 16; iy++)
    for (let ix = 0; ix <= 16; ix++)
      candidates.push({
        x: -halfX + (ix * halfX) / 8,
        y: -halfY + (iy * halfY) / 8,
      });
  candidates.sort(
    (a, b) =>
      Math.hypot(a.x - wanted.x, a.y - wanted.y) -
        Math.hypot(b.x - wanted.x, b.y - wanted.y) ||
      a.y - b.y ||
      a.x - b.x,
  );
  for (const candidate of candidates) {
    Object.assign(prop, candidate);
    if (
      propFits(
        prop,
        surface.w,
        surface.d,
        siblings,
        raisedParts(object, support.top),
      )
    )
      return prop;
  }
  return failure(
    floor,
    room,
    item.id,
    `no clear tabletop space for ${item.kind}; reduce clutter or choose another support`,
  );
}

/** Resolve a validated blueprint before seeded filler. Never silently omit an item. */
export function realizeAuthoredScene(
  floor: Floor,
  keepClear: Point[],
  from: Point,
  sealed: Furniture[],
) {
  const design = floor.design?.scene;
  if (!design) return;
  if (floor.scene)
    throw Error(`Authored scene floor ${floor.index} was already realized`);
  const scene: ResolvedScene = {
    version: 1,
    catalogVersion: 1,
    rooms: [],
    furniture: [],
    props: [],
  };
  const problems: string[] = [];
  for (const room of design.rooms) {
    const sector = floorSectors(floor).find((s) => s.room === room.room);
    if (!sector) failure(floor, room.room, "room", "study room is missing");
    const { furniture, ...details } = room;
    scene.rooms.push({
      ...structuredClone(details),
      plaque: roomPlaque(floor, sector),
    });
    for (const item of furniture) {
      // Report every problem in one pass so a repair round can fix them all.
      let object: Furniture;
      try {
        object = placeFurniture(floor, sector, item, keepClear, from, sealed);
      } catch (error) {
        problems.push(String((error as Error).message));
        continue;
      }
      scene.furniture.push({
        id: object.id,
        designId: item.id,
        room: room.room,
        kind: item.kind,
      });
      const siblings: ResolvedSceneProp[] = [];
      for (const prop of item.props)
        try {
          siblings.push(resolveProp(floor, room.room, object, prop, siblings));
        } catch (error) {
          problems.push(String((error as Error).message));
        }
      scene.props.push(...siblings);
    }
  }
  if (problems.length) throw Error(problems.join("; "));
  floor.scene = scene;
}

/** Surface contents follow native motion, and vanish with a removed/destroyed support. */
export function propWorldPose(floor: Floor, prop: ResolvedSceneProp) {
  const parent = floor.furniture.find((o) => o.id === prop.furnitureId);
  if (!parent || parent.destroyed) return undefined;
  return { ...worldPoint(prop, parent), elevation: prop.top, parent };
}

/** Validate saved anchors without regenerating geometry or undoing player movement.
 * Stamped extra sites own their floor furniture; `sites` tells their prefixed
 * ids from the start site's authored content. */
export function sceneSaveErrors(
  floor: Floor,
  sites?: readonly { id: string }[],
): string[] {
  const design = floor.design?.scene,
    scene = floor.scene,
    errors: string[] = [];
  if (!design)
    return scene ||
      floor.furniture.some((o) => o.appearance && !stampedBySite(o, sites))
      ? ["Scene data has no authored blueprint"]
      : [];
  if (
    !hasKeys(scene, [
      "version",
      "catalogVersion",
      "rooms",
      "furniture",
      "props",
    ]) ||
    scene.version !== 1 ||
    scene.catalogVersion !== 1 ||
    !Array.isArray(scene.rooms) ||
    !Array.isArray(scene.furniture) ||
    !Array.isArray(scene.props) ||
    scene.rooms.length !== 4 ||
    scene.furniture.length > 16 ||
    scene.props.length > 48
  )
    return ["Missing or unsupported resolved scene"];
  const expectedFurniture = design.rooms.flatMap((room) =>
    room.furniture.map((item) => ({
      room,
      item,
      id: furnitureId(floor, room.room, item.id),
    })),
  );
  if (
    scene.rooms.length !== design.rooms.length ||
    scene.furniture.length !== expectedFurniture.length ||
    scene.props.length !==
      expectedFurniture.reduce((sum, { item }) => sum + item.props.length, 0)
  )
    errors.push("Resolved scene counts do not match the blueprint");
  for (const room of design.rooms) {
    const saved = scene.rooms.filter((r) => r?.room === room.room),
      { furniture: _furniture, palette, ...metadata } = room;
    if (saved.length !== 1) {
      errors.push(`Scene room ${room.room} is missing or duplicated`);
      continue;
    }
    const actual = saved[0];
    if (
      !hasKeys(actual, [
        "room",
        "title",
        "description",
        "owner",
        "palette",
        "condition",
        "plaque",
      ]) ||
      !hasKeys(actual.palette, ["surface", "metal", "accent"]) ||
      Object.entries(palette).some(
        ([key, value]) => actual.palette[key as keyof typeof palette] !== value,
      ) ||
      Object.entries(metadata).some(
        ([key, value]) => actual[key as keyof ResolvedSceneRoom] !== value,
      )
    )
      errors.push(
        `Scene room ${room.room} metadata differs from its blueprint`,
      );
    const p = actual.plaque;
    if (!validPlaque(floor, room.room, p))
      errors.push(`Scene room ${room.room} has an invalid plaque anchor`);
  }
  for (const { room, item, id } of expectedFurniture) {
    const bindings = scene.furniture.filter((o) => o?.id === id),
      objects = floor.furniture.filter(
        (o) => o.id === id && !stampedBySite(o, sites),
      ),
      resolved = sceneKind(floor, item.kind),
      size = furnitureSpec(resolved),
      support = supportSurface({
        kind: resolved.kind,
        object: resolved.object,
        w: size.w,
        h: size.h,
      }),
      surface = support;
    if (resolved.kind === "custom" && !resolved.object) {
      errors.push(`Scene furniture ${id} names an unknown object`);
      continue;
    }
    if (
      bindings.length !== 1 ||
      !hasKeys(bindings[0], ["id", "designId", "room", "kind"]) ||
      bindings[0]?.designId !== item.id ||
      bindings[0]?.room !== room.room ||
      bindings[0]?.kind !== item.kind
    )
      errors.push(`Scene furniture ${id} does not match its blueprint`);
    if (
      objects.length > 1 ||
      objects.some(
        (o) =>
          o.kind !== resolved.kind ||
          (resolved.object &&
            JSON.stringify(o.object) !== JSON.stringify(resolved.object)) ||
          o.w !== size.w ||
          o.h !== size.h ||
          !Number.isFinite(o.x) ||
          !Number.isFinite(o.y) ||
          !Number.isFinite(o.angle ?? 0) ||
          !hasKeys(o.appearance, [
            "color",
            "condition",
            ...("label" in item ? ["label"] : []),
            "owner",
            "room",
            "designId",
          ]) ||
          Object.entries(appearance(room.room, item)).some(
            ([key, value]) =>
              o.appearance?.[
                key as keyof NonNullable<Furniture["appearance"]>
              ] !== value,
          ),
      )
    )
      errors.push(`Native scene furniture ${id} does not match its blueprint`);
    const checked: ResolvedSceneProp[] = [];
    for (const prop of item.props) {
      const matches = scene.props.filter((p) => p?.id === `${id}-${prop.id}`);
      if (matches.length !== 1) {
        errors.push(`Scene prop ${prop.id} is missing or duplicated`);
        continue;
      }
      let spec: ReturnType<typeof propSpec>;
      try {
        spec = propSpec(floor, prop.kind);
      } catch {
        errors.push(`Scene prop ${prop.id} names an unknown prop`);
        continue;
      }
      const actual = matches[0],
        catalog = spec.size,
        { at: _at, angle: _angle, id: _id, ...metadata } = prop;
      if (
        !hasKeys(actual, [
          "id",
          "kind",
          "scale",
          "color",
          "accent",
          "condition",
          "owner",
          ...(spec.object ? ["object"] : []),
          ...("label" in prop ? ["label", "text"] : []),
          "designId",
          "furnitureId",
          "room",
          "x",
          "y",
          "top",
          "w",
          "d",
          "h",
          "angle",
        ]) ||
        Object.entries(metadata).some(
          ([key, value]) => actual[key as keyof ResolvedSceneProp] !== value,
        ) ||
        JSON.stringify(actual.object) !== JSON.stringify(spec.object) ||
        actual.designId !== prop.id ||
        actual.furnitureId !== id ||
        actual.room !== room.room ||
        actual.angle !== radians(prop.angle) ||
        actual.w !== catalog.w * prop.scale ||
        actual.d !== catalog.d * prop.scale ||
        actual.h !== catalog.h * prop.scale ||
        actual.top !== support.top + 0.002 ||
        !Number.isFinite(actual.x) ||
        !Number.isFinite(actual.y) ||
        !propFits(actual, surface.w, surface.d, checked)
      )
        errors.push(
          `Scene prop ${prop.id} differs from its blueprint or leaves its support`,
        );
      checked.push(actual);
    }
  }
  const ids = new Set(expectedFurniture.map((o) => o.id));
  if (
    floor.furniture.some(
      (o) => o.appearance && !ids.has(o.id) && !stampedBySite(o, sites),
    )
  )
    errors.push("Unbound authored furniture in saved floor");
  return errors;
}
