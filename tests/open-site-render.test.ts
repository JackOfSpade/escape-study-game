import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Box3, type Object3D } from "three";
import { CONFIG, HELIPAD, type Game, type Roadmap } from "../src/model";
import {
  buildInteriorLighting,
  litFixtureColor,
} from "../src/interior-lighting";
import { extractionPad } from "../src/render";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { resolveGroundFeatures } from "../src/venue";
import { BuildingShell, OPEN_FENCE_HEIGHT } from "../src/view3d/building";
import { structureGame } from "../src/world";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;

/** The open market fixture: one ground plan, no building above it. */
function openMarket(): Game {
  return structureGame(
    42,
    roadmap,
    undefined,
    parseRunStructure(
      JSON.parse(
        readFileSync(
          "tests/fixtures/run-designs/open-market-structure.json",
          "utf8",
        ),
      ),
    ),
  );
}

/** The enclosed control: everything radio-broadcast says except the physical
 * city inventory, which a structural proposal does not carry. */
function radioBroadcast(): Game {
  const { environment: _environment, ...structure } = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
    ),
  ) as any;
  return structureGame(42, roadmap, undefined, parseRunStructure(structure));
}

/** Every mesh name and material identity in a built shell, plus its height. */
function shellInventory(shell: BuildingShell) {
  shell.group.updateMatrixWorld(true);
  const meshes: string[] = [],
    materials = new Set<unknown>();
  shell.group.traverse((object: Object3D) => {
    if (!(object as any).isMesh) return;
    meshes.push(object.name);
    const material = (object as any).material;
    for (const entry of Array.isArray(material) ? material : [material])
      materials.add(entry);
  });
  const bounds = new Box3().setFromObject(shell.group);
  return { meshes, materials: materials.size, top: bounds.max.y };
}

test("an open market's shell is a low fence with no glass and no storeys", () => {
  const game = openMarket(),
    shell = new BuildingShell();
  shell.build(game.floors, game.extraction);
  const inventory = shellInventory(shell);
  assert.equal(shell.group.userData.openSite, true);
  assert.ok(
    !inventory.meshes.some((name) => /glaz|window|facade|roof/i.test(name)),
    `the open shell draws no windows, facade or roof (got ${inventory.meshes})`,
  );
  const rails = shell.group.getObjectByName("open-site-fence-rails"),
    posts = shell.group.getObjectByName("open-site-fence-posts");
  assert.ok(rails && posts, "the ground perimeter is drawn as rails and posts");
  for (const part of [rails!, posts!]) {
    const top = new Box3().setFromObject(part).max.y;
    assert.ok(
      top <= OPEN_FENCE_HEIGHT + 0.01,
      `fence part ${part.name} tops out at fence height (got ${top})`,
    );
  }
  assert.ok(
    inventory.top <= OPEN_FENCE_HEIGHT + 0.3,
    `nothing in an open shell rises above the fence (got ${inventory.top})`,
  );
  shell.dispose();
});

test("an enclosed building still draws its glazing and full-height shell", () => {
  const game = radioBroadcast(),
    shell = new BuildingShell();
  shell.build(game.floors);
  const inventory = shellInventory(shell);
  assert.equal(shell.group.userData.openSite, undefined);
  assert.ok(
    inventory.meshes.includes("facade-glazing"),
    "the enclosed control keeps its window glass",
  );
  assert.ok(
    inventory.top > CONFIG.floors * 2,
    `the enclosed shell keeps its storeys (got ${inventory.top})`,
  );
  assert.ok(
    inventory.meshes.filter((name) => name === "facade-structure").length === 1,
    "the enclosed control keeps one multi-storey structure mesh",
  );
  shell.dispose();
});

test("an open floor's lamps are zone-edge lamp posts in the design's lit colour", () => {
  const game = openMarket(),
    floor = game.floors[0],
    plan = buildInteriorLighting(floor, game.seed);
  assert.ok(plan.fixtures.length > 0, "an open floor is lit by lamp posts");
  const lit = litFixtureColor(floor);
  for (const fixture of plan.fixtures) {
    assert.match(fixture.id, /^lamp-post-/);
    assert.equal(fixture.color, lit);
    // A lamp post stands on the open ground beside a zone edge, never on a
    // wall or in the middle of a room.
    assert.equal(
      floor.tiles[Math.floor(fixture.y)][Math.floor(fixture.x)],
      0,
      `lamp post ${fixture.id} stands on walkable ground`,
    );
  }
  const ceiling = buildInteriorLighting(radioBroadcast().floors[0], game.seed);
  assert.ok(
    ceiling.fixtures.every((fixture) => /^ceiling-/.test(fixture.id)),
    "an enclosed floor still hangs its fixtures from the ceiling",
  );
});

test("the 2D pad follows an open site's extraction and stays on the roof otherwise", () => {
  const open = openMarket(),
    pad = open.extraction!;
  assert.deepEqual(extractionPad(open, 0), {
    x: pad.x,
    y: pad.y,
    radius: pad.radius,
    rooftop: false,
  });
  assert.equal(extractionPad(open, CONFIG.floors), undefined);
  const enclosed = radioBroadcast();
  assert.deepEqual(extractionPad(enclosed, CONFIG.floors), {
    x: HELIPAD.x,
    y: HELIPAD.y,
    radius: 3.8,
    rooftop: true,
  });
  assert.equal(extractionPad(enclosed, 0), undefined);
  assert.equal(extractionPad(enclosed, CONFIG.floors - 1), undefined);
});

test("an open site's roof features stand on free ground, clear of the pad", () => {
  const game = openMarket(),
    floor = game.floors[0],
    pad = game.extraction!,
    features = [
      { kind: "beacon", x: 0.1, y: 0.1 },
      { kind: "billboard", x: 0.9, y: 0.9 },
    ],
    spots = resolveGroundFeatures(floor, features, [
      { x: pad.x, y: pad.y, radius: pad.radius + 1.6 },
    ]);
  assert.equal(spots.length, features.length);
  for (const spot of spots) {
    assert.ok(spot, "a ground feature finds a free perimeter cell");
    assert.equal(
      floor.tiles[Math.floor(spot!.y)][Math.floor(spot!.x)],
      0,
      "a ground feature stands on walkable ground",
    );
    assert.ok(
      Math.hypot(spot!.x - pad.x, spot!.y - pad.y) > pad.radius,
      "no ground feature stands on the extraction pad",
    );
    for (const fixed of floor.furniture)
      assert.ok(
        Math.hypot(fixed.x - spot!.x, fixed.y - spot!.y) > 1,
        "no ground feature stands on a fixture",
      );
  }
});

test("an enclosed shell's mesh and material counts are unchanged", () => {
  const game = radioBroadcast(),
    shell = new BuildingShell();
  shell.build(game.floors);
  const inventory = shellInventory(shell);
  // Recorded from the enclosed fixture; the open-site branch must not touch
  // this path, so any drift here is a regression in the enclosed render.
  assert.deepEqual(
    { meshes: inventory.meshes.length, materials: inventory.materials },
    { meshes: 6, materials: 6 },
  );
  shell.dispose();
});
