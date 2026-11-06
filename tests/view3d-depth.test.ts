import assert from "node:assert/strict";
import test from "node:test";
import {
  Euler,
  Group,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from "three";
import {
  FURNITURE,
  type Furniture,
  type FurnitureKind,
  type Game,
  type Item,
  type Station,
} from "../src/model";
import {
  TERMINAL_STYLES,
  type RunCustomObject,
} from "../src/setting-catalog.mjs";
import { objectGeometry } from "../src/view3d/object-shapes";
import { FirstPersonView } from "../src/view3d/scene";
import {
  furnitureHeightOf,
  furnitureSurfaceBoundsOf,
  furnitureSurfaceHeightOf,
} from "../src/view3d/furniture-height";

interface Part {
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  tint: string;
  batch: string;
  role?: string;
  color?: string;
  finish?: string;
}
interface Generators {
  furnitureParts(parts: Part[], object: Furniture): void;
  station(
    station: Station,
    game: Game,
    palette: object,
    facing?: 1 | -1,
    terminal?: object,
  ): void;
  loot(item: Item, position: { x: number; y: number }, palette: object): void;
}
const generators = FirstPersonView.prototype as unknown as Generators;
function recorder() {
  const parts: Part[] = [];
  const view = {
    part(
      target: Part[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      tint = "body",
      batch = "box",
      role?: string,
      _anchor?: string,
      color?: string,
      finish?: string,
    ) {
      target.push({ x, y, z, w, h, d, tint, batch, role, color, finish });
    },
    visual: () => ({ parts }),
    pools: new Proxy({} as Record<string, { set(): void }>, {
      get: () => ({ set() {} }),
    }),
    color: (tint: string) => tint,
  };
  return { parts, view };
}
interface Face {
  normal: Vector3;
  center: Vector3;
  u: Vector3;
  v: Vector3;
  corners: Vector3[];
  material: string;
  part: number;
}
function faces(parts: Part[], health = 1, destroyed = false) {
  const result: Face[] = [];
  parts.forEach((p, part) => {
    // These pools use octahedra rather than box faces.
    if (p.batch === "head") return;
    // Round composed-object shapes have no flat faces to compare.
    if (/^obj:(cylinder|sphere|cone):/.test(p.batch)) return;
    const broken = health < 0.45;
    const lean =
      p.role === "damage"
        ? 0.38
        : destroyed
          ? 0.18
          : broken && (p.role === "leg" || p.tint === "edge")
            ? 0.12
            : 0;
    const rotation = new Quaternion().setFromEuler(
      new Euler(0, 0, lean, "YXZ"),
    );
    const center = new Vector3(
      p.x,
      p.y - (broken && p.role === "leg" ? 0.07 : 0),
      p.z,
    );
    const half = [p.w / 2, p.h / 2, p.d / 2];
    for (let axis = 0; axis < 3; axis++)
      for (const sign of [-1, 1]) {
        const normal = new Vector3().setComponent(axis, sign);
        const uAxis = (axis + 1) % 3,
          u = new Vector3().setComponent(uAxis, 1),
          v = new Vector3().crossVectors(normal, u);
        const vAxis = (axis + 2) % 3;
        const faceCenter = normal.clone().multiplyScalar(half[axis]);
        const corners = [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
        ].map(([us, vs]) =>
          faceCenter
            .clone()
            .addScaledVector(u, us * half[uAxis])
            .addScaledVector(v, vs * half[vAxis])
            .applyQuaternion(rotation)
            .add(center),
        );
        result.push({
          normal: normal.applyQuaternion(rotation),
          center: faceCenter.applyQuaternion(rotation).add(center),
          u: u.applyQuaternion(rotation),
          v: v.applyQuaternion(rotation),
          corners,
          material: `${p.batch}/${p.tint}/${p.color ?? ""}`,
          part,
        });
      }
  });
  return result;
}
type Point2 = { x: number; y: number };
function overlapArea(a: Face, b: Face) {
  const project = (p: Vector3) => {
    const q = p.clone().sub(a.center);
    return { x: q.dot(a.u), y: q.dot(a.v) };
  };
  const boundary = a.corners.map(project);
  let polygon = b.corners.map(project);
  for (let i = 0; i < boundary.length && polygon.length; i++) {
    const start = boundary[i],
      end = boundary[(i + 1) % boundary.length];
    const side = (p: Point2) =>
      (end.x - start.x) * (p.y - start.y) - (end.y - start.y) * (p.x - start.x);
    const clipped: Point2[] = [];
    for (let j = 0; j < polygon.length; j++) {
      const previous = polygon[(j + polygon.length - 1) % polygon.length],
        current = polygon[j],
        before = side(previous),
        after = side(current);
      if (before >= 0 !== after >= 0) {
        const t = before / (before - after);
        clipped.push({
          x: previous.x + (current.x - previous.x) * t,
          y: previous.y + (current.y - previous.y) * t,
        });
      }
      if (after >= 0) clipped.push(current);
    }
    polygon = clipped;
  }
  return (
    Math.abs(
      polygon.reduce((sum, p, i) => {
        const q = polygon[(i + 1) % polygon.length];
        return sum + p.x * q.y - p.y * q.x;
      }, 0),
    ) / 2
  );
}
function competingFaces(parts: Part[], health = 1, destroyed = false) {
  const fs = faces(parts, health, destroyed),
    conflicts: string[] = [];
  for (let i = 0; i < fs.length; i++)
    for (let j = i + 1; j < fs.length; j++) {
      const a = fs[i],
        b = fs[j];
      if (
        a.part === b.part ||
        a.material === b.material ||
        a.normal.dot(b.normal) < 1 - 1e-8
      )
        continue;
      if (Math.abs(b.center.clone().sub(a.center).dot(a.normal)) > 1e-7)
        continue;
      const area = overlapArea(a, b);
      if (area > 1e-8)
        conflicts.push(
          `parts ${a.part}/${b.part} (${a.material}/${b.material}), ${area.toFixed(6)}m²`,
        );
    }
  return conflicts;
}

test("furniture joins never expose overlapping coplanar faces with competing finishes", () => {
  for (const [kind, dimensions] of Object.entries(FURNITURE))
    for (const scale of [0.8, 1, 1.2])
      for (const health of [1, 0.6, 0.3, 0]) {
        const { view, parts } = recorder(),
          destroyed = health === 0;
        const object = {
          kind: kind as FurnitureKind,
          w: dimensions.w * scale,
          h: dimensions.h * scale,
          hp: 100 * health,
          maxHp: 100,
          destroyed,
        } as Furniture;
        generators.furnitureParts.call(view, parts, object);
        assert.ok(
          parts.length > 0,
          `${kind} still has a complete visible model`,
        );
        assert.ok(parts.every((p) => p.w > 0 && p.h > 0 && p.d > 0));
        if (health === 1) {
          if (["chair", "officeChair", "armchair", "sofa"].includes(kind)) {
            assert.ok(
              parts.some((p) => p.tint === "body" && p.w === object.w),
              "the full-width seat still defines its original footprint",
            );
            assert.ok(
              parts.some((p) => p.tint === "edge" && p.h > 0.5),
              "the upholstered back stays present",
            );
            if (kind !== "chair")
              assert.ok(
                parts.filter((p) => p.tint === "edge").length >= 3,
                "both armrests stay present",
              );
          }
          if (kind === "shelf") {
            assert.ok(
              parts.some((p) => p.tint === "dark" && p.h > 1),
              "the backing stays present",
            );
            assert.ok(
              parts.filter((p) => p.tint === "body").length >= 6,
              "side panels and all four shelves stay present",
            );
            assert.ok(
              parts.filter((p) => p.tint === "edge" || p.tint === "metal")
                .length >= 9,
              "shelf contents stay present",
            );
          }
          if (kind === "door" || kind === "gate") {
            assert.ok(
              parts.some((p) => p.tint === "body"),
              "the hinged leaf stays present",
            );
            assert.ok(
              parts.filter((p) => p.tint === "edge").length >= 3,
              "both jambs and the header stay present",
            );
          }
          if (kind === "onAirLight")
            assert.ok(
              parts.some((p) => p.tint === "signal" && p.batch === "signal"),
              "the lightbox glows with the fixed signal red",
            );
          if (kind === "mixingConsole")
            assert.ok(
              parts.filter((p) => p.batch === "screen").length >= 4,
              "the meter bridge keeps its lit meters",
            );
          if (kind === "recordShelf")
            assert.ok(
              parts.filter((p) => p.tint !== "body" && p.h > 0.29).length >= 40,
              "the record spines fill the cubbies",
            );
          if (kind === "printer")
            assert.ok(
              parts.some((p) => p.batch === "screen"),
              "the printer display stays present",
            );
        }
        assert.deepEqual(
          competingFaces(parts, health, destroyed),
          [],
          `${kind}, scale ${scale}, health ${health}`,
        );
      }
});

test("whiteboard writing has a visible depth clearance even on thin office boards", () => {
  for (const depth of [0.1, 0.14, 0.25, 0.35, 1]) {
    const { view, parts } = recorder();
    generators.furnitureParts.call(view, parts, {
      kind: "whiteboard",
      w: 2,
      h: depth,
      hp: 100,
      maxHp: 100,
    } as Furniture);
    const panel = parts.find((p) => p.tint === "skin")!;
    const strokes = parts.filter((p) => p.tint === "dark");
    assert.equal(strokes.length, 2, "writing stays present on the board");
    for (const stroke of strokes) {
      assert.ok(
        stroke.z - stroke.d / 2 > panel.z + panel.d / 2 + 0.003,
        "the marker geometry sits in front of the board",
      );
      assert.ok(
        stroke.z + stroke.d / 2 - panel.z - panel.d / 2 >= 0.01,
        "visible front faces retain at least a centimetre of depth separation",
      );
    }
  }
});

test("terminals, pickup markings and door frames keep different finishes on distinct surfaces", () => {
  const station = recorder();
  generators.station.call(
    station.view,
    { x: 0, y: 0, encounter: "synthetic" } as Station,
    { encounters: { synthetic: { state: "active" } } } as unknown as Game,
    {},
  );
  assert.ok(
    station.parts.length >= 6,
    "the complete terminal and display remain present",
  );
  assert.deepEqual(competingFaces(station.parts), []);
  for (const kind of ["medkit", "bubble", "decoy"] as const) {
    const pickup = recorder();
    generators.loot.call(pickup.view, { kind } as Item, { x: 0, y: 0 }, {});
    assert.ok(pickup.parts.length >= 1);
    assert.deepEqual(competingFaces(pickup.parts), [], kind);
  }
  for (const vertical of [false, true]) {
    const field = recorder();
    generators.furnitureParts.call(field.view, field.parts, {
      id: "synthetic-door",
      kind: "door",
      doorStyle: {
        material: "glass",
        color: "#38474f",
        accent: "#b9c6cc",
        window: "full",
        label: "Glass door",
      },
      w: vertical ? 0.2 : 3,
      h: vertical ? 3 : 0.2,
      hp: 100,
      maxHp: 100,
      field: {},
    } as Furniture);
    assert.ok(
      field.parts.filter((p) => p.batch === "field").length >= 2,
      "each hinged leaf of a double door keeps its glass",
    );
    assert.ok(
      field.parts.some((p) => p.batch === "screen"),
      "the access and health light stays visible",
    );
    assert.deepEqual(competingFaces(field.parts), []);
  }
});

const crate: RunCustomObject = {
  id: "cryo-pod",
  name: "Cryo pod",
  role: "bed",
  weight: "heavy",
  size: { w: 1.2, d: 0.8, h: 1.4 },
  surface: true,
  parts: [
    // A slab top, a metal pedestal flush with its sides, a glass dome, a
    // glowing lamp and a cone, a ball and a feet pair: every shape and finish.
    {
      shape: "box",
      axis: "up",
      x: 0,
      y: 0,
      z: 0.9,
      w: 1.2,
      d: 0.8,
      h: 0.1,
      color: "#556677",
      finish: "matte",
    },
    {
      shape: "box",
      axis: "up",
      x: 0,
      y: 0,
      z: 0,
      w: 1.2,
      d: 0.8,
      h: 0.9,
      color: "#223344",
      finish: "metal",
    },
    {
      shape: "cylinder",
      axis: "up",
      x: -0.3,
      y: 0,
      z: 1,
      w: 0.3,
      d: 0.3,
      h: 0.2,
      color: "#9aa8b4",
      finish: "metal",
    },
    {
      shape: "sphere",
      axis: "up",
      x: 0.4,
      y: 0,
      z: 1,
      w: 0.3,
      d: 0.3,
      h: 0.3,
      color: "#88ccee",
      finish: "glass",
    },
    {
      shape: "cone",
      axis: "up",
      x: 0.2,
      y: 0,
      z: 1.4,
      w: 0.0,
      d: 0.0,
      h: 0,
      color: "#000000",
      finish: "matte",
    },
    {
      shape: "sphere",
      axis: "up",
      x: -0.3,
      y: 0.2,
      z: 1.2,
      w: 0.1,
      d: 0.1,
      h: 0.1,
      color: "#33ffaa",
      finish: "glow",
    },
    {
      shape: "cone",
      axis: "up",
      x: 0.5,
      y: 0.3,
      z: 1,
      w: 0.14,
      d: 0.14,
      h: 0.3,
      color: "#ff8844",
      finish: "glow",
    },
    {
      shape: "cylinder",
      axis: "up",
      x: 0.5,
      y: -0.3,
      z: 1,
      w: 0.1,
      d: 0.1,
      h: 0.2,
      color: "#cccccc",
      finish: "matte",
    },
  ].filter((p) => p.w > 0) as RunCustomObject["parts"],
};
function customObject(health: number): Furniture {
  return {
    kind: "custom",
    object: crate,
    w: crate.size.w,
    h: crate.size.d,
    hp: 100 * health,
    maxHp: 100,
    destroyed: health === 0,
  } as Furniture;
}
const poolOf = (shape: string, finish: string, axis = "up") =>
  shape === "box" && finish === "matte"
    ? "box"
    : `obj:${shape}:${finish}:${["cylinder", "cone", "wedge", "torus"].includes(shape) ? axis : "up"}`;

test("a composed object draws every recipe part in its shape and finish pool at every health stage", () => {
  for (const health of [1, 0.6, 0.3, 0]) {
    const { view, parts } = recorder(),
      object = customObject(health);
    generators.furnitureParts.call(view, parts, object);
    const custom = parts.filter((p) => p.color);
    if (health === 0) {
      assert.equal(custom.length, 0, "a wreck shows debris, not the recipe");
      assert.ok(parts.some((p) => p.role === "debris"));
    } else {
      assert.equal(custom.length, crate.parts.length);
      crate.parts.forEach((src, i) => {
        const p = custom[i];
        assert.equal(p.batch, poolOf(src.shape, src.finish), `part ${i}`);
        assert.equal(p.color, src.color);
        assert.equal(p.finish, src.finish);
        assert.ok(Math.abs(p.x - src.x) < 1e-9);
        assert.ok(Math.abs(p.z - src.y) < 1e-9, "recipe y maps to local z");
        assert.ok(Math.abs(p.y - (src.z + src.h / 2)) < 0.01, "centre height");
        assert.ok(p.w >= src.w && p.w - src.w < 0.012);
      });
      if (health < 0.65)
        assert.ok(
          parts.some((p) => p.role === "damage"),
          "cracks appear",
        );
    }
    assert.deepEqual(
      competingFaces(parts, health, health === 0),
      [],
      `${health}`,
    );
  }
});

test("glow parts use the unlit emissive pool and glass the transparent one", () => {
  const { view, parts } = recorder();
  generators.furnitureParts.call(view, parts, customObject(1));
  assert.ok(
    parts
      .filter((p) => p.finish === "glow")
      .every((p) => p.batch.includes(":glow:")),
  );
  assert.equal(parts.filter((p) => p.batch.includes(":glow:")).length, 2);
  assert.equal(parts.filter((p) => p.batch.includes(":glass:")).length, 1);
  assert.ok(!parts.some((p) => p.batch === "signal"), "never the fixed red");
  const make = (
    FirstPersonView.prototype as unknown as {
      pool(
        this: object,
        batch: string,
      ): {
        mesh: {
          material: unknown;
          count: number;
          instanceMatrix: { count: number };
        };
      };
    }
  ).pool;
  const fake = {
    pools: {} as Record<string, unknown>,
    poolList: [] as unknown[],
    floorRoot: new Group(),
    materials: {
      box: new MeshStandardMaterial(),
      objMetal: new MeshStandardMaterial(),
      objGlass: new MeshStandardMaterial({ transparent: true }),
      objGlow: new MeshBasicMaterial(),
    },
  };
  const glow = make.call(fake, "obj:sphere:glow:up"),
    again = make.call(fake, "obj:sphere:glow:up");
  assert.equal(glow, again, "pools are created once");
  assert.ok(glow.mesh.material instanceof MeshBasicMaterial);
  assert.equal(fake.poolList.length, 1);
  assert.ok(glow.mesh.instanceMatrix.count <= 4096, "bounded capacity");
  assert.equal(
    make.call(fake, "obj:cone:glass:up").mesh.material,
    fake.materials.objGlass,
  );
});

test("composed objects report their own height, surface and bounds", () => {
  const object = customObject(1);
  assert.equal(furnitureHeightOf(object), 1.4);
  assert.equal(furnitureHeightOf({ kind: "desk" }), 0.8);
  assert.equal(furnitureSurfaceHeightOf(object), 1.0);
  assert.deepEqual(furnitureSurfaceBoundsOf(object, 1.2, 0.8), {
    w: 1.2,
    d: 0.8,
  });
});

const verts = (g: ReturnType<typeof objectGeometry>) => {
  const p = g.getAttribute("position");
  return Array.from({ length: p.count }, (_, i) => ({
    x: p.getX(i),
    y: p.getY(i),
    z: p.getZ(i),
  }));
};
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("a wedge fills its box and its high edge follows the axis", () => {
  const tall = (axis: "up" | "across" | "along") =>
    verts(objectGeometry("wedge", axis)).filter((v) => near(v.y, 0.5));
  for (const axis of ["up", "across", "along"] as const) {
    const g = objectGeometry("wedge", axis);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    for (const k of ["x", "y", "z"] as const) {
      assert.ok(near(b.min[k], -0.5) && near(b.max[k], 0.5), `${axis} ${k}`);
    }
    // Every face normal points away from the centre of the prism.
    const pos = g.getAttribute("position"),
      nor = g.getAttribute("normal");
    for (let i = 0; i < pos.count; i++)
      assert.ok(
        pos.getX(i) * nor.getX(i) +
          pos.getY(i) * nor.getY(i) +
          pos.getZ(i) * nor.getZ(i) >=
          -1e-9 || pos.getY(i) < 0.5,
      );
    assert.ok(g.getAttribute("uv"), "uv lets it merge with stock shapes");
  }
  assert.ok(
    tall("up").every((v) => near(v.z, -0.5)),
    "up: high at the back",
  );
  assert.ok(
    tall("across").every((v) => near(v.x, 0.5)),
    "across: high at +x",
  );
  assert.ok(
    tall("along").every((v) => near(v.z, 0.5)),
    "along: high at front",
  );
});

test("a torus is a ring whose hole faces the axis and which fills its box", () => {
  const hole = {
    up: (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.z),
    along: (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y),
    across: (v: { x: number; y: number; z: number }) => Math.hypot(v.y, v.z),
  };
  for (const axis of ["up", "across", "along"] as const) {
    const g = objectGeometry("torus", axis);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    for (const k of ["x", "y", "z"] as const)
      assert.ok(near(b.max[k], 0.5) && near(b.min[k], -0.5), `${axis} ${k}`);
    const radii = verts(g).map(hole[axis]);
    assert.ok(Math.min(...radii) > 0.15, `${axis} has an open hole`);
    assert.ok(Math.max(...radii) <= 0.5 + 1e-6);
  }
});

test("wedge and torus parts keep their axis in the instance pool key", () => {
  const object: RunCustomObject = {
    ...crate,
    parts: [
      {
        shape: "wedge",
        axis: "across",
        x: 0,
        y: 0,
        z: 0,
        w: 1,
        d: 0.8,
        h: 0.5,
        color: "#445566",
        finish: "matte",
      },
      {
        shape: "torus",
        axis: "along",
        x: 0,
        y: 0,
        z: 0.5,
        w: 0.8,
        d: 0.2,
        h: 0.8,
        color: "#667788",
        finish: "glow",
      },
    ],
  };
  const { view, parts } = recorder();
  generators.furnitureParts.call(view, parts, {
    ...customObject(1),
    object,
  } as Furniture);
  const custom = parts.filter((p) => p.color);
  assert.deepEqual(
    custom.map((p) => p.batch),
    ["obj:wedge:matte:across", "obj:torus:glow:along"],
  );
});

test("every terminal style stays inside the desk footprint with a glowing face and no competing faces", () => {
  for (const style of TERMINAL_STYLES)
    for (const state of ["active", "consumed"]) {
      const { view, parts } = recorder();
      generators.station.call(
        view,
        { x: 0, y: 0, encounter: "synthetic" } as Station,
        { encounters: { synthetic: { state } } } as unknown as Game,
        {},
        1,
        { style, body: "#445566", accent: "#aa8844", screen: "#33ddcc" },
      );
      const label = `${style} ${state}`;
      assert.ok(parts.length >= 5, label);
      const faceParts = parts.filter((p) => p.finish === "glow");
      assert.ok(faceParts.length >= 1, `${label} keeps a glowing face`);
      for (const p of faceParts) {
        assert.equal(p.color, "#33ddcc", label);
        assert.ok(p.y >= 0.9 && p.y <= 1.4, `${label} screen height ${p.y}`);
      }
      assert.ok(
        parts.some((p) => p.color === "#445566") &&
          parts.some((p) => p.color === "#aa8844"),
        `${label} uses body and accent colours`,
      );
      for (const p of parts) {
        assert.ok(Math.abs(p.x) + p.w / 2 <= 0.5 + 1e-9, `${label} x`);
        assert.ok(Math.abs(p.z) + p.d / 2 <= 0.33 + 1e-9, `${label} z`);
        assert.ok(p.y - p.h / 2 >= -1e-9, `${label} above floor`);
      }
      assert.deepEqual(competingFaces(parts), [], label);
    }
});

test("a station without a terminal setting keeps today's desk and monitor parts", () => {
  const { view, parts } = recorder();
  generators.station.call(
    view,
    { x: 0, y: 0, encounter: "synthetic" } as Station,
    { encounters: { synthetic: { state: "active" } } } as unknown as Game,
    {},
  );
  assert.deepEqual(
    parts.map((p) => [p.x, p.y, p.z, p.w, p.h, p.d, p.tint, p.batch]),
    [
      [0, 0.76, 0, 0.98, 0.1, 0.65, "body", "box"],
      [-0.38, 0.38, 0, 0.06, 0.76, 0.5, "metal", "box"],
      [0.38, 0.38, 0, 0.06, 0.76, 0.5, "metal", "box"],
      [0, 0.93, -0.17, 0.08, 0.3, 0.08, "metal", "box"],
      [0, 1.18, -0.17, 0.7, 0.45, 0.1, "dark", "box"],
      [0, 1.18, -0.112, 0.61, 0.36, 0.025, "screen", "screen"],
      [0, 0.83, 0.15, 0.55, 0.04, 0.2, "dark", "box"],
    ],
  );
  assert.ok(parts.every((p) => p.color === undefined));
});
