import { clearFillerAroundDesks } from "./station-clearance";
import {
  CONFIG,
  FURNITURE,
  furnitureSpec,
  H,
  W,
  between,
  rand,
  shuffle,
  type Floor,
  type Furniture,
  type FurnitureKind,
  type OfficeRoomType,
  type Point,
  type Rng,
} from "./model";
import { boxesOverlap, normalizeAngle, turn } from "./furniture-geometry";
import { canPlace, inFurniture, wall } from "./spatial";
import { stairwellApproach } from "./stairwell";
import { floorSectors, inRect, type Rect } from "./floor-plan";
import { realizeAuthoredScene } from "./authored-scene";
import { floorVenue } from "./venue";
import {
  furnitureRole,
  type RunCustomObject,
  type RunObjectRole,
  type RunSetting,
  type RunVenue,
} from "./setting-catalog.mjs";

/** Office rooms for freshly generated floors. Each room gets a function
 * (break room, open-plan cubicles, meeting room, storage, reception or
 * manager's office) and is furnished with functional groups drawn only from
 * that function's catalog: counters along a wall, tables with chairs around
 * them, cubicle pods, sofa groups. Every piece is an ordinary physical object
 * with its own health and floor friction.
 *
 * Choices come from a seeded stream derived from the run seed and floor, so
 * world RNG (spawning, NPC decisions) is unchanged and the same seed always
 * furnishes the same way. Only fresh force-field floors are furnished:
 * legacy layouts keep their historical staged furniture, and restored
 * floors are never re-furnished. A group is
 * placed only if it keeps terminals, field openings and the stairs clear and
 * cuts off no reachable cell. */
export const ROOM_CATALOG: Record<OfficeRoomType, FurnitureKind[]> = {
  break: [
    "coffeeMaker",
    "microwave",
    "fridge",
    "vending",
    "cooler",
    "cafeTable",
    "chair",
    "plant",
  ],
  cubicles: ["partition", "desk", "officeChair", "drawers", "cabinet"],
  meeting: ["table", "officeChair", "whiteboard", "screen", "plant"],
  storage: ["shelf", "printer", "cabinet", "box"],
  reception: [
    "reception",
    "officeChair",
    "sofa",
    "armchair",
    "coffeeTable",
    "plant",
  ],
  manager: ["desk", "officeChair", "armchair", "shelf", "cabinet", "plant"],
};

/** Broadcast station rooms: the same six functions, built from studio, control
 * room and library equipment instead of office filler. */
const BROADCAST_CATALOG: Record<OfficeRoomType, FurnitureKind[]> = {
  reception: [
    "reception",
    "officeChair",
    "sofa",
    "armchair",
    "coffeeTable",
    "plant",
    "onAirLight",
    "recordShelf",
  ],
  break: [
    "sofa",
    "armchair",
    "coffeeTable",
    "fridge",
    "coffeeMaker",
    "cafeTable",
    "chair",
    "plant",
  ],
  cubicles: [
    "desk",
    "officeChair",
    "soundPanel",
    "studioMonitor",
    "recordShelf",
    "cabinet",
  ],
  meeting: [
    "table",
    "officeChair",
    "micStand",
    "studioMonitor",
    "soundPanel",
    "onAirLight",
    "plant",
  ],
  storage: ["recordShelf", "reelToReel", "box", "cabinet"],
  manager: [
    "mixingConsole",
    "officeChair",
    "equipmentRack",
    "studioMonitor",
    "turntable",
    "plant",
  ],
};
/** Which furniture each room function may hold, per fixed-catalog venue. A
 * custom venue furnishes from setting.filler instead. */
export const VENUE_ROOM_CATALOG: Record<
  Exclude<RunVenue, "custom">,
  Record<OfficeRoomType, FurnitureKind[]>
> = { office: ROOM_CATALOG, broadcast: BROADCAST_CATALOG };

export interface OfficeZone {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Functions this zone may be given; one is chosen per run. */
  types: OfficeRoomType[];
  /** Version 5: rects (sub-rooms with their walls) this zone must not use. */
  exclude?: Rect[];
  /** Version 5: id of the field through which this zone's sector is entered. */
  gate?: string;
}
const excluded = (zone: OfficeZone, p: Point) =>
  !!zone.exclude?.some((r) => inRect(r, Math.floor(p.x), Math.floor(p.y)));

/** A piece in a group's local frame. For wall groups +y points into the room
 * and y = 0 is the wall face; free groups are centred on their anchor. */
interface Piece {
  kind: FurnitureKind;
  x: number;
  y: number;
  angle: number;
  /** Length override, e.g. a short cubicle side panel. */
  w?: number;
  /** Recipe of an AI-composed object (kind "custom"). */
  object?: RunCustomObject;
}
interface Group {
  wall: boolean;
  pieces: Piece[];
  /** A fixed anchor instead of a searched one. */
  at?: { x: number; y: number; angle: number };
}
const N = 0,
  S = Math.PI,
  E = Math.PI / 2,
  Wst = -Math.PI / 2;

/** Pieces side by side along a wall, backs to the wall, centred on the anchor. */
function wallRun(kinds: FurnitureKind[], gap = 0.05): Group {
  const width = kinds.reduce((n, k) => n + FURNITURE[k].w + gap, -gap);
  let x = -width / 2;
  const pieces = kinds.map((kind) => {
    const spec = FURNITURE[kind],
      piece = { kind, x: x + spec.w / 2, y: spec.h / 2 + 0.03, angle: N };
    x += spec.w + gap;
    return piece;
  });
  return { wall: true, pieces };
}
/** Chairs facing a table centre from its sides. */
function seatsAround(
  w: number,
  h: number,
  perSide: number,
  ends: number,
  kind: FurnitureKind,
  object?: RunCustomObject,
): Piece[] {
  const seat = furnitureSpec({ kind, object }),
    out: Piece[] = [],
    off = (n: number, i: number) =>
      perSide === 1 ? 0 : -w / 2 + 0.55 + (i * (w - 1.1)) / (n - 1),
    make = (x: number, y: number, angle: number): Piece => ({
      kind,
      x,
      y,
      angle,
      ...(object ? { object } : {}),
    });
  for (let i = 0; i < perSide; i++) {
    out.push(make(off(perSide, i), -h / 2 - seat.h / 2 - 0.08, N));
    out.push(make(off(perSide, i), h / 2 + seat.h / 2 + 0.08, S));
  }
  if (ends > 0) out.push(make(-w / 2 - seat.h / 2 - 0.08, 0, Wst));
  if (ends > 1) out.push(make(w / 2 + seat.h / 2 + 0.08, 0, E));
  return out;
}

const solo = (kind: FurnitureKind, wall: boolean): Group => ({
  wall,
  pieces: [
    { kind, x: 0, y: wall ? FURNITURE[kind].h / 2 + 0.03 : 0, angle: N },
  ],
});
const cafe = (seats: number): Group => ({
  wall: false,
  pieces: [
    { kind: "cafeTable", x: 0, y: 0, angle: N },
    ...seatsAround(
      0.9,
      0.9,
      seats > 1 ? 1 : 0,
      Math.max(0, seats - 2),
      "chair",
    ),
    ...(seats === 1
      ? [{ kind: "chair" as const, x: 0, y: 0.88, angle: S }]
      : []),
  ],
});
const meetingTable = (
  perSide: number,
  ends: number,
  oneSide = false,
): Group => ({
  wall: false,
  pieces: [
    { kind: "table", x: 0, y: 0, angle: N },
    ...seatsAround(3, 1.4, perSide, ends, "officeChair").filter(
      (p) => !oneSide || p.y >= 0,
    ),
  ],
});
const pod: Group = {
  wall: false,
  pieces: [
    { kind: "partition", x: 0, y: -0.78, angle: N },
    { kind: "partition", x: -1.3, y: 0.1, angle: E },
    { kind: "desk", x: 0, y: -0.1, angle: N },
    { kind: "officeChair", x: 0.25, y: 0.82, angle: S },
    { kind: "drawers", x: 0.9, y: 0.72, angle: N },
  ],
};
/** A desk facing a wall with its own panel, chair and pedestal. */
const wallPod: Group = {
  wall: true,
  pieces: [
    { kind: "desk", x: 0, y: 0.53, angle: N },
    { kind: "officeChair", x: 0.2, y: 1.45, angle: S },
    { kind: "drawers", x: 0.9, y: 1.4, angle: N },
    { kind: "partition", x: -1.3, y: 1.05, angle: E },
  ],
};

/** The groups a room of this type asks for, in placement priority. Each entry
 * lists variants from fullest to smallest; the first that fits is used. */
function plan(type: OfficeRoomType, r: Rng, small: boolean): Group[][] {
  const groups: Group[][] = [];
  const plants = (n: number) => {
    for (let i = 0; i < n; i++)
      groups.push([solo("plant", rand(r) < 0.6), solo("plant", false)]);
  };
  switch (type) {
    case "break": {
      const counter = shuffle(r, [
        "microwave",
        "fridge",
        "cooler",
      ] as FurnitureKind[]).slice(0, between(r, 1, 3));
      groups.push([
        wallRun(["coffeeMaker", ...counter]),
        wallRun(["coffeeMaker", ...counter.slice(0, 1)]),
        wallRun(["coffeeMaker"]),
      ]);
      if (rand(r) < 0.7) groups.push([wallRun(["vending"])]);
      for (let i = between(r, small ? 1 : 2, small ? 2 : 4); i > 0; i--)
        groups.push([cafe(4), cafe(3), cafe(2), cafe(1)]);
      plants(between(r, 0, 2));
      break;
    }
    case "cubicles":
      for (let i = between(r, small ? 1 : 2, small ? 3 : 5); i > 0; i--)
        groups.push([pod, wallPod]);
      if (rand(r) < 0.7)
        groups.push([wallRun(["cabinet", "cabinet"]), wallRun(["cabinet"])]);
      break;
    case "meeting": {
      const perSide = between(r, 2, 3),
        ends = between(r, 0, 2);
      groups.push([
        meetingTable(perSide, ends),
        meetingTable(perSide, 0),
        meetingTable(perSide, ends, true),
        meetingTable(0, 2),
      ]);
      groups.push([wallRun(["whiteboard"])]);
      if (rand(r) < 0.8) groups.push([wallRun(["screen"])]);
      if (!small && rand(r) < 0.5)
        groups.push([meetingTable(2, 0), meetingTable(0, 2)]);
      plants(between(r, 1, 2));
      break;
    }
    case "storage": {
      groups.push([
        wallRun(
          shuffle(r, [
            "shelf",
            "shelf",
            "cabinet",
            "cabinet",
          ] as FurnitureKind[]),
        ),
        wallRun(["shelf", "cabinet"]),
        wallRun(["shelf"]),
      ]);
      groups.push([wallRun(["printer", "cabinet"]), wallRun(["printer"])]);
      if (rand(r) < 0.6)
        groups.push([wallRun(["shelf", "shelf"]), wallRun(["shelf"])]);
      for (let i = between(r, 2, 3); i > 0; i--)
        groups.push([
          {
            wall: false,
            pieces: [
              { kind: "box", x: -0.33, y: 0, angle: N },
              { kind: "box", x: 0.36, y: 0.05, angle: 0.2 },
              { kind: "box", x: 0, y: 0.55, angle: -0.1 },
            ],
          },
          solo("box", false),
        ]);
      break;
    }
    case "reception":
      groups.push([
        {
          wall: false,
          pieces: [
            { kind: "reception", x: 0, y: 0, angle: N },
            { kind: "officeChair", x: 0, y: 0.9, angle: S },
          ],
        },
      ]);
      groups.push([
        {
          wall: true,
          pieces: [
            { kind: "sofa", x: 0, y: 0.53, angle: N },
            { kind: "coffeeTable", x: 0, y: 1.45, angle: N },
            { kind: "armchair", x: -1.9, y: 0.48, angle: N },
          ],
        },
        wallRun(["armchair", "sofa"], 0.1),
        solo("sofa", true),
        wallRun(["armchair", "armchair"], 0.15),
      ]);
      if (rand(r) < 0.5) groups.push([wallRun(["armchair", "armchair"], 0.15)]);
      plants(between(r, 2, 4));
      break;
    case "manager":
      groups.push([
        {
          wall: false,
          pieces: [
            { kind: "desk", x: 0, y: 0, angle: N },
            { kind: "officeChair", x: 0, y: 0.9, angle: S },
            { kind: "armchair", x: -0.6, y: -1.05, angle: N },
            { kind: "armchair", x: 0.6, y: -1.05, angle: N },
          ],
        },
        {
          wall: true,
          pieces: [
            { kind: "desk", x: 0, y: 0.53, angle: N },
            { kind: "officeChair", x: 0, y: 1.45, angle: S },
          ],
        },
      ]);
      groups.push([wallRun(["shelf", "cabinet"]), wallRun(["shelf"])]);
      groups.push([
        wallRun(["armchair", "armchair"], 0.15),
        solo("armchair", true),
      ]);
      plants(between(r, 1, 3));
      break;
  }
  return groups;
}
/** A live-studio table: chairs and microphone stands ring it. */
const studioTable = (
  perSide: number,
  ends: number,
  oneSide = false,
): Group => ({
  wall: false,
  pieces: (
    [
      { kind: "table", x: 0, y: 0, angle: N },
      ...seatsAround(3, 1.4, perSide, ends, "officeChair"),
      ...[-1, 1].flatMap((side) => [
        { kind: "micStand" as const, x: side * 1.8, y: -0.68, angle: N },
        { kind: "micStand" as const, x: side * 1.8, y: 0.68, angle: N },
      ]),
      ...(perSide === 2
        ? [
            { kind: "micStand" as const, x: 0, y: -1, angle: N },
            { kind: "micStand" as const, x: 0, y: 1, angle: N },
          ]
        : []),
    ] as Piece[]
  ).filter((p) => !oneSide || p.y >= 0),
});
const newsPod: Group = {
  wall: false,
  pieces: [
    { kind: "soundPanel", x: 0, y: -0.78, angle: N },
    { kind: "soundPanel", x: -1.3, y: 0.1, angle: E },
    { kind: "desk", x: 0, y: -0.1, angle: N },
    { kind: "officeChair", x: 0.25, y: 0.82, angle: S },
    { kind: "studioMonitor", x: 0.9, y: 0.72, angle: N },
  ],
};
const newsWallPod: Group = {
  wall: true,
  pieces: [
    { kind: "desk", x: 0, y: 0.53, angle: N },
    { kind: "officeChair", x: 0.2, y: 1.45, angle: S },
    { kind: "studioMonitor", x: 0.9, y: 1.4, angle: N },
    { kind: "soundPanel", x: -1.3, y: 1.05, angle: E },
  ],
};
/** The mixing desk with its operator and a monitor on each side. */
const consoleGroup = (wall: boolean): Group => ({
  wall,
  pieces: [
    { kind: "mixingConsole", x: 0, y: wall ? 0.48 : 0, angle: N },
    { kind: "officeChair", x: 0, y: wall ? 1.4 : 0.95, angle: S },
    { kind: "studioMonitor", x: -1.3, y: wall ? 0.28 : 0, angle: N },
    { kind: "studioMonitor", x: 1.3, y: wall ? 0.28 : 0, angle: N },
  ],
});

/** The broadcast counterpart of plan(): same functions, same priorities. */
function planBroadcast(
  type: OfficeRoomType,
  r: Rng,
  small: boolean,
): Group[][] {
  const groups: Group[][] = [];
  const plants = (n: number) => {
    for (let i = 0; i < n; i++)
      groups.push([solo("plant", rand(r) < 0.6), solo("plant", false)]);
  };
  switch (type) {
    case "break": {
      const counter: FurnitureKind[] = rand(r) < 0.7 ? ["fridge"] : [];
      groups.push([
        wallRun(["coffeeMaker", ...counter]),
        wallRun(["coffeeMaker"]),
      ]);
      groups.push([
        {
          wall: true,
          pieces: [
            { kind: "sofa", x: 0, y: 0.53, angle: N },
            { kind: "coffeeTable", x: 0, y: 1.45, angle: N },
            { kind: "armchair", x: -1.9, y: 0.48, angle: N },
          ],
        },
        wallRun(["armchair", "sofa"], 0.1),
        solo("sofa", true),
      ]);
      for (let i = between(r, small ? 0 : 1, small ? 1 : 2); i > 0; i--)
        groups.push([cafe(3), cafe(2), cafe(1)]);
      if (rand(r) < 0.5) groups.push([wallRun(["armchair", "armchair"], 0.15)]);
      plants(between(r, 0, 2));
      break;
    }
    case "cubicles":
      for (let i = between(r, small ? 1 : 2, small ? 3 : 5); i > 0; i--)
        groups.push([newsPod, newsWallPod]);
      groups.push([wallRun(["recordShelf"]), wallRun(["cabinet"])]);
      if (rand(r) < 0.7)
        groups.push([wallRun(["cabinet", "cabinet"]), wallRun(["cabinet"])]);
      break;
    case "meeting": {
      const perSide = between(r, 2, 3),
        ends = between(r, 0, 2);
      groups.push([
        studioTable(perSide, ends),
        studioTable(perSide, 0),
        studioTable(perSide, ends, true),
        studioTable(0, 2),
      ]);
      groups.push([
        wallRun(["soundPanel", "soundPanel"]),
        wallRun(["soundPanel"]),
      ]);
      groups.push([
        wallRun(["studioMonitor", "studioMonitor"]),
        wallRun(["studioMonitor"]),
      ]);
      groups.push([solo("onAirLight", true)]);
      if (rand(r) < 0.6) groups.push([wallRun(["soundPanel"])]);
      plants(between(r, 0, 1));
      break;
    }
    case "storage": {
      groups.push([
        wallRun(
          shuffle(r, [
            "recordShelf",
            "recordShelf",
            "reelToReel",
            "cabinet",
          ] as FurnitureKind[]),
        ),
        wallRun(["recordShelf", "reelToReel"]),
        wallRun(["recordShelf"]),
      ]);
      groups.push([
        wallRun(["recordShelf", "recordShelf"]),
        wallRun(["recordShelf"]),
      ]);
      if (rand(r) < 0.6) groups.push([wallRun(["reelToReel", "cabinet"])]);
      for (let i = between(r, 2, 3); i > 0; i--)
        groups.push([
          {
            wall: false,
            pieces: [
              { kind: "box", x: -0.33, y: 0, angle: N },
              { kind: "box", x: 0.36, y: 0.05, angle: 0.2 },
              { kind: "box", x: 0, y: 0.55, angle: -0.1 },
            ],
          },
          solo("box", false),
        ]);
      break;
    }
    case "reception":
      groups.push([
        {
          wall: false,
          pieces: [
            { kind: "reception", x: 0, y: 0, angle: N },
            { kind: "officeChair", x: 0, y: 0.9, angle: S },
          ],
        },
      ]);
      groups.push([solo("onAirLight", true)]);
      groups.push([
        {
          wall: true,
          pieces: [
            { kind: "sofa", x: 0, y: 0.53, angle: N },
            { kind: "coffeeTable", x: 0, y: 1.45, angle: N },
            { kind: "armchair", x: -1.9, y: 0.48, angle: N },
          ],
        },
        wallRun(["armchair", "sofa"], 0.1),
        solo("sofa", true),
        wallRun(["armchair", "armchair"], 0.15),
      ]);
      groups.push([wallRun(["recordShelf"])]);
      if (rand(r) < 0.5) groups.push([wallRun(["armchair", "armchair"], 0.15)]);
      plants(between(r, 1, 3));
      break;
    case "manager":
      groups.push([consoleGroup(false), consoleGroup(true)]);
      groups.push([
        wallRun(["equipmentRack", "equipmentRack", "equipmentRack"]),
        wallRun(["equipmentRack", "equipmentRack"]),
        wallRun(["equipmentRack"]),
      ]);
      groups.push([wallRun(["turntable"])]);
      groups.push([wallRun(["studioMonitor", "studioMonitor"])]);
      plants(between(r, 0, 1));
      break;
  }
  return groups;
}
/** One furnishing name of a custom venue: a built-in kind or a composed object. */
interface Item {
  name: string;
  kind: FurnitureKind;
  object?: RunCustomObject;
  /** What the piece is for: the planner arranges by role, never by name. */
  role: RunObjectRole;
  w: number;
  h: number;
}
function fillerItem(setting: RunSetting, name: string): Item {
  const object = setting.objects.find((o) => o.id === name);
  if (object) {
    const spec = furnitureSpec({ kind: "custom", object });
    return {
      name,
      kind: "custom",
      object,
      role: object.role,
      w: spec.w,
      h: spec.h,
    };
  }
  const kind = name as FurnitureKind,
    spec = FURNITURE[kind];
  return { name, kind, role: furnitureRole(kind), w: spec.w, h: spec.h };
}
const piece = (it: Item, x: number, y: number, angle = N): Piece => ({
  kind: it.kind,
  x,
  y,
  angle,
  ...(it.object ? { object: it.object } : {}),
});
const soloItem = (it: Item, wall: boolean): Group => ({
  wall,
  pieces: [piece(it, 0, wall ? it.h / 2 + 0.03 : 0)],
});
function runItems(items: Item[], gap = 0.05): Group {
  const width = items.reduce((n, it) => n + it.w + gap, -gap);
  let x = -width / 2;
  return {
    wall: true,
    pieces: items.map((it) => {
      const out = piece(it, x + it.w / 2, it.h / 2 + 0.03);
      x += it.w + gap;
      return out;
    }),
  };
}
/** A main piece with a seat in front of its working side. */
const seatedItem = (main: Item, seat: Item, wall: boolean): Group => ({
  wall,
  pieces: wall
    ? [
        piece(main, 0, main.h / 2 + 0.03),
        piece(seat, 0, main.h + 0.03 + seat.h / 2 + 0.08, S),
      ]
    : [piece(main, 0, 0), piece(seat, 0, main.h / 2 + seat.h / 2 + 0.08, S)],
});
const tableItem = (
  main: Item,
  seat: Item,
  perSide: number,
  ends: number,
  oneSide = false,
): Group => ({
  wall: false,
  pieces: [
    piece(main, 0, 0),
    ...seatsAround(
      main.w,
      main.h,
      main.w >= 1.7 ? perSide : Math.min(perSide, 1),
      ends,
      seat.kind,
      seat.object,
    ).filter((p) => !oneSide || p.y >= 0),
  ],
});
/** Deepest a divider may be and still read as a panel between positions. */
const DIVIDER_DEPTH = 0.6;
/** Cubicle bays are split by the designer's first cubicles filler with the
 * divider role (and a panel's depth). Without one a custom venue leaves its
 * work positions open rather than borrowing office partitions. */
function dividerOf(
  setting: RunSetting,
): Pick<Item, "kind" | "object"> | undefined {
  return (setting.filler?.cubicles ?? [])
    .map((n) => fillerItem(setting, n))
    .find((it) => it.role === "divider" && it.h <= DIVIDER_DEPTH);
}
/** The room's signature piece: the first listed piece that is not a seat,
 * divider or ornament, else simply the first listed. */
const signatureOf = (items: Item[]) =>
  items.find(
    (it) => !["seat", "divider", "decor", "light"].includes(it.role),
  ) ?? items[0];
/** The signature piece and the seat that sits at its working side. */
function pickRoles(items: Item[]) {
  const sig = signatureOf(items),
    rest = items.filter((it) => it !== sig);
  return { sig, rest, seat: rest.find((it) => it.role === "seat") };
}
/** Which listed names a custom venue arranges as signature, seat and bay
 * divider, for tests and tooling. */
export function customFillerRoles(
  setting: RunSetting,
  roomFunction: OfficeRoomType,
) {
  const items = (setting.filler?.[roomFunction] ?? []).map((n) =>
      fillerItem(setting, n),
    ),
    { sig, seat } = pickRoles(items),
    divider = roomFunction === "cubicles" ? dividerOf(setting) : undefined;
  return {
    signature: sig?.name,
    seat: seat?.name,
    divider: divider && (divider.object?.id ?? divider.kind),
  };
}
/** Pieces that line a wall, storage first. */
const wallPieces = (items: Item[]) =>
  [...items].sort(
    (a, b) => Number(b.role === "storage") - Number(a.role === "storage"),
  );
/** The custom-venue counterpart of plan(): the same six functions and
 * priorities, built from the designer's filler list. The first name is the
 * room's signature piece; a seat among the rest sits at its working side. */
function planCustom(
  type: OfficeRoomType,
  r: Rng,
  small: boolean,
  names: readonly string[],
  setting: RunSetting,
): Group[][] {
  const items = names.map((n) => fillerItem(setting, n)),
    { sig, rest, seat } = pickRoles(items),
    // Dividers only split the work positions of cubicles.
    others = wallPieces(
      rest.filter(
        (it) => it !== seat && !(type === "cubicles" && it.role === "divider"),
      ),
    ),
    surfaces = [sig, ...others].filter((it) => it.role === "surface"),
    groups: Group[][] = [];
  const station = (wall: boolean) =>
    seat ? seatedItem(sig, seat, wall) : soloItem(sig, wall);
  const runs = (list: Item[], gap = 0.05): Group[] =>
    list.length
      ? [
          runItems(list.slice(0, 3), gap),
          runItems(list.slice(0, 2), gap),
          runItems(list.slice(0, 1), gap),
        ]
      : [];
  const seats = (): Group[] =>
    seat ? [runItems([seat, seat], 0.15), soloItem(seat, true)] : [];
  switch (type) {
    case "cubicles":
      for (let i = between(r, small ? 1 : 2, small ? 3 : 5); i > 0; i--)
        groups.push([station(false), station(true)]);
      if (others.length && rand(r) < 0.7) groups.push(runs(others));
      break;
    case "meeting": {
      const perSide = between(r, 2, 3),
        ends = between(r, 0, 2);
      groups.push(
        seat
          ? [
              tableItem(sig, seat, perSide, ends),
              tableItem(sig, seat, perSide, 0),
              tableItem(sig, seat, perSide, ends, true),
              tableItem(sig, seat, 0, 2),
            ]
          : [soloItem(sig, false), soloItem(sig, true)],
      );
      if (others.length) groups.push(runs(others));
      if (!small && seat && rand(r) < 0.5)
        groups.push([tableItem(sig, seat, 2, 0), tableItem(sig, seat, 0, 2)]);
      break;
    }
    case "storage": {
      const stock = wallPieces([sig, ...others]);
      groups.push([
        runItems(shuffle(r, stock.concat(stock)).slice(0, 4)),
        runItems(stock.slice(0, 2)),
        runItems([sig]),
      ]);
      groups.push([runItems(stock.slice(0, 2)), runItems([sig])]);
      const small1 = [...stock].sort((a, b) => a.w * a.h - b.w * b.h)[0];
      for (let i = between(r, 2, 3); i > 0; i--)
        groups.push([
          {
            wall: false,
            pieces: [
              piece(small1, -small1.w * 0.6, 0),
              piece(small1, small1.w * 0.6, 0.05, 0.2),
              piece(small1, 0, small1.h + 0.1, -0.1),
            ],
          },
          soloItem(small1, false),
        ]);
      break;
    }
    case "break":
      groups.push(runs([sig, ...others]));
      for (let i = between(r, small ? 1 : 2, small ? 2 : 3); i > 0; i--) {
        const main = surfaces.length
          ? surfaces[i % surfaces.length]
          : (others[i % Math.max(1, others.length)] ?? sig);
        groups.push(
          seat
            ? [
                tableItem(main, seat, 1, 2),
                tableItem(main, seat, 1, 1),
                tableItem(main, seat, 1, 0),
                soloItem(main, false),
              ]
            : [soloItem(main, false), soloItem(main, true)],
        );
      }
      if (seat && rand(r) < 0.5) groups.push(seats());
      break;
    case "reception":
      groups.push([station(false), station(true)]);
      if (others.length) groups.push(runs(others, 0.1));
      if (seat) groups.push(seats());
      if (rand(r) < 0.5 && others.length)
        groups.push([soloItem(others[others.length - 1], true)]);
      break;
    case "manager":
      groups.push([station(false), station(true)]);
      if (others.length) groups.push(runs(others));
      if (seat) groups.push(seats());
      break;
  }
  return groups;
}
/** Open-plan terminals become cubicle desks: short panels between neighbours
 * along the wall, with the bay left open toward the room. */
function terminalBays(
  f: Floor,
  zone: OfficeZone,
  entrances: Furniture[],
  panel: Pick<Item, "kind" | "object"> = { kind: "partition" },
): Group[] {
  const out: Group[] = [];
  const seen = new Set<string>();
  for (const s of f.stations) {
    if (
      s.x < zone.x1 ||
      s.x > zone.x2 + 1 ||
      s.y < zone.y1 ||
      s.y > zone.y2 + 1 ||
      excluded(zone, s)
    )
      continue;
    for (const d of FACES) {
      // The wall this terminal backs onto, within about a cell.
      const face = d.dx
        ? Math.floor(s.x) + (d.dx > 0 ? 1 : 0)
        : Math.floor(s.y) + (d.dy > 0 ? 1 : 0);
      if (!wall(f, s.x + d.dx, s.y + d.dy)) continue;
      // Arrivals fan out along the wall they enter this room through: no bays there.
      const wallRow = Math.floor(s.y + d.dy),
        wallColumn = Math.floor(s.x + d.dx);
      if (
        entrances.some((o) =>
          o.h > o.w
            ? d.dx && Math.floor(o.x) === wallColumn
            : !d.dx && Math.floor(o.y) === wallRow,
        )
      )
        continue;
      for (const side of [-1, 1]) {
        const along = d.dx ? s.y + side * 1.5 : s.x + side * 1.5,
          key = `${d.dx},${d.dy},${face},${along.toFixed(2)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          wall: true,
          pieces: [
            {
              kind: panel.kind,
              x: 0,
              // A composed divider keeps its own length, standing off the
              // wall by half of it like the 0.75 m built-in panel does.
              y: panel.object ? panel.object.size.w / 2 + 0.03 : 0.4,
              angle: E,
              w: panel.object ? panel.object.size.w : 0.75,
              ...(panel.object ? { object: panel.object } : {}),
            },
          ],
          at: d.dx
            ? { x: face, y: along, angle: d.angle }
            : { x: along, y: face, angle: d.angle },
        });
      }
    }
  }
  return out;
}

/** Cells a walking body cannot enter: walls and solid furniture (doors pass). */
export function blockedGrid(f: Floor) {
  const grid = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (wall(f, x + 0.5, y + 0.5)) grid[y * W + x] = 1;
  for (const o of f.furniture) markObject(grid, o);
  return grid;
}
export function markObject(grid: Uint8Array, o: Furniture) {
  if (o.kind === "door" || o.field) return;
  const r = Math.hypot(o.w, o.h) / 2 + 0.3;
  for (
    let y = Math.max(0, Math.floor(o.y - r));
    y <= Math.min(H - 1, o.y + r);
    y++
  )
    for (
      let x = Math.max(0, Math.floor(o.x - r));
      x <= Math.min(W - 1, o.x + r);
      x++
    )
      // A body plus a little steering room must fit between pieces.
      if (inFurniture({ x: x + 0.5, y: y + 0.5 }, o, 0.4)) grid[y * W + x] = 1;
}
/** Open cells connected to `from`. */
export function reachable(grid: Uint8Array, from: Point) {
  const seen = new Uint8Array(W * H),
    queue = [Math.floor(from.y) * W + Math.floor(from.x)];
  while (queue.length) {
    const id = queue.pop()!,
      x = id % W;
    if (id < 0 || id >= W * H || seen[id] || grid[id]) continue;
    seen[id] = 1;
    if (x + 1 < W) queue.push(id + 1);
    if (x > 0) queue.push(id - 1);
    queue.push(id + W, id - W);
  }
  return seen;
}

export function makeFurniture(
  id: string,
  floor: number,
  kind: FurnitureKind,
  p: Point,
  angle = 0,
  object?: RunCustomObject,
): Furniture {
  const spec = furnitureSpec({ kind, object });
  return {
    id,
    floor,
    kind,
    ...(object ? { object: structuredClone(object) } : {}),
    x: p.x,
    y: p.y,
    w: spec.w,
    h: spec.h,
    hp: spec.hp,
    maxHp: spec.hp,
    speed: spec.speed,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
    ...(angle ? { angle: normalize(angle) } : {}),
  };
}
const normalize = normalizeAngle;

/** Wall faces inside a zone: the point on the face and the into-room angle. */
const FACES = [
  { dx: 0, dy: -1, angle: 0 },
  { dx: 0, dy: 1, angle: Math.PI },
  { dx: -1, dy: 0, angle: -Math.PI / 2 },
  { dx: 1, dy: 0, angle: Math.PI / 2 },
];
function anchors(f: Floor, zone: OfficeZone, group: Group, r: Rng) {
  const out: { x: number; y: number; angle: number }[] = [];
  for (let y = zone.y1; y <= zone.y2; y++)
    for (let x = zone.x1; x <= zone.x2; x++) {
      if (wall(f, x + 0.5, y + 0.5) || excluded(zone, { x, y })) continue;
      if (!group.wall) {
        for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2])
          out.push({ x: x + 0.5, y: y + 0.5, angle });
        continue;
      }
      for (const d of FACES)
        if (wall(f, x + 0.5 + d.dx, y + 0.5 + d.dy))
          out.push({
            x: x + 0.5 + d.dx * 0.5,
            y: y + 0.5 + d.dy * 0.5,
            angle: d.angle,
          });
    }
  return shuffle(r, out);
}

export function furnishOffice(
  f: Floor,
  zones: OfficeZone[],
  keepClear: Point[],
  from: Point,
  seed: number,
  /** Entrance fields: every terminal must still reach the stairs with these sealed. */
  sealed: Furniture[] = [],
) {
  // Authored objects reserve real physical space before optional seeded filler.
  // The v1/legacy path performs no new work and consumes no additional RNG.
  if (f.design?.scene) realizeAuthoredScene(f, keepClear, from, sealed);
  const r: Rng = {
    rng:
      (Math.imul(seed ^ 0x51f15e, 0x2c1b3c6d) ^
        Math.imul(f.index + 1, 0x297a2d39)) >>>
      0,
  };
  const stations = f.stations as Point[],
    grid = blockedGrid(f),
    targets = [...stations, f.stairs],
    seal = new Uint8Array(W * H);
  for (const o of sealed)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (inFurniture({ x: x + 0.5, y: y + 0.5 }, { ...o, field: undefined }))
          seal[y * W + x] = 1;
  const egress = (grid: Uint8Array) => {
    if (!sealed.length) return true;
    const out = reachable(
      grid.map((v, i) => v | seal[i]),
      f.stairs,
    );
    return stations.every((s) => out[Math.floor(s.y) * W + Math.floor(s.x)]);
  };
  let before = reachable(grid, from);
  const venue = floorVenue(f),
    broadcast = venue === "broadcast",
    custom = venue === "custom" && f.setting?.filler ? f.setting : undefined;
  f.office = [];
  // Distinct functions where possible: shuffle the shared pool, then give each
  // zone the first type it allows that is still unused.
  const used = new Set<OfficeRoomType>();
  for (const zone of zones) {
    const options = shuffle(r, [...zone.types]),
      type = options.find((t) => !used.has(t)) ?? options[0];
    used.add(type);
    f.office.push({ zone: zone.id, type });
    const small = zone.y2 - zone.y1 < 3;
    // Only things near the zone can collide with its groups.
    const near = (p: Point, margin: number) =>
      p.x > zone.x1 - margin &&
      p.x < zone.x2 + 1 + margin &&
      p.y > zone.y1 - margin &&
      p.y < zone.y2 + 1 + margin;
    const zoneStations = stations.filter((s) => near(s, 3)),
      zoneClear = keepClear.filter((s) => near(s, 4)),
      local: Floor = {
        ...f,
        furniture: f.furniture.filter((o) => near(o, 4)),
      };
    let n = 0;
    const tryPlace = (group: Group) => {
      const id = `f${f.index}-${zone.id}-${type}${n}`;
      const options = group.at
        ? [group.at]
        : anchors(f, zone, group, r).slice(0, 240);
      for (const a of options) {
        const { c: cos, s: sin } = turn(a.angle);
        const pieces = group.pieces.map((p, i) => {
          const o = makeFurniture(
            `${id}-${p.object?.id ?? p.kind}${i}`,
            f.index,
            p.kind,
            { x: a.x + p.x * cos - p.y * sin, y: a.y + p.x * sin + p.y * cos },
            a.angle + p.angle,
            p.object,
          );
          if (p.w && !p.object) o.w = p.w;
          return o;
        });
        // Cheap tests first; collision against walls and earlier groups last.
        const fits =
          pieces.every(
            (o, i) =>
              o.x > zone.x1 &&
              o.x < zone.x2 + 1 &&
              o.y > zone.y1 &&
              o.y < zone.y2 + 1 &&
              !excluded(zone, o) &&
              // Pieces inside one group may stand close but never overlap.
              pieces
                .slice(0, i)
                .every((other) => !boxesOverlap(o, other, 0.05)) &&
              zoneStations.every((s) => !inFurniture(s, o, 0.8)) &&
              zoneClear.every(
                // Cubicle bays stand well back from openings, where an
                // arriving crowd fans out to its terminals.
                (s) => !inFurniture(s, o, group.at ? 2.5 : 1.6),
              ),
          ) &&
          // Walls and earlier groups, keeping a walking gap to the latter.
          pieces.every((o) =>
            canPlace(local, o, o, o.w, o.h, o.angle ?? 0, 0.6),
          );
        if (!fits) continue;
        const next = grid.slice();
        for (const o of pieces) markObject(next, o);
        const after = reachable(next, from);
        let pocket = false;
        for (let i = 0; i < W * H && !pocket; i++)
          pocket = !!before[i] && !after[i] && !next[i];
        if (
          pocket ||
          targets.some((s) => !after[Math.floor(s.y) * W + Math.floor(s.x)]) ||
          !egress(next)
        )
          continue;
        f.furniture.push(...pieces);
        local.furniture.push(...pieces);
        grid.set(next);
        before = after;
        n++;
        return true;
      }
      return false;
    };
    const divider = custom
      ? dividerOf(custom)
      : { kind: broadcast ? ("soundPanel" as const) : ("partition" as const) };
    if (type === "cubicles" && divider)
      for (const bay of terminalBays(
        f,
        zone,
        sealed.filter(
          (o) => o.id === (zone.gate ?? `f${f.index}-${zone.id}-door`),
        ),
        divider,
      ))
        tryPlace(bay);
    const planner = custom
      ? (t: OfficeRoomType, rr: Rng, sm: boolean) =>
          planCustom(t, rr, sm, custom.filler![t], custom)
      : broadcast
        ? planBroadcast
        : plan;
    let groups = planner(type, r, small);
    if (f.design) {
      const wanted = Math.ceil(groups.length * f.design.furnitureDensity);
      if (wanted > groups.length)
        groups.push(
          ...planner(type, r, small).slice(0, wanted - groups.length),
        );
      groups = groups.slice(0, wanted);
    }
    for (const variants of groups)
      for (const group of variants) if (tryPlace(group)) break;
  }
  if (f.generation?.version === 5) clearFillerAroundDesks(f);
}

/** Check the finished physical furnishing, not just the floor-plan raster. */
export function furnishingErrors(f: Floor) {
  const errors: string[] = [],
    grid = blockedGrid(f),
    reachableFromEntry = reachable(grid, f.entry),
    sealed = grid.slice();
  for (const o of f.furniture) {
    if (!o.field && !canPlace(f, o, o))
      errors.push(`furniture overlaps geometry: ${o.id}`);
    if (o.field && !o.field.exit && o.field.limit !== undefined)
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++)
          if (
            inFurniture({ x: x + 0.5, y: y + 0.5 }, { ...o, field: undefined })
          )
            sealed[y * W + x] = 1;
  }
  const egress = reachable(sealed, f.stairs),
    at = (p: Point) => Math.floor(p.y) * W + Math.floor(p.x);
  for (const point of [...f.stations, f.stairs])
    if (!reachableFromEntry[at(point)])
      errors.push(`furniture blocks route to ${point.x},${point.y}`);
  for (const station of f.stations)
    if (!egress[at(station)])
      errors.push(`furniture blocks egress from ${station.id}`);
  return errors;
}
const ROOMS: OfficeRoomType[] = [
  "break",
  "cubicles",
  "meeting",
  "storage",
  "manager",
];
/** Office zones for fresh force-field floors: each study stage and both lobbies.
 * The rear hall, full of terminals, is always open-plan; the other rooms take
 * random functions. */
export function pursuitOfficeZones(f: Floor): OfficeZone[] {
  const stages = f.generation?.stages;
  if (f.index < 4 && f.generation?.sectors) return sectorOfficeZones(f);
  if (f.index >= 4 || !stages) return [];
  const bounds = (y1: number, y2: number) => {
    if (!f.boundary) return { x1: 2, y1, x2: 41, y2 };
    y1 = Math.max(y1, f.boundary.top);
    y2 = Math.min(y2, f.boundary.bottom - 1);
    // A stage may cross a chamfer or setback. Its furnishing rectangle must
    // fit every row it spans; placement still checks the real walls too.
    const rows = f.boundary.rows.slice(y1, y2 + 1);
    return {
      x1: Math.max(...rows.map((row) => row.left)),
      y1,
      x2: Math.min(...rows.map((row) => row.right)) - 1,
      y2,
    };
  };
  return [
    ...stages.map((s) => ({
      id: `room${s.room}`,
      ...bounds(s.front + 1, s.rear - 1),
      types: s.room === 2 ? (["cubicles"] as OfficeRoomType[]) : ROOMS,
    })),
    {
      id: "entry",
      ...bounds(stages[0].rear + 1, (f.boundary?.bottom ?? 28) - 1),
      types: ["reception"],
    },
    {
      id: "lobby",
      ...bounds(f.boundary?.top ?? 2, stages[stages.length - 1].front - 1),
      types: ["break", "reception"],
    },
  ];
}
/** Points a fresh force-field floor must keep clear: every cell of every field
 * opening, the stairs and the entry, so furniture can never seal a field. */
export function fieldClearance(f: Floor): Point[] {
  const points: Point[] = [f.stairs, f.entry];
  // The arrival lane in front of the entry stays open for arriving crowds. A
  // carved entry well sits in the south wall, so the lane is the floor rows
  // in front of its mouth.
  const lane = Math.min(f.entry.y, 26.5);
  for (let x = f.entry.x - 5; x <= f.entry.x + 5; x++)
    points.push({ x, y: lane }, { x, y: lane + 1 });
  // Nothing may narrow the approach into either staircase.
  if (f.index < CONFIG.floors) points.push(...stairwellApproach(f, "up"));
  if (f.index > 0) points.push(...stairwellApproach(f, "down"));
  if (f.generation?.sectors) {
    // Version 5: every field cell in either orientation plus two cells in
    // front of it on both sides, and every sub-room doorway with its approach.
    for (const o of f.furniture)
      if (o.field) {
        const vertical = o.h > o.w,
          half = (vertical ? o.h : o.w) / 2;
        for (let d = -half + 0.5; d <= half - 0.5; d++)
          for (const t of [-2, -1, 0, 1, 2])
            points.push(
              vertical
                ? { x: o.x + t, y: o.y + d }
                : { x: o.x + d, y: o.y + t },
            );
      }
    for (const s of floorSectors(f))
      for (const room of s.rooms) {
        const { doorway: d, rect } = room;
        const dx = d.x1 === d.x2 ? (d.x1 > rect.x2 ? 1 : -1) : 0,
          dy = d.y1 === d.y2 ? (d.y1 > rect.y2 ? 1 : -1) : 0;
        for (let y = d.y1; y <= d.y2; y++)
          for (let x = d.x1; x <= d.x2; x++)
            points.push(
              { x: x + 0.5, y: y + 0.5 },
              { x: x + dx + 0.5, y: y + dy + 0.5 },
            );
      }
    return points;
  }
  for (const o of f.furniture)
    if (o.field)
      for (let d = -o.w / 2 + 0.5; d <= o.w / 2 - 0.5; d++)
        points.push({ x: o.x + d, y: o.y });
  return points;
}

const SUB_ROOM_TYPES: Record<string, OfficeRoomType> = {
  office: "manager",
  meeting: "meeting",
  storage: "storage",
  break: "break",
};
/** Version 5 zones: one per sector block (room3, room3b, room3c) with the
 * sector's sub-rooms excluded, then one per sub-room (room3r1, ...). The free
 * hall's circulation is always open-plan cubicles. */
function sectorOfficeZones(f: Floor): OfficeZone[] {
  const sectors = floorSectors(f);
  const study = sectors.filter((s) => s.room !== undefined);
  const zones: OfficeZone[] = [];
  for (const s of [...study, ...sectors.filter((s) => s.room === undefined)]) {
    const previous = sectors[s.order - 1];
    const gate =
      s.order === 0
        ? undefined
        : s.order === 1
          ? `f${f.index}-room2-door`
          : `f${f.index}-${previous.id}-forward`;
    const exclude = s.rooms.map(({ rect: r }) => ({
      x1: r.x1 - 1,
      y1: r.y1 - 1,
      x2: r.x2 + 1,
      y2: r.y2 + 1,
    }));
    const types: OfficeRoomType[] =
      f.design && s.room !== undefined
        ? [f.design.roomTypes[s.room]]
        : s.id === "room2"
          ? ["cubicles"]
          : s.id === "entry"
            ? ["reception"]
            : s.id === "lobby"
              ? ["break", "reception"]
              : ROOMS;
    s.blocks.forEach((b, i) =>
      zones.push({
        id: `${s.id}${i ? String.fromCharCode(97 + i) : ""}`,
        ...b,
        types,
        ...(exclude.length ? { exclude } : {}),
        ...(gate ? { gate } : {}),
      }),
    );
    for (const room of s.rooms)
      zones.push({
        id: room.id,
        ...room.rect,
        types: [SUB_ROOM_TYPES[room.kind]],
      });
  }
  return zones;
}
