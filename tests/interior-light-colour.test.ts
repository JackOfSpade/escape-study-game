import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Color, PerspectiveCamera, type PointLight } from "three";
import {
  buildInteriorLighting,
  DEFAULT_LIT_FIXTURE,
  DIM_FIXTURE,
  litFixtureColor,
} from "../src/interior-lighting";
import { type Floor, type Roadmap } from "../src/model";
import { parseSetting, type RunSetting } from "../src/setting-catalog.mjs";
import { InteriorAtmosphere } from "../src/view3d/interior-atmosphere";
import { InteriorLightmap } from "../src/view3d/interior-lightmap";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
/** A real, fully valid setting lifted from a checked-in run design. */
const baseSetting = (): RunSetting =>
  structuredClone(
    (
      JSON.parse(
        readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
      ) as {
        setting: RunSetting;
      }
    ).setting,
  );
/** A designed setting with `interior.light` present, or absent when omitted. */
function designed(light?: string): RunSetting {
  const setting = baseSetting();
  const interior = setting.interior as { light?: string };
  delete interior.light;
  if (light !== undefined) interior.light = light;
  return parseSetting(setting);
}
const hex = (colour: Color | string) =>
  typeof colour === "string"
    ? `#${new Color(colour).getHexString()}`
    : `#${colour.getHexString()}`;
function gameWithLight(light?: string): { floor: Floor; plain: Floor } {
  const game = createPlayableGame(42, roadmap),
    plain = game.floors[0],
    floor = game.floors[1];
  assert.equal(
    plain.setting,
    undefined,
    "an undesigned floor carries no setting",
  );
  floor.setting = designed(light);
  return { floor, plain };
}

test("a designed interior light dyes only the lit ceiling fixtures", () => {
  const { floor } = gameWithLight("#ff2bd6");
  assert.equal(litFixtureColor(floor), "#ff2bd6");
  const plan = buildInteriorLighting(floor, 42),
    lit = plan.fixtures.filter((f) => f.level > 0.5),
    dim = plan.fixtures.filter((f) => f.level <= 0.5);
  assert.ok(lit.length > 4, "the floor has lit lamps to dye");
  assert.ok(dim.length > 0, "the floor has dim lamps that stay cool");
  for (const fixture of lit) {
    assert.equal(fixture.color, "#ff2bd6", `${fixture.id} is lit`);
    assert.ok(fixture.level > 0.5, `${fixture.id} keeps its level`);
  }
  for (const fixture of dim)
    assert.equal(fixture.color, DIM_FIXTURE, `${fixture.id} stays cool`);
});

test("undesigned light and undesigned floors keep the warm default", () => {
  assert.deepEqual(
    [litFixtureColor(undefined), DEFAULT_LIT_FIXTURE],
    ["#f2d7a3", "#f2d7a3"],
  );
  // A setting without interior.light behaves exactly like no setting at all.
  for (const floorSetting of [undefined, designed()]) {
    const game = createPlayableGame(42, roadmap),
      floor = game.floors[1];
    floor.setting = floorSetting;
    const plan = buildInteriorLighting(floor, game.seed),
      lit = plan.fixtures.filter((f) => f.level > 0.5),
      dim = plan.fixtures.filter((f) => f.level <= 0.5);
    assert.ok(lit.length > 4);
    assert.equal(litFixtureColor(floor), "#f2d7a3");
    for (const fixture of lit)
      assert.equal(fixture.color, "#f2d7a3", `${fixture.id} stays warm`);
    for (const fixture of dim)
      assert.equal(fixture.color, DIM_FIXTURE, `${fixture.id} stays cool`);
  }
});

test("the lightmap warm uniform follows the viewed floor without reallocating", () => {
  const lightmap = new InteriorLightmap(),
    warm = lightmap.uniforms.interiorLmWarm.value;
  assert.equal(hex(warm), "#f2d7a3");
  lightmap.setWarmColour("#ff2bd6");
  assert.equal(hex(warm), "#ff2bd6");
  assert.equal(
    lightmap.uniforms.interiorLmWarm.value,
    warm,
    "the uniform Color instance is reused",
  );
  lightmap.reset();
  assert.equal(hex(warm), "#f2d7a3", "a reset returns to the warm default");
});

test("the atmosphere tints the shared atlas with the floor it shows", () => {
  const game = createPlayableGame(42, roadmap),
    player = game.survivors[0],
    plain = game.floors[0],
    designedFloor = game.floors[1],
    atmosphere = new InteriorAtmosphere(),
    camera = new PerspectiveCamera();
  designedFloor.setting = designed("#ff2bd6");
  game.status = "playing";
  const warm = () => atmosphere.lightmap.uniforms.interiorLmWarm.value;
  Object.assign(player, { floor: 1, x: 6, y: 6 });
  atmosphere.update(game, camera, 0);
  const colour = warm();
  assert.equal(hex(colour), "#ff2bd6", "the viewed floor's lamps are magenta");
  for (let i = 0; i < 5; i++) atmosphere.update(game, camera, 0.1);
  assert.equal(warm(), colour, "no per-frame Color allocation");
  Object.assign(player, { floor: plain.index, x: 6, y: 6 });
  atmosphere.update(game, camera, 0);
  assert.equal(
    hex(warm()),
    "#f2d7a3",
    "the undesigned floor keeps the default",
  );
  atmosphere.dispose();
});

test("practical point lights take the fixture colour of the floor in view", () => {
  const game = createPlayableGame(42, roadmap),
    player = game.survivors[0],
    plain = game.floors[0],
    designedFloor = game.floors[1],
    atmosphere = new InteriorAtmosphere(),
    camera = new PerspectiveCamera(),
    lights = (atmosphere as unknown as { practicals: PointLight[] }).practicals;
  designedFloor.setting = designed("#ff2bd6");
  game.status = "playing";
  const stand = (floor: Floor) => {
    const fixture = buildInteriorLighting(floor, game.seed).fixtures.find(
      (f) => f.level > 0.5,
    )!;
    Object.assign(player, {
      floor: floor.index,
      x: fixture.x + 0.6,
      y: fixture.y,
    });
    atmosphere.update(game, camera, 0);
    return lights.filter((light) => light.intensity > 0);
  };
  const dyed = stand(designedFloor);
  assert.ok(dyed.length > 0, "the nearby lit lamp gets a practical light");
  for (const light of dyed)
    assert.equal(hex(light.color), "#ff2bd6", "the practical follows the lamp");
  const warm = stand(plain);
  assert.ok(warm.length > 0, "the undesigned floor still lights its rooms");
  for (const light of warm)
    assert.equal(hex(light.color), "#f2d7a3", "undesigned stays warm");
  atmosphere.dispose();
});
