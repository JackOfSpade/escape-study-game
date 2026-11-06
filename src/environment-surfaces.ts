import {
  buildInteriorLighting,
  hasDeskStory,
  interiorHash,
} from "./interior-lighting";
import { floorSectors, inRect } from "./floor-plan";
import { cityWall, type CityObstacle } from "./city-layout";
import { CONFIG, type Floor, type Furniture, type Game } from "./model";
import {
  furnitureHeightOf,
  furnitureSurfaceHeightOf,
} from "./view3d/furniture-height";
import { streetLayout } from "./view3d/exterior-layout";
import {
  furnitureBoardFace,
  furnitureLabelFace,
  propSurfaceFace,
} from "./environment-faces";
import type {
  SurfaceBinding,
  SurfaceSlot,
  SurfaceRole,
} from "./environment-contract.mjs";
import { parseEnvironmentSurfaces } from "./environment-contract.mjs";

/** This inventory is generated once, before writing is requested. It uses no
 * rendering state, browser APIs or simulation RNG. Saved inventories are never
 * selected again after furniture moves or disappears. */
/** An ON AIR lightbox's label is the lit text itself, painted as a glowing sign. */
/** Height of seeded paper, mug and photo dressing on a desk-like host. Desks
 * keep their historical value; a mixing console's dressing sits on its deck. */
export function dressingTop(host: Furniture) {
  return host.kind === "mixingConsole"
    ? furnitureSurfaceHeightOf(host) + 0.005
    : furnitureHeightOf(host) + 0.055;
}
export const ON_AIR_LABEL_CONTEXT =
  "onAirLight lit sign: the few words it shows while a broadcast is live, such as ON AIR.";
export const ENVIRONMENT_BUILDER_VERSION = "environment-v1";

export interface SurfacePose {
  x: number;
  y: number;
  /** Elevation above this floor, not absolute building elevation. */
  z: number;
  yaw: number;
  pitch: number;
  width: number;
  height: number;
  parent?: Furniture;
}

/** The only pose adapter used by graphics, readable captions and NPC evidence. */
export function surfaceWorldPose(
  floor: Floor,
  slot: SurfaceSlot,
): SurfacePose | undefined {
  if (slot.floor !== floor.index) return undefined;
  const b = slot.binding;
  if (b.kind === "fixed") return { ...b };
  const parent = floor.furniture.find((f) => f.id === b.furnitureId);
  if (!parent || parent.destroyed) return undefined;
  let { x, y, z, yaw } = b;
  if (b.kind === "prop") {
    const prop = floor.scene?.props.find(
      (p) => p.id === b.propId && p.furnitureId === parent.id,
    );
    if (!prop) return undefined;
    const c = Math.cos(prop.angle),
      s = Math.sin(prop.angle);
    [x, y] = [prop.x + x * c - y * s, prop.y + x * s + y * c];
    z += prop.top;
    yaw += prop.angle;
  }
  const angle = parent.angle ?? 0,
    c = Math.cos(angle),
    s = Math.sin(angle);
  return {
    x: parent.x + x * c - y * s,
    y: parent.y + x * s + y * c,
    z,
    yaw: yaw + angle,
    pitch: b.pitch,
    width: b.width,
    height: b.height,
    parent,
  };
}

/** The same bounded set that receives the existing solid papers/mugs/frames. */
export function seededDressingHosts(floor: Floor, seed: number) {
  const desks = floor.furniture
    .filter((o) => !o.appearance && hasDeskStory(o))
    .sort(
      (a, b) =>
        interiorHash(seed, floor.index, a.id) -
          interiorHash(seed, floor.index, b.id) || a.id.localeCompare(b.id),
    )
    .slice(0, 64);
  const boards = floor.furniture
    .filter((o) => !o.appearance && o.kind === "whiteboard" && !o.destroyed)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 72 - desks.length);
  return { desks, boards };
}

export interface CityFacadeAddress {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export function cityObstacleId(o: CityObstacle) {
  const key = `${o.kind}/${o.x}/${o.y}/${o.w}/${o.h}`;
  return `block-${interiorHash(0, 0, key).toString(16)}-${interiorHash(1, 0, key).toString(16)}`;
}
/** Physical address slices, identified by obstacle and side rather than a
 * global counter that renumbers unrelated signs when another block is added. */
export function cityFacadeAddresses(o: CityObstacle): CityFacadeAddress[] {
  const result: CityFacadeAddress[] = [],
    depth = Math.min(6, o.h / 2),
    sideDepth = Math.min(6, o.w / 2),
    across = Math.max(1, Math.ceil(o.w / 18));
  for (const side of [-1, 1])
    for (let j = 0; j < across; j++)
      result.push({
        id: `${cityObstacleId(o)}:horizontal:${side}:${j}`,
        x: o.x - o.w / 2 + (o.w / across) * (j + 0.5),
        y: o.y + side * (o.h / 2 - depth / 2),
        w: o.w / across,
        h: depth,
      });
  const along = Math.max(1, Math.ceil((o.h - 2 * depth) / 18));
  if (o.h > 2 * depth)
    for (const side of [-1, 1])
      for (let j = 0; j < along; j++)
        result.push({
          id: `${cityObstacleId(o)}:vertical:${side}:${j}`,
          x: o.x + side * (o.w / 2 - sideDepth / 2),
          y: o.y - o.h / 2 + depth + ((o.h - 2 * depth) / along) * (j + 0.5),
          w: sideDepth,
          h: (o.h - 2 * depth) / along,
        });
  return result;
}
export function cityFacadeSignFaces(floor: Floor, a: CityFacadeAddress) {
  if (
    Math.hypot(
      Math.max(0, Math.abs(a.x - 22) - a.w / 2),
      Math.max(0, Math.abs(a.y - 25) - a.h / 2),
    ) >= 95
  )
    return [];
  const clamp = (n: number, lo: number, hi: number) =>
    Math.max(lo, Math.min(n, hi));
  return [
    {
      x: a.x - a.w / 2 - 0.06,
      y: clamp(35, a.y - a.h / 2 + 1.8, a.y + a.h / 2 - 1.8),
      nx: -1,
      ny: 0,
      span: a.h,
    },
    {
      x: a.x + a.w / 2 + 0.06,
      y: clamp(35, a.y - a.h / 2 + 1.8, a.y + a.h / 2 - 1.8),
      nx: 1,
      ny: 0,
      span: a.h,
    },
    {
      x: clamp(22, a.x - a.w / 2 + 1.8, a.x + a.w / 2 - 1.8),
      y: a.y - a.h / 2 - 0.06,
      nx: 0,
      ny: -1,
      span: a.w,
    },
    {
      x: clamp(22, a.x - a.w / 2 + 1.8, a.x + a.w / 2 - 1.8),
      y: a.y + a.h / 2 + 0.06,
      nx: 0,
      ny: 1,
      span: a.w,
    },
  ].filter(
    (f) =>
      f.span >= 3.8 &&
      cityWall(floor, f.x + f.nx * 0.15, f.y + f.ny * 0.15) === false,
  );
}

function roomAt(floor: Floor, x: number, y: number) {
  return (
    floorSectors(floor).find(
      (s) =>
        s.room !== undefined &&
        s.blocks.some((b) => inRect(b, Math.floor(x), Math.floor(y))),
    )?.room ?? null
  );
}
function inside(floor: Floor, x: number, y: number) {
  const b = floor.boundary,
    row = b?.rows[Math.floor(y)];
  return (
    !!b && !!row && y >= b.top && y < b.bottom && x >= row.left && x < row.right
  );
}
function fixed(
  x: number,
  y: number,
  z: number,
  width: number,
  height: number,
  yaw = 0,
  pitch = 0,
): SurfaceBinding {
  return { kind: "fixed", x, y, z, width, height, yaw, pitch };
}

/** Exact, individually addressable environmental writing/art surfaces. */
export function buildEnvironmentSurfaces(
  game: Pick<Game, "floors" | "seed">,
): SurfaceSlot[] {
  const slots: SurfaceSlot[] = [];
  for (const floor of game.floors) {
    const add = (
      id: string,
      role: SurfaceRole,
      binding: SurfaceBinding,
      context: string,
      room: number | null = null,
      maxTitle = 48,
      maxBody = 160,
      scope: "interior" | "exterior" = "interior",
      owner?: string | null,
    ) => {
      const description = floor.scene?.rooms.find((r) => r.room === room);
      slots.push({
        id,
        floor: floor.index,
        scope,
        role,
        room,
        owner: owner === undefined ? (description?.owner ?? null) : owner,
        binding,
        context: `${floor.name}. ${description?.title ?? ""} ${context}`
          .trim()
          .slice(0, 240),
        maxTitle,
        maxBody,
        allowsArt: true,
      });
    };
    const plan = buildInteriorLighting(floor, game.seed);
    for (const s of plan.stories) {
      const wx = Math.floor(s.x - s.nx * 0.514),
        wy = Math.floor(s.y - s.ny * 0.514);
      add(
        `f${floor.index}:wall:${wx}:${wy}:${s.nx}:${s.ny}`,
        s.story === 3 ? "wall-whiteboard" : "wall-poster",
        fixed(s.x, s.y, 1.69, s.width, s.height, -Math.atan2(s.nx, s.ny)),
        s.story === 3
          ? "Wall-mounted whiteboard writing and diagrams."
          : "Printed wall poster; every poster is a separate object.",
        roomAt(floor, s.x + s.nx * 0.2, s.y + s.ny * 0.2),
      );
    }
    const { desks, boards } = seededDressingHosts(floor, game.seed);
    for (const host of desks) {
      const roll = interiorHash(game.seed, floor.index, host.id),
        top = dressingTop(host),
        x = host.w * 0.22,
        y = -host.h * 0.19,
        pageW = Math.min(0.25, host.w * 0.32),
        pageD = Math.min(0.29, host.h * 0.38),
        room = roomAt(floor, host.x, host.y),
        binding = (
          x: number,
          y: number,
          z: number,
          width: number,
          height: number,
          pitch = 0,
        ): SurfaceBinding => ({
          kind: "furniture",
          furnitureId: host.id,
          x,
          y,
          z,
          width,
          height,
          yaw: 0,
          pitch,
        });
      // A sticky note occupies the top sheet when selected; do not stack two
      // independently written coplanar textures on the very same paper.
      if (roll % 4 === 1)
        add(
          `${host.id}:note`,
          "desk-note",
          binding(
            -x,
            y + pageD * 0.02,
            top + 0.023,
            pageW * 0.82,
            pageD * 0.82,
            -Math.PI / 2,
          ),
          "Personal note on this desk's paper stack.",
          room,
          28,
          100,
        );
      else
        add(
          `${host.id}:papers`,
          "desk-papers",
          binding(
            -x + 0.012,
            y + 0.018,
            top + 0.0135,
            pageW * 0.95,
            pageD * 0.95,
            -Math.PI / 2,
          ),
          "Top sheet of this desk's paper stack.",
          room,
          28,
          100,
        );
      if (roll % 3 === 0 || host.kind === "desk" || host.kind === "reception")
        add(
          `${host.id}:photo`,
          "desk-photo",
          binding(x, y + 0.0145, top + 0.115, 0.136, 0.176),
          "Framed desk photograph. Illustrate the people or scene; any caption belongs to this frame.",
          room,
          24,
          60,
        );
    }
    for (const host of [
      ...boards,
      ...floor.furniture.filter((o) => o.appearance && o.kind === "whiteboard"),
    ]) {
      add(
        `${host.id}:whiteboard`,
        "furniture-whiteboard",
        {
          kind: "furniture",
          furnitureId: host.id,
          ...furnitureBoardFace(host),
        },
        "Writing and diagrams on this movable whiteboard's actual face.",
        host.appearance?.room ?? roomAt(floor, host.x, host.y),
      );
    }
    for (const room of floor.scene?.rooms ?? []) {
      const p = room.plaque;
      add(
        `f${floor.index}:room:${room.room}:plaque`,
        "room-plaque",
        fixed(p.x, p.y, 1.65, 1.12, 0.5, -Math.atan2(p.nx, p.ny)),
        `${room.title}. ${room.description}`,
        room.room,
        48,
        180,
      );
    }
    for (const item of floor.scene?.furniture ?? []) {
      const host = floor.furniture.find((o) => o.id === item.id);
      if (!host) continue;
      const face = furnitureLabelFace(host);
      add(
        `${host.id}:label`,
        "furniture-label",
        {
          kind: "furniture",
          furnitureId: host.id,
          x: 0,
          y: face.z,
          z: face.y,
          width: face.w,
          height: face.h,
          yaw: 0,
          pitch: 0,
        },
        host.kind === "onAirLight"
          ? ON_AIR_LABEL_CONTEXT
          : host.kind === "custom" && host.object
            ? `${host.object.name} ownership or purpose tag.`
            : `${host.kind} ownership or purpose tag.`,
        item.room,
        24,
        0,
        "interior",
        host.appearance?.owner,
      );
    }
    for (const prop of floor.scene?.props ?? []) {
      const face = propSurfaceFace(prop),
        tiny = face.width < 0.05 || face.height < 0.025;
      add(
        `${prop.id}:face`,
        "prop-face",
        {
          kind: "prop",
          furnitureId: prop.furnitureId,
          propId: prop.id,
          ...face,
        },
        `${prop.kind} face. ${prop.condition} condition. Give this individual object its own authored writing or illustration.`,
        prop.room,
        tiny ? 0 : 28,
        tiny ? 0 : 100,
        "interior",
        prop.owner,
      );
    }
    if (floor.index < CONFIG.floors) {
      // Low wall marks use a whole, existing interior wall face. Kept well away
      // from portals and other surfaces, they add no collision or false opening.
      const candidates: {
        x: number;
        y: number;
        nx: number;
        ny: number;
        wx: number;
        wy: number;
      }[] = [];
      for (let y = 1; y < floor.tiles.length - 1; y++)
        for (let x = 1; x < floor.tiles[y].length - 1; x++) {
          if (!floor.tiles[y][x] || !inside(floor, x + 0.5, y + 0.5)) continue;
          for (const [nx, ny] of [
            [0, 1],
            [1, 0],
            [0, -1],
            [-1, 0],
          ]) {
            const p = {
              x: x + 0.5 + nx * 0.514,
              y: y + 0.5 + ny * 0.514,
              nx,
              ny,
              wx: x,
              wy: y,
            };
            if (
              floor.tiles[y + ny]?.[x + nx] !== 0 ||
              !inside(floor, x + nx + 0.5, y + ny + 0.5)
            )
              continue;
            if (
              !floor.tiles[y + (nx ? 1 : 0)]?.[x + (ny ? 1 : 0)] ||
              !floor.tiles[y - (nx ? 1 : 0)]?.[x - (ny ? 1 : 0)]
            )
              continue;
            if (
              floor.furniture.some(
                (o) =>
                  (o.field || o.door) && Math.hypot(o.x - p.x, o.y - p.y) < 2.4,
              )
            )
              continue;
            if (
              slots.some(
                (s) =>
                  s.floor === floor.index &&
                  s.binding.kind === "fixed" &&
                  Math.hypot(s.binding.x - p.x, s.binding.y - p.y) < 2.1,
              )
            )
              continue;
            candidates.push(p);
          }
        }
      candidates.sort(
        (a, b) =>
          interiorHash(
            game.seed,
            floor.index,
            `graffiti:${a.wx}:${a.wy}:${a.nx}:${a.ny}`,
          ) -
          interiorHash(
            game.seed,
            floor.index,
            `graffiti:${b.wx}:${b.wy}:${b.nx}:${b.ny}`,
          ),
      );
      let count = 0;
      for (const p of candidates) {
        if (
          slots.some(
            (s) =>
              s.floor === floor.index &&
              s.binding.kind === "fixed" &&
              Math.hypot(s.binding.x - p.x, s.binding.y - p.y) < 2.1,
          )
        )
          continue;
        add(
          `f${floor.index}:graffiti:${p.wx}:${p.wy}:${p.nx}:${p.ny}`,
          "graffiti",
          fixed(p.x, p.y, 1.15, 1.2, 0.65, -Math.atan2(p.nx, p.ny)),
          "Paint or marker graffiti on this solid wall; transparent art background is allowed.",
          roomAt(floor, p.x + p.nx * 0.2, p.y + p.ny * 0.2),
          36,
          100,
        );
        if (++count === 4) break;
      }
    }
    if (floor.index !== 0) continue;
    const layout = streetLayout(floor);
    if (layout)
      add(
        "building:entrance-sign",
        "building-sign",
        fixed(layout.entrance, layout.front + 1.025 + 0.56, 3.22, 3.55, 0.74),
        `${floor.exteriorDesign?.buildingName ?? "Building"}. ${floor.exteriorDesign?.buildingSubtitle ?? ""}`,
        null,
        48,
        100,
        "exterior",
      );
    if (!floor.city || !floor.boundary) continue;
    const entrance = floor.furniture.find((o) => o.id === "main-gate")?.x ?? 22;
    add(
      "building:quarantine-sign",
      "quarantine-sign",
      fixed(entrance + 4, floor.boundary.bottom + 1.06, 1.8, 3.2, 0.65),
      `${floor.exteriorDesign?.quarantineTitle ?? "Quarantine"}. ${floor.exteriorDesign?.quarantineSubtitle ?? ""}`,
      null,
      48,
      100,
      "exterior",
    );
    for (const obstacle of floor.city.obstacles.filter(
      (o) => o.kind === "building",
    ))
      for (const address of cityFacadeAddresses(obstacle))
        for (const face of cityFacadeSignFaces(floor, address)) {
          const key = `city:${address.id}:${face.nx}:${face.ny}`,
            yaw = -Math.atan2(face.nx, face.ny);
          add(
            `${key}:shop`,
            "storefront-sign",
            fixed(
              face.x + face.nx * 0.055,
              face.y + face.ny * 0.055,
              2.05,
              3.05,
              0.6,
              yaw,
            ),
            "Individual street-facing shop or office address sign.",
            null,
            48,
            80,
            "exterior",
          );
          if (interiorHash(game.seed, 0, address.id) % 3 === 0)
            add(
              `${key}:street`,
              "street-sign",
              fixed(
                face.x + face.nx * 0.04,
                face.y + face.ny * 0.04,
                3.05,
                2.5,
                0.38,
                yaw,
              ),
              "Street-name sign at this physical address.",
              null,
              36,
              0,
              "exterior",
            );
        }
  }
  // Canonical JSON also removes negative zero, so a captured request and its
  // durable/replayed inventory compare exactly after any JSON boundary.
  return parseEnvironmentSurfaces(
    slots.sort((a, b) => a.id.localeCompare(b.id)),
  );
}
