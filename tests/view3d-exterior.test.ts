import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBuildingFootprint,
  footprintTiles,
} from "../src/building-layout";
import type { Floor } from "../src/model";
import type { RunSetting } from "../src/setting-catalog.mjs";
import {
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  Raycaster,
  Vector3,
} from "three";
import { ExteriorDressing } from "../src/view3d/exterior";
import {
  cityGroundRectangles,
  cityLayout,
  clearStreetEdge,
  exteriorWallTiles,
  outsideBuilding,
  streetLayout,
} from "../src/view3d/exterior-layout";

function street(seed = 1): Floor {
  const boundary = createBuildingFootprint(seed),
    tiles = footprintTiles(boundary);
  for (let y = boundary.bottom; y < tiles.length; y++)
    for (let x = 18; x < 26; x++)
      if (y > boundary.bottom || (x >= 20 && x < 24)) tiles[y][x] = 0;
  return {
    boundary,
    tiles,
    index: 0,
    stations: [],
    furniture: [],
    dark: 0.1,
    name: "Synthetic street",
    doors: [],
    entry: { x: 22, y: 29 },
    stairs: { x: 22, y: 1 },
  };
}

test("street decoration requires a ground floor footprint and an open entrance approach", () => {
  const floor = street();
  assert.ok(streetLayout(floor));
  floor.index = 1;
  assert.equal(streetLayout(floor), undefined);
  floor.index = 0;
  const boundary = floor.boundary!;
  floor.tiles[boundary.bottom][22] = 1;
  assert.equal(streetLayout(floor), undefined);
  floor.tiles[boundary.bottom][22] = 0;
  floor.tiles[boundary.bottom + 1].fill(1);
  assert.equal(
    streetLayout(floor),
    undefined,
    "a footprint without an open street receives no dressing",
  );
  assert.notEqual(
    exteriorWallTiles(floor),
    floor.tiles,
    "closed entrances still use the exterior shell on upper floors",
  );
  delete floor.boundary;
  assert.equal(streetLayout(floor), undefined);
  assert.equal(outsideBuilding(floor, 20, 30), false);
  assert.equal(
    exteriorWallTiles(floor),
    floor.tiles,
    "legacy and arenas retain their original wall geometry",
  );
});

test("parked cars, lamps, cones and debris occupy only blocked exterior tiles, keeping every walkable tile clear", () => {
  for (let seed = 1; seed <= 128; seed++) {
    const floor = street(seed),
      before = JSON.stringify(floor),
      layout = streetLayout(floor)!;
    assert.equal(layout.props.filter((p) => p.kind === "car").length, 2);
    assert.equal(
      layout.props.filter((p) => p.kind === "streetlight").length,
      2,
    );
    assert.equal(layout.props.filter((p) => p.kind === "cone").length, 2);
    for (const p of layout.props) {
      assert.ok(clearStreetEdge(floor, p), `seed ${seed}, ${p.kind}`);
      for (let y = Math.floor(p.y - p.h / 2); y < p.y + p.h / 2; y++)
        for (let x = Math.floor(p.x - p.w / 2); x < p.x + p.w / 2; x++) {
          assert.notEqual(floor.tiles[y][x], undefined);
          assert.notEqual(
            floor.tiles[y][x],
            0,
            "no decorative prop footprint overlaps walkable simulation space",
          );
          assert.ok(outsideBuilding(floor, x + 0.5, y + 0.5));
          assert.ok(
            x < 18 || x >= 26,
            "the complete walkable arrival lane, including its outer columns, stays empty",
          );
        }
    }
    assert.equal(
      JSON.stringify(floor),
      before,
      "dressing does not edit simulation tiles or RNG",
    );
  }
});

test("edge clearance validates the entire footprint and rejects central routes, portals and walkable cells", () => {
  const floor = street(),
    car = streetLayout(floor)!.props.find((p) => p.kind === "car")!;
  assert.ok(clearStreetEdge(floor, car));
  assert.equal(clearStreetEdge(floor, { ...car, x: 22 }), false);
  assert.equal(
    clearStreetEdge(floor, { ...car, w: 1.2 }),
    false,
    "overhanging into the next tile is rejected",
  );
  assert.equal(
    clearStreetEdge(floor, { ...car, y: 29 }),
    false,
    "no prop can overlap the portal row",
  );
  floor.tiles[32][17] = 0;
  assert.equal(
    clearStreetEdge(floor, car),
    false,
    "a walkable far end rejects an otherwise blocked footprint",
  );
  for (const value of [NaN, Infinity, -Infinity])
    assert.equal(clearStreetEdge(floor, { ...car, h: value }), false);
});

test("exterior wall geometry retains the solid shell, openings and all interior walls while removing distant black blocks", () => {
  const floor = street(),
    b = floor.boundary!,
    before = JSON.stringify(floor.tiles);
  floor.tiles[b.top + 5][22] = 1;
  const tiles = exteriorWallTiles(floor);
  assert.notEqual(tiles, floor.tiles);
  assert.equal(tiles[b.top + 5][22], 1);
  assert.equal(tiles[b.bottom][10], 1, "one-cell exterior shell remains solid");
  assert.equal(tiles[b.bottom][22], 0, "entrance remains open");
  assert.equal(
    tiles[b.bottom + 3][10],
    0,
    "distant simulation blockers are dressed as a street edge instead of tall masses",
  );
  floor.tiles[b.top + 5][22] = JSON.parse(before)[b.top + 5][22];
  assert.equal(JSON.stringify(floor.tiles), before);
});

test("street dressing closes the actual south map edge across the arrival lane", () => {
  // Build the real merged geometry without requiring a browser canvas texture.
  const dressing = Object.assign(Object.create(ExteriorDressing.prototype), {
    world: new Group(),
    group: new Group(),
    tint: new Color(),
    asphalt: new MeshStandardMaterial(),
    solid: new MeshStandardMaterial(),
    glass: new MeshStandardMaterial(),
    warm: new MeshStandardMaterial(),
    canopyMaterial: new MeshStandardMaterial(),
    emergency: new MeshStandardMaterial(),
    signMaterial: new MeshStandardMaterial(),
    entranceLight: new PointLight(),
    streetLight: new PointLight(),
  }) as ExteriorDressing;
  const floor = street();
  dressing.build(floor);
  const world = (dressing as any).world as Group,
    props = world.getObjectByName(
      "merged-street-facade-props",
    ) as Mesh<BufferGeometry>;
  assert.ok(props);
  props.updateMatrixWorld(true);
  // Every lane column hits a crosswise rail where simulation collision ends.
  for (let x = 18.5; x < 26; x++) {
    const ray = new Raycaster(
        new Vector3(x, 0.68, floor.tiles.length - 1),
        new Vector3(0, 0, 1),
      ),
      hit = ray.intersectObject(props)[0];
    assert.ok(hit, `south rail at x=${x}`);
    assert.ok(Math.abs(hit.point.z - floor.tiles.length) < 0.06);
  }
  for (const child of world.children)
    (child as Mesh<BufferGeometry>).geometry.dispose();
});

test("the same city surrounds every floor without consuming simulation state", () => {
  for (let seed = 1; seed <= 32; seed++) {
    const floor = street(seed),
      before = JSON.stringify(floor),
      city = cityLayout(floor)!;
    assert.equal(city.blocks.filter((b) => !b.distant).length, 14);
    assert.equal(city.blocks.filter((b) => b.distant).length, 24);
    for (const block of city.blocks) {
      assert.ok(block.stories >= 3);
      assert.ok(
        block.x + block.w / 2 < 0 ||
          block.x - block.w / 2 > 44 ||
          block.y + block.d / 2 < 0 ||
          block.y - block.d / 2 > floor.tiles.length,
        "every raised city block is outside the playable physics grid",
      );
    }
    for (const index of [1, 2, 4])
      assert.deepEqual(
        cityLayout({ ...floor, index }),
        city,
        "upper windows and the roof look onto the same city",
      );
    assert.equal(JSON.stringify(floor), before);
  }
});

function syntheticDressing() {
  return Object.assign(Object.create(ExteriorDressing.prototype), {
    world: new Group(),
    group: new Group(),
    tint: new Color(),
    asphalt: new MeshStandardMaterial(),
    solid: new MeshStandardMaterial(),
    glass: new MeshStandardMaterial(),
    warm: new MeshStandardMaterial(),
    emergency: new MeshStandardMaterial(),
    signMaterial: new MeshStandardMaterial(),
    quarantineMaterial: new MeshStandardMaterial(),
    routeMaterial: new MeshStandardMaterial(),
    entranceLight: new PointLight(),
    streetLight: new PointLight(),
  }) as ExteriorDressing;
}

test("city geometry is present on all sides from street to rooftop and has a bounded mesh budget", () => {
  const floor = street(),
    upper = { ...floor, index: 4 },
    dressing = syntheticDressing();
  dressing.build(upper, [floor, upper]);
  assert.ok(dressing.enabled);
  const world = (dressing as any).world as Group;
  assert.ok(world.getObjectByName("continuous-city-ground"));
  assert.ok(world.getObjectByName("evacuation-suspended-sign"));
  assert.ok(world.getObjectByName("rooftop-assembly-sign"));
  assert.ok(
    world.children.length <= 9,
    "blocks and vehicles are merged, not individual scene objects",
  );
  world.updateMatrixWorld(true);
  for (const height of [1.6, 8.8, 16])
    for (const direction of [
      new Vector3(1, 0, 0),
      new Vector3(-1, 0, 0),
      new Vector3(0, 0, 1),
      new Vector3(0, 0, -1),
    ]) {
      const ray = new Raycaster(new Vector3(22, height, 16), direction),
        hits = ray.intersectObjects(world.children, false);
      assert.ok(
        hits.length,
        `city silhouette at height ${height}, heading ${direction.toArray()}`,
      );
      assert.ok(hits[0].distance < 120);
    }
  const before = JSON.stringify(floor);
  dressing.build(upper, [floor, upper]);
  assert.equal(
    JSON.stringify(floor),
    before,
    "rebuilding never edits world tiles",
  );
  assert.ok(
    world.children.length <= 9,
    "rebuilds replace rather than duplicate city meshes",
  );
  (dressing as any).clear();
});

test("upper floors remove distant blocking masses while retaining their physical stair surrounds", () => {
  const floor = street();
  floor.index = 2;
  const b = floor.boundary!;
  for (let y = b.top - 2; y < b.top; y++)
    for (const x of [21, 22]) floor.tiles[y][x] = 0;
  // An upper floor has the carved two-column well, not the ground fixture's
  // eight-column arrival lane. Retain its real side jambs in this regression.
  for (let y = b.bottom; y < floor.tiles.length; y++) floor.tiles[y].fill(1);
  for (let y = b.bottom; y < b.bottom + 2; y++)
    for (const x of [21, 22]) floor.tiles[y][x] = 0;
  const tiles = exteriorWallTiles(floor);
  assert.equal(tiles[b.top - 1][20], 1);
  assert.equal(tiles[b.top - 1][21], 0);
  assert.equal(
    tiles[b.bottom + 1][23],
    1,
    "the descending well retains its jamb",
  );
  assert.equal(
    tiles[b.bottom + 2][23],
    0,
    "the outer jamb cannot block the gallery across the landing",
  );
  if (b.top >= 3)
    assert.equal(
      tiles[b.top - 3][23],
      0,
      "the north gallery also stays clear of extended jambs",
    );
  assert.equal(tiles[b.bottom + 3][10], 0);
  assert.equal(tiles[b.top + 4][b.rows[b.top + 4].left - 1], 1);
});

test("city asphalt owns only exterior ground, with a footprint cutout and no overlapping patches", () => {
  for (let seed = 1; seed <= 32; seed++) {
    const floor = street(seed),
      before = JSON.stringify(floor),
      b = floor.boundary!,
      rectangles = cityGroundRectangles(floor),
      footprintArea = b.rows
        .slice(b.top, b.bottom)
        .reduce((sum, row) => sum + row.right - row.left, 0);
    assert.equal(
      rectangles.reduce((sum, r) => sum + r.w * r.d, 0),
      280 * 280 - footprintArea,
    );
    for (let i = 0; i < rectangles.length; i++)
      for (let j = i + 1; j < rectangles.length; j++) {
        const a = rectangles[i],
          c = rectangles[j],
          w =
            Math.min(a.x + a.w / 2, c.x + c.w / 2) -
            Math.max(a.x - a.w / 2, c.x - c.w / 2),
          d =
            Math.min(a.z + a.d / 2, c.z + c.d / 2) -
            Math.max(a.z - a.d / 2, c.z - c.d / 2);
        assert.ok(
          w <= 1e-7 || d <= 1e-7,
          "ground patches never share a surface",
        );
      }
    for (let z = 0; z < floor.tiles.length; z++)
      for (let x = 0; x < floor.tiles[z].length; x++) {
        const owners = rectangles.filter(
          (r) =>
            x + 0.5 > r.x - r.w / 2 &&
            x + 0.5 < r.x + r.w / 2 &&
            z + 0.5 > r.z - r.d / 2 &&
            z + 0.5 < r.z + r.d / 2,
        );
        assert.equal(
          owners.length,
          outsideBuilding(floor, x + 0.5, z + 0.5) ? 1 : 0,
          "room floors and outside asphalt each have exactly one surface owner",
        );
      }
    assert.equal(JSON.stringify(floor), before);
  }
});

test("sidewalk crossings, ambulance crosses and lamp joints contain only one visible face per plane", () => {
  const floor = street(),
    city = cityLayout(floor)!,
    dressing = syntheticDressing();
  dressing.build(floor);
  const world = (dressing as any).world as Group,
    props = world.getObjectByName("merged-street-facade-props") as Mesh,
    signals = world.getObjectByName("city-emergency-signals") as Mesh,
    westRoad = city.left - 9,
    eastRoad = city.right + 9,
    northRoad = city.north - 8,
    southRoad = city.south + 9;
  assert.equal(
    world.getObjectByName("asphalt-street"),
    undefined,
    "the arrival lane shares city asphalt instead of adding another close ground plane",
  );
  world.updateMatrixWorld(true);
  for (const x of [
    westRoad - 5.6,
    westRoad + 5.6,
    eastRoad - 5.6,
    eastRoad + 5.6,
  ])
    for (const z of [
      northRoad - 5.6,
      northRoad + 5.6,
      southRoad - 5.6,
      southRoad + 5.6,
    ]) {
      const ray = new Raycaster(
          new Vector3(x + 0.19, 10, z + 0.11),
          new Vector3(0, -1, 0),
        ),
        faces = ray
          .intersectObject(props)
          .filter((hit) => Math.abs(hit.point.y - 0.085) < 1e-5);
      assert.equal(faces.length, 1, `one sidewalk top at crossing ${x},${z}`);
    }
  const ax = city.left + 5,
    az = southRoad - 3;
  for (const side of [-1, 1]) {
    const ray = new Raycaster(
        new Vector3(ax + side * 3, 1.36, az + 0.23),
        new Vector3(-side, 0, 0),
      ),
      faces = ray
        .intersectObject(signals)
        .filter((hit) => Math.abs(hit.point.x - (ax + side * 1.0825)) < 1e-5);
    assert.equal(
      faces.length,
      1,
      "ambulance cross arms do not duplicate the centre face",
    );
  }
  const lx = westRoad + 5,
    lz = 16,
    lampRay = new Raycaster(
      new Vector3(lx + 0.03, 5.38, lz + 2),
      new Vector3(0, 0, -1),
    ),
    lampFaces = lampRay
      .intersectObject(props)
      .filter((hit) => Math.abs(hit.point.z - (lz + 0.06)) < 1e-5);
  assert.equal(
    lampFaces.length,
    1,
    "lamp arm starts above the pole instead of duplicating its side face",
  );
  (dressing as any).clear();
});

function broadcastSetting(
  canopy: RunSetting["exterior"]["canopy"],
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
      facade: "brick",
      facadeColor: "#8a4b3a",
      trimColor: "#d8d0b8",
      windows: "ribbon",
      canopy,
      canopyGlow: "#ff4a3a",
      roofFeatures: [],
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
  };
}

test("the entrance canopy follows the setting while the sign slot and the undesigned look stay put", () => {
  const plain = street(),
    names = (setting?: RunSetting) => {
      const dressing = syntheticDressing();
      dressing.build({ ...plain, setting }, [{ ...plain, setting }]);
      const world = (dressing as any).world as Group,
        sign = world.getObjectByName("entrance-sign")!;
      const info = {
        canopy: world.getObjectByName("entrance-canopy") as Mesh | undefined,
        lights: world.getObjectByName("entrance-canopy-lights") as
          Mesh | undefined,
        sign: sign.position.toArray(),
      };
      (dressing as any).clear();
      return info;
    };
  const absent = names();
  assert.equal(absent.canopy, undefined, "no setting keeps the original slab");
  assert.equal(absent.lights, undefined);
  const flat = names(broadcastSetting("flat")),
    gabled = names(broadcastSetting("gabled")),
    marquee = names(broadcastSetting("marquee")),
    none = names(broadcastSetting("none"));
  for (const designed of [flat, gabled, marquee, none])
    assert.deepEqual(designed.sign, absent.sign, "sign slot never moves");
  assert.ok(flat.canopy && flat.lights);
  assert.ok(gabled.canopy && gabled.lights);
  assert.ok(marquee.canopy && marquee.lights);
  assert.equal(none.canopy, undefined);
  assert.equal(none.lights, undefined);
  const count = (m: Mesh) => m.geometry.getAttribute("position").count;
  assert.ok(
    count(marquee.lights!) > count(flat.lights!) * 8,
    "the marquee carries rows of lit edge bulbs",
  );
  for (const designed of [flat, gabled, marquee]) {
    designed.canopy!.geometry.computeBoundingBox();
    assert.ok(
      designed.canopy!.geometry.boundingBox!.max.y <= 2.85 + 0.1,
      "a canopy never rises into the entrance sign",
    );
  }
  const colors = marquee.lights!.geometry.getAttribute("color");
  const glow = new Color("#ff4a3a");
  let lit = 0;
  for (let i = 0; i < colors.count; i++)
    if (
      Math.abs(colors.getX(i) - glow.r) < 1e-4 &&
      Math.abs(colors.getY(i) - glow.g) < 1e-4
    )
      lit++;
  assert.ok(lit > 0, "bulbs use the authored canopyGlow colour");
});
