import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { CONFIG, type Floor } from "../model";
import { FLOOR_HEIGHT } from "../stair-route";
import { outsideBuilding } from "./exterior-layout";
import type { RunFacade, RunWindowStyle } from "../setting-catalog.mjs";
import { resolveRoofFeatures } from "../venue";
import { roofFeatureParts } from "./roof-features";

export interface PerimeterWindow {
  x: number;
  z: number;
  /** Direction along the window opening. */
  axis: "x" | "z";
  /** Outward direction along the other horizontal axis. */
  normal: -1 | 1;
}

function inside(floor: Floor, x: number, z: number) {
  return !outsideBuilding(floor, x + 0.5, z + 0.5);
}

/** Only the one-cell outer shell belongs to the facade. Interior partitions
 * and the collision grid remain authoritative and are never edited here. */
export function isPerimeterWall(floor: Floor, x: number, z: number) {
  return (
    !!floor.boundary &&
    !!floor.tiles[z]?.[x] &&
    !inside(floor, x, z) &&
    [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ].some(([dx, dz]) => inside(floor, x + dx, z + dz))
  );
}

export function perimeterWindows(floor: Floor): PerimeterWindow[] {
  if (!floor.boundary || floor.index === CONFIG.floors) return [];
  const windows: PerimeterWindow[] = [];
  for (let z = 0; z < floor.tiles.length; z++)
    for (let x = 0; x < floor.tiles[z].length; x++) {
      if (!isPerimeterWall(floor, x, z)) continue;
      const neighbors = [
        [0, -1],
        [0, 1],
        [-1, 0],
        [1, 0],
      ].filter(([dx, dz]) => inside(floor, x + dx, z + dz));
      if (neighbors.length !== 1) continue;
      const [dx, dz] = neighbors[0];
      // A window opens onto a usable room, never onto the back of a partition.
      if (floor.tiles[z + dz]?.[x + dx] !== 0) continue;
      // Corner piers remain solid and give the building a structural rhythm.
      if (
        dx
          ? !isPerimeterWall(floor, x, z - 1) ||
            !isPerimeterWall(floor, x, z + 1)
          : !isPerimeterWall(floor, x - 1, z) ||
            !isPerimeterWall(floor, x + 1, z)
      )
        continue;
      windows.push({
        x: x + 0.5,
        z: z + 0.5,
        axis: dx ? "z" : "x",
        normal: -(dx || dz) as -1 | 1,
      });
    }
  return windows;
}

/** Window opening proportions, relative to a storey that starts at y = 0. The
 * default is the original punched window, in its original literal numbers. */
interface WindowSpec {
  bottom: [number, number]; // centre y, height of the wall below the opening
  top: [number, number];
  pier: [number, number] | null; // offset from cell centre, thickness
  side: [number, number]; // centre y, height of frame and pier
  frame: [number, number]; // offset, thickness of the vertical frame bars
  bars: [number, number]; // y of the horizontal frame bars
  barLength: number;
  glass: [number, number, number]; // width, height, centre y
  sill: [number, number, number]; // y, length along the wall, across it
}

const PUNCHED: WindowSpec = {
  bottom: [0.425, 0.85],
  top: [2.575, 0.45],
  pier: [0.46, 0.08],
  side: [1.6, 1.5],
  frame: [0.4, 0.035],
  bars: [0.89, 2.31],
  barLength: 0.84,
  glass: [0.79, 1.35, 1.6],
  sill: [0.855, 0.92, 1.12],
};

function windowSpec(style: RunWindowStyle, curtain: boolean): WindowSpec {
  if (style === "punched" && !curtain) return PUNCHED;
  let [sill, head, pier] =
    style === "strip"
      ? [1.0, 2.15, 0]
      : style === "ribbon"
        ? [1.2, 1.9, 0]
        : style === "slit"
          ? [0.45, 2.5, 0.3]
          : [0.85, 2.35, 0.08];
  // A curtain wall is mostly glass between hairline piers.
  if (curtain) {
    sill = Math.max(0.25, sill - 0.3);
    head = Math.min(2.6, head + 0.15);
    pier = Math.min(pier, 0.03);
  }
  const half = 0.5 - pier,
    open = head - sill,
    mid = (sill + head) / 2;
  return {
    bottom: [sill / 2, sill],
    top: [(head + 2.8) / 2, 2.8 - head],
    pier: pier ? [0.5 - pier / 2, pier] : null,
    side: [mid, open],
    frame: [half - 0.02, 0.03],
    bars: [sill + 0.04, head - 0.04],
    barLength: half * 2,
    glass: [half * 2 - 0.05, open - 0.15, mid],
    sill: [sill + 0.005, half * 2 + 0.08, half * 2 + 0.28],
  };
}

const COURSE: Partial<Record<RunFacade, { height: number; grow: number }>> = {
  brick: { height: 0.28, grow: 0.012 },
  clapboard: { height: 0.23, grow: 0.03 },
  metal: { height: 0.7, grow: 0 },
};

function noise(a: number, b: number, c: number) {
  const n = Math.imul(
    (a * 73856093) ^ (b * 19349663) ^ (c * 83492791),
    2654435761,
  );
  return (n >>> 0) / 4294967296;
}

/** A solid colour scaled in linear light, returned as sRGB hex. */
function tone(hex: string, factor: number) {
  return `#${new Color(hex).multiplyScalar(factor).getHexString()}`;
}

/** A persistent whole-building facade. Every storey is present from the street
 * and every real window is an opening through the entire shell thickness. */
export class BuildingShell {
  readonly group = new Group();
  private structure = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
  });
  private frames = new MeshStandardMaterial({
    color: "#263e48",
    roughness: 0.55,
    metalness: 0.4,
  });
  private glass = new MeshStandardMaterial({
    color: "#9ab5bd",
    transparent: true,
    opacity: 0.1,
    depthWrite: false,
    roughness: 0.3,
    metalness: 0.05,
  });
  private roofMetal = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.62,
    metalness: 0.3,
    side: DoubleSide,
  });
  private roofLamps = new MeshBasicMaterial({
    vertexColors: true,
    side: DoubleSide,
  });
  private tint = new Color();

  constructor() {
    this.group.name = "building-shell";
  }

  build(floors: Floor[]) {
    this.clear();
    this.group.visible = !!floors[0]?.boundary;
    if (!this.group.visible) return;
    // A designed building restyles its facade, windows, wall faces and roof.
    // Without a setting every colour and dimension below is the original.
    const setting = floors[0].setting,
      ext = setting?.exterior,
      facade = ext?.facade,
      course = facade ? COURSE[facade] : undefined,
      curtain = facade === "glass",
      spec = ext ? windowSpec(ext.windows, curtain) : PUNCHED,
      liner = setting?.interior.wall;
    this.frames.color.set(
      ext ? (curtain ? "#1c262c" : tone(ext.trimColor, 0.75)) : "#263e48",
    );
    this.glass.color.set(curtain ? "#3d6b7c" : "#9ab5bd");
    this.glass.opacity = curtain ? 0.24 : 0.1;
    this.group.userData = ext ? { facade, windows: ext.windows } : {};
    const baseColor = (x: number, z: number) =>
      ext
        ? (x + z) % 7 === 0
          ? tone(ext.facadeColor, 0.81)
          : ext.facadeColor
        : (x + z) % 7 === 0
          ? "#657779"
          : "#7e8987";
    const trim = ext?.trimColor ?? "#465e68";
    const walls: BufferGeometry[] = [],
      frames: BufferGeometry[] = [],
      glass: BufferGeometry[] = [];
    const box = (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color?: string,
    ) => {
      const geometry = new BoxGeometry(w, h, d).translate(x, y, z);
      if (color) {
        this.tint.set(color);
        const values = new Float32Array(
          geometry.getAttribute("position").count * 3,
        );
        for (let i = 0; i < values.length; i += 3) this.tint.toArray(values, i);
        geometry.setAttribute("color", new Float32BufferAttribute(values, 3));
      }
      out.push(geometry);
    };
    /** One piece of solid facade wall: a single box, or courses of brick,
     * boards, panels or glazing bands when the building has a finish. */
    const piece = (
      x: number,
      z: number,
      cx: number,
      cz: number,
      base: number,
      yc: number,
      h: number,
      w: number,
      d: number,
      color: string,
      storey: number,
    ) => {
      if (!ext || facade === "concrete") {
        box(walls, cx, base + yc, cz, w, h, d, color);
        return;
      }
      const y0 = yc - h / 2,
        y1 = yc + h / 2,
        cut = course ? course.height : facade === "stucco" ? 0.45 : 0;
      const edges = [y0];
      if (facade === "glass") {
        for (const e of [0.85, 2.35]) if (e > y0 && e < y1) edges.push(e);
      } else if (facade === "stucco") {
        if (cut > y0 && cut < y1) edges.push(cut);
      } else
        for (
          let e = (Math.floor(y0 / cut + 1e-6) + 1) * cut;
          e < y1 - 1e-6;
          e += cut
        )
          edges.push(e);
      edges.push(y1);
      for (let i = 0; i < edges.length - 1; i++) {
        const a = edges[i],
          b = edges[i + 1],
          mid = (a + b) / 2;
        let factor = 1,
          grow = 0;
        if (facade === "brick") {
          const k = Math.floor(mid / cut);
          factor = 0.86 + 0.26 * noise(x, z, k + storey * 13);
          if (k % 9 === 8) factor *= 0.82;
          grow = k % 2 ? course!.grow : 0;
        } else if (facade === "clapboard") {
          const k = Math.floor(mid / cut);
          factor = 0.95 + 0.05 * (k % 2) + 0.03 * noise(x, z, k);
          grow = k % 2 ? course!.grow : 0;
        } else if (facade === "metal") {
          const k = Math.floor(mid / cut);
          factor = 0.93 + 0.09 * ((x + z + k) % 2);
        } else if (facade === "stucco") {
          factor = mid < cut ? 0.78 : 0.96 + 0.06 * noise(x, z, storey);
        } else if (facade === "glass") {
          factor = mid < 0.85 || mid > 2.35 ? 0.55 : 1.12;
        }
        box(
          walls,
          cx,
          base + mid,
          cz,
          w + grow,
          b - a,
          d + grow,
          tone(color, factor),
        );
      }
    };
    /** Plaster in the interior wall colour over the faces that look inward. */
    const lining = (
      cx: number,
      cz: number,
      base: number,
      yc: number,
      h: number,
      w: number,
      d: number,
      inward: readonly (readonly [number, number])[],
    ) => {
      if (!liner) return;
      for (const [dx, dz] of inward)
        box(
          walls,
          cx + dx * 0.51 * (w === 1 ? 1 : 0),
          base + yc,
          cz + dz * 0.51 * (d === 1 ? 1 : 0),
          dx ? 0.02 : w,
          h,
          dz ? 0.02 : d,
          liner,
        );
    };
    for (const floor of floors) {
      if (!floor.boundary) continue;
      const base = floor.index * FLOOR_HEIGHT,
        roof = floor.index === CONFIG.floors;
      const windows = new Map(
        perimeterWindows(floor).map((w) => [`${w.x}/${w.z}`, w]),
      );
      for (let z = 0; z < floor.tiles.length; z++)
        for (let x = 0; x < floor.tiles[z].length; x++) {
          if (!isPerimeterWall(floor, x, z)) continue;
          const cx = x + 0.5,
            cz = z + 0.5,
            window = windows.get(`${cx}/${cz}`);
          const color = roof
            ? ext
              ? tone(ext.facadeColor, 1.12)
              : "#8d9694"
            : baseColor(x, z);
          if (roof) {
            piece(x, z, cx, cz, base, 0.46, 0.92, 1, 1, color, floor.index);
            box(
              walls,
              cx,
              base + 0.96,
              cz,
              1.06,
              0.08,
              1.06,
              ext ? ext.trimColor : "#b0b5a7",
            );
            continue;
          }
          // The faces of this cell that look into the building.
          const inward = (
            [
              [0, -1],
              [0, 1],
              [-1, 0],
              [1, 0],
            ] as const
          ).filter(([dx, dz]) => inside(floor, x + dx, z + dz));
          if (!window) {
            piece(x, z, cx, cz, base, 1.4, 2.8, 1, 1, color, floor.index);
            lining(cx, cz, base, 1.4, 2.8, 1, 1, inward);
            if (curtain)
              for (const sx of [-1, 1])
                for (const sz of [-1, 1])
                  box(
                    walls,
                    cx + sx * 0.485,
                    base + 1.4,
                    cz + sz * 0.485,
                    0.07,
                    2.8,
                    0.07,
                    ext!.trimColor,
                  );
            else if (facade === "metal")
              for (const [w, d] of [
                [0.05, 1.03],
                [1.03, 0.05],
              ])
                box(walls, cx, base + 1.4, cz, w, 2.8, d, ext!.trimColor);
          } else {
            const alongX = window.axis === "x",
              back: readonly (readonly [number, number])[] = alongX
                ? [[0, -window.normal]]
                : [[-window.normal, 0]];
            piece(
              x,
              z,
              cx,
              cz,
              base,
              spec.bottom[0],
              spec.bottom[1],
              1,
              1,
              color,
              floor.index,
            );
            piece(
              x,
              z,
              cx,
              cz,
              base,
              spec.top[0],
              spec.top[1],
              1,
              1,
              color,
              floor.index,
            );
            lining(cx, cz, base, spec.bottom[0], spec.bottom[1], 1, 1, back);
            lining(cx, cz, base, spec.top[0], spec.top[1], 1, 1, back);
            for (const side of [-1, 1]) {
              if (spec.pier) {
                const [offset, thickness] = spec.pier,
                  px = cx + (alongX ? side * offset : 0),
                  pz = cz + (alongX ? 0 : side * offset),
                  pw = alongX ? thickness : 1,
                  pd = alongX ? 1 : thickness;
                piece(
                  x,
                  z,
                  px,
                  pz,
                  base,
                  spec.side[0],
                  spec.side[1],
                  pw,
                  pd,
                  color,
                  floor.index,
                );
                if (liner)
                  for (const [dx, dz] of back)
                    box(
                      walls,
                      px + dx * 0.51,
                      base + spec.side[0],
                      pz + dz * 0.51,
                      dx ? 0.02 : pw,
                      spec.side[1],
                      dz ? 0.02 : pd,
                      liner,
                    );
              }
              box(
                frames,
                cx + (alongX ? side * spec.frame[0] : 0),
                base + spec.side[0],
                cz + (alongX ? 0 : side * spec.frame[0]),
                alongX ? spec.frame[1] : 0.08,
                spec.side[1],
                alongX ? 0.08 : spec.frame[1],
              );
            }
            for (const height of spec.bars)
              box(
                frames,
                cx,
                base + height,
                cz,
                alongX ? spec.barLength : 0.12,
                0.055,
                alongX ? 0.12 : spec.barLength,
              );
            box(
              glass,
              cx,
              base + spec.glass[2],
              cz,
              alongX ? spec.glass[0] : 0.025,
              spec.glass[1],
              alongX ? 0.025 : spec.glass[0],
            );
            // Projecting sill catches the cold sky light from inside.
            box(
              frames,
              cx,
              base + spec.sill[0],
              cz,
              alongX ? spec.sill[1] : spec.sill[2],
              0.055,
              alongX ? spec.sill[2] : spec.sill[1],
            );
          }
          box(walls, cx, base + 3.2, cz, 1.04, 0.8, 1.04, trim);
        }
      if (!roof) {
        // Open stair/entrance portals still have continuous floor beams above
        // them, rather than a black vertical slot through every storey.
        const southWidth = floor.index === 0 ? 4 : 2;
        box(
          walls,
          22,
          base + 3.2,
          floor.boundary.bottom + 0.5,
          southWidth,
          0.8,
          1.04,
          trim,
        );
        box(
          walls,
          22,
          base + 3.2,
          floor.boundary.top - 0.5,
          2,
          0.8,
          1.04,
          trim,
        );
      }
      // Thin floor plates reveal the true storey spacing without populating
      // undiscovered interiors or creating another active simulation.
      for (let z = floor.boundary.top; z < floor.boundary.bottom; z++) {
        const row = floor.boundary.rows[z];
        box(
          walls,
          (row.left + row.right) / 2,
          // Structure sits below the finished floor (-0.025), rather than
          // hiding it or competing with its texture in the depth buffer.
          base - 0.2,
          z + 0.5,
          row.right - row.left,
          0.2,
          1,
          "#4c5c60",
        );
      }
    }
    this.merge(walls, this.structure, "facade-structure");
    this.merge(frames, this.frames, "facade-window-frames");
    this.merge(glass, this.glass, "facade-glazing");
    if (ext) this.buildRoofFeatures(floors, ext.roofFeatures, setting?.objects);
  }

  /** Radio masts, dishes, tanks and the like stand on the roof's outer ring,
   * leaning toward the parapet. They are visual only: the roof walkable
   * area, helipad and stairs are untouched. */
  private buildRoofFeatures(
    floors: Floor[],
    features: NonNullable<Floor["setting"]>["exterior"]["roofFeatures"],
    objects: NonNullable<Floor["setting"]>["objects"] = [],
  ) {
    const roof = floors.find((f) => f.index === CONFIG.floors);
    if (!roof?.boundary || !features.length) return;
    const solid: BufferGeometry[] = [],
      lamps: BufferGeometry[] = [],
      kinds: string[] = [];
    for (const feature of resolveRoofFeatures(roof.boundary, features)) {
      if (!feature) continue;
      const parts = roofFeatureParts(
        feature,
        CONFIG.floors * FLOOR_HEIGHT,
        objects,
      );
      solid.push(...parts.solid);
      lamps.push(...parts.lamps);
      kinds.push(feature.kind);
    }
    this.merge(solid, this.roofMetal, "roof-feature-structure");
    this.merge(lamps, this.roofLamps, "roof-feature-lamps");
    this.group.userData.roofFeatures = kinds;
  }

  private merge(
    parts: BufferGeometry[],
    material: MeshStandardMaterial | MeshBasicMaterial,
    name: string,
  ) {
    if (!parts.length) return;
    const mesh = new Mesh(mergeGeometries(parts)!, material);
    for (const part of parts) part.dispose();
    mesh.name = name;
    this.group.add(mesh);
  }

  private clear() {
    for (const child of [...this.group.children]) {
      (child as Mesh).geometry.dispose();
      child.removeFromParent();
    }
  }

  dispose() {
    this.clear();
    this.structure.dispose();
    this.frames.dispose();
    this.glass.dispose();
    this.roofMetal.dispose();
    this.roofLamps.dispose();
  }
}
