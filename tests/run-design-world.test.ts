import { inStation } from "../src/spatial";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildingLayoutErrors, layoutRandom } from "../src/building-layout";
import { step } from "../src/engine";
import { furnishingErrors } from "../src/office-layout";
import { planOfficeFloor } from "../src/office-plan";
import { parseScenario } from "../src/gametest/schema";
import { TestRunner } from "../src/gametest/runner";
import { captureLayout } from "../src/gametest/world";
import { decode, encode } from "../src/persistence";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { pacingProfile, spawnGrace } from "../src/study-pacing";
import { type Game, type Roadmap } from "../src/model";
import { createGame, createPlayableGame } from "../src/world";
import { runDesignFixture, savedRunDesign } from "./helpers/run-design";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

test("authored run choices control actual geometry, field quotas, furnishings and the cast", () => {
  for (const name of ["harbor-archive", "glass-orchard"] as const) {
    const design = runDesignFixture(name),
      g = createPlayableGame(42, roadmap, undefined, savedRunDesign(design));
    assert.deepEqual(buildingLayoutErrors(g), []);
    assert.equal(g.floors[0].boundary!.shape, design.footprint.shape);
    assert.equal(g.floors[0].boundary!.width, design.footprint.width);
    assert.equal(g.floors[0].boundary!.top, design.footprint.top);
    assert.equal(g.floors[4].name, design.roofName);
    for (const f of g.floors.slice(0, 4)) {
      const authored = design.floors[f.index];
      assert.equal(f.name, authored.name);
      assert.equal(f.generation!.family, authored.family);
      assert.deepEqual(
        f
          .generation!.sectors!.filter((s) => s.room !== undefined)
          .map((s) => s.room),
        [2, ...authored.roomOrder],
      );
      assert.deepEqual(pursuitLayoutErrors(g, f), []);
      assert.deepEqual(furnishingErrors(f), []);
      for (const o of f.furniture) {
        const room = /room(\d)-forward$/.exec(o.id)?.[1];
        if (room)
          assert.equal(o.field!.limit, authored.fieldQuotas[Number(room)]);
      }
      const publicGate = f.furniture.find((o) => o.field?.publicEntry)!;
      assert.equal(publicGate.field!.limit, undefined);
      for (const zone of f.office!) {
        const room = /^room(\d)(?:[bc])?$/.exec(zone.zone)?.[1];
        if (room) assert.equal(zone.type, authored.roomTypes[Number(room)]);
      }
      for (const room of f.generation!.sectors!.flatMap((s) => s.rooms))
        assert.ok(authored.subroomKinds.includes(room.kind));
    }
    assert.deepEqual(
      g.survivors.slice(1).map(({ name, role, skill, risk, social }) => ({
        name,
        role,
        skill,
        risk,
        social,
      })),
      design.roster,
    );
    assert.ok(g.notice.startsWith(design.opening));
    assert.ok(g.notice.includes("about three minutes"));
  }
});

test("different authored designs change spatial play at the same seed without consuming simulation RNG", () => {
  const a = createPlayableGame(
      42,
      roadmap,
      undefined,
      savedRunDesign(runDesignFixture("harbor-archive")),
    ),
    b = createPlayableGame(
      42,
      roadmap,
      undefined,
      savedRunDesign(runDesignFixture("glass-orchard")),
    ),
    legacy = createGame(42, roadmap);
  assert.notDeepEqual(
    a.floors.map((f) => f.tiles),
    b.floors.map((f) => f.tiles),
  );
  assert.notDeepEqual(
    a.floors.map((f) => f.furniture.map((o) => [o.kind, o.x, o.y])),
    b.floors.map((f) => f.furniture.map((o) => [o.kind, o.x, o.y])),
  );
  assert.notDeepEqual(a.floors[0].city!.roads, b.floors[0].city!.roads);
  assert.equal(a.rng, legacy.rng);
  assert.equal(b.rng, legacy.rng);
});

test("authored city dimensions, heights, colors and tempo reach the physical world", () => {
  const design = runDesignFixture(),
    g = createPlayableGame(42, roadmap, undefined, savedRunDesign(design)),
    city = g.floors[0].city!;
  const buildings = city.obstacles.filter((o) => o.kind === "building");
  assert.ok(buildings.length > 0);
  for (const building of buildings) {
    assert.ok(building.height >= design.city.buildingHeightMin);
    assert.ok(building.height <= design.city.buildingHeightMax);
    assert.ok(design.city.palette.includes(building.color));
  }
  assert.ok(
    city.roads.some(
      (r) => r.w === design.city.roadWidth || r.h === design.city.roadWidth,
    ),
  );
  assert.equal(
    city.approaches.find((a) => a.id === "west")!.points[1].y,
    g.floors[0].boundary!.bottom + design.city.boulevardOffset,
  );
  assert.deepEqual(pacingProfile(g), {
    zombieGraceSeconds: 180,
    ...design.pacing,
  });
  assert.equal(spawnGrace(g), 180);
  assert.equal(g.nextSpawn, design.pacing.swarmInterval);
  assert.equal(g.helicopter.next, design.pacing.firstHelicopter);
});

test("authored density changes furnishings while leaving the validated floor geometry intact", () => {
  const sparse = runDesignFixture(),
    dense = runDesignFixture();
  for (const f of sparse.floors) f.furnitureDensity = 0.5;
  for (const f of dense.floors) f.furnitureDensity = 1.5;
  const a = createPlayableGame(42, roadmap, undefined, savedRunDesign(sparse)),
    b = createPlayableGame(42, roadmap, undefined, savedRunDesign(dense));
  assert.deepEqual(
    a.floors.map((f) => f.tiles),
    b.floors.map((f) => f.tiles),
  );
  assert.ok(
    b.floors.reduce((n, f) => n + f.furniture.length, 0) >
      a.floors.reduce((n, f) => n + f.furniture.length, 0),
  );
  for (const f of [...a.floors.slice(0, 4), ...b.floors.slice(0, 4)])
    assert.deepEqual(furnishingErrors(f), []);
});

test("saved authored worlds retain their design, geometry and deterministic simulation continuation", () => {
  const g = createPlayableGame(42, roadmap, undefined, savedRunDesign());
  g.status = "playing";
  const restored = decode(encode(g));
  assert.deepEqual(restored.design, g.design);
  assert.deepEqual(restored.floors, g.floors);
  const frame = (game: Game) => ({
    time: game.time,
    rng: game.rng,
    survivors: game.survivors,
    zombies: game.zombies,
    nextSpawn: game.nextSpawn,
  });
  for (let i = 0; i < 30; i++) {
    step(g, 1 / 30, { x: 0, y: 0, grab: false });
    step(restored, 1 / 30, { x: 0, y: 0, grab: false });
  }
  assert.deepEqual(frame(restored), frame(g));
  assert.deepEqual(restored.design, savedRunDesign());
});

test("final furnishing validation rejects a solid obstruction at a required terminal", () => {
  const g = createPlayableGame(42, roadmap, undefined, savedRunDesign()),
    f = g.floors[0],
    station = f.stations[0],
    block = structuredClone(
      f.furniture.find((o) => !o.field && o.kind !== "door")!,
    );
  Object.assign(block, {
    id: "synthetic-blocker",
    x: station.x,
    y: station.y,
    w: 2,
    h: 2,
  });
  f.furniture.push(block);
  assert.ok(furnishingErrors(f).some((e) => e.includes("blocks route")));
});

test("rejected authored geometry never falls back to another floor-plan family", () => {
  const g = createPlayableGame(42, roadmap, undefined, savedRunDesign()),
    f = g.floors[0],
    families = new Set<string>();
  let attempts = 0;
  assert.throws(
    () =>
      planOfficeFloor(g, f, layoutRandom(42, 0x726f6f6d), (candidate) => {
        families.add(candidate.generation!.family!);
        attempts++;
        return ["Synthetic geometry rejection"];
      }),
    /Invalid office floor 0: Synthetic geometry rejection/,
  );
  assert.ok(attempts > 0 && attempts <= 64);
  assert.deepEqual([...families], [f.design!.family]);
});

test("GameTest design data is validated, checkpointed and stripped from arena layout captures", () => {
  const scenario = parseScenario(
    JSON.parse(
      readFileSync("tests/fixtures/gametest/ai-designed-run.json", "utf8"),
    ),
  );
  assert.throws(
    () => parseScenario({ ...scenario, template: "arena" }),
    /building/,
  );
  assert.throws(
    () =>
      parseScenario({
        ...scenario,
        design: { ...scenario.design, arbitraryScript: "run()" },
      }),
    /unknown/i,
  );
  const malformed = structuredClone(scenario);
  malformed.design!.floors[0].roomOrder = [0, 0, 3];
  assert.throws(() => parseScenario(malformed), /roomOrder/);
  const runner = new TestRunner(scenario, roadmap),
    design = structuredClone(runner.game.design);
  runner.advance(151);
  assert.deepEqual(runner.game.design, design);
  assert.equal(runner.game.design!.source, "fixture");
  const captured = captureLayout(runner.game, scenario);
  assert.equal(captured.template, "arena");
  assert.equal(captured.design, undefined);
  assert.doesNotThrow(() => parseScenario(captured));
  assert.equal(runner.run().status, "passed");
  for (const actor of runner.game.survivors.slice(1)) {
    const station = runner.game.floors[0].stations.find(
      (s) => s.id === actor.station,
    );
    assert.ok(station, `${actor.name} has reached a study terminal`);
    assert.ok(Math.hypot(actor.x - station.x, actor.y - station.y) < 1.3);
    assert.ok(!inStation(station, actor, 0.1), "stands outside the desk");
    assert.ok(
      actor.thought > 0,
      `${actor.name} is performing actual study work`,
    );
  }
});
