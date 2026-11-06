import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import type { RunNeighborStyle } from "../setting-catalog.mjs";

/** The non-building neighbour looks. A block keeps the exact footprint (and so
 * the exact collision box) the city plan gave it; every piece below stays
 * inside that footprint and only changes what stands there. */
export type NeighborStyle = Exclude<RunNeighborStyle, "buildings">;
export type NeighborLayer = "solid" | "glow" | "ice";
export interface Footprint {
  /** Centre. */
  x: number;
  z: number;
  w: number;
  d: number;
}
export type NeighborEmit = (
  geometry: BufferGeometry,
  color: string,
  layer: NeighborLayer,
) => void;
/** Shared across a whole city so the piece count stays bounded. */
export interface NeighborBudget {
  left: number;
}

const hashInt = (value: number) => {
  let v = Math.imul(value ^ 0x5bd1e995, 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return (v ^ (v >>> 16)) >>> 0;
};
export function randomStream(seed: number) {
  let state = hashInt(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const tmp = new Color();
export function shade(hex: string, factor: number) {
  return `#${tmp.set(hex).multiplyScalar(factor).getHexString()}`;
}
export function mix(a: string, b: string, t: number) {
  return `#${tmp.set(a).lerp(new Color(b), t).getHexString()}`;
}
function hueShift(hex: string, hue: number, lightness = 0) {
  const hsl = { h: 0, s: 0, l: 0 };
  tmp.set(hex).getHSL(hsl);
  return `#${tmp
    .setHSL(
      (hsl.h + hue + 1) % 1,
      hsl.s,
      Math.min(0.9, Math.max(0.08, hsl.l + lightness)),
    )
    .getHexString()}`;
}

/** The tallest a block of each style reaches. */
const CAP: Record<NeighborStyle, number> = {
  ruins: 11,
  rocks: 9,
  trees: 14,
  ice: 16,
  coral: 8,
  dunes: 6.5,
  crystals: 18,
  tents: 6,
  hedges: 3.4,
};
/** Height of the solid mass filling the unseen interior of a large block. */
const CORE: Record<NeighborStyle, number> = {
  ruins: 3,
  rocks: 5,
  trees: 8,
  ice: 7,
  coral: 2.5,
  dunes: 3,
  crystals: 6,
  tents: 2,
  hedges: 3,
};
/** How far into a block the detailed outer layer reaches. */
export const NEIGHBOR_RIM = 8;

function box(
  emit: NeighborEmit,
  layer: NeighborLayer,
  color: string,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
  d: number,
  yaw = 0,
) {
  emit(new BoxGeometry(w, h, d).rotateY(yaw).translate(x, y, z), color, layer);
}

const UP = new Vector3(0, 1, 0);
function strut(
  emit: NeighborEmit,
  color: string,
  a: Vector3,
  b: Vector3,
  radius: number,
) {
  const direction = b.clone().sub(a),
    length = direction.length();
  if (length < 1e-4) return;
  const mid = a.clone().add(b).multiplyScalar(0.5);
  emit(
    new CylinderGeometry(radius * 0.7, radius, length, 5)
      .applyQuaternion(
        new Quaternion().setFromUnitVectors(UP, direction.normalize()),
      )
      .translate(mid.x, mid.y, mid.z),
    color,
    "solid",
  );
}

/** One piece of a block. `f` is the piece's own cell; the style fills it. */
export function neighborCell(
  style: NeighborStyle,
  f: Footprint,
  height: number,
  color: string,
  seed: number,
  emit: NeighborEmit,
  lod = false,
) {
  const rnd = randomStream(seed),
    H = Math.min(CAP[style], Math.max(2, height * (0.3 + rnd() * 0.25))),
    area = f.w * f.d,
    scale = lod ? 0.45 : 1,
    n = (per: number, lo: number, hi: number) =>
      Math.max(lo, Math.min(hi, Math.round((area / per) * scale)));
  const minSide = Math.min(f.w, f.d);
  switch (style) {
    case "rocks": {
      box(emit, "solid", shade(color, 0.55), f.x, 0.25, f.z, f.w, 0.5, f.d);
      const count = n(22, 1, 9);
      for (let i = 0; i < count; i++) {
        const r = Math.max(0.6, minSide / 2.4) * (0.55 + rnd() * 0.45),
          rr = Math.min(r, minSide / 2.4),
          sy = Math.max(
            0.5,
            Math.min(1.7, (H * (0.35 + rnd() * 0.65)) / (rr * 1.6)),
          ),
          reach = rr * 1.2,
          cx = pickWithin(f.x, f.w, reach, rnd),
          cz = pickWithin(f.z, f.d, reach, rnd);
        emit(
          new SphereGeometry(rr, 6, 5)
            .scale(1.2, sy, 0.8 + rnd() * 0.4)
            .rotateY(rnd() * 3)
            .translate(cx, rr * sy * 0.55, cz),
          shade(color, 0.7 + rnd() * 0.5),
          "solid",
        );
      }
      return;
    }
    case "trees": {
      box(emit, "solid", shade(color, 0.4), f.x, 0.35, f.z, f.w, 0.7, f.d);
      const spacing = lod ? 6 : 3.6,
        nx = Math.max(1, Math.floor(f.w / spacing)),
        nz = Math.max(1, Math.floor(f.d / spacing));
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
          const cw = f.w / nx,
            cd = f.d / nz,
            r = Math.min(1.6, cw / 2, cd / 2) * (0.75 + rnd() * 0.25),
            cx = f.x - f.w / 2 + cw * (i + 0.5),
            cz = f.z - f.d / 2 + cd * (j + 0.5),
            trunk = Math.max(2.2, Math.min(5, H * 0.35)) * (0.8 + rnd() * 0.4),
            crown = Math.max(3, Math.min(9, H * 0.6)) * (0.8 + rnd() * 0.4),
            leaf = shade(color, 0.65 + rnd() * 0.6);
          emit(
            new CylinderGeometry(0.2, 0.3, trunk, 5).translate(
              cx,
              trunk / 2,
              cz,
            ),
            "#54402c",
            "solid",
          );
          if (rnd() < 0.5) {
            emit(
              new ConeGeometry(r, crown, 6).translate(
                cx,
                trunk + crown / 2 - 0.4,
                cz,
              ),
              leaf,
              "solid",
            );
            emit(
              new ConeGeometry(r * 0.72, crown * 0.7, 6).translate(
                cx,
                trunk + crown * 0.85,
                cz,
              ),
              shade(leaf, 1.1),
              "solid",
            );
          } else
            emit(
              new SphereGeometry(r, 7, 5)
                .scale(1, crown / (r * 2.4), 1)
                .translate(cx, trunk + crown * 0.3, cz),
              leaf,
              "solid",
            );
        }
      return;
    }
    case "ice": {
      box(
        emit,
        "solid",
        shade(color, 0.5),
        f.x,
        H * 0.25,
        f.z,
        Math.max(0.5, f.w - 1),
        H * 0.5,
        Math.max(0.5, f.d - 1),
      );
      const pale = mix(color, "#ffffff", 0.45),
        count = n(30, 1, 5);
      for (let i = 0; i < count; i++) {
        const wi = Math.max(1, Math.min(5, f.w * (0.3 + rnd() * 0.3))),
          di = Math.max(1, Math.min(5, f.d * (0.3 + rnd() * 0.3))),
          hi = H * (0.4 + rnd() * 0.6),
          yaw = rnd() * 1.5,
          reach = Math.hypot(wi, di) / 2;
        box(
          emit,
          "ice",
          shade(pale, 0.9 + rnd() * 0.25),
          pickWithin(f.x, f.w, reach, rnd),
          hi / 2,
          pickWithin(f.z, f.d, reach, rnd),
          wi,
          hi,
          di,
          yaw,
        );
      }
      if (!lod) {
        const r = Math.min(1, minSide / 3);
        emit(
          new ConeGeometry(r, H * 0.9, 4).translate(
            pickWithin(f.x, f.w, r * 1.2, rnd),
            H * 0.45,
            pickWithin(f.z, f.d, r * 1.2, rnd),
          ),
          pale,
          "ice",
        );
      }
      return;
    }
    case "coral": {
      box(emit, "solid", shade(color, 0.5), f.x, 0.18, f.z, f.w, 0.36, f.d);
      const count = n(40, 1, 5),
        half = minSide / 2 - 0.25;
      for (let i = 0; i < count; i++) {
        const root = new Vector3(
            pickWithin(f.x, f.w, Math.min(3, half), rnd),
            0.1,
            pickWithin(f.z, f.d, Math.min(3, half), rnd),
          ),
          length = Math.max(0.8, Math.min(3.3, half / 0.9, H * 0.4)),
          tint = hueShift(color, rnd() * 0.14 - 0.07, rnd() * 0.12 - 0.04);
        const grow = (
          from: Vector3,
          len: number,
          depth: number,
          tilt: number,
        ) => {
          const azimuth = rnd() * Math.PI * 2,
            to = new Vector3(
              from.x + Math.cos(azimuth) * Math.sin(tilt) * len,
              from.y + Math.cos(tilt) * len,
              from.z + Math.sin(azimuth) * Math.sin(tilt) * len,
            );
          strut(emit, tint, from, to, 0.16 * (1 - depth * 0.25));
          if (depth < 2)
            for (let k = 0; k < (lod ? 2 : 3); k++)
              grow(to, len * 0.62, depth + 1, 0.5 + rnd() * 0.4);
          else
            emit(
              new SphereGeometry(0.17, 5, 4).translate(to.x, to.y, to.z),
              shade(tint, 1.25),
              "solid",
            );
        };
        grow(root, length, 0, 0.12);
      }
      return;
    }
    case "dunes": {
      box(emit, "solid", shade(color, 0.9), f.x, 0.3, f.z, f.w, 0.6, f.d);
      const alongX = f.w >= f.d,
        long = alongX ? f.w : f.d,
        count = Math.max(1, Math.min(4, Math.round((long / 9) * scale)));
      for (let i = 0; i < count; i++) {
        const seg = long / count,
          centre = -long / 2 + seg * (i + 0.5),
          rx = alongX ? seg / 2 : f.w / 2,
          rz = alongX ? f.d / 2 : seg / 2;
        emit(
          new SphereGeometry(1, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2)
            .scale(rx, H * (0.35 + rnd() * 0.65), rz)
            .translate(
              f.x + (alongX ? centre : 0),
              0,
              f.z + (alongX ? 0 : centre),
            ),
          shade(color, 0.85 + rnd() * 0.3),
          "solid",
        );
      }
      return;
    }
    case "crystals": {
      box(emit, "solid", shade(color, 0.4), f.x, 0.25, f.z, f.w, 0.5, f.d);
      const inset = Math.max(0.6, Math.min(2.6, minSide / 2 - 0.2)),
        clusters = n(36, 1, 5);
      for (let i = 0; i < clusters; i++) {
        const cx = pickWithin(f.x, f.w, inset, rnd),
          cz = pickWithin(f.z, f.d, inset, rnd),
          prisms = lod ? 3 : 3 + Math.floor(rnd() * 4);
        for (let k = 0; k < prisms; k++) {
          const r = Math.min(0.9, 0.35 + rnd() * 0.55, inset / 2),
            h = Math.max(2, H * (0.35 + rnd() * 0.65)),
            tilt = Math.min(
              0.22,
              Math.asin(Math.min(1, Math.max(0, inset - r) / h)),
            ),
            az = rnd() * Math.PI * 2,
            tint = shade(color, 0.75 + rnd() * 0.5),
            place = (g: BufferGeometry) =>
              g
                .rotateX(tilt * Math.cos(az))
                .rotateZ(tilt * Math.sin(az))
                .translate(cx, 0, cz);
          emit(
            place(
              new CylinderGeometry(r * 0.55, r, h * 0.72, 6).translate(
                0,
                h * 0.36,
                0,
              ),
            ),
            tint,
            "solid",
          );
          emit(
            place(
              new ConeGeometry(r * 0.55, h * 0.28, 6).translate(
                0,
                h * 0.72 + h * 0.14,
                0,
              ),
            ),
            mix(tint, "#ffffff", 0.3),
            rnd() < 0.5 ? "glow" : "solid",
          );
        }
      }
      return;
    }
    case "tents": {
      box(emit, "solid", shade(color, 0.6), f.x, 0.15, f.z, f.w, 0.3, f.d);
      const cell = lod ? 12 : 6,
        nx = Math.max(1, Math.floor(f.w / cell)),
        nz = Math.max(1, Math.floor(f.d / cell));
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
          const cw = f.w / nx,
            cd = f.d / nz,
            half = (Math.min(cw, cd) / 2) * 0.9,
            wall = 1.4,
            peak = Math.max(2.2, Math.min(CAP.tents - wall, H * 0.5)),
            cx = f.x - f.w / 2 + cw * (i + 0.5),
            cz = f.z - f.d / 2 + cd * (j + 0.5),
            tint = (i + j) % 2 ? shade(color, 1) : mix(color, "#e8dfc8", 0.55);
          box(
            emit,
            "solid",
            shade(tint, 0.85),
            cx,
            wall / 2 + 0.3,
            cz,
            half * 2,
            wall,
            half * 2,
          );
          emit(
            new ConeGeometry(half * Math.SQRT2, peak, 4)
              .rotateY(Math.PI / 4)
              .translate(cx, 0.3 + wall + peak / 2, cz),
            tint,
            "solid",
          );
          emit(
            new CylinderGeometry(0.05, 0.05, 1.2, 4).translate(
              cx,
              0.3 + wall + peak + 0.5,
              cz,
            ),
            "#4b3f33",
            "solid",
          );
        }
      return;
    }
    case "hedges": {
      const cell = lod ? 8 : 4,
        nx = Math.max(1, Math.round(f.w / cell)),
        nz = Math.max(1, Math.round(f.d / cell));
      for (let i = 0; i < nx; i++)
        for (let j = 0; j < nz; j++) {
          const cw = f.w / nx,
            cd = f.d / nz,
            h = 2 + rnd() * (CAP.hedges - 2),
            cx = f.x - f.w / 2 + cw * (i + 0.5),
            cz = f.z - f.d / 2 + cd * (j + 0.5),
            tint = shade(color, 0.8 + rnd() * 0.4);
          box(emit, "solid", tint, cx, h / 2, cz, cw - 0.1, h, cd - 0.1);
          box(
            emit,
            "solid",
            shade(tint, 1.12),
            cx,
            h + 0.15,
            cz,
            (cw - 0.1) * 0.78,
            0.3,
            (cd - 0.1) * 0.78,
          );
        }
      return;
    }
    default: {
      // Ruins: a ragged ring of broken wall around a rubble-filled lot.
      box(emit, "solid", shade(color, 0.55), f.x, 0.6, f.z, f.w, 1.2, f.d);
      const t = Math.min(0.5, minSide / 3),
        segment = lod ? 7 : 3.5;
      for (const side of [-1, 1]) {
        for (const alongX of [true, false]) {
          const length = alongX ? f.w : f.d,
            count = Math.max(1, Math.round(length / segment));
          for (let i = 0; i < count; i++) {
            const seg = length / count,
              h = 1.2 + rnd() * Math.min(H - 1.2, 8) * (rnd() < 0.3 ? 0.2 : 1),
              along = -length / 2 + seg * (i + 0.5),
              tint = shade(color, 0.7 + rnd() * 0.5);
            if (alongX)
              box(
                emit,
                "solid",
                tint,
                f.x + along,
                h / 2,
                f.z + side * (f.d / 2 - t / 2),
                seg,
                h,
                t,
              );
            else
              box(
                emit,
                "solid",
                tint,
                f.x + side * (f.w / 2 - t / 2),
                h / 2,
                f.z + along,
                t,
                h,
                seg,
              );
          }
        }
      }
      if (!lod) {
        const r = Math.min(0.9, minSide / 4);
        emit(
          new CylinderGeometry(r * 0.7, r, H, 6).translate(
            pickWithin(f.x, f.w, r, rnd),
            H / 2,
            pickWithin(f.z, f.d, r, rnd),
          ),
          shade(color, 0.85),
          "solid",
        );
        for (let i = 0; i < n(30, 0, 4); i++) {
          const s = 0.6 + rnd() * 0.8;
          box(
            emit,
            "solid",
            shade(color, 0.6 + rnd() * 0.4),
            pickWithin(f.x, f.w, s, rnd),
            1.2 + s / 2,
            pickWithin(f.z, f.d, s, rnd),
            s,
            s,
            s,
            rnd() * 3,
          );
        }
      }
    }
  }
}

/** The unseen interior of a large block: a single low mass. */
export function neighborCore(
  style: NeighborStyle,
  f: Footprint,
  color: string,
  emit: NeighborEmit,
) {
  const layer: NeighborLayer = "solid";
  const h = CORE[style];
  box(
    emit,
    layer,
    shade(color, style === "dunes" ? 0.9 : 0.5),
    f.x,
    h / 2,
    f.z,
    f.w,
    h,
    f.d,
  );
}

/** A raised bed that holds scenery on a lot the city otherwise fills. */
export function neighborPlinth(
  f: Footprint,
  color: string,
  emit: NeighborEmit,
  height = PLINTH,
) {
  box(
    emit,
    "solid",
    shade(color, 0.55),
    f.x,
    height / 2,
    f.z,
    f.w,
    height,
    f.d,
  );
}
export const PLINTH = 1;

/** A stone for road clutter on a ground with no streets to park on. */
export function neighborStone(
  x: number,
  z: number,
  size: number,
  color: string,
  seed: number,
  emit: NeighborEmit,
) {
  const rnd = randomStream(seed);
  emit(
    new SphereGeometry(size, 6, 5)
      .scale(1.15, 0.6 + rnd() * 0.3, 0.85 + rnd() * 0.3)
      .rotateY(rnd() * 3)
      .translate(x, size * 0.3, z),
    shade(color, 0.7 + rnd() * 0.4),
    "solid",
  );
}

/** Cells of one lot for a style: a rim of detailed pieces along the faces the
 * player can see and one core mass for the rest. */
export function lotCells(
  lot: Footprint,
  rim: number,
  cell: number,
): { rim: Footprint[]; core?: Footprint } {
  const out: Footprint[] = [],
    tile = (x: number, z: number, w: number, d: number, alongX: boolean) => {
      const length = alongX ? w : d,
        count = Math.max(1, Math.ceil(length / cell)),
        step = length / count;
      for (let i = 0; i < count; i++)
        out.push(
          alongX
            ? { x: x - w / 2 + step * (i + 0.5), z, w: step, d }
            : { x, z: z - d / 2 + step * (i + 0.5), w, d: step },
        );
    };
  const rx = Math.min(rim, lot.w / 2),
    rz = Math.min(rim, lot.d / 2);
  if (lot.w <= 2 * rim || lot.d <= 2 * rim) {
    // A thin lot is all rim: tile its long axis.
    const alongX = lot.w >= lot.d;
    tile(lot.x, lot.z, lot.w, lot.d, alongX);
    return { rim: out };
  }
  tile(lot.x, lot.z - lot.d / 2 + rz / 2, lot.w, rz, true);
  tile(lot.x, lot.z + lot.d / 2 - rz / 2, lot.w, rz, true);
  const innerD = lot.d - 2 * rz;
  tile(lot.x - lot.w / 2 + rx / 2, lot.z, rx, innerD, false);
  tile(lot.x + lot.w / 2 - rx / 2, lot.z, rx, innerD, false);
  return {
    rim: out,
    core: { x: lot.x, z: lot.z, w: lot.w - 2 * rx, d: innerD },
  };
}

function pickWithin(
  centre: number,
  size: number,
  margin: number,
  rnd: () => number,
) {
  const span = size - 2 * margin;
  return span <= 0 ? centre : centre - span / 2 + rnd() * span;
}
