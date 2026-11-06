import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { sceneSaveErrors } from "../src/authored-scene";
import { fnv1a } from "../src/hash";
import {
  furnitureSpec,
  type Floor,
  type Game,
  type Roadmap,
} from "../src/model";
import { decode, encode } from "../src/persistence";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { savedRunDesign } from "./helpers/run-design";

import {
  ROOM_CATALOG,
  VENUE_ROOM_CATALOG,
  customFillerRoles,
  fieldClearance,
  furnishOffice,
  furnishingErrors,
  pursuitOfficeZones,
} from "../src/office-layout";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { parseSetting } from "../src/setting-catalog.mjs";
import {
  createPlayableGame,
  finalizeDesignedRun,
  previewDesignedRun,
} from "../src/world";
import { environmentStructureFixture } from "./helpers/environment-design";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const SEEDS = Array.from({ length: 8 }, (_, i) => i * 7919 + 3);
const setting = (venue: "office" | "broadcast") =>
  parseSetting({
    venue,
    interior: {
      roomFloor: "studioCarpet",
      hallFloor: "terrazzo",
      roomTint: "#2b2f3a",
      hallTint: "#d8cfbd",
      wall: "#8a7a66",
      trim: "#3a2a22",
    },
    exterior: {
      facade: "brick",
      facadeColor: "#8c4a3a",
      trimColor: "#e8dcc8",
      windows: "punched",
      canopy: "marquee",
      canopyGlow: "#ff3030",
      roofFeatures: [{ kind: "mast", x: 0.2, y: 0.3 }],
    },
    terminal: {
      style: "desk",
      body: "#6b5036",
      accent: "#2a2a2a",
      screen: "#40e0d0",
    },
    objects: [],
    props: [],
    surroundings: {
      ground: "asphalt",
      groundColor: "#3b3f44",
      pathColor: "#2b2e33",
      sky: { zenith: "#0d1622", horizon: "#3a4656" },
      fog: { color: "#1c2430", density: 0 },
      neighbors: "buildings",
      neighborColor: "#4a4f57",
      weather: "none",
      scenery: [],
    },
    filler: null,
  });
const worlds = new Map<number, Game>();
const world = (seed: number) => {
  if (!worlds.has(seed)) worlds.set(seed, createPlayableGame(seed, roadmap));
  return worlds.get(seed)!;
};
/** Strip a floor's furnishing and furnish it again from the seed alone. */
function refurnish(g: Game, f: Floor, venue?: "office" | "broadcast") {
  const bare: Floor = {
    ...structuredClone(f),
    furniture: structuredClone(f.furniture.filter((o) => o.field)),
    ...(venue ? { setting: setting(venue) } : { setting: undefined }),
  };
  if (!venue) delete bare.setting;
  furnishOffice(
    bare,
    pursuitOfficeZones(bare),
    fieldClearance(bare),
    bare.entry,
    g.seed,
    bare.furniture.filter((o) => /-room\d-door$/.test(o.id)),
  );
  return bare;
}
const parse = (id: string) =>
  /^f\d-(room\d(?:[bc]|r\d+)?|(?:entry|lobby)[bc]?)-([a-z]+)\d+-/
    .exec(id)
    ?.slice(1) as [string, string] | undefined;
const layout = (f: Floor) =>
  f.furniture.map((o) => [o.id, o.kind, o.x, o.y, o.angle ?? 0, o.w, o.h]);

test("broadcast rooms are furnished only from the broadcast catalog", () => {
  const kinds = new Set<string>(),
    byKind = new Map<string, Set<string>>();
  for (const seed of SEEDS) {
    const g = world(seed);
    for (const f of g.floors.slice(0, 4)) {
      const b = refurnish(g, f, "broadcast");
      assert.deepEqual(
        furnishingErrors(b),
        [],
        `seed ${seed} floor ${f.index}`,
      );
      assert.deepEqual(pursuitLayoutErrors(g, b), []);
      const types = new Map(b.office!.map((z) => [z.zone, z.type]));
      for (const o of b.furniture.filter((o) => !o.field)) {
        const parsed = parse(o.id);
        assert.ok(parsed, o.id);
        const type = types.get(parsed[0])!;
        assert.ok(
          VENUE_ROOM_CATALOG.broadcast[type].includes(o.kind),
          `${o.kind} does not belong in a broadcast ${type} room (${o.id})`,
        );
        kinds.add(o.kind);
        if (!byKind.has(o.kind)) byKind.set(o.kind, new Set());
        byKind.get(o.kind)!.add(type);
      }
    }
  }
  for (const kind of [
    "mixingConsole",
    "micStand",
    "recordShelf",
    "soundPanel",
    "studioMonitor",
    "equipmentRack",
    "turntable",
    "onAirLight",
    "reelToReel",
  ])
    assert.ok(kinds.has(kind), `${kind} never appears`);
  // No office filler survives in a station.
  for (const kind of [
    "printer",
    "vending",
    "partition",
    "microwave",
    "shelf",
    "whiteboard",
    "screen",
    "drawers",
    "cooler",
  ])
    assert.equal(kinds.has(kind), false, kind);
  assert.deepEqual([...byKind.get("coffeeMaker")!], ["break"]);
  assert.deepEqual([...byKind.get("mixingConsole")!], ["manager"]);
  assert.deepEqual([...byKind.get("micStand")!], ["meeting"]);
  assert.deepEqual([...byKind.get("reelToReel")!], ["storage"]);
  assert.ok(byKind.get("soundPanel")!.has("cubicles"));
});

test("a floor without a setting, or with an office setting, furnishes exactly as before", () => {
  assert.equal(VENUE_ROOM_CATALOG.office, ROOM_CATALOG);
  for (const seed of SEEDS) {
    const g = world(seed);
    for (const f of g.floors.slice(0, 4)) {
      const plain = refurnish(g, f),
        office = refurnish(g, f, "office");
      assert.deepEqual(
        layout(office),
        layout(plain),
        `seed ${seed} ${f.index}`,
      );
      assert.deepEqual(office.office, plain.office);
      // The world builder's own furnishing of the 2nd floor is the baseline
      // the office-room tests already pin; it must not move either.
      if (f.index === 2) {
        assert.deepEqual(layout(plain), layout(f), `seed ${seed}`);
        assert.deepEqual(plain.office, f.office);
      }
    }
  }
});

test("a broadcast-themed designed run builds a valid building", () => {
  const structure = {
      ...environmentStructureFixture(),
      setting: setting("broadcast"),
    },
    token = previewDesignedRun(42, roadmap, undefined, structure);
  assert.ok(token.surfaces.length > 0);
});

// --- Custom venue: AI-composed objects and designer filler -----------------

type Part = {
  shape: "box" | "cylinder" | "cone" | "sphere" | "wedge" | "torus";
  axis: "up" | "across" | "along";
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  h: number;
  color: string;
  finish: "matte" | "metal" | "glass" | "glow";
  pitch: number;
  roll: number;
  motion: "none";
  rate: number;
};
const part = (
  shape: Part["shape"],
  [x, y, z]: [number, number, number],
  [w, d, h]: [number, number, number],
  color: string,
  finish: Part["finish"] = "matte",
  axis: Part["axis"] = "up",
): Part => ({
  shape,
  axis,
  x,
  y,
  z,
  w,
  d,
  h,
  color,
  finish,
  pitch: 0,
  roll: 0,
  motion: "none",
  rate: 1,
});
const OBJECTS = [
  {
    id: "cryo-pod",
    role: "bed",
    name: "Cryo pod",
    weight: "heavy",
    size: { w: 0.9, d: 1, h: 1.8 },
    surface: false,
    parts: [
      part("box", [0, 0, 0], [0.9, 1, 0.3], "#5b6470", "metal"),
      part("cylinder", [0, 0, 0.3], [0.7, 0.8, 1.2], "#9fd4e6", "glass"),
      part("cylinder", [0, 0, 1.5], [0.5, 0.5, 0.2], "#4ae0ff", "glow"),
    ],
  },
  {
    id: "airlock-console",
    role: "surface",
    name: "Airlock console",
    weight: "medium",
    size: { w: 1.2, d: 0.6, h: 1.1 },
    surface: true,
    parts: [
      part("box", [0, 0, 0], [1, 0.5, 0.75], "#6c7480", "metal"),
      part("box", [0, 0, 0.75], [1.2, 0.6, 0.1], "#8a929c", "metal"),
      part("box", [0, -0.22, 0.85], [0.8, 0.05, 0.25], "#58ff9a", "glow"),
    ],
  },
  {
    id: "hydro-rack",
    role: "storage",
    name: "Hydroponic rack",
    weight: "medium",
    size: { w: 1.4, d: 0.5, h: 1.6 },
    surface: false,
    parts: [
      part("box", [-0.65, 0, 0], [0.1, 0.5, 1.6], "#9aa0a8", "metal"),
      part("box", [0.65, 0, 0], [0.1, 0.5, 1.6], "#9aa0a8", "metal"),
      part("box", [0, 0, 0.6], [1.2, 0.4, 0.05], "#2f9e4f"),
      part("box", [0, 0, 1.2], [1.2, 0.4, 0.05], "#2f9e4f"),
      part("sphere", [0, 0, 0.65], [0.4, 0.3, 0.3], "#5fd070"),
    ],
  },
  {
    id: "stool",
    role: "seat",
    name: "Crew stool",
    weight: "light",
    size: { w: 0.4, d: 0.4, h: 0.5 },
    surface: false,
    parts: [
      part("cylinder", [0, 0, 0], [0.12, 0.12, 0.4], "#6c7480", "metal"),
      part("cylinder", [0, 0, 0.4], [0.4, 0.4, 0.1], "#c4572b"),
    ],
  },
];
const FILLER = {
  reception: ["airlock-console", "stool", "plant"],
  break: ["hydro-rack", "stool", "cafeTable"],
  cubicles: ["airlock-console", "stool", "soundPanel"],
  meeting: ["table", "stool", "cryo-pod"],
  storage: ["hydro-rack", "cabinet", "box"],
  manager: ["airlock-console", "stool", "cryo-pod"],
};
const radio = () => {
  const { environment: _environment, ...rest } = JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  );
  return rest;
};
/** The radio structure with a custom venue, composed objects and scene items. */
function customStructure(filler: Record<string, string[]> = FILLER) {
  const d = radio();
  d.setting = {
    ...d.setting,
    venue: "custom",
    objects: structuredClone(OBJECTS),
    filler,
  };
  d.floors.forEach((floor: any, n: number) => {
    const swap = (room: number, id: string, kind: string) => {
      const item = floor.scene.rooms[room].furniture.find(
        (i: any) => i.id === id,
      );
      item.kind = kind;
      if (kind !== "airlock-console") item.props = [];
    };
    swap(2, "r2-desk-0", "airlock-console");
    swap(2, "r2-studiomonitor-2", "stool");
    if (n === 0) {
      swap(0, "r0-armchair-2", "cryo-pod");
      swap(1, "r1-sofa-0", "hydro-rack");
    }
  });
  return parseRunStructure(d);
}
/** Distinct letters-only phrases (the contract rejects similar writing). */
const words = (n: number) =>
  [n, n * 7 + 3, n * 13 + 5]
    .map((v) => "x" + v.toString(26).replace(/[0-9]/g, (d) => "qrstuvwxyz"[+d]))
    .join(" ");
/** A complete accepted design for a structure: every surface gets a plain
 * one-line entry, which is enough for the physical world and for saving. */
function accept(structure: ReturnType<typeof customStructure>, seed: number) {
  const token = previewDesignedRun(seed, roadmap, undefined, structure),
    environment = {
      version: 1,
      surfaceFingerprint: token.surfaceFingerprint,
      surfaces: token.surfaces,
      fragments: [],
      entries: token.surfaces.map((s, i) =>
        s.maxTitle || s.maxBody
          ? {
              surfaceId: s.id,
              layout: "text",
              title: s.maxTitle ? [{ text: words(i) }] : [],
              body: s.maxTitle ? [] : [{ text: words(i) }],
              description: "",
              drawing: null,
            }
          : {
              surfaceId: s.id,
              layout: "art",
              title: [],
              body: [],
              description: `Disc ${words(i)}`,
              drawing: {
                version: 1,
                background: "#e9e1cc",
                primitives: [
                  {
                    kind: "ellipse",
                    x: 0.15,
                    y: 0.15,
                    w: 0.7,
                    h: 0.7,
                    rotation: 0,
                    fill: "#1b1b1b",
                    stroke: "#20262b",
                    width: 0.012 + i / 100000,
                    opacity: 1,
                  },
                ],
              },
            },
      ),
    },
    saved = savedRunDesign(parseRunDesign({ ...structure, environment }));
  return { token, saved };
}

test("a custom venue builds valid buildings for several seeds with composed furniture", () => {
  const structure = customStructure();
  for (const seed of SEEDS.slice(0, 4)) {
    const { token, saved } = accept(structure, seed);
    assert.ok(token.surfaces.length > 0);
    const g = finalizeDesignedRun(token, saved);
    let composed = 0;
    for (const f of g.floors.slice(0, 4)) {
      assert.deepEqual(
        furnishingErrors(f),
        [],
        `seed ${seed} floor ${f.index}`,
      );
      assert.deepEqual(pursuitLayoutErrors(g, f), []);
      assert.deepEqual(sceneSaveErrors(f), []);
      for (const o of f.furniture.filter((o) => o.kind === "custom")) {
        composed++;
        const recipe = OBJECTS.find((r) => r.id === o.object?.id)!;
        assert.deepEqual(o.object, recipe);
        const spec = furnitureSpec(o);
        assert.equal(o.w, recipe.size.w);
        assert.equal(o.h, recipe.size.d);
        assert.equal(o.maxHp, spec.hp);
        assert.equal(o.speed, spec.speed);
      }
      // The authored scene items are realised as composed furniture.
      const wanted = f
        .design!.scene!.rooms.flatMap((room) => room.furniture)
        .map((i) => i.kind as string)
        .filter((k) => OBJECTS.some((r) => r.id === k))
        .sort();
      assert.deepEqual(
        f.furniture
          .filter((o) => o.appearance && o.kind === "custom")
          .map((o) => o.object!.id)
          .sort(),
        wanted,
      );
      assert.ok(wanted.length >= 2);
    }
    assert.ok(composed > 8, `seed ${seed}: ${composed}`);
  }
});

test("custom venue filler uses only the names listed for each room function", () => {
  const structure = customStructure(),
    seen = new Set<string>(),
    signatures = new Set<string>();
  for (const seed of SEEDS.slice(0, 4)) {
    const { token, saved } = accept(structure, seed),
      g = finalizeDesignedRun(token, saved);
    for (const f of g.floors.slice(0, 4)) {
      const types = new Map(f.office!.map((z) => [z.zone, z.type]));
      for (const o of f.furniture.filter((o) => !o.field && !o.appearance)) {
        const parsed = parse(o.id);
        if (!parsed) continue;
        const type = types.get(parsed[0])!,
          name = o.object?.id ?? o.kind;
        assert.ok(
          (FILLER[type as keyof typeof FILLER] as string[]).includes(name),
          `${name} is not listed for ${type} (${o.id})`,
        );
        seen.add(name);
        if (name === FILLER[type as keyof typeof FILLER][0])
          signatures.add(`${type}:${name}`);
      }
    }
  }
  for (const id of OBJECTS.map((o) => o.id))
    assert.ok(seen.has(id), `${id} never appears as filler`);
  // Cubicle bays are split by the thin soundPanel the designer listed.
  assert.ok(seen.has("soundPanel"));
  assert.ok(signatures.size >= 4, [...signatures].join());
  // No office or broadcast filler leaks in.
  for (const kind of ["desk", "officeChair", "mixingConsole", "printer"])
    assert.equal(seen.has(kind), false, kind);
});

test("props on a composed surface sit at its surface height and stay on it", () => {
  const { token, saved } = accept(customStructure(), 3),
    g = finalizeDesignedRun(token, saved),
    f = g.floors[0],
    hostIds = new Set(
      f.furniture
        .filter((o) => o.object?.id === "airlock-console" && o.appearance)
        .map((o) => o.id),
    );
  assert.ok(hostIds.size > 0);
  const props = f.scene!.props.filter((p) => hostIds.has(p.furnitureId));
  assert.ok(props.length >= 3);
  for (const p of props) {
    assert.ok(Math.abs(p.top - 0.852) < 1e-9, String(p.top));
    assert.ok(Math.abs(p.x) <= 0.6 && Math.abs(p.y) <= 0.3);
  }
});

test("a composed object save restores the canonical recipe and rejects unknown ids", () => {
  const { token, saved } = accept(customStructure(), 3),
    g = finalizeDesignedRun(token, saved),
    text = encode(g),
    again = (mutate: (game: Game) => void) => {
      const game = JSON.parse(
        (JSON.parse(text) as { payload: string }).payload,
      ) as Game;
      mutate(game);
      const payload = JSON.stringify(game);
      return JSON.stringify({ schema: 1, payload, checksum: fnv1a(payload) });
    };
  const custom = (game: Game) =>
    game.floors.flatMap((f) => f.furniture).filter((o) => o.kind === "custom");
  const clean = decode(text);
  assert.ok(custom(clean).length > 8);
  for (const o of custom(clean))
    assert.deepEqual(
      o.object,
      OBJECTS.find((r) => r.id === o.object!.id),
    );
  const tampered = decode(
    again((game) => {
      for (const o of custom(game)) {
        o.object!.weight = "light";
        o.object!.size = { w: 3, d: 2, h: 2.6 };
        o.object!.parts = [];
        o.w = 3;
        o.h = 2;
      }
    }),
  );
  for (const o of custom(tampered)) {
    const recipe = OBJECTS.find((r) => r.id === o.object!.id)!;
    assert.deepEqual(o.object, recipe);
    assert.equal(o.w, recipe.size.w);
    assert.equal(o.h, recipe.size.d);
    assert.equal(o.maxHp, furnitureSpec(o).hp);
  }
  assert.throws(
    () =>
      decode(
        again((game) => {
          custom(game)[0].object!.id = "ghost-pod";
        }),
      ),
    /not in the run design/,
  );
  assert.throws(
    () =>
      decode(
        again((game) => {
          delete custom(game)[0].object;
        }),
      ),
    /not in the run design/,
  );
});

// --- Roles, not names, decide how a custom venue is arranged ---------------

const roleSetting = (
  objects: Record<string, unknown>[],
  filler: Record<string, string[]>,
) =>
  parseSetting({
    ...(radio().setting as object),
    venue: "custom",
    objects,
    filler: {
      reception: ["desk"],
      break: ["table"],
      cubicles: ["desk"],
      meeting: ["table"],
      storage: ["shelf"],
      manager: ["desk"],
      ...filler,
    },
  });
const piece = (
  id: string,
  role: string,
  size: { w: number; d: number; h: number },
  surface = false,
) => ({
  id,
  name: id,
  role,
  weight: "medium",
  size,
  surface,
  parts: [part("box", [0, 0, 0], [size.w, size.d, size.h], "#808890", "matte")],
});

test("seats, surfaces and dividers are chosen by role and never by name", () => {
  const s = roleSetting(
    [
      // Names that the old name heuristic would have taken for a seat.
      piece("bench-press", "equipment", { w: 0.8, d: 0.6, h: 0.9 }),
      piece("cushion-rack", "storage", { w: 0.8, d: 0.5, h: 1.2 }),
      // A seat that looks like nothing the old heuristic knew.
      piece("altar-block", "seat", { w: 0.5, d: 0.5, h: 0.5 }),
      piece("slat-wall", "divider", { w: 1.4, d: 0.3, h: 1.5 }),
      piece("fat-wall", "divider", { w: 1.4, d: 0.9, h: 1.5 }),
      piece("low-rail", "decor", { w: 1.4, d: 0.3, h: 0.5 }),
      piece("drafting-slab", "surface", { w: 1.8, d: 0.9, h: 0.9 }, true),
    ],
    {
      meeting: ["bench-press", "cushion-rack", "altar-block", "drafting-slab"],
      cubicles: ["low-rail", "slat-wall", "altar-block"],
      break: ["altar-block", "drafting-slab"],
    },
  );
  const meeting = customFillerRoles(s, "meeting");
  assert.equal(meeting.seat, "altar-block");
  assert.equal(meeting.signature, "bench-press");
  // A seat is never the signature piece, even when listed first.
  assert.equal(customFillerRoles(s, "break").signature, "drafting-slab");
  // The divider is the first divider-role piece, not the first thin one.
  const cubicles = customFillerRoles(s, "cubicles");
  assert.equal(cubicles.divider, "slat-wall");
  assert.equal(cubicles.seat, "altar-block");
  // Depth sanity: a deep divider and a thin non-divider do not split bays.
  for (const filler of [["fat-wall"], ["low-rail"], ["whiteboard"], ["screen"]])
    assert.equal(
      customFillerRoles(
        {
          ...s,
          filler: { ...s.filler!, cubicles: ["drafting-slab", ...filler] },
        },
        "cubicles",
      ).divider,
      undefined,
      filler[0],
    );
  // Built-in kinds map to roles through the same table.
  assert.equal(
    customFillerRoles(
      {
        ...s,
        filler: {
          ...s.filler!,
          cubicles: ["desk", "officeChair", "partition"],
        },
      },
      "cubicles",
    ).divider,
    "partition",
  );
  assert.equal(
    customFillerRoles(
      { ...s, filler: { ...s.filler!, meeting: ["table", "armchair"] } },
      "meeting",
    ).seat,
    "armchair",
  );
});
