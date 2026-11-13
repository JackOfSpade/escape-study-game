/**
 * Geometry for an AI-drawn outdoors (src/outdoor-plan.mjs): the authored
 * solid kinds the neighbour renderers do not cover, the backdrop beyond the
 * playable bounds, and an enclosing dome or cave roof. Everything here is
 * visual only; collision comes from the compiled CityPlan.
 */
import {
  BoxGeometry,
  ConeGeometry,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  type BufferGeometry,
} from "three";
import type { CityObstacle, CityPlan } from "../city-layout";
import type { OutdoorBackdrop, OutdoorEnclosure } from "../outdoor-plan.mjs";
import type { NeighborStyle } from "./neighbors";

export type OutdoorLayer = "solid" | "glass" | "water";
export type OutdoorEmit = (
  geometry: BufferGeometry,
  color: string,
  layer: OutdoorLayer,
) => void;

/** Authored kinds drawn by the existing themed-neighbour renderers. */
export function neighbourStyleOf(
  kind: CityObstacle["kind"],
): NeighborStyle | undefined {
  switch (kind) {
    case "rocks":
    case "cliff":
      return "rocks";
    case "trees":
    case "ice":
    case "coral":
    case "dunes":
    case "crystals":
    case "tents":
    case "hedges":
    case "ruins":
      return kind;
    default:
      return undefined;
  }
}

const box = (
  emit: OutdoorEmit,
  layer: OutdoorLayer,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  color: string,
) => emit(new BoxGeometry(w, h, d).translate(x, y, z), color, layer);

/** Draw one authored obstacle whose kind has no neighbour style. Returns
 * false for kinds the caller draws itself (buildings, vehicles, themed). */
export function drawAuthoredObstacle(o: CityObstacle, emit: OutdoorEmit) {
  switch (o.kind) {
    case "water": {
      // A water surface laid just over the ground plane (which sits at
      // -0.035), above paths, so the ground never shows through it.
      emit(
        new PlaneGeometry(o.w, o.h)
          .rotateX(-Math.PI / 2)
          .translate(o.x, 0.012, o.y),
        o.color,
        "water",
      );
      return true;
    }
    case "dome-wall": {
      // Glazed panels between structural ribs.
      const along = o.w >= o.h,
        length = along ? o.w : o.h,
        ribs = Math.max(2, Math.ceil(length / 3));
      box(emit, "glass", o.x, o.height / 2, o.y, o.w, o.height, o.h, o.color);
      for (let i = 0; i <= ribs; i++) {
        const t = -length / 2 + (length / ribs) * i;
        box(
          emit,
          "solid",
          o.x + (along ? t : 0),
          o.height / 2,
          o.y + (along ? 0 : t),
          along ? 0.18 : o.w + 0.08,
          o.height,
          along ? o.h + 0.08 : 0.18,
          "#5f6b72",
        );
      }
      box(emit, "solid", o.x, 0.15, o.y, o.w + 0.1, 0.3, o.h + 0.1, "#4a5359");
      return true;
    }
    case "fence": {
      const along = o.w >= o.h,
        length = along ? o.w : o.h,
        posts = Math.max(2, Math.ceil(length / 2.2)),
        height = Math.min(o.height, 2.2);
      for (let i = 0; i <= posts; i++) {
        const t = -length / 2 + (length / posts) * i;
        box(
          emit,
          "solid",
          o.x + (along ? t : 0),
          height / 2,
          o.y + (along ? 0 : t),
          0.12,
          height,
          0.12,
          o.color,
        );
      }
      for (const level of [0.35, 0.75])
        box(
          emit,
          "solid",
          o.x,
          height * level,
          o.y,
          along ? o.w : 0.06,
          0.08,
          along ? 0.06 : o.h,
          o.color,
        );
      return true;
    }
    case "low-wall": {
      const height = Math.min(o.height, 1.4);
      box(emit, "solid", o.x, height / 2, o.y, o.w, height, o.h, o.color);
      box(
        emit,
        "solid",
        o.x,
        height + 0.05,
        o.y,
        o.w + 0.1,
        0.1,
        o.h + 0.1,
        "#6a6f6c",
      );
      return true;
    }
    case "structure": {
      box(emit, "solid", o.x, o.height / 2, o.y, o.w, o.height, o.h, o.color);
      box(
        emit,
        "solid",
        o.x,
        o.height + 0.12,
        o.y,
        o.w * 0.9,
        0.24,
        o.h * 0.9,
        "#3e474c",
      );
      return true;
    }
    default:
      return false;
  }
}

function hash(seed: number, n: number) {
  let v = Math.imul(n ^ seed, 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return ((v ^ (v >>> 16)) >>> 0) / 0x100000000;
}

/** Unreachable silhouettes beyond the bounds (everything except "skyline",
 * which keeps the city backdrop). A fixed budget of pieces per kind. */
export function drawBackdrop(
  kind: OutdoorBackdrop,
  plan: CityPlan,
  emit: OutdoorEmit,
  color: string,
) {
  if (kind === "skyline" || kind === "none" || kind === "stars") return;
  const b = plan.bounds,
    cx = (b.left + b.right) / 2,
    cz = (b.top + b.bottom) / 2,
    reach = Math.hypot(b.right - b.left, b.bottom - b.top) / 2;
  if (kind === "sea") {
    // A wide water ring from the bounds edge to the fog horizon.
    emit(
      new PlaneGeometry(2 * (reach + 420), 2 * (reach + 420))
        .rotateX(-Math.PI / 2)
        .translate(cx, -0.09, cz),
      color,
      "water",
    );
    return;
  }
  const count = kind === "forest" ? 120 : kind === "cavern-wall" ? 36 : 48;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + hash(plan.seed, i) * 0.2,
      distance = reach + 30 + hash(plan.seed, i + 997) * 60,
      x = cx + Math.cos(angle) * distance,
      z = cz + Math.sin(angle) * distance,
      r = hash(plan.seed, i + 31);
    if (kind === "mountains")
      emit(
        new ConeGeometry(28 + r * 30, 40 + r * 70, 6).translate(
          x,
          (40 + r * 70) / 2,
          z,
        ),
        color,
        "solid",
      );
    else if (kind === "dunes")
      emit(
        new SphereGeometry(30 + r * 25, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2)
          .scale(1.6, 0.35, 1)
          .rotateY(angle)
          .translate(x, 0, z),
        color,
        "solid",
      );
    else if (kind === "forest")
      emit(
        new ConeGeometry(4 + r * 3, 14 + r * 12, 6).translate(
          x,
          (14 + r * 12) / 2,
          z,
        ),
        color,
        "solid",
      );
    else if (kind === "ice-field")
      emit(
        new ConeGeometry(10 + r * 14, 8 + r * 20, 4)
          .rotateY(r * 3)
          .translate(x, (8 + r * 20) / 2, z),
        color,
        "solid",
      );
    else if (kind === "cavern-wall")
      emit(
        new BoxGeometry(40, 60, 18)
          .rotateY(-angle)
          .translate(
            cx + Math.cos(angle) * (reach + 20),
            30,
            cz + Math.sin(angle) * (reach + 20),
          ),
        color,
        "solid",
      );
  }
}

/** A dome or a cave roof over the playable bounds, or nothing. The caller
 * owns and disposes the returned mesh's geometry and material. */
export function enclosureMesh(
  kind: OutdoorEnclosure,
  plan: CityPlan,
): Mesh | undefined {
  if (kind === "open-sky") return undefined;
  const b = plan.bounds,
    cx = (b.left + b.right) / 2,
    cz = (b.top + b.bottom) / 2,
    rx = (b.right - b.left) / 2,
    rz = (b.bottom - b.top) / 2;
  if (kind === "dome") {
    const radius = Math.hypot(rx, rz) * 1.02,
      geometry = new SphereGeometry(
        radius,
        48,
        16,
        0,
        Math.PI * 2,
        0,
        Math.PI / 2,
      )
        .scale(
          (rx / radius) * 1.42,
          Math.min(1, 45 / radius),
          (rz / radius) * 1.42,
        )
        .translate(cx, 0, cz),
      material = new MeshStandardMaterial({
        color: "#bcd6e0",
        roughness: 0.08,
        metalness: 0.1,
        transparent: true,
        opacity: 0.16,
        depthWrite: false,
        side: DoubleSide,
        fog: true,
      }),
      mesh = new Mesh(geometry, material);
    mesh.name = "outdoor-enclosure-dome";
    return mesh;
  }
  const geometry = new PlaneGeometry(2 * rx + 80, 2 * rz + 80)
      .rotateX(Math.PI / 2)
      .translate(cx, 28, cz),
    material = new MeshStandardMaterial({
      color: "#2a2724",
      roughness: 1,
      fog: true,
    }),
    mesh = new Mesh(geometry, material);
  mesh.name = "outdoor-enclosure-cavern";
  return mesh;
}
