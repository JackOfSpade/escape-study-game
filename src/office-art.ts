import type { Floor, Furniture, FurnitureKind } from "./model";
import type {
  RunCustomObject,
  RunObjectPart,
  RunTerminal,
} from "./setting-catalog.mjs";
import { partReach } from "./setting-catalog.mjs";
import { H, W } from "./model";
import { inRect, sectorAt } from "./floor-plan";
import { carvedCells, cornerProfile } from "./room-shapes";

/** Procedural top-down office art. Floors, walls and every furniture kind are
 * painted once into cached canvases and reused each frame, so the per-frame
 * cost is a few drawImage calls. Sources and techniques: docs/OFFICE_ART.md. */
export type Theme = "normal" | "mutation";
interface Materials {
  carpet: [string, string];
  carpetAlt: [string, string];
  fibre: string;
  lino: [string, string];
  seam: string;
  concrete: string;
  roof: string;
  wallTop: string;
  wallEdge: string;
  wallShadow: string;
  wood: string;
  woodDark: string;
  laminate: string;
  metal: string;
  metalDark: string;
  white: string;
  fabric: string;
  fabricDark: string;
  screen: string;
  leaf: string;
  leafDark: string;
  pot: string;
  water: string;
  outline: string;
  signal: string;
  studio: [string, string];
  parquet: [string, string];
  terrazzo: [string, string];
  rubber: string;
  polished: string;
}
const MATERIALS: Record<Theme, Materials> = {
  normal: {
    carpet: ["#2f3b48", "#35424f"],
    carpetAlt: ["#3a3644", "#403b4b"],
    fibre: "rgba(210,225,240,0.07)",
    lino: ["#55574f", "#5b5d55"],
    seam: "rgba(20,24,22,0.35)",
    concrete: "#3b3e3d",
    roof: "#45484a",
    wallTop: "#5c6466",
    wallEdge: "#8b9493",
    wallShadow: "rgba(8,12,14,0.45)",
    wood: "#8a6a4a",
    woodDark: "#5e4631",
    laminate: "#b9ae98",
    metal: "#8e989c",
    metalDark: "#5d666a",
    white: "#dfe4e2",
    fabric: "#55667a",
    fabricDark: "#3d4a59",
    screen: "#1b2a33",
    leaf: "#4f9a53",
    leafDark: "#2f6a3a",
    pot: "#a2583a",
    water: "#6fb4e0",
    outline: "#22201e",
    signal: "#d8322b",
    studio: ["#23262b", "#292c32"],
    parquet: ["#9a7448", "#86623c"],
    terrazzo: ["#b9b4a8", "#4f5a5e"],
    rubber: "#2b2d2f",
    polished: "#6c7072",
  },
  mutation: {
    carpet: ["#3a2a48", "#42304f"],
    carpetAlt: ["#4a2d43", "#52334a"],
    fibre: "rgba(250,220,200,0.08)",
    lino: ["#5a4c5c", "#625363"],
    seam: "rgba(20,10,24,0.4)",
    concrete: "#3e3344",
    roof: "#4a3e4e",
    wallTop: "#6b5068",
    wallEdge: "#a48a80",
    wallShadow: "rgba(16,6,20,0.5)",
    wood: "#9a6a5c",
    woodDark: "#6a4440",
    laminate: "#c4a49a",
    metal: "#a08e9e",
    metalDark: "#6a5868",
    white: "#ecdccc",
    fabric: "#7a5670",
    fabricDark: "#583c52",
    screen: "#2a1830",
    leaf: "#a6a84a",
    leafDark: "#6e6a30",
    pot: "#b0604a",
    water: "#d08ad8",
    outline: "#24161e",
    signal: "#e03a52",
    studio: ["#2a2030", "#302636"],
    parquet: ["#a2705a", "#8c5e4c"],
    terrazzo: ["#bcaab0", "#5a4a60"],
    rubber: "#32282f",
    polished: "#75676f",
  },
};
const PX = 40; // terrain pixels per world unit
const SPRITE_PX = 64;

// Deterministic per-cell noise so textures are stable across frames and reloads.
function hash(x: number, y: number, seed: number) {
  let h = Math.imul(x * 374761393 + y * 668265263 + seed * 1442695041, 1);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type Zone =
  | "carpet"
  | "carpetAlt"
  | "lino"
  | "concrete"
  | "roof"
  | "studioCarpet"
  | "parquet"
  | "terrazzo"
  | "rubber"
  | "polished";
/** Which floor finish a cell has: carpeted rooms, vinyl circulation, outside
 * paving. A designed run's setting swaps the room and circulation finishes. */
export function floorZone(f: Floor, x: number, y: number): Zone {
  const z = legacyZone(f, x, y);
  if (!f.setting || z === "concrete" || z === "roof") return z;
  const { roomFloor, hallFloor } = f.setting.interior;
  if (z === "lino") return hallFloor === "carpet" ? "carpet" : hallFloor;
  return roomFloor === "carpet" ? z : roomFloor;
}

function legacyZone(f: Floor, x: number, y: number): Zone {
  if (f.boundary) {
    const row = f.boundary.rows[y];
    if (
      y < f.boundary.top ||
      y >= f.boundary.bottom ||
      !row ||
      x < row.left ||
      x >= row.right
    )
      return "concrete";
    if (f.index === 4) return "roof";
  } else {
    if (f.index === 4) return "roof";
    if (x < 2 || x >= 42 || y < 2 || y >= 28) return "concrete";
  }
  if (f.generation?.sectors) {
    // Version 5: vinyl reception, stair lobby and corridors; carpeted
    // departments, with sub-rooms in a contrasting carpet.
    const sector = sectorAt(f, { x: x + 0.5, y: y + 0.5 });
    if (!sector || sector.room === undefined) return "lino";
    if (sector.corridors.some((c) => inRect(c, x, y))) return "lino";
    const room = sector.rooms.findIndex((r) => inRect(r.rect, x, y));
    const alt = room >= 0 ? (sector.order + room + 1) % 2 : sector.order % 2;
    return alt ? "carpetAlt" : "carpet";
  }
  const stages = f.generation?.stages;
  if (stages) {
    const i = stages.findIndex((s) => y > s.front && y < s.rear);
    if (i < 0) return "lino";
    return i % 2 ? "carpetAlt" : "carpet";
  }
  if (x >= 17 && x <= 26) return "lino";
  return y < 15 ? "carpet" : "carpetAlt";
}

function paintFloorCell(
  c: CanvasRenderingContext2D,
  m: Materials,
  zone: Zone,
  x: number,
  y: number,
  seed: number,
) {
  const px = x * PX,
    py = y * PX;
  if (zone === "carpet" || zone === "carpetAlt") {
    // 50 cm carpet tiles laid quarter-turned, the common commercial pattern.
    const [a, b] = m[zone];
    for (let j = 0; j < 2; j++)
      for (let i = 0; i < 2; i++) {
        const turned = (x * 2 + i + y * 2 + j) % 2 === 0;
        c.fillStyle = turned ? a : b;
        c.fillRect(px + (i * PX) / 2, py + (j * PX) / 2, PX / 2, PX / 2);
        c.strokeStyle = m.fibre;
        c.lineWidth = 1;
        c.beginPath();
        for (let k = 1; k < 5; k++) {
          const o = (k * PX) / 10;
          if (turned) {
            c.moveTo(px + (i * PX) / 2 + o, py + (j * PX) / 2 + 2);
            c.lineTo(px + (i * PX) / 2 + o, py + (j * PX) / 2 + PX / 2 - 2);
          } else {
            c.moveTo(px + (i * PX) / 2 + 2, py + (j * PX) / 2 + o);
            c.lineTo(px + (i * PX) / 2 + PX / 2 - 2, py + (j * PX) / 2 + o);
          }
        }
        c.stroke();
      }
    c.fillStyle = m.seam;
    c.fillRect(px, py, PX, 1);
    c.fillRect(px, py, 1, PX);
    return;
  }
  if (zone === "lino") {
    // Vinyl composition tile: 1 m squares, slightly varied, with chip speckle.
    c.fillStyle = m.lino[(x + y) % 2];
    c.fillRect(px, py, PX, PX);
    for (let k = 0; k < 14; k++) {
      const r = hash(x * 31 + k, y * 17 + k, seed);
      c.fillStyle = r > 0.5 ? "rgba(255,255,255,0.07)" : "rgba(0,0,0,0.12)";
      c.fillRect(
        px + hash(x, y * 7 + k, seed + 3) * PX,
        py + hash(x * 5 + k, y, seed + 9) * PX,
        2,
        2,
      );
    }
    c.fillStyle = m.seam;
    c.fillRect(px, py, PX, 1);
    c.fillRect(px, py, 1, PX);
    return;
  }
  if (zone === "studioCarpet") {
    // Dark low-pile broadcast carpet: tight flecks, faint tile seams.
    c.fillStyle = m.studio[(x + y) % 2];
    c.fillRect(px, py, PX, PX);
    for (let k = 0; k < 40; k++) {
      c.fillStyle =
        hash(x * 13 + k, y * 7, seed + 21) > 0.5
          ? "rgba(190,200,215,0.09)"
          : "rgba(0,0,0,0.22)";
      c.fillRect(
        px + hash(x, y * 9 + k, seed + 4) * PX,
        py + hash(x * 7 + k, y, seed + 6) * PX,
        1.5,
        1.5,
      );
    }
    c.fillStyle = "rgba(0,0,0,0.3)";
    c.fillRect(px, py, PX, 1);
    c.fillRect(px, py, 1, PX);
    return;
  }
  if (zone === "parquet") {
    // Oak strips laid in a herringbone: 20 x 5 cm boards in alternating pairs.
    c.fillStyle = m.parquet[0];
    c.fillRect(px, py, PX, PX);
    const bw = PX / 4,
      bt = PX / 16;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const vertical = (i + j + x + y) % 2 === 0,
          tone = hash(x * 4 + i, y * 4 + j, seed + 31);
        c.fillStyle = tone > 0.5 ? m.parquet[0] : m.parquet[1];
        const bx = px + i * bw,
          by = py + j * bw;
        // Two boards per cell, stacked across the short side.
        for (let b = 0; b < 2; b++) {
          const o = b * (bw / 2);
          if (vertical) c.fillRect(bx + o, by, bw / 2, bw);
          else c.fillRect(bx, by + o, bw, bw / 2);
          c.fillStyle = tone > 0.5 ? m.parquet[1] : m.parquet[0];
        }
        c.fillStyle = "rgba(20,10,0,0.35)";
        if (vertical) {
          c.fillRect(bx, by, 1, bw);
          c.fillRect(bx + bw / 2, by, 1, bw);
        } else {
          c.fillRect(bx, by, bw, 1);
          c.fillRect(bx, by + bw / 2, bw, 1);
        }
        c.fillStyle = "rgba(255,230,190,0.08)";
        c.fillRect(bx + bt, by + bt, 1, 1);
      }
    return;
  }
  if (zone === "terrazzo") {
    // Pale cement matrix with scattered marble chips and brass-free joints.
    c.fillStyle = m.terrazzo[0];
    c.fillRect(px, py, PX, PX);
    for (let k = 0; k < 34; k++) {
      const r = hash(x * 17 + k, y * 5, seed + 41);
      c.fillStyle =
        r > 0.66
          ? m.terrazzo[1]
          : r > 0.33
            ? "rgba(120,110,100,0.5)"
            : "rgba(255,255,255,0.35)";
      const s = 1 + Math.floor(hash(x, y * 3 + k, seed + 43) * 3);
      c.fillRect(
        px + hash(x * 3 + k, y, seed + 45) * (PX - s),
        py + hash(x, y * 13 + k, seed + 47) * (PX - s),
        s,
        s,
      );
    }
    c.fillStyle = m.seam;
    c.fillRect(px, py, PX, 1);
    c.fillRect(px, py, 1, PX);
    return;
  }
  if (zone === "rubber") {
    // Studded rubber flooring: a grid of raised round studs.
    c.fillStyle = m.rubber;
    c.fillRect(px, py, PX, PX);
    for (let j = 0; j < 8; j++)
      for (let i = 0; i < 8; i++) {
        const cx = px + i * 5 + 2.5,
          cy = py + j * 5 + 2.5;
        c.fillStyle = "rgba(0,0,0,0.35)";
        c.beginPath();
        c.arc(cx + 0.6, cy + 0.6, 1.7, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = "rgba(255,255,255,0.1)";
        c.beginPath();
        c.arc(cx - 0.3, cy - 0.3, 1.6, 0, Math.PI * 2);
        c.fill();
      }
    c.fillStyle = m.seam;
    c.fillRect(px, py, PX, 1);
    c.fillRect(px, py, 1, PX);
    return;
  }
  if (zone === "polished") {
    // Polished concrete: soft clouding and a saw-cut joint every 2 m.
    c.fillStyle = m.polished;
    c.fillRect(px, py, PX, PX);
    for (let k = 0; k < 5; k++) {
      c.fillStyle =
        hash(x + k * 3, y * 5 + k, seed + 51) > 0.5
          ? "rgba(255,255,255,0.045)"
          : "rgba(0,0,0,0.06)";
      c.beginPath();
      c.arc(
        px + hash(x * 5 + k, y, seed + 53) * PX,
        py + hash(x, y * 5 + k, seed + 55) * PX,
        8 + hash(x + k, y + k, seed + 57) * 12,
        0,
        Math.PI * 2,
      );
      c.fill();
    }
    c.fillStyle = "rgba(255,255,255,0.05)";
    c.fillRect(px, py + PX * 0.3, PX, 2);
    c.fillStyle = "rgba(0,0,0,0.3)";
    if (x % 2 === 0) c.fillRect(px, py, 1, PX);
    if (y % 2 === 0) c.fillRect(px, py, PX, 1);
    return;
  }
  c.fillStyle = zone === "roof" ? m.roof : m.concrete;
  c.fillRect(px, py, PX, PX);
  for (let k = 0; k < 22; k++) {
    c.fillStyle =
      hash(x + k, y * 3, seed) > 0.5
        ? "rgba(255,255,255,0.05)"
        : "rgba(0,0,0,0.1)";
    c.fillRect(
      px + hash(x * 3, y + k, seed) * PX,
      py + hash(x, y * 11 + k, seed + 1) * PX,
      zone === "roof" ? 2 : 3,
      zone === "roof" ? 2 : 1,
    );
  }
  if (zone === "concrete" && x % 4 === 0) {
    c.fillStyle = m.seam;
    c.fillRect(px, py, 1, PX);
  }
}

/** The top-down colours of a designed outdoors, already dimmed toward the
 * scene palette so the sight overlay keeps its mood. Undesigned floors have
 * none, and the caller keeps its fixed colours. */
export function outdoorColors(
  f: Floor,
  sky: string,
): { ground: string; path: string; neighbor: string } | undefined {
  const look = f.setting?.surroundings;
  if (!look) return undefined;
  return {
    ground: mixHex(look.groundColor, sky, 0.45),
    path: mixHex(look.pathColor, sky, 0.45),
    neighbor: mixHex(look.neighborColor, sky, 0.4),
  };
}

/** Blend two #rrggbb colours; an unparseable tint leaves the base unchanged. */
function mixHex(base: string, tint: string, t: number) {
  const parse = (h: string) =>
    /^#[0-9a-f]{6}$/i.test(h)
      ? [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
      : undefined;
  const a = parse(base),
    b = parse(tint);
  if (!a || !b) return base;
  return (
    "#" +
    a
      .map((v, i) =>
        Math.round(v + (b[i] - v) * t)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
  );
}

let terrain: { key: string; canvas: HTMLCanvasElement } | undefined;
/** Whole-floor floor/wall texture, rebuilt only when walls or the theme change. */
export function terrainCanvas(f: Floor, theme: Theme, seed: number) {
  const s = f.setting?.interior,
    look = s
      ? `${f.setting!.venue}/${s.roomFloor}/${s.hallFloor}/${s.wall}/${s.trim}/${s.roomTint}/${s.hallTint}/`
      : "";
  const corners = f.generation?.corners ?? [],
    shapes = corners.length ? JSON.stringify(corners) : "";
  const outdoor = f.setting?.surroundings?.groundColor,
    ground = outdoor ? `ground:${outdoor}/` : "";
  const key = `${f.index}/${theme}/${seed}/${f.generation?.version ?? 0}/${look}${ground}${shapes}${f.tiles.map((r) => r.join("")).join("")}`;
  if (terrain?.key === key) return terrain.canvas;
  const canvas = terrain?.canvas ?? document.createElement("canvas");
  canvas.width = W * PX;
  canvas.height = H * PX;
  const c = canvas.getContext("2d")!,
    m = MATERIALS[theme];
  // Carved room corners are drawn as one smooth wall over open-looking floor.
  const carved = new Set(carvedCells(f).map((p) => p.y * W + p.x));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (!f.tiles[y][x] || carved.has(y * W + x)) {
        const zone = floorZone(f, x, y);
        paintFloorCell(c, m, zone, x, y, seed);
        // Outside paving takes the designed ground colour; the cell keeps its
        // own texture beneath the wash.
        if (outdoor && zone === "concrete" && /^#[0-9a-f]{6}$/i.test(outdoor)) {
          c.globalAlpha = 0.55;
          c.fillStyle = outdoor;
          c.fillRect(x * PX, y * PX, PX, PX);
          c.globalAlpha = 1;
        }
        if (s && zone !== "concrete" && zone !== "roof") {
          // The designer's tint is blended over the finish, rooms and halls
          // separately, keeping the finish's own texture visible beneath.
          const tint = legacyZone(f, x, y) === "lino" ? s.hallTint : s.roomTint;
          if (/^#[0-9a-f]{6}$/i.test(tint)) {
            c.globalAlpha = 0.22;
            c.fillStyle = tint;
            c.fillRect(x * PX, y * PX, PX, PX);
            c.globalAlpha = 1;
          }
        }
      }
  const wallTop = s ? mixHex(m.wallTop, s.wall, 0.75) : m.wallTop,
    wallEdge = s ? mixHex(m.wallEdge, s.trim, 0.8) : m.wallEdge;
  const solidAt = (x: number, y: number) =>
    x < 0 || y < 0 || x >= W || y >= H || !!f.tiles[y][x];
  // Wall caps with a lit rim on faces that border a room, and a soft contact
  // shadow cast onto the floor along the wall's south and east faces.
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!f.tiles[y][x] || carved.has(y * W + x)) continue;
      const px = x * PX,
        py = y * PX;
      c.fillStyle = wallTop;
      c.fillRect(px, py, PX, PX);
      c.fillStyle = "rgba(255,255,255,0.04)";
      if ((x + y) % 2) c.fillRect(px, py, PX, PX);
      c.fillStyle = wallEdge;
      const rim = 3;
      if (!solidAt(x, y - 1)) c.fillRect(px, py, PX, rim);
      if (!solidAt(x, y + 1)) c.fillRect(px, py + PX - rim, PX, rim);
      if (!solidAt(x - 1, y)) c.fillRect(px, py, rim, PX);
      if (!solidAt(x + 1, y)) c.fillRect(px + PX - rim, py, rim, PX);
      c.fillStyle = m.wallShadow;
      if (!solidAt(x, y + 1)) c.fillRect(px, py + PX, PX, PX * 0.12);
      if (!solidAt(x + 1, y)) c.fillRect(px + PX, py, PX * 0.12, PX);
    }
  for (const corner of corners) {
    const outline = cornerProfile(corner);
    c.beginPath();
    outline.forEach((p, i) =>
      i ? c.lineTo(p.x * PX, p.y * PX) : c.moveTo(p.x * PX, p.y * PX),
    );
    c.closePath();
    c.fillStyle = wallTop;
    c.fill();
    // Lit rim and contact shadow along the visible chamfer or curve only.
    c.lineJoin = "round";
    c.strokeStyle = wallEdge;
    c.lineWidth = 3;
    c.beginPath();
    outline
      .slice(1)
      .forEach((p, i) =>
        i ? c.lineTo(p.x * PX, p.y * PX) : c.moveTo(p.x * PX, p.y * PX),
      );
    c.stroke();
  }
  terrain = { key, canvas };
  return canvas;
}

// ---------------------------------------------------------------------------
// Furniture sprites, drawn in local units centred on the object (w along x).

type Painter = (
  c: CanvasRenderingContext2D,
  m: Materials,
  w: number,
  h: number,
) => void;
const rect = (
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  stroke?: string,
  line = 0.03,
) => {
  c.fillStyle = fill;
  c.fillRect(x, y, w, h);
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = line;
    c.strokeRect(x, y, w, h);
  }
};
const round = (
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  stroke?: string,
) => {
  c.beginPath();
  c.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
  c.fillStyle = fill;
  c.fill();
  if (stroke) {
    c.strokeStyle = stroke;
    c.lineWidth = 0.03;
    c.stroke();
  }
};
const disc = (
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  fill: string,
) => {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fillStyle = fill;
  c.fill();
};
const BOOKS = [
  "#a8423a",
  "#3c6e9e",
  "#d0a443",
  "#4d8a5a",
  "#7a4f8f",
  "#c9c2b0",
];
const PAINTERS: Record<FurnitureKind, Painter> = {
  // Composed objects are painted from their recipe in paintCustomObject; this
  // plain slab only covers a "custom" piece whose recipe is missing.
  custom(c, m, w, h) {
    round(c, -w / 2, -h / 2, w, h, 0.06, m.laminate, m.outline);
  },
  chair(c, m, w, h) {
    // Four-legged stacking chair: seat pad and backrest along its north edge.
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [-1, 1],
      [1, 1],
    ])
      disc(c, x * (w / 2 - 0.08), y * (h / 2 - 0.08), 0.05, m.metalDark);
    round(
      c,
      -w / 2 + 0.08,
      -h / 2 + 0.14,
      w - 0.16,
      h - 0.2,
      0.08,
      m.fabric,
      m.outline,
    );
    round(
      c,
      -w / 2 + 0.06,
      -h / 2 + 0.02,
      w - 0.12,
      0.16,
      0.05,
      m.woodDark,
      m.outline,
    );
  },
  officeChair(c, m, w, h) {
    // Five-star caster base under a round seat and curved back.
    c.strokeStyle = m.metalDark;
    c.lineWidth = 0.06;
    c.beginPath();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      c.moveTo(0, 0);
      c.lineTo(Math.cos(a) * w * 0.47, Math.sin(a) * h * 0.47);
    }
    c.stroke();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 - Math.PI / 2;
      disc(c, Math.cos(a) * w * 0.47, Math.sin(a) * h * 0.47, 0.045, m.outline);
    }
    disc(c, 0, 0.03, Math.min(w, h) * 0.33, m.fabricDark);
    disc(c, 0, 0.03, Math.min(w, h) * 0.26, m.fabric);
    c.beginPath();
    c.arc(0, 0.05, Math.min(w, h) * 0.4, Math.PI * 1.15, Math.PI * 1.85);
    c.strokeStyle = m.outline;
    c.lineWidth = 0.13;
    c.stroke();
  },
  desk(c, m, w, h) {
    // Laminate desktop with a monitor, keyboard, mouse, papers and a mug.
    round(c, -w / 2, -h / 2, w, h, 0.05, m.laminate, m.outline);
    rect(c, -w / 2, -h / 2, w, 0.06, m.woodDark);
    const s = Math.min(1, w / 2.2);
    rect(c, -0.45 * s, -h / 2 + 0.1, 0.9 * s, 0.12, m.outline);
    rect(c, -0.42 * s, -h / 2 + 0.12, 0.84 * s, 0.06, m.screen);
    rect(c, -0.08, -h / 2 + 0.22, 0.16, 0.1, m.metalDark);
    round(c, -0.32 * s, -h / 2 + 0.42, 0.64 * s, 0.18, 0.03, m.metalDark);
    disc(c, 0.42 * s, -h / 2 + 0.5, 0.05, m.metalDark);
    if (w > 1.4) {
      c.save();
      c.translate(-w / 2 + 0.38, h / 2 - 0.3);
      c.rotate(-0.2);
      rect(c, -0.15, -0.2, 0.3, 0.38, m.white, m.metal, 0.015);
      c.restore();
      disc(c, w / 2 - 0.3, h / 2 - 0.28, 0.08, m.white);
      disc(c, w / 2 - 0.3, h / 2 - 0.28, 0.05, m.woodDark);
    }
  },
  table(c, m, w, h) {
    // Meeting table: rounded veneer top, grain, cable port and notepads.
    round(c, -w / 2, -h / 2, w, h, 0.35, m.wood, m.outline);
    c.strokeStyle = m.woodDark;
    c.lineWidth = 0.015;
    c.beginPath();
    for (let i = 1; i < 6; i++) {
      const y = -h / 2 + (i * h) / 6;
      c.moveTo(-w / 2 + 0.3, y);
      c.bezierCurveTo(-w / 6, y + 0.04, w / 6, y - 0.04, w / 2 - 0.3, y);
    }
    c.stroke();
    round(c, -0.25, -0.08, 0.5, 0.16, 0.08, m.metalDark);
    for (const x of [-w / 3, 0, w / 3])
      for (const y of [-h / 2 + 0.22, h / 2 - 0.42])
        rect(c, x - 0.12, y, 0.24, 0.2, m.white, m.metal, 0.012);
  },
  sofa(c, m, w, h) {
    // Lobby sofa: back along north edge, arms at both ends, seat cushions.
    round(c, -w / 2, -h / 2, w, h, 0.12, m.fabricDark, m.outline);
    const arm = Math.min(0.25, w * 0.1);
    const seats = Math.max(1, Math.round((w - arm * 2) / 0.85));
    const sw = (w - arm * 2) / seats;
    for (let i = 0; i < seats; i++)
      round(
        c,
        -w / 2 + arm + i * sw + 0.03,
        -h / 2 + 0.3,
        sw - 0.06,
        h - 0.36,
        0.08,
        m.fabric,
        m.outline,
      );
    round(c, -w / 2 + arm, -h / 2 + 0.04, w - arm * 2, 0.24, 0.08, m.fabric);
  },
  fridge(c, m, w, h) {
    // Break-room fridge from above: enamel top, hinge side and rear vent grille.
    round(c, -w / 2, -h / 2, w, h, 0.06, m.white, m.outline);
    rect(c, -w / 2 + 0.06, -h / 2 + 0.06, w - 0.12, 0.16, m.metal);
    c.strokeStyle = m.metalDark;
    c.lineWidth = 0.02;
    c.beginPath();
    for (let x = -w / 2 + 0.12; x < w / 2 - 0.1; x += 0.08) {
      c.moveTo(x, -h / 2 + 0.08);
      c.lineTo(x, -h / 2 + 0.2);
    }
    c.stroke();
    rect(c, -w / 2, h / 2 - 0.08, w, 0.08, m.metal);
    rect(c, w / 2 - 0.16, h / 2 - 0.14, 0.08, 0.06, m.metalDark);
  },
  shelf(c, m, w, h) {
    // Tall bookcase: wooden carcass with rows of coloured spines and binders.
    rect(c, -w / 2, -h / 2, w, h, m.woodDark, m.outline);
    let x = -w / 2 + 0.08,
      i = 0;
    while (x < w / 2 - 0.1) {
      const bw = 0.06 + ((i * 7) % 5) * 0.02;
      rect(
        c,
        x,
        -h / 2 + 0.1,
        Math.min(bw, w / 2 - 0.08 - x),
        h * 0.55,
        BOOKS[(i * 5) % BOOKS.length],
      );
      x += bw + 0.01;
      i++;
    }
    rect(c, -w / 2 + 0.05, -h / 2 + 0.1 + h * 0.58, w - 0.1, 0.05, m.wood);
    for (let k = 0; k < Math.floor(w / 0.7); k++)
      rect(
        c,
        -w / 2 + 0.15 + k * 0.7,
        h / 2 - 0.28,
        0.5,
        0.18,
        m.white,
        m.metal,
        0.012,
      );
  },
  cabinet(c, m, w, h) {
    // Steel filing cabinet: drawer lips and handles on the front (south) face.
    rect(c, -w / 2, -h / 2, w, h, m.metal, m.outline);
    rect(
      c,
      -w / 2 + 0.05,
      -h / 2 + 0.05,
      w - 0.1,
      h - 0.18,
      "rgba(255,255,255,0.12)",
    );
    rect(c, -w / 2, h / 2 - 0.1, w, 0.1, m.metalDark);
    rect(c, -0.12, h / 2 - 0.08, 0.24, 0.05, m.white);
    rect(c, -w / 2 + 0.1, -h / 2 + 0.12, 0.3, 0.2, m.white, m.metal, 0.01);
  },
  cooler(c, m, w, h) {
    // Water cooler: square cabinet topped by a big blue bottle.
    rect(c, -w / 2, -h / 2, w, h, m.white, m.outline);
    const r = Math.min(w, h) * 0.38;
    disc(c, 0, 0, r, m.water);
    disc(c, -r * 0.3, -r * 0.3, r * 0.35, "rgba(255,255,255,0.35)");
    disc(c, 0, 0, r * 0.32, m.metal);
    rect(c, -w / 2 + 0.06, h / 2 - 0.1, 0.1, 0.06, "#c64a3a");
    rect(c, w / 2 - 0.16, h / 2 - 0.1, 0.1, 0.06, "#3a6ac6");
  },
  plant(c, m, w, h) {
    // Potted office plant: terracotta rim with radiating leaves.
    const r = Math.min(w, h) / 2;
    disc(c, 0, 0, r * 0.62, m.pot);
    disc(c, 0, 0, r * 0.5, m.woodDark);
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + (i % 2) * 0.3;
      c.save();
      c.rotate(a);
      c.beginPath();
      c.ellipse(r * 0.45, 0, r * 0.5, r * 0.16, 0, 0, Math.PI * 2);
      c.fillStyle = i % 2 ? m.leaf : m.leafDark;
      c.fill();
      c.restore();
    }
    disc(c, 0, 0, r * 0.18, m.leaf);
  },
  printer(c, m, w, h) {
    // Multifunction printer: grey body, scanner lid, output paper and panel.
    round(c, -w / 2, -h / 2, w, h, 0.06, m.metal, m.outline);
    round(
      c,
      -w / 2 + 0.06,
      -h / 2 + 0.06,
      w * 0.7,
      h - 0.12,
      0.04,
      m.metalDark,
    );
    rect(c, -w / 2 + 0.14, -h / 2 + 0.14, w * 0.55, h - 0.32, m.white);
    rect(c, w / 2 - 0.26, -h / 2 + 0.1, 0.18, h - 0.2, m.screen);
    disc(c, w / 2 - 0.17, h / 2 - 0.2, 0.03, "#5ee07a");
    disc(c, w / 2 - 0.17, -h / 2 + 0.2, 0.03, "#e0b45e");
  },
  whiteboard(c, m, w, h) {
    // Mobile whiteboard from above: aluminium frame, marker tray and caster feet.
    for (const x of [-w / 2 + 0.12, w / 2 - 0.12]) {
      rect(c, x - 0.04, -h / 2, 0.08, h, m.metalDark);
      disc(c, x, -h / 2 + 0.04, 0.04, m.outline);
      disc(c, x, h / 2 - 0.04, 0.04, m.outline);
    }
    rect(c, -w / 2 + 0.04, -0.07, w - 0.08, 0.14, m.white, m.metal, 0.03);
    rect(c, -w / 2 + 0.3, 0.07, w - 0.6, 0.05, m.metal);
    for (const [x, color] of [
      [-0.2, "#2f6fd0"],
      [0, "#d03a2f"],
      [0.2, "#222"],
    ] as const)
      rect(c, x - 0.06, 0.075, 0.12, 0.035, color);
  },
  partition(c, m, w, h) {
    // Cubicle panel: fabric core with aluminium end caps and top rail.
    rect(c, -w / 2, -h / 2, w, h, m.fabric, m.outline);
    rect(c, -w / 2, -0.02, w, 0.04, m.metal);
    rect(c, -w / 2, -h / 2, 0.08, h, m.metal);
    rect(c, w / 2 - 0.08, -h / 2, 0.08, h, m.metal);
  },
  coffeeMaker(c, m, w, h) {
    // Counter cabinet with an espresso machine, cups and a sugar tray.
    rect(c, -w / 2, -h / 2, w, h, m.laminate, m.outline);
    round(c, -w / 2 + 0.08, -h / 2 + 0.06, w * 0.48, h * 0.5, 0.05, m.outline);
    rect(c, -w / 2 + 0.14, -h / 2 + 0.12, w * 0.36, h * 0.22, m.metal);
    disc(c, -w / 2 + 0.3, -h / 2 + 0.45, 0.06, m.woodDark);
    for (const [x, y] of [
      [0.12, -0.05],
      [0.28, -0.05],
      [0.2, 0.15],
    ]) {
      disc(c, x, y, 0.07, m.white);
      disc(c, x, y, 0.045, m.woodDark);
    }
  },
  microwave(c, m, w, h) {
    // Counter cabinet with a microwave: door window and keypad.
    rect(c, -w / 2, -h / 2, w, h, m.laminate, m.outline);
    round(
      c,
      -w / 2 + 0.06,
      -h / 2 + 0.06,
      w - 0.12,
      h * 0.62,
      0.04,
      m.metalDark,
    );
    rect(c, -w / 2 + 0.12, -h / 2 + 0.11, w * 0.55, h * 0.45, m.screen);
    for (let i = 0; i < 3; i++)
      rect(c, w / 2 - 0.22, -h / 2 + 0.12 + i * 0.09, 0.1, 0.05, m.white);
    disc(c, -0.1, h / 2 - 0.12, 0.06, m.white);
  },
  vending(c, m, w, h) {
    // Snack machine: glass front with coloured product rows and coin panel.
    round(c, -w / 2, -h / 2, w, h, 0.05, "#7b2f36", m.outline);
    rect(
      c,
      -w / 2 + 0.07,
      -h / 2 + 0.07,
      w * 0.68,
      h - 0.24,
      "rgba(170,210,230,0.5)",
    );
    for (let row = 0; row < 3; row++)
      for (let col = 0; col < 4; col++)
        rect(
          c,
          -w / 2 + 0.11 + col * 0.15,
          -h / 2 + 0.11 + row * 0.17,
          0.1,
          0.11,
          BOOKS[(row * 4 + col) % BOOKS.length],
        );
    rect(c, w / 2 - 0.2, -h / 2 + 0.12, 0.12, 0.3, m.metal);
    rect(c, -w / 2 + 0.07, h / 2 - 0.15, w * 0.68, 0.08, m.outline);
  },
  cafeTable(c, m, w, h) {
    // Round cafe table with a centre post and a cup.
    const r = Math.min(w, h) / 2;
    disc(c, 0, 0, r, m.outline);
    disc(c, 0, 0, r - 0.03, m.laminate);
    disc(c, 0, 0, r * 0.18, m.metal);
    disc(c, r * 0.4, -r * 0.3, 0.07, m.white);
  },
  coffeeTable(c, m, w, h) {
    // Low lounge table with magazines.
    round(c, -w / 2, -h / 2, w, h, 0.08, m.wood, m.outline);
    c.save();
    c.rotate(0.15);
    rect(c, -0.35, -0.12, 0.3, 0.22, "#3c6e9e", m.outline, 0.01);
    c.restore();
    rect(c, 0.08, -0.1, 0.28, 0.2, m.white, m.metal, 0.01);
  },
  reception(c, m, w, h) {
    // Front desk: raised transaction ledge at the front, work surface behind.
    round(c, -w / 2, -h / 2, w, h, 0.08, m.woodDark, m.outline);
    rect(c, -w / 2 + 0.08, -h / 2 + 0.08, w - 0.16, h * 0.5, m.laminate);
    rect(c, -0.4, -h / 2 + 0.12, 0.8, 0.1, m.outline);
    rect(c, -0.37, -h / 2 + 0.135, 0.74, 0.07, m.screen);
    rect(c, w / 2 - 0.5, -h / 2 + 0.14, 0.3, 0.22, m.white, m.metal, 0.01);
    rect(c, -w / 2, h / 2 - 0.16, w, 0.16, m.wood);
  },
  armchair(c, m, w, h) {
    // Upholstered armchair: back along north edge, arms and seat cushion.
    round(c, -w / 2, -h / 2, w, h, 0.14, m.fabricDark, m.outline);
    round(c, -w / 2 + 0.16, -h / 2 + 0.22, w - 0.32, h - 0.3, 0.1, m.fabric);
  },
  screen(c, m, w, h) {
    // Wall display on a stand: dark panel with a lit slide.
    rect(c, -w / 2, -h / 2, w, h, m.outline);
    rect(c, -w / 2 + 0.05, -h / 2 + 0.05, w - 0.1, h - 0.12, "#2f6fd0");
    rect(c, -w / 2 + 0.15, -h / 2 + 0.08, w * 0.35, 0.05, m.white);
    rect(c, -0.15, h / 2 - 0.06, 0.3, 0.06, m.metalDark);
  },
  box(c, m, w, h) {
    // Archive box: cardboard with a lid seam and label.
    rect(c, -w / 2, -h / 2, w, h, "#b48a5a", m.outline, 0.02);
    rect(c, -w / 2, -0.02, w, 0.04, "#8e6a42");
    rect(c, -0.1, -h / 2 + 0.06, 0.2, 0.1, m.white);
  },
  drawers(c, m, w, h) {
    // Mobile desk pedestal: steel body with a pen tray on top.
    rect(c, -w / 2, -h / 2, w, h, m.metal, m.outline);
    rect(c, -w / 2 + 0.05, -h / 2 + 0.05, w - 0.1, 0.12, m.metalDark);
    rect(c, -0.08, h / 2 - 0.08, 0.16, 0.04, m.white);
  },
  door(c, m, w, h) {
    // Solid-core office door leaf with a lever handle.
    rect(c, -w / 2, -h / 2, w, h, m.wood, m.outline);
    rect(c, -w / 2 + 0.06, -h / 2 + 0.06, w - 0.12, h - 0.12, m.woodDark);
    rect(c, -w / 2 + 0.1, -h / 2 + 0.1, w - 0.2, h - 0.2, m.wood);
    const long = h >= w;
    disc(c, long ? 0 : w / 2 - 0.2, long ? h / 2 - 0.2 : 0, 0.06, m.metal);
  },
  mixingConsole(c, m, w, h) {
    // Broadcast desk seen from above: fader rows, knob strip, meter bridge.
    round(c, -w / 2, -h / 2, w, h, 0.05, m.metalDark, m.outline);
    rect(c, -w / 2 + 0.05, -h / 2 + 0.05, w - 0.1, 0.14, m.screen);
    for (let i = 0; i < 12; i++) {
      const lit = i % 3 !== 2;
      rect(
        c,
        -w / 2 + 0.09 + i * 0.06,
        -h / 2 + 0.08,
        0.035,
        0.08,
        lit ? (i > 8 ? m.signal : "#5fd37a") : "#d0a443",
      );
    }
    for (let i = 0; i < 8; i++)
      disc(c, -w / 2 + 0.14 + i * 0.2, -h / 2 + 0.3, 0.035, m.white);
    for (let i = 0; i < 8; i++) {
      const x = -w / 2 + 0.1 + i * 0.2;
      rect(c, x, -h / 2 + 0.4, 0.1, 0.38, m.outline);
      rect(c, x + 0.04, -h / 2 + 0.42 + (i % 4) * 0.07, 0.02, 0.28, m.metal);
      rect(
        c,
        x + 0.01,
        -h / 2 + 0.5 + ((i * 3) % 5) * 0.045,
        0.08,
        0.05,
        m.white,
      );
    }
  },
  micStand(c, m, w, h) {
    // Round weighted base, a boom arm and a windshielded mic head.
    const r = Math.min(w, h) / 2;
    disc(c, 0, 0, r, m.outline);
    disc(c, 0, 0, r - 0.03, m.metalDark);
    disc(c, 0, 0, r * 0.28, m.metal);
    c.strokeStyle = m.metal;
    c.lineWidth = 0.035;
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(r * 0.7, -r * 0.55);
    c.stroke();
    disc(c, r * 0.7, -r * 0.55, 0.09, m.outline);
    disc(c, r * 0.7, -r * 0.55, 0.065, "#6b6f73");
  },
  recordShelf(c, m, w, h) {
    // Long open shelf from above: a row of record spines standing in it.
    rect(c, -w / 2, -h / 2, w, h, m.woodDark, m.outline);
    rect(c, -w / 2 + 0.04, -h / 2 + 0.05, w - 0.08, h - 0.1, m.outline);
    const n = Math.floor((w - 0.16) / 0.05);
    for (let i = 0; i < n; i++) {
      const top = -h / 2 + 0.07 + (i % 4 === 0 ? 0.03 : 0);
      rect(
        c,
        -w / 2 + 0.08 + i * 0.05,
        top,
        0.04,
        h - 0.14 - (top + h / 2 - 0.07),
        BOOKS[(i * 5) % BOOKS.length],
      );
    }
    rect(c, -w / 2, h / 2 - 0.05, w, 0.05, m.wood);
  },
  turntable(c, m, w, h) {
    // Twin DJ decks: two platters with tonearms, centre mixer strip.
    round(c, -w / 2, -h / 2, w, h, 0.05, m.metalDark, m.outline);
    for (const s of [-1, 1]) {
      const cx = s * w * 0.3,
        cy = 0.02;
      disc(c, cx, cy, 0.24, m.outline);
      disc(c, cx, cy, 0.22, "#17181a");
      disc(c, cx, cy, 0.08, s < 0 ? m.signal : "#d0a443");
      disc(c, cx, cy, 0.015, m.white);
      c.strokeStyle = m.metal;
      c.lineWidth = 0.025;
      c.beginPath();
      c.moveTo(cx + s * 0.2, -h / 2 + 0.07);
      c.lineTo(cx + s * 0.08, cy - 0.1);
      c.stroke();
    }
    rect(c, -0.08, -h / 2 + 0.06, 0.16, h - 0.12, m.screen);
    rect(c, -0.05, -0.05 + 0.04, 0.1, 0.04, m.white);
  },
  studioMonitor(c, m, w, h) {
    // Speaker cabinet with a woofer cone and tweeter, on a stand.
    rect(c, -w / 2, -h / 2, w, h, m.outline);
    rect(c, -w / 2 + 0.04, -h / 2 + 0.04, w - 0.08, h - 0.08, m.metalDark);
    disc(c, 0, 0.06, w * 0.3, m.outline);
    disc(c, 0, 0.06, w * 0.24, "#33383c");
    disc(c, 0, 0.06, w * 0.08, m.metal);
    disc(c, 0, -h / 2 + 0.11, 0.045, m.metal);
  },
  equipmentRack(c, m, w, h) {
    // 19-inch rack: dark carcase, rows of LEDs and vent slots.
    rect(c, -w / 2, -h / 2, w, h, "#1c1e21", m.outline);
    for (let i = 0; i < 7; i++) {
      const y = -h / 2 + 0.06 + i * ((h - 0.12) / 7);
      rect(c, -w / 2 + 0.05, y, w - 0.1, (h - 0.12) / 7 - 0.02, "#2a2d31");
      for (let k = 0; k < 4; k++)
        disc(
          c,
          -w / 2 + 0.1 + k * 0.06,
          y + 0.04,
          0.016,
          (i + k) % 3 === 0 ? m.signal : (i * k) % 2 ? "#5fd37a" : "#d0a443",
        );
      rect(c, w / 2 - 0.25, y + 0.025, 0.16, 0.012, m.metalDark);
    }
  },
  soundPanel(c, m, w, h) {
    // Freestanding gobo: quilted fabric panel between two frame end caps.
    rect(c, -w / 2, -h / 2, w, h, m.fabricDark, m.outline, 0.02);
    for (let i = 1; i < 8; i++)
      rect(c, -w / 2 + (i * w) / 8, -h / 2 + 0.02, 0.012, h - 0.04, m.fabric);
    rect(c, -w / 2, -h / 2, 0.06, h, m.metal, m.outline, 0.01);
    rect(c, w / 2 - 0.06, -h / 2, 0.06, h, m.metal, m.outline, 0.01);
  },
  onAirLight(c, m, w, h) {
    // Floor stand base seen from above under a red lightbox with a lit lens.
    disc(c, 0, h / 2 - 0.1, 0.1, m.metalDark);
    rect(c, -w / 2, -h / 2, w, h * 0.7, m.outline);
    rect(c, -w / 2 + 0.04, -h / 2 + 0.04, w - 0.08, h * 0.7 - 0.08, m.signal);
    rect(
      c,
      -w / 2 + 0.08,
      -h / 2 + 0.08,
      w - 0.16,
      0.05,
      "rgba(255,200,190,0.6)",
    );
    rect(
      c,
      -w / 2 + 0.1,
      -h / 2 + 0.17,
      w - 0.2,
      0.06,
      "rgba(255,240,230,0.9)",
    );
  },
  reelToReel(c, m, w, h) {
    // Tape deck on a cabinet: two reels, a tape path and a head block.
    rect(c, -w / 2, -h / 2, w, h, m.metal, m.outline);
    rect(c, -w / 2 + 0.04, -h / 2 + 0.04, w - 0.08, h - 0.08, m.metalDark);
    for (const s of [-1, 1]) {
      disc(c, s * w * 0.25, -h * 0.12, 0.17, m.outline);
      disc(c, s * w * 0.25, -h * 0.12, 0.14, "#6b5a3e");
      for (let k = 0; k < 3; k++)
        disc(
          c,
          s * w * 0.25 + Math.cos(k * 2.1) * 0.08,
          -h * 0.12 + Math.sin(k * 2.1) * 0.08,
          0.035,
          m.metalDark,
        );
      disc(c, s * w * 0.25, -h * 0.12, 0.02, m.white);
    }
    rect(c, -0.1, h * 0.18, 0.2, 0.07, m.outline);
    rect(c, -w / 2 + 0.1, h * 0.3, 0.1, 0.05, m.signal);
  },
  gate(c, m, w, h) {
    // Glass entrance doors in an aluminium frame.
    rect(c, -w / 2, -h / 2, w, h, m.metalDark, m.outline);
    rect(
      c,
      -w / 2 + 0.08,
      -h / 2 + 0.08,
      w - 0.16,
      h - 0.16,
      "rgba(140,190,210,0.55)",
    );
    rect(c, -0.02, -h / 2, 0.04, h, m.metal);
  },
};

/** Top-down projection of a composed object's parts in local metres: taller
 * parts paint last, lower ones darker; glow gets a halo, metal a highlight,
 * glass is semi-transparent. Cylinders, spheres and cones are circles. */
/** The plan-view box of a tilted part: its tipped extents at rest, in the
 * same frame as the part. */
function tiltedFootprint(part: RunObjectPart): RunObjectPart {
  const reach = partReach({
    ...part,
    pitch: part.pitch ?? 0,
    roll: part.roll ?? 0,
    motion: "none",
  });
  return { ...part, w: reach.w, d: reach.d, z: reach.z, h: reach.h };
}
function paintCustomObject(
  c: CanvasRenderingContext2D,
  object: RunCustomObject,
) {
  const height = Math.max(0.01, object.size.h),
    parts = [...object.parts].sort((a, b) => a.z + a.h - (b.z + b.h));
  for (const source of parts) {
    // A tilted part shows the footprint of its tipped box; its motion is not
    // drawn on the plan, which keeps the part at rest.
    const part = source.pitch || source.roll ? tiltedFootprint(source) : source,
      top = part.z + part.h,
      shade = Math.min(1, top / height),
      base = /^#[0-9a-f]{6}$/i.test(part.color) ? part.color : "#808080",
      fill = mixHex(base, "#000000", 0.4 * (1 - shade)),
      // From above, upright round parts are ellipses; lying cylinders and
      // cones show their side as a rectangle.
      round =
        part.shape === "sphere" ||
        ((part.shape === "cylinder" || part.shape === "cone") &&
          part.axis !== "across" &&
          part.axis !== "along"),
      outline = mixHex(base, "#000000", 0.55),
      // A flat torus is a ring seen from above; upright ones are thin slabs.
      ring = part.shape === "torus" && part.axis === "up";
    const path = () => {
      c.beginPath();
      if (round || ring) {
        c.ellipse(part.x, part.y, part.w / 2, part.d / 2, 0, 0, Math.PI * 2);
        if (ring) {
          // Hole as a second subpath, cut out by the even-odd fill rule.
          c.moveTo(part.x + part.w * 0.2, part.y);
          c.ellipse(
            part.x,
            part.y,
            part.w * 0.2,
            part.d * 0.2,
            0,
            0,
            Math.PI * 2,
          );
        }
      } else c.rect(part.x - part.w / 2, part.y - part.d / 2, part.w, part.d);
    };
    if (part.finish === "glow") {
      const r = Math.max(part.w, part.d) * 0.9;
      const g = c.createRadialGradient(part.x, part.y, 0, part.x, part.y, r);
      g.addColorStop(0, base + "88");
      g.addColorStop(1, base + "00");
      c.fillStyle = g;
      c.fillRect(part.x - r, part.y - r, r * 2, r * 2);
    }
    path();
    if (part.finish === "glass") c.globalAlpha = 0.5;
    c.fillStyle = part.finish === "glow" ? mixHex(base, "#ffffff", 0.35) : fill;
    if (part.shape === "wedge") {
      // The slope shades from its low edge (dark) to its high edge (light).
      const [x0, y0, x1, y1] =
        part.axis === "across"
          ? [part.x - part.w / 2, part.y, part.x + part.w / 2, part.y]
          : part.axis === "along"
            ? [part.x, part.y - part.d / 2, part.x, part.y + part.d / 2]
            : [part.x, part.y + part.d / 2, part.x, part.y - part.d / 2];
      const g = c.createLinearGradient(x0, y0, x1, y1);
      g.addColorStop(0, mixHex(base, "#000000", 0.45));
      g.addColorStop(1, mixHex(base, "#ffffff", 0.25));
      c.fillStyle = g;
    }
    c.fill(ring ? "evenodd" : "nonzero");
    c.globalAlpha = 1;
    c.strokeStyle = outline;
    c.lineWidth = 0.02;
    c.stroke();
    if (part.shape === "cone" && round) {
      // Apex at the centre reads as a point from above.
      disc(c, part.x, part.y, Math.min(part.w, part.d) * 0.12, outline);
    }
    if (part.finish === "metal") {
      c.strokeStyle = "rgba(255,255,255,0.55)";
      c.lineWidth = 0.03;
      c.beginPath();
      if (round)
        c.ellipse(
          part.x,
          part.y,
          part.w / 2 - 0.02,
          part.d / 2 - 0.02,
          0,
          Math.PI * 1.1,
          Math.PI * 1.6,
        );
      else {
        c.moveTo(part.x - part.w / 2 + 0.02, part.y + part.d / 2 - 0.02);
        c.lineTo(part.x - part.w / 2 + 0.02, part.y - part.d / 2 + 0.02);
        c.lineTo(part.x + part.w / 2 - 0.02, part.y - part.d / 2 + 0.02);
      }
      c.stroke();
    }
  }
}
/** The colour that dominates a composed object, by footprint area. */
function dominantColor(object: RunCustomObject): string {
  const area = new Map<string, number>();
  for (const p of object.parts as RunObjectPart[])
    area.set(p.color, (area.get(p.color) ?? 0) + p.w * p.d);
  let best = "",
    most = -1;
  for (const [color, a] of area) if (a > most) ((best = color), (most = a));
  return /^#[0-9a-f]{6}$/i.test(best) ? best : "";
}
function objectKey(object: RunCustomObject) {
  const s = JSON.stringify([object.size, object.parts]);
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return `custom:${object.id}:${h.toString(36)}`;
}

const sprites = new Map<string, HTMLCanvasElement>();
/** A cached sprite of one furniture kind at one footprint and theme. */
export function furnitureSprite(o: Furniture, theme: Theme) {
  const key = `${o.kind === "custom" && o.object ? objectKey(o.object) : o.kind}/${o.w.toFixed(2)}/${o.h.toFixed(2)}/${theme}`;
  let sprite = sprites.get(key);
  if (sprite) return sprite;
  if (sprites.size > 256) sprites.clear();
  sprite = document.createElement("canvas");
  const pad = 0.1;
  sprite.width = Math.ceil((o.w + pad * 2) * SPRITE_PX);
  sprite.height = Math.ceil((o.h + pad * 2) * SPRITE_PX);
  const c = sprite.getContext("2d")!;
  c.scale(SPRITE_PX, SPRITE_PX);
  c.translate(o.w / 2 + pad, o.h / 2 + pad);
  // Drop shadow gives props height against the floor.
  c.fillStyle = "rgba(0,0,0,0.35)";
  c.fillRect(-o.w / 2 + 0.06, -o.h / 2 + 0.08, o.w, o.h);
  if (o.kind === "custom" && o.object) paintCustomObject(c, o.object);
  else (PAINTERS[o.kind] ?? PAINTERS.desk)(c, MATERIALS[theme], o.w, o.h);
  sprites.set(key, sprite);
  return sprite;
}
export function drawFurniture(
  ctx: CanvasRenderingContext2D,
  o: Furniture,
  theme: Theme,
) {
  ctx.drawImage(
    furnitureSprite(o, theme),
    -o.w / 2 - 0.1,
    -o.h / 2 - 0.1,
    o.w + 0.2,
    o.h + 0.2,
  );
}
/** Broken pieces in the object's own colours, scattered deterministically. */
export function drawDebris(
  ctx: CanvasRenderingContext2D,
  o: Furniture,
  theme: Theme,
) {
  const m = MATERIALS[theme],
    colors: Partial<Record<FurnitureKind, string>> = {
      fridge: m.white,
      cabinet: m.metal,
      printer: m.metal,
      plant: m.leaf,
      cooler: m.water,
      whiteboard: m.white,
      partition: m.fabric,
      sofa: m.fabric,
      officeChair: m.fabric,
      table: m.wood,
      shelf: m.woodDark,
      vending: "#7b2f36",
      reception: m.woodDark,
      armchair: m.fabric,
      box: "#b48a5a",
      drawers: m.metal,
      screen: m.outline,
      mixingConsole: m.metalDark,
      micStand: m.metal,
      recordShelf: m.woodDark,
      turntable: m.metalDark,
      studioMonitor: m.outline,
      equipmentRack: m.outline,
      soundPanel: m.fabricDark,
      onAirLight: m.signal,
      reelToReel: m.metal,
    };
  ctx.fillStyle =
    (o.kind === "custom" && o.object && dominantColor(o.object)) ||
    (colors[o.kind] ?? m.laminate);
  const n = 6 + Math.round(o.w * o.h * 2);
  for (let i = 0; i < n; i++) {
    const seed = o.id.length * 97 + i;
    ctx.save();
    ctx.translate(
      o.x + (hash(seed, 1, 7) - 0.5) * o.w,
      o.y + (hash(seed, 2, 7) - 0.5) * o.h,
    );
    ctx.rotate(hash(seed, 3, 7) * Math.PI);
    ctx.fillRect(-0.08, -0.03, 0.06 + hash(seed, 4, 7) * 0.18, 0.06);
    ctx.restore();
  }
}
/** Office workstation at a terminal: a short desk with a glowing monitor. */
export function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  theme: Theme,
) {
  const m = MATERIALS[theme];
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.fillRect(x - 0.52, y - 0.36, 1.08, 0.82);
  ctx.fillStyle = m.laminate;
  ctx.fillRect(x - 0.55, y - 0.42, 1.1, 0.8);
  ctx.strokeStyle = m.outline;
  ctx.lineWidth = 0.03;
  ctx.strokeRect(x - 0.55, y - 0.42, 1.1, 0.8);
}

/** A study terminal in the place's own idiom, seen from above within the
 * workstation footprint. The glowing face fills with `screenFill` (the spent
 * colour once the terminal is consumed) and only glows while `glow` is set. */
export function drawTerminal(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  terminal: RunTerminal,
  screenFill: string,
  glow: boolean,
) {
  const { body, accent, screen } = terminal;
  const rect = (
    color: string,
    dx: number,
    dy: number,
    w: number,
    h: number,
  ) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + dx, y + dy, w, h);
  };
  const disc = (color: string, dx: number, dy: number, r: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + dx, y + dy, r, 0, Math.PI * 2);
    ctx.fill();
  };
  const face = (dx: number, dy: number, w: number, h: number) => {
    ctx.save();
    ctx.shadowColor = screen;
    ctx.shadowBlur = glow ? 8 : 0;
    rect(screenFill, dx, dy, w, h);
    ctx.restore();
  };
  rect("rgba(0,0,0,0.35)", -0.5, -0.36, 1.04, 0.82);
  switch (terminal.style) {
    case "console":
      rect(body, -0.5, -0.4, 1, 0.78);
      rect(accent, -0.46, 0.04, 0.92, 0.3);
      rect("#101b20", -0.42, -0.36, 0.84, 0.36);
      face(-0.36, -0.32, 0.72, 0.28);
      for (const dx of [-0.28, 0, 0.28]) disc(body, dx, 0.19, 0.06);
      break;
    case "lectern":
      rect(body, -0.36, -0.36, 0.72, 0.72);
      rect(accent, -0.36, 0.28, 0.72, 0.08);
      rect(accent, -0.32, -0.36, 0.64, 0.12);
      face(-0.26, -0.3, 0.52, 0.2);
      break;
    case "pedestal":
      disc(body, 0, 0, 0.34);
      disc(accent, 0, 0, 0.26);
      face(-0.2, -0.17, 0.4, 0.26);
      break;
    case "kiosk":
      rect(body, -0.36, -0.3, 0.72, 0.6);
      rect(accent, -0.36, -0.3, 0.72, 0.08);
      face(-0.26, 0.04, 0.52, 0.2);
      rect(accent, -0.18, -0.08, 0.36, 0.08);
      break;
    case "altar":
      rect(body, -0.5, -0.4, 1, 0.78);
      rect(accent, -0.46, -0.36, 0.92, 0.7);
      rect(body, -0.4, -0.28, 0.8, 0.54);
      face(-0.3, -0.18, 0.6, 0.34);
      for (const dx of [-0.38, 0.38]) disc(accent, dx, -0.32, 0.05);
      break;
    case "cabinet":
      rect(body, -0.46, -0.38, 0.92, 0.74);
      rect(accent, -0.46, -0.38, 0.92, 0.1);
      rect(accent, -0.015, -0.28, 0.03, 0.64);
      for (const dx of [-0.08, 0.08]) rect(accent, dx - 0.015, 0.1, 0.03, 0.14);
      face(-0.3, -0.34, 0.6, 0.16);
      break;
    default:
      rect(body, -0.55, -0.42, 1.1, 0.8);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 0.03;
      ctx.strokeRect(x - 0.55, y - 0.42, 1.1, 0.8);
      rect(accent, -0.4, -0.35, 0.8, 0.5);
      face(-0.32, -0.3, 0.64, 0.35);
      rect(accent, -0.48, 0.25, 0.96, 0.14);
  }
}
