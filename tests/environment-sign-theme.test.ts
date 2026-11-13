import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  type MeshStandardMaterial,
} from "three";
import type {
  EnvironmentManifest,
  SurfaceRole,
  SurfaceSlot,
} from "../src/environment-contract.mjs";
import { environmentSurfaceFingerprint } from "../src/environment-contract.mjs";
import type { Floor, Roadmap } from "../src/model";
import type {
  RunNeighborStyle,
  RunSetting,
  RunSurroundings,
} from "../src/setting-catalog.mjs";
import { ExteriorDressing } from "../src/view3d/exterior";
import {
  ENVIRONMENT_ATLAS_ANISOTROPY,
  EnvironmentSurfaces,
} from "../src/view3d/environment-surfaces";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const radio = () =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  ).setting as RunSetting;

/** A saved exterior inventory shaped like the real city one. */
function slot(
  id: string,
  role: SurfaceRole,
  width: number,
  height: number,
): SurfaceSlot {
  return {
    id,
    floor: 0,
    scope: "exterior",
    role,
    room: null,
    owner: null,
    context: "A synthetic test surface.",
    maxTitle: 48,
    maxBody: 240,
    allowsArt: true,
    binding: {
      kind: "fixed",
      x: 10,
      y: 0,
      z: 3.2,
      width,
      height,
      yaw: 0,
      pitch: 0,
    },
  };
}
const surfaces = [
  slot("city:shop", "storefront-sign", 3.05, 0.6),
  slot("city:street", "street-sign", 2.5, 0.38),
  slot("building:entrance-sign", "building-sign", 3.55, 0.74),
];
function manifest(collection: SurfaceSlot[] = surfaces): EnvironmentManifest {
  return {
    version: 1,
    surfaceFingerprint: environmentSurfaceFingerprint(collection),
    surfaces: collection,
    fragments: [],
    entries: collection.map((s) => ({
      surfaceId: s.id,
      layout: "text",
      title: [{ text: `Written for ${s.id}` }],
      body: [],
      description: "",
      drawing: null,
    })),
  };
}
const shop = (s: SurfaceSlot) =>
  s.role !== "storefront-sign" && s.role !== "street-sign";

function instanced(surfaces: EnvironmentSurfaces) {
  const meshes = surfaces.group.children.filter(
    (child) => child instanceof InstancedMesh,
  ) as InstancedMesh[];
  return {
    meshes: meshes.length,
    count: meshes.reduce((n, mesh) => n + mesh.count, 0),
    ids: meshes.flatMap((mesh) => mesh.userData.surfaceIds as string[]).sort(),
  };
}

const floor0 = () => createPlayableGame(42, roadmap).floors[0];

/** A recording 2D context: enough canvas for the painters, no browser needed. */
function withCanvas<T>(work: () => T): T {
  const noop = () => undefined,
    context: object = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "measureText"
            ? () => ({ width: 8 })
            : key === "createRadialGradient" || key === "createLinearGradient"
              ? () => ({ addColorStop: noop })
              : noop,
        set: () => true,
      },
    ),
    globals = globalThis as any,
    previous = globals.document;
  globals.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => context,
    }),
  };
  try {
    return work();
  } finally {
    if (previous === undefined) delete globals.document;
    else globals.document = previous;
  }
}

test("a slot filter drops filtered roles before any atlas page or instance", () => {
  const floor = floor0(),
    all = new EnvironmentSurfaces(floor, manifest(), "exterior"),
    filtered = new EnvironmentSurfaces(
      floor,
      manifest(),
      "exterior",
      undefined,
      shop,
    );
  assert.deepEqual(instanced(all).ids, [
    "building:entrance-sign",
    "city:shop",
    "city:street",
  ]);
  assert.equal(instanced(all).count, 3, "no filter keeps every saved slot");
  assert.equal(instanced(all).meshes, 1, "wide signs share one atlas page");
  assert.deepEqual(instanced(filtered).ids, ["building:entrance-sign"]);
  assert.equal(instanced(filtered).count, 1, "the shop signs cost no instance");
  assert.equal(
    filtered.group.userData.surfaces,
    1,
    "hidden slots are not counted as surfaces",
  );
  assert.equal(all.group.userData.surfaces, 3);
  assert.ok(
    filtered.group.userData.texturePixels < all.group.userData.texturePixels,
    "hidden slots take no atlas space",
  );
  // A binding that is present only for the slot that survived still follows
  // its host, and filtered-out slots are simply absent rather than hidden.
  assert.deepEqual(
    filtered.group.children.map((child) => child.name),
    ["environment-atlas-page-0"],
  );
  all.dispose();
  filtered.dispose();
});

test("atlas textures keep power-of-two edges and minify through mipmaps", () =>
  withCanvas(() => {
    const drawing = new EnvironmentSurfaces(
        floor0(),
        manifest([surfaces[2]]),
        "exterior",
      ),
      mesh = drawing.group.children[0] as InstancedMesh,
      map = (mesh.material as MeshStandardMaterial).map!;
    assert.ok(map, "the atlas page carries a texture");
    assert.equal(map.generateMipmaps, true);
    assert.equal(map.minFilter, LinearMipmapLinearFilter);
    assert.equal(map.magFilter, LinearFilter);
    assert.equal(map.anisotropy, ENVIRONMENT_ATLAS_ANISOTROPY);
    assert.ok(ENVIRONMENT_ATLAS_ANISOTROPY > 1);
    const image = map.image as { width: number; height: number };
    for (const edge of [image.width, image.height])
      assert.equal(edge & (edge - 1), 0, `${edge} is a power of two`);
    drawing.dispose();
  }));

/** A real city floor whose saved exterior signs meet a designed neighbour look. */
function designed(neighbors: RunNeighborStyle): Floor {
  const game = createPlayableGame(7, roadmap),
    floor = game.floors[0],
    setting = structuredClone(radio());
  setting.surroundings = {
    ...setting.surroundings,
    neighbors,
    scenery: [],
    weather: "none",
  } as RunSurroundings;
  floor.setting = setting;
  floor.environment = manifest();
  return floor;
}

function exteriorSigns(neighbors: RunNeighborStyle) {
  const floor = designed(neighbors),
    dressing = new ExteriorDressing();
  withCanvas(() => dressing.build(floor, [floor]));
  const group = dressing.group.getObjectByName(
    `environment-surfaces-exterior-${floor.index}`,
  );
  assert.ok(group, `${neighbors}: the exterior builds its surfaces`);
  const seen = {
    ids: [...(group.userData.surfaceIds as string[])].sort(),
    count: group.children
      .filter((child) => child instanceof InstancedMesh)
      .reduce((n, child) => n + (child as InstancedMesh).count, 0),
  };
  dressing.dispose();
  return seen;
}

test("themed neighbour lots keep the building's own signs and drop shop signs", () => {
  const rocks = exteriorSigns("rocks");
  assert.deepEqual(rocks.ids, ["building:entrance-sign"]);
  assert.equal(rocks.count, 1, "no shop or street sign is instanced over rock");
  const buildings = exteriorSigns("buildings");
  assert.deepEqual(buildings.ids, [
    "building:entrance-sign",
    "city:shop",
    "city:street",
  ]);
  assert.equal(buildings.count, 3, "untouched building lots keep every sign");
});
