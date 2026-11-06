import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Box3, BufferGeometry, Color, Group, Mesh } from "three";
import { cityCollisionBoxes } from "../src/city-layout";
import type { Floor, Roadmap } from "../src/model";
import {
  GROUNDS,
  NEIGHBOR_STYLES,
  WEATHERS,
  parseSetting,
  type RunNeighborStyle,
  type RunSetting,
  type RunSurroundings,
} from "../src/setting-catalog.mjs";
import { ExteriorDressing } from "../src/view3d/exterior";
import { sceneryPads, SCENERY_PAD } from "../src/view3d/exterior-layout";
import {
  lotCells,
  neighborCell,
  neighborCore,
  type NeighborStyle,
} from "../src/view3d/neighbors";
import { WEATHER_MAX_PARTICLES, WeatherField } from "../src/view3d/weather";
import { createPlayableGame } from "../src/world";

// The physical city draws its signs on canvases; a recording stub is enough to
// build every mesh without a browser.
const noop = () => undefined;
const context: object = new Proxy(
  {},
  {
    get: (_target, key) =>
      key === "createRadialGradient" || key === "createLinearGradient"
        ? () => ({ addColorStop: noop })
        : noop,
    set: () => true,
  },
);
(globalThis as any).document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => context }),
};

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const radio = () =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  ).setting as RunSetting;

const part = (over: object) => ({
  shape: "cylinder",
  axis: "up",
  x: 0,
  y: 0,
  z: 0,
  w: 0.3,
  d: 0.3,
  h: 1.5,
  pitch: 0,
  roll: 0,
  motion: "none",
  rate: 1,
  color: "#2d6a4f",
  finish: "matte",
  ...over,
});
const object = (id: string, parts: object[]) => ({
  id,
  name: id,
  role: "decor",
  weight: "light",
  size: { w: 1, d: 1, h: 2.2 },
  surface: false,
  parts,
});

function settingWith(over: Partial<RunSurroundings> = {}): RunSetting {
  const setting = structuredClone(radio()) as any;
  setting.objects = [
    object("kelp", [
      part({}),
      part({ x: 0.3, h: 1.2, color: "#3e8f5a" }),
      part({ shape: "sphere", z: 1.4, w: 0.4, d: 0.4, h: 0.4, finish: "glow" }),
    ]),
    object("urn", [part({ shape: "box", w: 0.6, d: 0.6, h: 0.9 })]),
  ];
  setting.surroundings = { ...setting.surroundings, ...over };
  return setting;
}

function city(seed = 7, over: Partial<RunSurroundings> | null = {}) {
  const game = createPlayableGame(seed, roadmap),
    floor = game.floors[0];
  if (over) floor.setting = settingWith(over);
  return { game, floor };
}

function dressing() {
  return new ExteriorDressing();
}
const worldOf = (d: ExteriorDressing) => (d as any).world as Group;
const names = (d: ExteriorDressing) =>
  worldOf(d)
    .children.map((c) => c.name)
    .sort();

function digest(d: ExteriorDressing) {
  let h = 2166136261;
  for (const child of worldOf(d).children as Mesh[]) {
    for (const name of ["position", "color"]) {
      const a = child.geometry.getAttribute(name);
      if (!a) continue;
      for (let i = 0; i < a.array.length; i++)
        h = Math.imul(h ^ Math.round((a.array[i] as number) * 1000), 16777619);
    }
    h = Math.imul(h ^ child.name.length, 16777619);
  }
  return h >>> 0;
}

test("an undesigned run keeps the default look", () => {
  const { floor } = city(7, null),
    d = dressing();
  d.build(floor, [floor]);
  assert.ok(d.enabled);
  assert.ok(!names(d).some((n) => n.startsWith("themed")));
  assert.equal(d.horizon.getHexString(), "344552");
  assert.equal((d as any).asphalt.color.getHexString(), "77838a");
  assert.equal((d as any).asphalt.fog, true);
  assert.equal((d as any).solid.fog, false);
  assert.deepEqual(d.fogRange(100, 700, true, 5), { near: 100, far: 700 });
  assert.equal((d as any).weather.active, false);
  const again = dressing();
  again.build(floor, [floor]);
  assert.equal(digest(again), digest(d), "the same seed builds the same city");
  // Building a designed floor and then an undesigned one restores the look.
  const designed = city(7, { ground: "snow", groundColor: "#ffffff" }).floor,
    reuse = dressing();
  reuse.build(designed, [designed]);
  assert.ok(names(reuse).includes("themed-paths"));
  reuse.build(floor, [floor]);
  assert.equal(digest(reuse), digest(d));
  assert.equal((reuse as any).asphalt.color.getHexString(), "77838a");
  assert.equal((reuse as any).solid.fog, false);
  d.dispose();
  again.dispose();
  reuse.dispose();
});

test("every ground, neighbour style and weather builds within bounds", () => {
  for (const [i, ground] of GROUNDS.entries()) {
    const neighbors = NEIGHBOR_STYLES[i % NEIGHBOR_STYLES.length],
      weather = WEATHERS[i % WEATHERS.length],
      { floor } = city(3 + i, {
        ground,
        neighbors,
        weather,
        groundColor: "#8899aa",
        pathColor: "#334455",
        neighborColor: "#aa7744",
        scenery: ["kelp", "urn"],
      }),
      d = dressing();
    d.build(floor, [floor]);
    const world = worldOf(d);
    assert.ok(world.getObjectByName("themed-paths"), ground);
    assert.ok(world.children.length <= 20, `${ground}: bounded meshes`);
    let triangles = 0;
    for (const child of world.children as Mesh[]) {
      const g = child.geometry as BufferGeometry;
      const p = g.getAttribute("position");
      for (let k = 0; k < p.array.length; k++)
        assert.ok(Number.isFinite(p.array[k]), `${ground}/${neighbors} NaN`);
      triangles += (g.index?.count ?? p.count) / 3;
    }
    assert.ok(triangles < 900_000, `${ground}/${neighbors}: ${triangles}`);
    (d as any).weather.update(1, { x: 22, y: 1.6, z: 30, exposed: true });
    assert.ok((d as any).weather.count <= WEATHER_MAX_PARTICLES);
    d.dispose();
  }
});

test("each neighbour style builds, and the plan's collision boxes never change", () => {
  for (const [i, style] of NEIGHBOR_STYLES.entries()) {
    const { floor } = city(11 + i, {
        neighbors: style,
        ground: style === "buildings" || style === "ruins" ? "asphalt" : "sand",
        scenery: ["kelp"],
      }),
      before = JSON.stringify(floor.city),
      boxes = JSON.stringify(cityCollisionBoxes(floor.city!)),
      tiles = JSON.stringify(floor.tiles),
      d = dressing();
    d.build(floor, [floor]);
    d.build(floor, [floor]);
    assert.equal(JSON.stringify(floor.city), before, style);
    assert.equal(JSON.stringify(cityCollisionBoxes(floor.city!)), boxes);
    assert.equal(JSON.stringify(floor.tiles), tiles, "tiles are untouched");
    d.dispose();
  }
});

test("neighbour pieces stay inside the footprint of the lot they dress", () => {
  const sizes = [
    { x: 40, z: -30, w: 12, d: 8 },
    { x: -20, z: 60, w: 5, d: 30 },
    { x: 100, z: 100, w: 9, d: 9 },
  ];
  for (const style of NEIGHBOR_STYLES.filter(
    (s): s is NeighborStyle => s !== "buildings",
  ))
    for (const lot of sizes)
      for (let seed = 0; seed < 4; seed++) {
        const box = new Box3(),
          emit = (g: BufferGeometry) => {
            g.computeBoundingBox();
            box.union(g.boundingBox!);
          },
          { rim, core } = lotCells(lot, 8, 12);
        rim.forEach((cell, i) =>
          neighborCell(style, cell, 30, "#668844", seed * 31 + i, emit),
        );
        if (core) neighborCore(style, core, "#668844", emit);
        const slack = 0.5;
        assert.ok(
          box.min.x >= lot.x - lot.w / 2 - slack &&
            box.max.x <= lot.x + lot.w / 2 + slack &&
            box.min.z >= lot.z - lot.d / 2 - slack &&
            box.max.z <= lot.z + lot.d / 2 + slack,
          `${style} ${JSON.stringify(lot)}: ${box.min.toArray()} ${box.max.toArray()}`,
        );
        assert.ok(box.min.y >= -3, `${style} stays above ground`);
        assert.ok(box.max.y <= 24, `${style} is a sane height`);
      }
});

test("scenery stands in solid lots, clear of roads, the entrance and spawns", () => {
  for (let seed = 1; seed <= 12; seed++) {
    const { floor } = city(seed, null),
      pads = sceneryPads(floor, ["kelp", "urn"]);
    assert.ok(pads.length >= 4, `seed ${seed} found ${pads.length} pads`);
    assert.ok(pads.length <= 6);
    assert.deepEqual(
      pads,
      sceneryPads(floor, ["kelp", "urn"]),
      "deterministic",
    );
    assert.deepEqual(
      new Set(pads.map((p) => p.id)),
      new Set(["kelp", "urn"]),
      "every id appears",
    );
    const plan = floor.city!,
      entrance = floor.furniture.find((o) => o.id === "main-gate")?.x ?? 22;
    for (const pad of pads) {
      assert.equal(pad.w <= SCENERY_PAD.along, true);
      for (const road of plan.roads)
        assert.ok(
          pad.x + pad.w / 2 <= road.x - road.w / 2 ||
            pad.x - pad.w / 2 >= road.x + road.w / 2 ||
            pad.z + pad.d / 2 <= road.y - road.h / 2 ||
            pad.z - pad.d / 2 >= road.y + road.h / 2,
          `seed ${seed}: pad ${pad.x},${pad.z} overlaps a road`,
        );
      assert.ok(
        plan.obstacles.some(
          (o) =>
            o.kind === "building" &&
            pad.x - pad.w / 2 >= o.x - o.w / 2 - 1e-6 &&
            pad.x + pad.w / 2 <= o.x + o.w / 2 + 1e-6 &&
            pad.z - pad.d / 2 >= o.y - o.h / 2 - 1e-6 &&
            pad.z + pad.d / 2 <= o.y + o.h / 2 + 1e-6,
        ),
        "the pad lies wholly inside a solid lot",
      );
      assert.ok(
        Math.abs(pad.x - entrance) > 16 ||
          pad.z < floor.boundary!.top - 3 ||
          pad.z > floor.boundary!.bottom + 40,
        "away from the entrance lane",
      );
      for (const a of plan.approaches)
        for (const point of a.points)
          assert.ok(Math.hypot(point.x - pad.x, point.y - pad.z) >= 14);
    }
  }
  const { floor } = city(5, null);
  assert.deepEqual(sceneryPads(floor, []), []);
  const a = sceneryPads(floor, ["kelp"]).map((p) => p.x);
  floor.city!.seed += 1;
  assert.notDeepEqual(
    a,
    sceneryPads(floor, ["kelp"]).map((p) => p.x),
  );
});

test("scenery is built from the composed recipes and adds no collision", () => {
  const { floor } = city(9, { scenery: ["kelp", "urn"] }),
    before = JSON.stringify(floor.city),
    d = dressing();
  d.build(floor, [floor]);
  const scenery = worldOf(d).getObjectByName("themed-scenery") as Mesh;
  assert.ok(scenery, "scenery mesh");
  assert.ok(worldOf(d).getObjectByName("themed-scenery-lit"), "glow parts");
  assert.ok((d as any).pads.length >= 4);
  scenery.geometry.computeBoundingBox();
  assert.ok(scenery.geometry.boundingBox!.max.y > 1, "stands on its bed");
  assert.equal(JSON.stringify(floor.city), before);
  // An id the design does not define is ignored rather than drawn.
  const ghost = city(9, { scenery: ["missing"] }).floor,
    g = dressing();
  g.build(ghost, [ghost]);
  assert.equal(worldOf(g).getObjectByName("themed-scenery"), undefined);
  d.dispose();
  g.dispose();
});

test("sky, fog and the ground take the designed colours", () => {
  const { floor } = city(4, {
      ground: "snow",
      groundColor: "#e8f1ff",
      pathColor: "#9fb4cc",
      sky: { zenith: "#102040", horizon: "#aaccee" },
      fog: { color: "#ddeeff", density: 0.8 },
    }),
    d = dressing();
  d.build(floor, [floor]);
  assert.equal(d.horizon.getHexString(), "ddeeff");
  assert.equal(
    ((d as any).skyMaterial.uniforms.zenith.value as Color).getHexString(),
    "102040",
  );
  assert.equal((d as any).asphalt.color.getHexString(), "e8f1ff");
  assert.equal((d as any).pathMaterial.color.getHexString(), "9fb4cc");
  assert.equal((d as any).solid.fog, true);
  d.setTheme(true);
  assert.notEqual(
    d.horizon.getHexString(),
    "ddeeff",
    "the surge tints the fog",
  );
  d.setTheme(false);
  assert.equal(d.horizon.getHexString(), "ddeeff");
  // Dense fog still leaves the street ahead of the entrance readable, and
  // eases between the street and the indoors rather than snapping.
  const outside = d.fogRange(100, 700, true, 10),
    first = d.fogRange(100, 700, false, 10.05);
  assert.ok(outside.far >= 48 && outside.near < outside.far);
  assert.ok(first.far > outside.far && first.far < outside.far + 60);
  let range = first;
  for (let t = 10.1; t < 14; t += 0.1) range = d.fogRange(100, 700, false, t);
  assert.ok(range.far > outside.far, "indoors is clearer than outside");
  const clear = city(4, { fog: { color: "#ddeeff", density: 0 } }).floor,
    c = dressing();
  c.build(clear, [clear]);
  assert.deepEqual(c.fogRange(100, 700, true, 3), { near: 100, far: 700 });
  d.dispose();
  c.dispose();
});

test("streetlights and cars only stand on grounds that carry streets", () => {
  const lamps = (ground: RunSurroundings["ground"]) => {
    const { floor } = city(6, { ground, neighbors: "buildings" }),
      d = dressing();
    d.build(floor, [floor]);
    const poles = (
      worldOf(d).getObjectByName("merged-street-facade-props") as Mesh
    ).geometry.getAttribute("position").count;
    d.dispose();
    return poles;
  };
  const road = lamps("asphalt"),
    sand = lamps("sand");
  assert.ok(sand < road, `sand ${sand} < asphalt ${road}`);
});

test("weather is a bounded, deterministic particle field that follows the viewer", () => {
  for (const kind of WEATHERS) {
    const field = new WeatherField();
    field.setKind(kind);
    if (kind === "none") {
      assert.equal(field.active, false);
      continue;
    }
    assert.ok(field.active);
    assert.ok(field.count > 0 && field.count <= WEATHER_MAX_PARTICLES, kind);
    const view = { x: 20, y: 1.6, z: 30, exposed: true };
    for (const t of [0.5, 1, 7.3]) field.update(t, view);
    const object = field.group.children[0] as Mesh,
      position = object.geometry.getAttribute("position");
    for (let i = 0; i < position.count; i++) {
      assert.ok(Math.abs(position.getX(i) - view.x) <= 24 + 1.5, kind);
      assert.ok(Math.abs(position.getZ(i) - view.z) <= 24 + 1.5, kind);
      assert.ok(
        position.getY(i) >= view.y - 6 && position.getY(i) <= view.y + 20,
      );
    }
    const snapshot = Array.from(position.array as Float32Array);
    const twin = new WeatherField();
    twin.setKind(kind);
    for (const t of [0.5, 1, 7.3]) twin.update(t, view);
    assert.deepEqual(
      Array.from(
        (twin.group.children[0] as Mesh).geometry.getAttribute("position")
          .array as Float32Array,
      ),
      snapshot,
      "deterministic",
    );
    // Reduced motion holds the field still.
    const calm = new WeatherField();
    calm.setKind(kind);
    calm.update(1, view, true);
    const a = Array.from(
      (calm.group.children[0] as Mesh).geometry.getAttribute("position")
        .array as Float32Array,
    );
    calm.update(9, view, true);
    assert.deepEqual(
      a,
      Array.from(
        (calm.group.children[0] as Mesh).geometry.getAttribute("position")
          .array as Float32Array,
      ),
    );
    // Indoors the field fades out entirely.
    for (let t = 10; t < 14; t += 0.25)
      field.update(t, { ...view, exposed: false });
    assert.equal(field.group.visible, false);
    field.dispose();
    twin.dispose();
    calm.dispose();
  }
});

test("a legacy city without a stored plan takes the designed look too", () => {
  const { floor } = city(2, null);
  const legacy: Floor = { ...floor, city: undefined };
  legacy.setting = settingWith({
    ground: "grass",
    neighbors: "hedges",
    weather: "leaves",
    scenery: ["urn"],
  });
  const d = dressing();
  d.build(legacy, [legacy]);
  assert.ok(d.enabled);
  assert.ok(worldOf(d).getObjectByName("themed-paths"));
  assert.equal((d as any).look.neighbors, "hedges");
  d.dispose();
});

test("the setting parser still accepts the test settings", () => {
  const s = settingWith({ neighbors: "coral" as RunNeighborStyle });
  assert.doesNotThrow(() => parseSetting(s));
});
