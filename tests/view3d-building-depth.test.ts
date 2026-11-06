import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Box3, Raycaster, Vector3 } from "three";
import { CONFIG } from "../src/model";
import type { Roadmap } from "../src/model";
import {
  exteriorStructure,
  stairAccessPortals,
  slabTop,
} from "../src/exterior-structure";
import { buildStairRoute, FLOOR_HEIGHT } from "../src/stair-route";
import { BuildingShell, perimeterWindows } from "../src/view3d/building";
import type { RunSetting } from "../src/setting-catalog.mjs";
import { StairGallery } from "../src/view3d/stair-gallery";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

test("structural floor plates stay below the visible finish on every storey", () => {
  const game = createPlayableGame(42, roadmap),
    shell = new BuildingShell();
  shell.build(game.floors);
  shell.group.updateMatrixWorld(true);
  const structure = shell.group.getObjectByName("facade-structure")!;
  for (const floor of game.floors) {
    const height = floor.index * FLOOR_HEIGHT;
    const hits = new Raycaster(
      new Vector3(22.317, height + 0.2, 15.453),
      new Vector3(0, -1, 0),
      0,
      0.5,
    ).intersectObject(structure, false);
    assert.ok(hits.length > 0, `floor ${floor.index} has its structural slab`);
    assert.ok(
      hits[0].point.y < height - 0.075,
      "the slab cannot hide or depth-fight the textured finish at -0.025m",
    );
  }
  shell.dispose();
});

test("each gallery landing and adjoining walkway has one visible top surface", () => {
  const game = createPlayableGame(42, roadmap),
    gallery = new StairGallery();
  // The production geometry is independent of sign textures. Suppress only
  // canvas labels so this actual geometry regression runs without a browser.
  (gallery as any).sign = () => {};
  gallery.build(game);
  gallery.group.updateMatrixWorld(true);
  const decks = gallery.group.getObjectByName("stair-decks-and-treads")!;
  const supports = gallery.group.getObjectByName("stair-support-columns")!;
  assert.ok(supports, "elevated galleries retain structural supports");
  const supportBounds = new Box3().setFromObject(supports);
  for (let level = 0; level < game.floors.length - 1; level++) {
    const route = buildStairRoute(game, {
      fromFloor: level,
      toFloor: level + 1,
      origin: game.floors[level].stairs,
      destination: game.floors[level + 1].entry,
      until: 0,
    });
    assert.ok(
      supportBounds.min.x > route.points[2].x + 0.85,
      "support columns stay outside the complete walking width instead of rising through landings",
    );
    for (let i = 1; i < route.points.length - 1; i++) {
      const a = route.points[i - 1],
        corner = route.points[i],
        b = route.points[i + 1];
      const cross =
        (corner.x - a.x) * (b.z - corner.z) -
        (corner.z - a.z) * (b.x - corner.x);
      if (Math.abs(cross) < 0.01) continue;
      const target = new Vector3(
        corner.x - 0.453,
        corner.y + 0.4,
        corner.z - 0.317,
      );
      const hits = new Raycaster(target, new Vector3(0, -1, 0), 0, 0.6)
        .intersectObject(decks, false)
        .filter((hit) => hit.face!.normal.y > 0.9);
      assert.ok(
        hits.length > 0,
        `floor ${level} turn ${i} has a supported landing`,
      );
      const top = hits[0].point.y;
      assert.equal(
        hits.filter((hit) => Math.abs(hit.point.y - top) < 0.0001).length,
        1,
        `floor ${level} turn ${i} cannot have coplanar decks competing at the corner`,
      );
      const centerHits = new Raycaster(
        new Vector3(corner.x + 0.033, corner.y + 0.4, corner.z + 0.077),
        new Vector3(0, -1, 0),
        0,
        0.6,
      )
        .intersectObjects([decks, supports], false)
        .filter((hit) => hit.face!.normal.y > 0.9);
      assert.ok(centerHits.length > 0);
      assert.equal(
        centerHits.filter((hit) => Math.abs(hit.point.y - corner.y) < 0.0001)
          .length,
        1,
        "the old support-column centre has exactly one landing top, without an exposed or coplanar post cap",
      );
    }
  }
  gallery.dispose();
});

test("rendered treads, intact guards and storm gaps match the shared collision structure", () => {
  const game = createPlayableGame(42, roadmap),
    gallery = new StairGallery();
  (gallery as any).sign = () => {};
  gallery.build(game);
  gallery.group.updateMatrixWorld(true);
  const structure = exteriorStructure(game),
    decks = gallery.group.getObjectByName("stair-decks-and-treads")!,
    guards = gallery.group.getObjectByName("stair-glass-guards")!,
    rails = gallery.group.getObjectByName("stair-handrails")!;
  for (const slab of structure.slabs) {
    for (let i = 0; i < slab.steps; i++) {
      const along =
          -slab.halfLength + (slab.halfLength * 2 * (i + 0.5)) / slab.steps,
        p = { x: slab.x + slab.ux * along, y: slab.y + slab.uy * along },
        top = slabTop(slab, p),
        hit = new Raycaster(
          new Vector3(p.x, top + 0.1, p.y),
          new Vector3(0, -1, 0),
          0,
          0.15,
        ).intersectObject(decks, false)[0];
      assert.ok(hit, "every physical tread has a visible walking surface");
      assert.ok(Math.abs(hit.point.y - top) < 1e-5);
    }
  }
  for (const bay of structure.guards) {
    const run = Math.hypot(bay.x2 - bay.x1, bay.y2 - bay.y1),
      nx = -(bay.y2 - bay.y1) / run,
      nz = (bay.x2 - bay.x1) / run,
      x = (bay.x1 + bay.x2) / 2,
      z = (bay.y1 + bay.y2) / 2,
      base = (bay.base1 + bay.base2) / 2;
    for (const height of [0.52, 1.14]) {
      const hits = new Raycaster(
        new Vector3(x + nx * 0.2, base + height, z + nz * 0.2),
        new Vector3(-nx, 0, -nz),
        0,
        0.4,
      ).intersectObjects([guards, rails], false);
      assert.equal(
        hits.length > 0,
        !bay.broken,
        `level ${bay.level} ${bay.broken ? "damaged" : "intact"} guard at height ${height}`,
      );
    }
    if (bay.broken) {
      const hits = new Raycaster(
        new Vector3(bay.x1 + nx * 0.2, bay.base1 + 0.6, bay.y1 + nz * 0.2),
        new Vector3(-nx, 0, -nz),
        0,
        0.4,
      ).intersectObject(rails, false);
      assert.ok(
        hits.length,
        "the damaged guard keeps its visible supporting posts",
      );
    }
  }
  assert.equal(
    structure.guards.filter((b) => b.broken).length,
    game.floors.length - 1,
  );
  gallery.dispose();
});

test("stair access fields visibly cover the shared one-way portal and follow personal permission", () => {
  const game = createPlayableGame(42, roadmap),
    gallery = new StairGallery(),
    actor = game.survivors[0];
  (gallery as any).sign = () => {};
  actor.access = [];
  gallery.build(game);
  for (const portal of stairAccessPortals(game)) {
    const field = gallery.group.getObjectByName(
      `stair-access-field-${portal.kind}-${portal.floor}`,
    )!;
    assert.ok(field.visible, "locked portals must show a real visible field");
    assert.equal(field.position.x, portal.x);
    assert.equal(field.position.y, portal.base + portal.height / 2);
    assert.equal(field.position.z, portal.y);
    assert.equal(field.userData.direction, portal.direction);
    assert.equal(field.rotation.y, portal.axis === "x" ? Math.PI / 2 : 0);
  }
  const side = gallery.group.getObjectByName(
      "stair-access-field-city-base-side-0",
    )!,
    front = gallery.group.getObjectByName("stair-access-field-city-base-0")!;
  assert.ok(
    side.visible,
    "the public-court side opening also shows its access barrier",
  );
  const sideBounds = new Box3().setFromObject(side);
  assert.ok(Math.abs(sideBounds.min.x - (front.position.x - 0.86)) < 1e-6);
  assert.ok(Math.abs(sideBounds.min.z - front.position.z) < 1e-6);
  assert.ok(Math.abs(sideBounds.max.z - (front.position.z + 0.96)) < 1e-6);
  assert.equal(
    side.userData.direction,
    1,
    "only entering eastward is locked; descending westward remains open",
  );
  actor.access = [0];
  gallery.update(game);
  assert.equal(
    gallery.group.getObjectByName("stair-access-field-well-0")!.visible,
    false,
  );
  assert.equal(
    gallery.group.getObjectByName("stair-access-field-city-base-0")!.visible,
    false,
  );
  assert.equal(side.visible, false);
  assert.equal(
    gallery.group.getObjectByName("stair-access-field-well-1")!.visible,
    true,
  );
  gallery.dispose();
});

function designed(
  facade: RunSetting["exterior"]["facade"],
  windows: RunSetting["exterior"]["windows"],
  roofFeatures: RunSetting["exterior"]["roofFeatures"] = [],
): RunSetting {
  return {
    venue: "broadcast",
    interior: {
      roomFloor: "studioCarpet",
      hallFloor: "terrazzo",
      roomTint: "#6d7aa0",
      hallTint: "#b9a98a",
      wall: "#3b4350",
      trim: "#c9a24a",
    },
    exterior: {
      facade,
      facadeColor: "#8a4b3a",
      trimColor: "#d8d0b8",
      windows,
      canopy: "marquee",
      canopyGlow: "#ff4a3a",
      roofFeatures,
    },
    terminal: {
      style: "desk",
      body: "#6b5036",
      accent: "#2a2a2a",
      screen: "#40e0d0",
    },
    objects: [],
    filler: null,
  };
}

function shellOf(setting?: RunSetting) {
  const game = createPlayableGame(42, roadmap),
    shell = new BuildingShell();
  for (const floor of game.floors) floor.setting = setting;
  shell.build(game.floors);
  return { game, shell };
}

const vertices = (shell: BuildingShell, name: string) =>
  (shell.group.getObjectByName(name) as any)?.geometry.getAttribute("position")
    .count as number | undefined;

test("an undesigned shell is the original three meshes with no roof dressing", () => {
  const { shell } = shellOf();
  assert.deepEqual(
    shell.group.children.map((c) => c.name),
    ["facade-structure", "facade-window-frames", "facade-glazing"],
  );
  assert.deepEqual(shell.group.userData, {});
  shell.dispose();
});

test("each facade finish restyles the shell without changing which walls open", () => {
  const baseline = shellOf();
  const windows = vertices(baseline.shell, "facade-glazing");
  for (const facade of [
    "concrete",
    "brick",
    "glass",
    "stucco",
    "metal",
    "clapboard",
  ] as const)
    for (const style of ["punched", "strip", "ribbon", "slit"] as const) {
      const { shell } = shellOf(designed(facade, style));
      assert.equal(
        vertices(shell, "facade-glazing"),
        windows,
        `${facade}/${style} keeps exactly the same window openings`,
      );
      assert.equal(shell.group.userData.facade, facade);
      assert.ok(
        vertices(shell, "facade-structure")! >=
          vertices(baseline.shell, "facade-structure")!,
      );
      shell.dispose();
    }
  const brick = shellOf(designed("brick", "punched")).shell;
  assert.ok(
    vertices(brick, "facade-structure")! >
      vertices(baseline.shell, "facade-structure")! * 3,
    "brick is laid in courses rather than one block per wall",
  );
  brick.dispose();
  const game = baseline.game;
  assert.ok(game.floors.some((f) => perimeterWindows(f).length > 0));
  baseline.shell.dispose();
});

test("broadcast roof features stand on the roof edge as visual-only meshes", () => {
  const setting = designed("brick", "ribbon", [
    { kind: "mast", x: 0.1, y: 0.1 },
    { kind: "dish", x: 0.9, y: 0.1 },
    { kind: "beacon", x: 0.5, y: 0.05 },
    { kind: "watertank", x: 0.1, y: 0.9 },
    { kind: "chimney", x: 0.9, y: 0.9 },
    { kind: "solar", x: 0.5, y: 0.95 },
  ]);
  const { game, shell } = shellOf(setting),
    roof = game.floors[CONFIG.floors],
    base = CONFIG.floors * FLOOR_HEIGHT;
  const kinds = shell.group.userData.roofFeatures as string[];
  assert.equal(kinds.length, 6, "every authored roof feature is placed");
  const structure = shell.group.getObjectByName("roof-feature-structure")!,
    lamps = shell.group.getObjectByName("roof-feature-lamps")!;
  assert.ok(structure && lamps);
  const bounds = new Box3().setFromObject(structure);
  assert.ok(bounds.min.y >= base - 0.05, "nothing sinks below the roof");
  assert.ok(bounds.max.y > base + 8, "a lattice mast rises several metres");
  const rows = roof.boundary!.rows,
    minX = Math.min(...rows.map((r) => r.left)),
    maxX = Math.max(...rows.map((r) => r.right));
  assert.ok(bounds.min.x > minX - 1.5 && bounds.max.x < maxX + 1.5);
  assert.ok(
    bounds.min.z > roof.boundary!.top - 1.5 &&
      bounds.max.z < roof.boundary!.bottom + 1.5,
  );
  assert.ok(new Box3().setFromObject(lamps).max.y > base + 9, "aviation light");
  const before = JSON.stringify(game.floors.map((f) => f.tiles));
  shell.build(game.floors);
  assert.equal(JSON.stringify(game.floors.map((f) => f.tiles)), before);
  shell.dispose();
});

test("every roof feature kind builds geometry", () => {
  for (const kind of [
    "mast",
    "dish",
    "beacon",
    "watertank",
    "chimney",
    "solar",
    "vent",
    "billboard",
  ] as const) {
    const { shell } = shellOf(
      designed("stucco", "slit", [{ kind, x: 0.3, y: 0.1 }]),
    );
    assert.deepEqual(shell.group.userData.roofFeatures, [kind]);
    assert.ok(vertices(shell, "roof-feature-structure"), kind);
    shell.dispose();
  }
});

test("a roof feature may be a composed object drawn from its parts", () => {
  const object: RunSetting["objects"][number] = {
    id: "lantern-room",
    name: "Lantern room",
    role: "light",
    weight: "heavy",
    size: { w: 1.4, d: 1.4, h: 3 },
    surface: false,
    parts: [
      {
        shape: "cylinder",
        axis: "up",
        x: 0,
        y: 0,
        z: 0,
        w: 1.2,
        d: 1.2,
        h: 2,
        color: "#f2efe6",
        finish: "matte",
      },
      {
        shape: "cone",
        axis: "up",
        x: 0,
        y: 0,
        z: 2.4,
        w: 1.4,
        d: 1.4,
        h: 0.6,
        color: "#8a2f2a",
        finish: "metal",
      },
      {
        shape: "torus",
        axis: "up",
        x: 0,
        y: 0,
        z: 2,
        w: 1.4,
        d: 1.4,
        h: 0.1,
        color: "#2b2b2b",
        finish: "metal",
      },
      {
        shape: "sphere",
        axis: "up",
        x: 0,
        y: 0,
        z: 2,
        w: 0.4,
        d: 0.4,
        h: 0.4,
        color: "#fff2a0",
        finish: "glow",
      },
    ],
  };
  const setting = {
    ...designed("stucco", "slit", [
      { kind: "lantern-room", x: 0.3, y: 0.1 },
      { kind: "mast", x: 0.9, y: 0.1 },
    ]),
    objects: [object],
  };
  const { game, shell } = shellOf(setting),
    base = CONFIG.floors * FLOOR_HEIGHT;
  assert.deepEqual(shell.group.userData.roofFeatures, ["lantern-room", "mast"]);
  const lamps = shell.group.getObjectByName("roof-feature-lamps")!;
  assert.ok(
    new Box3().setFromObject(lamps).max.y > base + 2,
    "the glow part is a lamp",
  );
  // An id with no object draws nothing but does not break the shell.
  const missing = shellOf(
    designed("stucco", "slit", [{ kind: "ghost-statue", x: 0.3, y: 0.1 }]),
  );
  assert.equal(vertices(missing.shell, "roof-feature-structure"), undefined);
  missing.shell.dispose();
  const before = JSON.stringify(game.floors.map((f) => f.tiles));
  shell.build(game.floors);
  assert.equal(JSON.stringify(game.floors.map((f) => f.tiles)), before);
  shell.dispose();
});
