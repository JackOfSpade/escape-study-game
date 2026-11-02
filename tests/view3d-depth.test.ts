import assert from "node:assert/strict";
import test from "node:test";
import { Euler, Quaternion, Vector3 } from "three";
import {
  FURNITURE,
  type Furniture,
  type FurnitureKind,
  type Game,
  type Item,
  type Station,
} from "../src/model";
import { FirstPersonView } from "../src/view3d/scene";

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
}
interface Generators {
  furnitureParts(parts: Part[], object: Furniture): void;
  station(station: Station, game: Game, palette: object): void;
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
    ) {
      target.push({ x, y, z, w, h, d, tint, batch, role });
    },
    visual: () => ({ parts }),
    pools: Object.fromEntries(
      ["box", "screen", "head", "field"].map((batch) => [batch, { set() {} }]),
    ),
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
          material: `${p.batch}/${p.tint}`,
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
