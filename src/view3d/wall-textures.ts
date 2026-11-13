import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";
import type { RunWallFinish } from "../setting-catalog.mjs";

/** Surface response per wall finish. Plaster keeps the plain wall's original
 * values so an undesigned floor (or a plaster design) is unchanged. */
export function wallMaterialParams(finish: RunWallFinish) {
  switch (finish) {
    case "brick":
      return { roughness: 0.92, metalness: 0 };
    case "stone":
      return { roughness: 0.88, metalness: 0 };
    case "wood":
      return { roughness: 0.62, metalness: 0 };
    case "metal":
      return { roughness: 0.42, metalness: 0.45 };
    case "tile":
      return { roughness: 0.3, metalness: 0.05 };
    default:
      return { roughness: 0.92, metalness: 0 };
  }
}

// Integer hashing keeps every wall surface identical across reloads.
const hash = (i: number) => Math.imul(i + 11, 2654435761) >>> 0;

/** Painters are pale and near-greyscale: the interior wall colour set from the
 * design still tints them, so the finish adds relief rather than a new hue. */
const cache = new Map<RunWallFinish, CanvasTexture>();

/** One cached 1 m repeating wall surface per finish; plaster is the plain
 * painted wall, so it has none. Textures live as long as the module/view. */
export function wallTexture(finish: RunWallFinish): CanvasTexture | null {
  if (finish === "plaster") return null;
  let texture = cache.get(finish);
  if (!texture) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const c = canvas.getContext("2d")!;
    paint(c, finish);
    texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.anisotropy = 4;
    cache.set(finish, texture);
  }
  return texture;
}

function paint(c: CanvasRenderingContext2D, finish: RunWallFinish) {
  if (finish === "brick") brick(c);
  else if (finish === "stone") stone(c);
  else if (finish === "wood") wood(c);
  else if (finish === "metal") metal(c);
  else tile(c);
}

/** Running-bond brickwork: eight 12.5 cm courses per metre, half-bond stagger. */
function brick(c: CanvasRenderingContext2D) {
  c.fillStyle = "#b9b3aa";
  c.fillRect(0, 0, 64, 64);
  for (let row = 0; row < 8; row++) {
    const offset = row % 2 ? 8 : 0;
    for (let i = 0; i < 4; i++) {
      const n = hash(row * 19 + i * 7),
        x = ((offset + i * 16) % 64) - 1,
        y = row * 8 + 1;
      c.fillStyle = ["#ddd8d1", "#d5cfc7", "#e3ded7", "#cfc8bf"][(n >>> 5) % 4];
      c.fillRect(x + 1, y, 15, 6);
      c.fillStyle = "rgba(255,255,255,.24)";
      c.fillRect(x + 1, y, 15, 1);
      c.fillStyle = "rgba(60,55,50,.2)";
      c.fillRect(x + 1, y + 5, 15, 1);
      for (let k = 0; k < 3; k++) {
        const s = hash(n + k * 13);
        c.fillStyle = k % 2 ? "rgba(90,84,76,.14)" : "rgba(255,255,255,.12)";
        c.fillRect(x + 2 + ((s >>> 7) % 13), y + 1 + ((s >>> 11) % 4), 1, 1);
      }
    }
  }
  c.fillStyle = "rgba(70,64,58,.18)";
  for (let row = 0; row < 8; row++) c.fillRect(0, row * 8, 64, 1);
}

/** Coursed ashlar: pale dressed blocks of varied length with recessed joints. */
function stone(c: CanvasRenderingContext2D) {
  c.fillStyle = "#a9a49c";
  c.fillRect(0, 0, 64, 64);
  const rows = [
    [0, 21],
    [21, 15],
    [36, 28],
  ];
  for (let r = 0; r < rows.length; r++) {
    const [y0, h] = rows[r];
    let x = r % 2 ? 9 : 0;
    let i = 0;
    while (x < 64) {
      const n = hash(r * 23 + i * 11),
        w = 14 + ((n >>> 4) % 12);
      c.fillStyle = ["#d7d3cc", "#cfcbc3", "#dedad3", "#c6c2ba"][(n >>> 9) % 4];
      c.fillRect(x + 1, y0 + 1, w - 1, h - 2);
      c.fillStyle = "rgba(255,255,255,.28)";
      c.fillRect(x + 1, y0 + 1, w - 1, 1);
      c.fillStyle = "rgba(65,62,58,.22)";
      c.fillRect(x + 1, y0 + h - 2, w - 1, 1);
      for (let k = 0; k < 4; k++) {
        const s = hash(n + k * 17);
        c.fillStyle = k % 2 ? "rgba(80,76,70,.16)" : "rgba(255,255,255,.16)";
        c.fillRect(
          x + 2 + ((s >>> 6) % Math.max(1, w - 4)),
          y0 + 2 + ((s >>> 12) % Math.max(1, h - 4)),
          2,
          1,
        );
      }
      x += w;
      i++;
    }
  }
  c.fillStyle = "rgba(60,57,53,.3)";
  for (const [y] of rows) c.fillRect(0, y, 64, 1);
}

/** Vertical timber boarding, 12.5 cm boards with a bead between them. */
function wood(c: CanvasRenderingContext2D) {
  c.fillStyle = "#8f8a83";
  c.fillRect(0, 0, 64, 64);
  for (let b = 0; b < 8; b++) {
    const n = hash(b * 37),
      x = b * 8;
    c.fillStyle = ["#dad4cb", "#d1cbc2", "#e0dbd3", "#c8c2b9"][(n >>> 6) % 4];
    c.fillRect(x + 1, 0, 6, 64);
    // Grain: long, slightly wandering lines down the board.
    for (let g = 0; g < 3; g++) {
      const s = hash(b * 13 + g * 5);
      c.fillStyle = g % 2 ? "rgba(255,255,255,.18)" : "rgba(95,85,74,.16)";
      c.fillRect(x + 1 + ((s >>> 7) % 6), 0, 1, 64);
    }
    for (let k = 0; k < 6; k++) {
      const s = hash(b * 41 + k);
      c.fillStyle = "rgba(90,80,70,.13)";
      c.fillRect(x + 1, (s >>> 8) % 64, 6, 1);
    }
    c.fillStyle = "rgba(55,48,42,.4)";
    c.fillRect(x, 0, 1, 64);
    c.fillStyle = "rgba(255,255,255,.2)";
    c.fillRect(x + 1, 0, 1, 64);
  }
}

/** Riveted metal panels: brushed plate, 25 cm seams and a rivet per corner. */
function metal(c: CanvasRenderingContext2D) {
  c.fillStyle = "#c9cdd0";
  c.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 120; i++) {
    const n = hash(i * 3 + 7);
    c.fillStyle = i % 2 ? "rgba(255,255,255,.16)" : "rgba(105,112,118,.13)";
    c.fillRect(n % 64, (n >>> 8) % 64, 8 + ((n >>> 14) % 18), 1);
  }
  c.fillStyle = "rgba(90,96,102,.5)";
  c.fillRect(0, 0, 64, 1);
  c.fillRect(0, 0, 1, 64);
  c.fillRect(32, 0, 1, 64);
  c.fillRect(0, 32, 64, 1);
  c.fillStyle = "rgba(255,255,255,.3)";
  c.fillRect(1, 1, 64, 1);
  c.fillRect(33, 0, 1, 64);
  c.fillRect(0, 33, 64, 1);
  for (const [x, y] of [
    [4, 4],
    [28, 4],
    [36, 4],
    [60, 4],
    [4, 28],
    [28, 28],
    [36, 36],
    [60, 36],
    [4, 60],
    [36, 60],
  ]) {
    c.fillStyle = "rgba(80,86,92,.5)";
    c.beginPath();
    c.arc(x + 0.6, y + 0.6, 1.6, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = "rgba(245,248,250,.75)";
    c.beginPath();
    c.arc(x, y, 1.3, 0, Math.PI * 2);
    c.fill();
  }
}

/** Glazed square tiles, 25 cm with pale grout and a soft glaze highlight. */
function tile(c: CanvasRenderingContext2D) {
  c.fillStyle = "#b0aca6";
  c.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const n = hash(x * 31 + y * 17),
        px = x * 16 + 1,
        py = y * 16 + 1;
      c.fillStyle = ["#e6e3df", "#dedbd6", "#eeece8", "#d6d3ce"][(n >>> 4) % 4];
      c.fillRect(px, py, 14, 14);
      c.fillStyle = "rgba(255,255,255,.5)";
      c.fillRect(px, py, 14, 2);
      c.fillRect(px, py, 2, 14);
      c.fillStyle = "rgba(95,92,88,.18)";
      c.fillRect(px, py + 12, 14, 2);
      c.fillRect(px + 12, py, 2, 14);
      c.fillStyle = "rgba(255,255,255,.28)";
      c.fillRect(px + 3 + ((n >>> 9) % 6), py + 3 + ((n >>> 13) % 6), 3, 1);
    }
}
