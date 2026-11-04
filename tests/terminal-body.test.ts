import assert from "node:assert/strict";
import test from "node:test";
import { step } from "../src/engine";
import { path, stationFacing, stationSpot, STATION_BODY } from "../src/spatial";
import { survivorPath } from "../src/navigation";
import { readFileSync } from "node:fs";
import { environmentSurfaceFingerprint } from "../src/environment-contract.mjs";
import { buildEnvironmentSurfaces } from "../src/environment-surfaces";
import { TestRunner } from "../src/gametest/runner";
import { parseScenario } from "../src/gametest/schema";
import type { Roadmap } from "../src/model";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { solidDesks } from "../src/station-clearance";
import { createPlayableGame } from "../src/world";
import { loopFixture } from "./helpers/study-loop";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;

function worker() {
  const fixture = loopFixture(42, false);
  fixture.g.zombies = [];
  fixture.g.survivors = fixture.g.survivors.filter(
    (s) => s === fixture.a || s.id === "human",
  );
  return { ...fixture, station: fixture.f.stations[0] };
}

for (const [name, dx, dy] of [
  ["inside the desk, as older saves left it", 0, 0],
  ["behind the screen", 0, -2.5],
  ["in front of the keyboard", 0.5, 2.5],
  ["beside the desk", 2.5, 0],
] as const)
  test(`an NPC starting ${name} works from the screen side`, () => {
    const { g, a, f, station } = worker();
    a.x = station.x + dx;
    a.y = station.y + dy;
    const sign = stationFacing(f, station);
    for (let i = 0; i < 300; i++) step(g, 1 / 30);
    assert.equal(a.activity, "studying");
    assert.equal(a.station, station.id);
    assert.ok(
      (a.y - station.y) * sign > STATION_BODY.h / 2,
      `stood at ${a.x},${a.y}, in front of ${station.x},${station.y}`,
    );
    assert.ok(Math.abs(a.x - station.x) < 0.3, `stood at x=${a.x}`);
    assert.ok(a.heading.y * sign < -0.8, "looks at the screen");
  });

test("a terminal against a wall turns its screen to the open floor and keeps it", () => {
  const { f, station } = worker();
  assert.equal(stationFacing(f, station), 1);
  const walled = { ...station, facing: undefined };
  for (const row of [Math.floor(walled.y + 1), Math.floor(walled.y + 2)])
    f.tiles[row][Math.floor(walled.x)] = 1;
  assert.equal(stationFacing(f, walled), -1);
  assert.ok(stationSpot(f, walled).y < walled.y);
  for (const row of [Math.floor(walled.y + 1), Math.floor(walled.y + 2)])
    f.tiles[row][Math.floor(walled.x)] = 0;
  assert.equal(stationFacing(f, walled), -1);
});

test("routes pass around a terminal that is not their destination", () => {
  const { a, f, station } = worker();
  // Only current office plans give terminals a body.
  f.generation = { ...f.generation!, version: 5 };
  const start = { x: station.x, y: station.y - 2 },
    end = { x: station.x, y: station.y + 2 };
  Object.assign(a, start);
  const route = survivorPath(f, a, end);
  assert.ok(route.length > 1, "must detour rather than go straight");
  const zombie = path(f, start, end);
  assert.ok(
    zombie.every(
      (p) =>
        Math.abs(p.x - station.x) > STATION_BODY.w / 2 ||
        Math.abs(p.y - station.y) > STATION_BODY.h / 2,
    ),
    "zombie guidance must not cross the desk",
  );
});

test("fresh office floors keep almost every terminal solid without breaking their layout", () => {
  let terminals = 0,
    solid = 0;
  for (const seed of [1, 2, 3, 12, 42]) {
    const g = createPlayableGame(seed, roadmap);
    for (const f of g.floors) {
      terminals += f.stations.length;
      solid += solidDesks(f).length;
      if (f.index < 4) assert.deepEqual(pursuitLayoutErrors(g, f), []);
    }
  }
  assert.ok(terminals > 500);
  assert.ok(solid / terminals > 0.99, `${solid} of ${terminals} solid`);
});

test("a saved design keeps its written inventory while its terminals become solid", () => {
  const scenario = parseScenario(
      readFileSync(
        "tests/fixtures/gametest/ai-environment-study-arrival.json",
        "utf8",
      ),
    ),
    g = new TestRunner(scenario, roadmap).game;
  assert.equal(
    environmentSurfaceFingerprint(buildEnvironmentSurfaces(g)),
    (g.design!.design as { environment: { surfaceFingerprint: string } })
      .environment.surfaceFingerprint,
  );
  for (const f of g.floors)
    assert.equal(solidDesks(f).length, f.stations.length);
});
