import { inStation } from "../src/spatial";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  propWorldPose,
  realizeAuthoredScene,
  sceneSaveErrors,
} from "../src/authored-scene";
import { buildingLayoutErrors } from "../src/building-layout";
import { step } from "../src/engine";
import { boxesOverlap, worldPoint } from "../src/furniture-geometry";
import { TestRunner } from "../src/gametest/runner";
import { parseScenario } from "../src/gametest/schema";
import { FURNITURE, type Roadmap } from "../src/model";
import { fieldClearance, furnishingErrors } from "../src/office-layout";
import { decode, encode } from "../src/persistence";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { PROP_CATALOG } from "../src/scene-catalog.mjs";
import {
  furnitureSurfaceBounds,
  furnitureSurfaceHeight,
} from "../src/view3d/furniture-height";
import { createPlayableGame } from "../src/world";
import { sceneDesignFixture, savedRunDesign } from "./helpers/run-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const build = (design = sceneDesignFixture()) =>
  createPlayableGame(42, roadmap, undefined, savedRunDesign(design));

test("AI scene fixtures create every requested physical item and individually authored surface prop", () => {
  for (const name of ["botanical-office", "observatory-records"] as const) {
    const design = sceneDesignFixture(name),
      g = build(design);
    assert.deepEqual(buildingLayoutErrors(g), []);
    for (const floor of g.floors.slice(0, 4)) {
      const scene = floor.scene!,
        source = design.floors[floor.index].scene!;
      assert.deepEqual(sceneSaveErrors(floor), []);
      assert.deepEqual(furnishingErrors(floor), []);
      assert.deepEqual(pursuitLayoutErrors(g, floor), []);
      assert.equal(scene.rooms.length, 4);
      assert.equal(
        scene.furniture.length,
        source.rooms.reduce((n, room) => n + room.furniture.length, 0),
      );
      assert.equal(
        scene.props.length,
        source.rooms.reduce(
          (n, room) =>
            n + room.furniture.reduce((m, item) => m + item.props.length, 0),
          0,
        ),
      );
      assert.deepEqual(
        new Set(scene.props.map((p) => p.kind)),
        new Set(Object.keys(PROP_CATALOG)),
      );
      for (const binding of scene.furniture) {
        const item = source.rooms
            .find((r) => r.room === binding.room)!
            .furniture.find((o) => o.id === binding.designId)!,
          object = floor.furniture.find((o) => o.id === binding.id)!;
        assert.equal(object.kind, item.kind);
        assert.equal(object.w, FURNITURE[item.kind].w);
        assert.equal(object.h, FURNITURE[item.kind].h);
        assert.equal(
          object.hp / object.maxHp,
          { intact: 1, worn: 0.85, damaged: 0.45 }[item.condition],
        );
        assert.equal(object.appearance!.color, item.color);
        assert.equal(object.appearance!.label, item.label);
        assert.equal(object.appearance!.owner, item.owner);
        assert.equal(object.angle ?? 0, (item.angle * Math.PI) / 180);
      }
      for (const prop of scene.props) {
        const pose = propWorldPose(floor, prop)!;
        assert.ok(pose.parent.appearance);
        assert.deepEqual(
          { x: pose.x, y: pose.y },
          worldPoint(prop, pose.parent),
        );
        assert.ok(prop.top + prop.h < 2.82);
      }
    }
  }
});

test("scene realization is deterministic and keeps the simulation random stream unchanged", () => {
  const design = sceneDesignFixture(),
    a = build(design),
    b = build(design),
    procedural = createPlayableGame(42, roadmap);
  assert.deepEqual(a.floors, b.floors);
  assert.equal(a.rng, b.rng);
  assert.equal(a.rng, procedural.rng);
  assert.deepEqual(decode(encode(a)).floors, a.floors);
});

test("every supported furniture family packs props onto its actual visible upper surface", () => {
  const surfaces = {
    desk: 0.85,
    table: 0.85,
    cafeTable: 0.81,
    coffeeTable: 0.47,
    reception: 1.1,
    cabinet: 1.15,
    shelf: 1.915,
    drawers: 0.7,
  } as const;
  for (const [kind, top] of Object.entries(surfaces)) {
    const design = sceneDesignFixture(),
      item = design.floors[0].scene!.rooms[0].furniture[0];
    item.kind = kind as keyof typeof surfaces;
    // A drawer top supports a mug; it cannot hold the larger three-prop tableau.
    item.props = [item.props[0]];
    const floor = build(design).floors[0],
      object = floor.furniture.find((o) => o.appearance?.room === 0)!,
      props = floor.scene!.props.filter((p) => p.furnitureId === object.id),
      surface = furnitureSurfaceBounds(object.kind, object.w, object.h);
    assert.ok(Math.abs(furnitureSurfaceHeight(object.kind) - top) < 1e-8);
    for (const prop of props) {
      assert.ok(
        Math.abs(prop.top - top - 0.002) < 1e-8,
        `${kind} prop is on its top face`,
      );
      assert.ok(Math.abs(prop.x) + prop.w / 2 < surface.w / 2);
      assert.ok(Math.abs(prop.y) + prop.d / 2 < surface.d / 2);
    }
    assert.deepEqual(sceneSaveErrors(floor), []);
  }
});

test("authored room coordinates change actual object placement and damage changes native health", () => {
  const left = sceneDesignFixture(),
    right = sceneDesignFixture();
  for (const f of left.floors)
    for (const room of f.scene!.rooms) room.furniture[0].at = { x: 0, y: 0 };
  for (const f of right.floors)
    for (const room of f.scene!.rooms) {
      room.furniture[0].at = { x: 1, y: 1 };
      room.furniture[0].condition = "damaged";
    }
  const a = build(left),
    b = build(right);
  let changed = 0;
  for (let i = 0; i < 4; i++)
    for (const binding of a.floors[i].scene!.furniture) {
      const first = a.floors[i].furniture.find((o) => o.id === binding.id)!,
        other = b.floors[i].furniture.find((o) => o.id === binding.id)!;
      if (Math.hypot(first.x - other.x, first.y - other.y) > 1) changed++;
      assert.equal(other.hp, other.maxHp * 0.45);
    }
  assert.ok(
    changed >= 12,
    `actual placement changed in ${changed}/16 room scenes`,
  );
});

test("crowded requested tabletop points are packed without overlaps and oversized arrangements reject", () => {
  const design = sceneDesignFixture();
  const item = design.floors[0].scene!.rooms[0].furniture[0];
  for (const prop of item.props) {
    prop.at = { x: 1, y: -1 };
    prop.angle = 45;
  }
  const floor = build(design).floors[0],
    props = floor.scene!.props.filter((p) => p.furnitureId.endsWith(item.id));
  assert.equal(props.length, item.props.length);
  for (let i = 0; i < props.length; i++)
    for (const other of props.slice(i + 1)) {
      const a = props[i];
      assert.equal(
        boxesOverlap({ ...a, h: a.d }, { ...other, h: other.d }),
        false,
      );
    }
  const full = sceneDesignFixture(),
    small = full.floors[0].scene!.rooms[0].furniture[0],
    sample = small.props[0];
  small.kind = "drawers";
  small.props = Array.from({ length: 8 }, (_, i) => ({
    ...sample,
    id: `crowded-${i}`,
    kind: "plant",
    scale: 1.25,
  }));
  assert.throws(() => build(full), /no clear tabletop space/);
});

test("an unplaceable authored furniture request rejects the candidate instead of dropping the item", () => {
  const g = build(),
    floor = structuredClone(g.floors[0]);
  delete floor.scene;
  floor.furniture = floor.furniture.filter((o) => !o.appearance);
  floor.tiles = floor.tiles.map((row) => row.map(() => 1));
  assert.throws(
    () => realizeAuthoredScene(floor, fieldClearance(floor), floor.entry, []),
    /Authored scene floor 0/,
  );
  assert.equal(floor.scene, undefined);
});

test("saved scenes preserve moved, rotated, damaged, destroyed and removed native parents", () => {
  const g = build(),
    floor = g.floors[0],
    props = floor.scene!.props,
    first = floor.furniture.find((o) => o.id === props[0].furnitureId)!,
    secondId = floor.scene!.furniture[1].id,
    thirdId = floor.scene!.furniture[2].id;
  first.x += 1.25;
  first.y -= 0.4;
  first.angle = 0.73;
  first.hp = 13;
  floor.furniture.find((o) => o.id === secondId)!.destroyed = true;
  floor.furniture = floor.furniture.filter((o) => o.id !== thirdId);
  const before = structuredClone(floor),
    restored = decode(encode(g));
  assert.deepEqual(restored.floors[0], before);
  assert.deepEqual(sceneSaveErrors(restored.floors[0]), []);
  assert.deepEqual(
    propWorldPose(restored.floors[0], props[0]),
    propWorldPose(floor, props[0]),
  );
  assert.equal(
    propWorldPose(
      floor,
      props.find((p) => p.furnitureId === secondId)!,
    ),
    undefined,
  );
  assert.equal(
    propWorldPose(
      floor,
      props.find((p) => p.furnitureId === thirdId)!,
    ),
    undefined,
  );
});

test("saved scene validation rejects changed authorship, floating signs, extra fields and unsupported transforms", () => {
  const g = build();
  const changes = [
    (f: (typeof g.floors)[0]) => {
      f.scene!.props[0].text = "unbound replacement";
    },
    (f: (typeof g.floors)[0]) => {
      f.scene!.props[0].x = 10;
    },
    (f: (typeof g.floors)[0]) => {
      f.scene!.rooms[0].plaque.x += 0.2;
    },
    (f: (typeof g.floors)[0]) => {
      f.scene!.rooms[0].plaque = { ...f.scene!.rooms[1].plaque };
    },
    (f: (typeof g.floors)[0]) => {
      Object.assign(f.scene!, { arbitrary: "ignored?" });
    },
    (f: (typeof g.floors)[0]) => {
      f.scene!.props[0].angle = NaN;
    },
    (f: (typeof g.floors)[0]) => {
      f.furniture.find((o) => o.appearance)!.appearance!.owner = "Unknown";
    },
  ];
  for (const change of changes) {
    const copy = structuredClone(g.floors[0]);
    change(copy);
    assert.ok(sceneSaveErrors(copy).length > 0);
  }
  const reordered = structuredClone(g.floors[0]);
  const object = reordered.furniture.find((o) => o.appearance)!;
  object.appearance = Object.fromEntries(
    Object.entries(object.appearance!).reverse(),
  ) as typeof object.appearance;
  reordered.scene!.rooms[0].palette = Object.fromEntries(
    Object.entries(reordered.scene!.rooms[0].palette).reverse(),
  ) as { surface: string; metal: string; accent: string };
  assert.deepEqual(sceneSaveErrors(reordered), []);
  delete reordered.design;
  assert.ok(sceneSaveErrors(reordered).length > 0);
});

test("authored physical furniture blocks real walking and destruction leaves no invisible collider", () => {
  const design = sceneDesignFixture();
  design.floors[0].scene!.rooms[2].furniture[0].kind = "cabinet";
  const g = build(design),
    floor = g.floors[0],
    actor = g.survivors[0],
    object = floor.furniture.find((o) => o.appearance?.room === 2)!;
  g.survivors = [actor];
  g.zombies = [];
  g.nextSpawn = 1e9;
  g.surge.anchor = 1e9;
  g.status = "playing";
  floor.furniture = [object];
  Object.assign(actor, { x: object.x - 1.3, y: object.y, floor: 0 });
  const before = object.x;
  for (let i = 0; i < 90; i++) step(g, 1 / 30, { x: 1, y: 0, grab: false });
  assert.ok(Math.abs(object.x - before) < 0.05);
  assert.ok(actor.x < object.x - object.w / 2 - 0.2);
  object.destroyed = true;
  for (let i = 0; i < 60; i++) step(g, 1 / 30, { x: 1, y: 0, grab: false });
  assert.ok(actor.x > before + object.w / 2 + 0.5);
  assert.equal(
    propWorldPose(
      floor,
      floor.scene!.props.find((p) => p.furnitureId === object.id)!,
    ),
    undefined,
  );
});

test("authored scene GameTest keeps all NPCs physically at study terminals through a checkpoint", () => {
  const scenario = parseScenario(
      readFileSync(
        "tests/fixtures/gametest/ai-scene-study-arrival.json",
        "utf8",
      ),
    ),
    runner = new TestRunner(scenario, roadmap);
  runner.run();
  assert.equal(runner.status, "passed", JSON.stringify(runner.report().checks));
  for (const npc of runner.game.survivors.slice(1)) {
    const terminal = runner.game.floors[npc.floor].stations.find(
      (s) => s.id === npc.station,
    );
    assert.ok(
      terminal &&
        Math.hypot(npc.x - terminal.x, npc.y - terminal.y) < 1.3 &&
        !inStation(terminal, npc, 0.1),
    );
    assert.ok(npc.thought > 0);
  }
  for (const floor of runner.game.floors.slice(0, 4))
    assert.deepEqual(sceneSaveErrors(floor), []);
});
