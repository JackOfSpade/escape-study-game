import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Material,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type {
  RunCustomObject,
  RunObjectMotion,
  RunObjectPart,
  RunRoofFeatureKind,
} from "../setting-catalog.mjs";
import type { ResolvedRoofFeature } from "../venue";
import {
  effectiveMotion,
  motionPhase,
  objectGeometry,
  partMotion,
  partTilt,
  type PartMotionPose,
} from "./object-shapes";

type V3 = [number, number, number];
export interface RoofFeatureParts {
  /** Lit, vertex-coloured structure. */
  solid: BufferGeometry[];
  /** Unlit emissive lamps (aviation lights, display faces). */
  lamps: BufferGeometry[];
  /** Parts that move: each is centred on its own pivot so the caller can
   * add a mesh at `position` (the world pivot) and hand it to a
   * PartAnimator. Empty for a feature that stands still. */
  animated: AnimatedRoofPart[];
}
export interface AnimatedRoofPart {
  /** Centred on the pivot, tilted, vertex-coloured. */
  geometry: BufferGeometry;
  lamp: boolean;
  /** World position of the pivot, before any bob. */
  position: V3;
  /** The feature's own yaw about the vertical. */
  yaw: number;
  motion: RunObjectMotion;
  rate: number;
  phase: number;
}

const UP = new Vector3(0, 1, 0);
const tint = new Color();
const hash = (i: number) => Math.imul(i + 13, 15485863) >>> 0;

function colorize(geometry: BufferGeometry, color: string) {
  tint.set(color);
  const count = geometry.getAttribute("position").count,
    colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) tint.toArray(colors, i * 3);
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
}

/** One composed part's geometry, centred on its own middle: scaled to its
 * extents, then tipped by pitch (toward the front, +z) and roll (toward +x)
 * about that centre. Motion is not baked in. */
export function composedPartGeometry(part: RunObjectPart): BufferGeometry {
  const g = objectGeometry(part.shape, part.axis);
  g.scale(part.w, part.h, part.d);
  const tilt = partTilt(part);
  if (tilt) g.rotateX(tilt.pitch).rotateZ(-tilt.roll);
  return g;
}

/** Drives the meshes of moving parts from a clock. Static meshes are never
 * registered, so the per-frame cost is bounded by the animated part count. */
export class PartAnimator {
  private entries: {
    mesh: Mesh;
    base: Vector3;
    yaw: number;
    motion: RunObjectMotion;
    rate: number;
    phase: number;
    material?: MeshBasicMaterial;
  }[] = [];
  private pose: PartMotionPose = { yaw: 0, lift: 0, glow: 1 };

  get count() {
    return this.entries.length;
  }

  /** Register a mesh already placed at `base` with its yaw. A glow part that
   * pulses or flickers gets its own copy of an unlit material so only it
   * changes brightness. */
  add(
    mesh: Mesh,
    base: Vector3,
    yaw: number,
    motion: RunObjectMotion,
    rate: number,
    phase: number,
  ) {
    let material: MeshBasicMaterial | undefined;
    if (
      (motion === "pulse" || motion === "flicker") &&
      mesh.material instanceof MeshBasicMaterial
    ) {
      material = mesh.material.clone();
      mesh.material = material;
    }
    this.entries.push({
      mesh,
      base: base.clone(),
      yaw,
      motion,
      rate,
      phase,
      material,
    });
    this.update(0, false, this.entries.length - 1);
  }

  update(time: number, calm = false, only?: number) {
    const from = only ?? 0,
      to = only === undefined ? this.entries.length : only + 1;
    for (let i = from; i < to; i++) {
      const e = this.entries[i],
        pose = partMotion(e.motion, e.rate, e.phase, time, calm, this.pose);
      e.mesh.position.set(e.base.x, e.base.y + pose.lift, e.base.z);
      e.mesh.rotation.y = e.yaw + pose.yaw;
      e.material?.color.setScalar(pose.glow);
    }
  }

  dispose() {
    for (const e of this.entries) e.material?.dispose();
    this.entries.length = 0;
  }
}

/** A recipe's parts as meshes in the object's own frame (x across, recipe y
 * on the z axis, up on y), tilted about each part's centre. Still parts are
 * merged into one solid and one lamp mesh; moving parts are separate meshes
 * registered with `animator`, which the caller updates each frame. The group
 * owns its geometry; materials stay with the caller. */
export function composedPartsGroup(
  parts: readonly RunObjectPart[],
  materials: { solid: Material; lamp: Material },
  animator: PartAnimator,
): Group {
  const group = new Group(),
    still = { solid: [] as BufferGeometry[], lamp: [] as BufferGeometry[] };
  parts.forEach((part, i) => {
    const geometry = composedPartGeometry(part),
      lamp = part.finish === "glow",
      pivot = new Vector3(part.x, part.z + part.h / 2, part.y);
    colorize(geometry, part.color);
    const motion = effectiveMotion(part.motion, part.finish);
    if (motion === "none") {
      geometry.translate(pivot.x, pivot.y, pivot.z);
      (lamp ? still.lamp : still.solid).push(geometry);
      return;
    }
    const mesh = new Mesh(geometry, lamp ? materials.lamp : materials.solid);
    mesh.position.copy(pivot);
    group.add(mesh);
    animator.add(mesh, pivot, 0, motion, part.rate, motionPhase(i));
  });
  for (const [list, material] of [
    [still.solid, materials.solid],
    [still.lamp, materials.lamp],
  ] as const)
    if (list.length) {
      const mesh = new Mesh(mergeGeometries(list)!, material);
      for (const g of list) g.dispose();
      group.add(mesh);
    }
  return group;
}

/** Visual-only rooftop dressing in a local frame whose +z points out of the
 * building and whose origin is the roof surface under the feature. */
class Builder {
  readonly solid: BufferGeometry[] = [];
  readonly lamps: BufferGeometry[] = [];
  readonly animated: AnimatedRoofPart[] = [];
  private motions = 0;
  private readonly yaw: number;
  constructor(
    private readonly at: ResolvedRoofFeature,
    private readonly base: number,
  ) {
    this.yaw = Math.atan2(at.outward.x, at.outward.y);
  }

  private place(
    out: BufferGeometry[],
    geometry: BufferGeometry,
    color: string,
    local: V3,
  ) {
    colorize(geometry, color);
    geometry
      .translate(local[0], local[1], local[2])
      .rotateY(this.yaw)
      .translate(
        this.at.x + this.at.outward.x * 0.2,
        this.base,
        this.at.y + this.at.outward.y * 0.2,
      );
    out.push(geometry);
  }

  box(size: V3, at: V3, color: string, rotation: V3 = [0, 0, 0], lamp = false) {
    const g = new BoxGeometry(...size);
    this.rotate(g, rotation);
    this.place(lamp ? this.lamps : this.solid, g, color, at);
  }

  cylinder(
    top: number,
    bottom: number,
    height: number,
    at: V3,
    color: string,
    segments = 8,
    lamp = false,
  ) {
    this.place(
      lamp ? this.lamps : this.solid,
      new CylinderGeometry(top, bottom, height, segments),
      color,
      at,
    );
  }

  cone(radius: number, height: number, at: V3, color: string, segments = 8) {
    this.place(
      this.solid,
      new ConeGeometry(radius, height, segments),
      color,
      at,
    );
  }

  sphere(radius: number, at: V3, color: string, lamp = false) {
    this.place(
      lamp ? this.lamps : this.solid,
      new SphereGeometry(radius, 10, 6),
      color,
      at,
    );
  }

  /** A round bar between two local points. */
  strut(a: V3, b: V3, radius: number, color: string) {
    const from = new Vector3(...a),
      to = new Vector3(...b),
      direction = to.clone().sub(from),
      length = direction.length();
    if (length < 1e-6) return;
    const g = new CylinderGeometry(radius, radius, length, 4);
    g.applyQuaternion(
      new Quaternion().setFromUnitVectors(UP, direction.normalize()),
    );
    const mid = from.add(to).multiplyScalar(0.5);
    this.place(this.solid, g, color, [mid.x, mid.y, mid.z]);
  }

  /** A bowl whose open face points along `tilt` radians from straight up
   * toward the outside. */
  bowl(radius: number, tilt: number, at: V3, color: string) {
    const angle = 1.0,
      sphere = radius / Math.sin(angle),
      g = new SphereGeometry(sphere, 16, 6, 0, Math.PI * 2, 0, angle);
    g.rotateX(Math.PI).translate(0, sphere, 0).rotateX(tilt);
    this.place(this.solid, g, color, at);
  }

  /** One part of a composed object. The object's own frame maps onto the
   * local one with its front (+y) facing out of the building; glow parts are
   * unlit lamps. Parts tilt about their own centre and may move; they are
   * visual only, like every roof feature. */
  objectPart(part: RunObjectPart, inset = 0) {
    const centre: V3 = [part.x, part.z + part.h / 2, part.y - inset],
      lamp = part.finish === "glow",
      geometry = composedPartGeometry(part);
    const motion = effectiveMotion(part.motion, part.finish);
    if (motion === "none") {
      this.place(lamp ? this.lamps : this.solid, geometry, part.color, centre);
      return;
    }
    this.animate(geometry, part.color, centre, lamp, motion, part.rate);
  }

  /** A part that moves: kept apart from the merged geometry. */
  animate(
    geometry: BufferGeometry,
    color: string,
    local: V3,
    lamp: boolean,
    motion: RunObjectMotion,
    rate: number,
  ) {
    colorize(geometry, color);
    const pivot = new Vector3(...local)
      .applyAxisAngle(UP, this.yaw)
      .add(
        new Vector3(
          this.at.x + this.at.outward.x * 0.2,
          this.base,
          this.at.y + this.at.outward.y * 0.2,
        ),
      );
    this.animated.push({
      geometry,
      lamp,
      position: [pivot.x, pivot.y, pivot.z],
      yaw: this.yaw,
      motion,
      rate,
      phase: motionPhase(this.motions++),
    });
  }

  private rotate(g: BufferGeometry, [x, y, z]: V3) {
    if (x) g.rotateX(x);
    if (y) g.rotateY(y);
    if (z) g.rotateZ(z);
  }
}

const IRON = "#3a4247",
  PAINT = "#c9ccc4",
  RED = "#ff2a1f";

function mast(b: Builder) {
  const height = 9,
    bays = 6,
    half0 = 0.4,
    half1 = 0.07,
    half = (y: number) => half0 + (half1 - half0) * (y / height);
  b.box([0.9, 0.12, 0.9], [0, 0.06, 0], "#767b78");
  const corners: [number, number][] = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (const [sx, sz] of corners)
    b.strut(
      [sx * half(0), 0.1, sz * half(0)],
      [sx * half(height), height, sz * half(height)],
      0.028,
      PAINT,
    );
  for (let i = 0; i < bays; i++) {
    const y0 = 0.1 + (i * (height - 0.1)) / bays,
      y1 = 0.1 + ((i + 1) * (height - 0.1)) / bays,
      h0 = half(y0),
      h1 = half(y1);
    for (let c = 0; c < 4; c++) {
      const [ax, az] = corners[c],
        [bx, bz] = corners[(c + 1) % 4];
      // Horizontal ring at the bay's head and an X on each face.
      b.strut(
        [ax * h1, y1, az * h1],
        [bx * h1, y1, bz * h1],
        0.014,
        i % 2 ? PAINT : "#a63a2c",
      );
      b.strut([ax * h0, y0, az * h0], [bx * h1, y1, bz * h1], 0.012, PAINT);
      b.strut([bx * h0, y0, bz * h0], [ax * h1, y1, az * h1], 0.012, PAINT);
    }
  }
  b.strut([0, height, 0], [0, height + 1.5, 0], 0.012, IRON);
  b.cylinder(0.09, 0.09, 0.1, [0, height + 0.05, 0], IRON, 6);
  b.sphere(0.11, [0, height + 1.55, 0], RED, true);
  // Mid-height obstruction light, as on any real tower.
  b.sphere(0.07, [0, height * 0.5, half(height * 0.5) + 0.04], RED, true);
}

function dish(b: Builder) {
  b.box([0.5, 0.08, 0.5], [0, 0.04, 0], "#767b78");
  b.cylinder(0.07, 0.09, 1.0, [0, 0.58, 0], "#8c9291");
  b.box([0.2, 0.2, 0.2], [0, 1.1, 0], "#5d6462");
  const tilt = 0.85;
  b.bowl(0.72, tilt, [0, 1.25, 0.05], "#e4e6e0");
  const face: V3 = [0, Math.cos(tilt), Math.sin(tilt)],
    focus: V3 = [face[0] * 0.65, 1.25 + face[1] * 0.65, 0.05 + face[2] * 0.65];
  b.strut([0, 1.25, 0.05], focus, 0.012, IRON);
  b.box([0.09, 0.09, 0.09], focus, "#2c3236");
}

function beacon(b: Builder) {
  b.box([0.5, 0.08, 0.5], [0, 0.04, 0], "#767b78");
  b.cylinder(0.05, 0.06, 1.0, [0, 0.58, 0], "#8c9291");
  b.cylinder(0.13, 0.15, 0.14, [0, 1.15, 0], IRON, 10);
  // The warning lamp breathes, as a real beacon does.
  b.animate(
    new CylinderGeometry(0.11, 0.11, 0.26, 10),
    RED,
    [0, 1.35, 0],
    true,
    "pulse",
    0.8,
  );
  b.cylinder(0.14, 0.12, 0.05, [0, 1.51, 0], IRON, 10);
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    b.strut(
      [Math.cos(a) * 0.13, 1.22, Math.sin(a) * 0.13],
      [Math.cos(a) * 0.13, 1.49, Math.sin(a) * 0.13],
      0.01,
      IRON,
    );
  }
}

function watertank(b: Builder) {
  const legs: [number, number][] = [
    [-0.36, -0.36],
    [0.36, -0.36],
    [0.36, 0.36],
    [-0.36, 0.36],
  ];
  for (const [x, z] of legs)
    b.strut([x, 0, z], [x * 1.05, 1.1, z * 1.05], 0.035, IRON);
  b.strut([-0.36, 0.45, -0.36], [0.36, 0.45, 0.36], 0.012, IRON);
  b.strut([0.36, 0.45, -0.36], [-0.36, 0.45, 0.36], 0.012, IRON);
  b.cylinder(0.46, 0.46, 1.1, [0, 1.65, 0], "#6f5240", 14);
  for (const y of [1.25, 1.65, 2.05])
    b.cylinder(0.475, 0.475, 0.04, [0, y, 0], IRON, 14);
  b.cone(0.52, 0.3, [0, 2.35, 0], "#5a4535", 14);
}

function chimney(b: Builder) {
  b.box([0.7, 0.2, 0.7], [0, 0.1, 0], "#7b6f66");
  const courses = 16;
  for (let i = 0; i < courses; i++) {
    const f = 0.85 + 0.25 * ((hash(i * 5) % 100) / 100);
    tint.set("#9a5040").multiplyScalar(f);
    b.box(
      [0.52 - i * 0.004, 0.14, 0.52 - i * 0.004],
      [0, 0.27 + i * 0.14, 0],
      `#${tint.getHexString()}`,
    );
  }
  b.box([0.64, 0.12, 0.64], [0, 0.27 + courses * 0.14, 0], "#6f635b");
  b.box([0.34, 0.04, 0.34], [0, 0.35 + courses * 0.14, 0], "#16191a");
  b.cylinder(0.3, 0.3, 0.02, [0, 0.4 + courses * 0.14, 0], IRON, 8);
}

function solar(b: Builder) {
  const tilt = 0.55,
    frame = "#aab1b4";
  // Rear legs are taller than front legs so the array leans toward the edge.
  for (const x of [-0.42, 0.42]) {
    b.strut([x, 0, -0.3], [x, 0.7, -0.28], 0.02, IRON);
    b.strut([x, 0, 0.3], [x, 0.18, 0.28], 0.02, IRON);
  }
  const at: V3 = [0, 0.45, 0];
  b.box([0.98, 0.04, 0.78], at, "#1a2d4b", [tilt, 0, 0]);
  b.box(
    [1.0, 0.03, 0.04],
    [0, 0.45 + Math.sin(tilt) * 0.39, -Math.cos(tilt) * 0.39 + 0.01],
    frame,
    [tilt, 0, 0],
  );
  for (let i = -1; i <= 1; i++) {
    const along = i * 0.245;
    b.box([0.012, 0.045, 0.76], [along, 0.452, 0], frame, [tilt, 0, 0]);
  }
  for (let j = -1; j <= 1; j++) {
    const up = j * 0.2;
    b.box(
      [0.96, 0.045, 0.012],
      [0, 0.45 - Math.sin(tilt) * up, up * Math.cos(tilt)],
      frame,
      [tilt, 0, 0],
    );
  }
}

function vent(b: Builder) {
  b.box([0.9, 0.5, 0.7], [0, 0.35, 0], "#a0a8a6");
  b.box([0.96, 0.05, 0.76], [0, 0.62, 0], "#8b9391");
  b.cylinder(0.27, 0.27, 0.1, [0, 0.68, 0], IRON, 14);
  for (const angle of [0.4, 1.97]) {
    b.box([0.5, 0.012, 0.07], [0, 0.735, 0], "#c0c6c4", [0, angle, 0]);
  }
  b.cylinder(0.04, 0.04, 0.02, [0, 0.74, 0], "#c0c6c4", 8);
  for (let i = 0; i < 5; i++)
    b.box([0.5, 0.025, 0.012], [-0.08, 0.2 + i * 0.07, 0.36], IRON);
  b.cylinder(0.11, 0.11, 0.4, [0.52, 0.3, -0.1], "#8b9391", 8);
  b.box([0.1, 0.4, 0.1], [0.4, 0.2, 0.2], "#8b9391");
}

function billboard(b: Builder) {
  for (const x of [-0.38, 0.38]) b.strut([x, 0, 0], [x, 1.4, 0], 0.035, IRON);
  b.strut([-0.38, 0.5, 0], [0.38, 0.9, 0], 0.012, IRON);
  b.strut([0.38, 0.5, 0], [-0.38, 0.9, 0], 0.012, IRON);
  b.box([1.06, 0.6, 0.06], [0, 1.45, 0.02], IRON);
  b.box([0.96, 0.5, 0.02], [0, 1.45, 0.06], "#e9e4d0");
  // Lit headline blocks stand in for lettering that no texture is spent on.
  b.box([0.62, 0.1, 0.01], [-0.14, 1.55, 0.075], "#ff4a2e", [0, 0, 0], true);
  b.box([0.44, 0.06, 0.01], [-0.23, 1.4, 0.075], "#f0d68a", [0, 0, 0], true);
  b.box([0.14, 0.14, 0.01], [0.33, 1.45, 0.075], "#ff4a2e", [0, 0, 0], true);
  // Catwalk and rail along the lower edge.
  b.box([1.0, 0.03, 0.22], [0, 1.1, -0.1], IRON);
}

const BUILDERS: Record<RunRoofFeatureKind, (b: Builder) => void> = {
  mast,
  dish,
  beacon,
  watertank,
  chimney,
  solar,
  vent,
  billboard,
};

/** Geometry for one resolved roof feature standing on a roof at `base`. A
 * feature whose kind is not a built-in one is drawn from the composed object
 * of that id; an unknown id draws nothing. */
export function roofFeatureParts(
  feature: ResolvedRoofFeature,
  base: number,
  objects: readonly RunCustomObject[] = [],
): RoofFeatureParts {
  const builder = new Builder(feature, base);
  const builtIn = (BUILDERS as Record<string, (b: Builder) => void>)[
    feature.kind
  ];
  if (builtIn) builtIn(builder);
  else {
    const object = objects.find((o) => o.id === feature.kind);
    // Deep pieces are drawn a little way in from the parapet so they do not
    // hang over the street, but never far enough to cover the helipad.
    const inset = object
      ? Math.min(0.8, Math.max(0, object.size.d / 2 - 0.3))
      : 0;
    object?.parts.forEach((part) => builder.objectPart(part, inset));
  }
  return {
    solid: builder.solid,
    lamps: builder.lamps,
    animated: builder.animated,
  };
}
