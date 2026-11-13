import { CanvasTexture, RepeatWrapping, SRGBColorSpace } from "three";

export type FloorFinish =
  | "carpet"
  | "carpetAlt"
  | "lino"
  | "concrete"
  | "roof"
  | "studioCarpet"
  | "parquet"
  | "terrazzo"
  | "rubber"
  | "polished"
  | "planks"
  | "flagstone"
  | "checker"
  | "grating"
  | "earth"
  | "mosaic";

/** Material tint and gloss per finish. The office finishes keep their original
 * values; the venue finishes are authored near their final colour. */
export function floorMaterialParams(finish: FloorFinish) {
  switch (finish) {
    case "lino":
      return { color: "#969b8d", roughness: 0.98 };
    case "studioCarpet":
      return { color: "#a3a8b2", roughness: 1 };
    case "parquet":
      return { color: "#c9bda9", roughness: 0.72 };
    case "terrazzo":
      return { color: "#bcbcb4", roughness: 0.62 };
    case "rubber":
      return { color: "#a4a8aa", roughness: 0.9 };
    case "polished":
      return { color: "#b4bcc0", roughness: 0.34 };
    case "planks":
      return { color: "#b09070", roughness: 0.7 };
    case "flagstone":
      return { color: "#9d9c96", roughness: 0.95 };
    case "checker":
      return { color: "#c2c0b8", roughness: 0.45 };
    case "grating":
      return { color: "#7c8388", roughness: 0.5 };
    case "earth":
      return { color: "#8a7355", roughness: 1 };
    case "mosaic":
      return { color: "#b6bdb6", roughness: 0.4 };
    default:
      return { color: "#89939b", roughness: 0.98 };
  }
}

// Integer hashing avoids global randomness and makes reloads identical.
const hash = (i: number) => Math.imul(i + 13, 15485863) >>> 0;

/** Tiny, deterministic repeating surfaces; generated once for the view lifetime. */
export function floorTexture(finish: FloorFinish) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const c = canvas.getContext("2d")!;
  if (finish === "studioCarpet") studioCarpet(c);
  else if (finish === "parquet") parquet(c);
  else if (finish === "terrazzo") terrazzo(c);
  else if (finish === "rubber") rubber(c);
  else if (finish === "polished") polished(c);
  else if (finish === "planks") planks(c);
  else if (finish === "flagstone") flagstone(c);
  else if (finish === "checker") checker(c);
  else if (finish === "grating") grating(c);
  else if (finish === "earth") earth(c);
  else if (finish === "mosaic") mosaic(c);
  else legacy(c, finish);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  // One texture tile spans one world metre (UVs are assigned in world units).
  texture.anisotropy = 4;
  return texture;
}

function legacy(c: CanvasRenderingContext2D, finish: FloorFinish) {
  const carpet = finish === "carpet" || finish === "carpetAlt";
  const colors =
    finish === "carpet"
      ? ["#738090", "#687583"]
      : finish === "carpetAlt"
        ? ["#807587", "#756b7b"]
        : finish === "lino"
          ? ["#a5a69b", "#999b91"]
          : ["#777b7a", "#717675"];
  c.fillStyle = colors[0];
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = colors[1];
  c.fillRect(0, 0, 32, 32);
  c.fillRect(32, 32, 32, 32);
  for (let i = 0; i < 400; i++) {
    const n = hash(i);
    c.fillStyle = i % 2 ? "rgba(240,245,240,.055)" : "rgba(10,15,20,.055)";
    c.fillRect(n % 64, (n >>> 8) % 64, carpet ? 1 : 2, carpet ? 4 : 1);
  }
  c.fillStyle = carpet ? "rgba(15,20,25,.09)" : "rgba(15,20,25,.2)";
  c.fillRect(0, 0, 64, 1);
  c.fillRect(0, 0, 1, 64);
}

/** Dense charcoal pile with a faint diamond weave, as in a sound-treated room. */
function studioCarpet(c: CanvasRenderingContext2D) {
  c.fillStyle = "#454a57";
  c.fillRect(0, 0, 64, 64);
  c.strokeStyle = "rgba(20,24,34,.35)";
  c.lineWidth = 1;
  for (let k = -64; k <= 64; k += 16) {
    c.beginPath();
    c.moveTo(k, 0);
    c.lineTo(k + 64, 64);
    c.moveTo(k + 64, 0);
    c.lineTo(k, 64);
    c.stroke();
  }
  for (let i = 0; i < 700; i++) {
    const n = hash(i);
    c.fillStyle = i % 2 ? "rgba(210,215,230,.06)" : "rgba(5,8,15,.1)";
    c.fillRect(n % 64, (n >>> 8) % 64, 1, 2);
  }
}

/** Four blocks of laid boards, alternately across and along, with dark joints. */
function parquet(c: CanvasRenderingContext2D) {
  const woods = ["#8a5e3b", "#9a6c45", "#7c5333", "#a47650"];
  for (let by = 0; by < 2; by++)
    for (let bx = 0; bx < 2; bx++) {
      const across = (bx + by) % 2 === 0;
      for (let p = 0; p < 4; p++) {
        c.fillStyle = woods[(hash(bx * 7 + by * 3 + p) >>> 4) % 4];
        if (across) c.fillRect(bx * 32, by * 32 + p * 8, 32, 8);
        else c.fillRect(bx * 32 + p * 8, by * 32, 8, 32);
      }
    }
  c.fillStyle = "rgba(25,12,5,.55)";
  for (let k = 0; k < 64; k += 8) {
    for (let by = 0; by < 2; by++)
      for (let bx = 0; bx < 2; bx++) {
        if ((bx + by) % 2 === 0) c.fillRect(bx * 32, by * 32 + (k % 32), 32, 1);
        else c.fillRect(bx * 32 + (k % 32), by * 32, 1, 32);
      }
  }
  c.fillRect(0, 0, 64, 1);
  c.fillRect(0, 32, 64, 1);
  c.fillRect(0, 0, 1, 64);
  c.fillRect(32, 0, 1, 64);
  for (let i = 0; i < 160; i++) {
    const n = hash(i);
    c.fillStyle = i % 2 ? "rgba(255,225,180,.06)" : "rgba(20,10,0,.07)";
    c.fillRect(n % 64, (n >>> 8) % 64, 5, 1);
  }
}

/** Pale cement with scattered chips of stone, and a fine expansion joint. */
function terrazzo(c: CanvasRenderingContext2D) {
  c.fillStyle = "#c8c6bc";
  c.fillRect(0, 0, 64, 64);
  const chips = ["#7d8085", "#b9a58e", "#e9e6dc", "#8a9a98", "#a3837a"];
  for (let i = 0; i < 260; i++) {
    const n = hash(i * 5);
    c.fillStyle = chips[(n >>> 3) % chips.length];
    const w = 1 + ((n >>> 12) % 3),
      h = 1 + ((n >>> 15) % 2);
    c.fillRect(n % 64, (n >>> 8) % 64, w, h);
  }
  c.fillStyle = "rgba(60,60,55,.35)";
  c.fillRect(0, 0, 64, 1);
  c.fillRect(0, 0, 1, 64);
}

/** Dark studded rubber: a grid of raised coins. */
function rubber(c: CanvasRenderingContext2D) {
  c.fillStyle = "#3a3d3f";
  c.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 4; y++)
    for (let x = 0; x < 4; x++) {
      const cx = x * 16 + 8,
        cy = y * 16 + 8;
      c.fillStyle = "#4b4f51";
      c.beginPath();
      c.arc(cx, cy, 5.5, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "rgba(255,255,255,.1)";
      c.beginPath();
      c.arc(cx - 1.5, cy - 1.5, 2.6, 0, Math.PI * 2);
      c.fill();
    }
}

/** Large polished slabs with a thin joint and a soft diagonal reflection. */
function polished(c: CanvasRenderingContext2D) {
  c.fillStyle = "#a9b0b3";
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = "#9fa7ab";
  c.fillRect(0, 0, 32, 32);
  c.fillRect(32, 32, 32, 32);
  const sheen = c.createLinearGradient(0, 0, 64, 64);
  sheen.addColorStop(0, "rgba(255,255,255,0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,.14)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = sheen;
  c.fillRect(0, 0, 64, 64);
  c.fillStyle = "rgba(40,50,55,.35)";
  c.fillRect(0, 0, 64, 1);
  c.fillRect(0, 0, 1, 64);
  c.fillRect(0, 32, 64, 1);
  c.fillRect(32, 0, 1, 64);
}

/** Wide wooden floorboards laid along x, with staggered butt joints. */
function planks(c: CanvasRenderingContext2D) {
  const woods = ["#8a6440", "#946c46", "#805a38", "#9c744c"];
  const rowH = 16;
  for (let row = 0; row < 4; row++) {
    const board = hash(row * 29);
    c.fillStyle = woods[(board >>> 5) % woods.length];
    c.fillRect(0, row * rowH, 64, rowH);
    // Grain runs along the board; a few fine lines, softly varied.
    for (let g = 0; g < 3; g++) {
      const n = hash(row * 13 + g * 7);
      c.fillStyle = g % 2 ? "rgba(255,225,180,.07)" : "rgba(30,16,4,.12)";
      c.fillRect(0, row * rowH + 3 + ((n >>> 8) % (rowH - 6)), 64, 1);
    }
    c.fillStyle = "rgba(25,12,4,.5)";
    c.fillRect(0, row * rowH + rowH - 1, 64, 1);
    // Butt joints stagger by half a board every other row.
    const offset = row % 2 ? 16 : 48;
    for (let j = 0; j < 2; j++) {
      const n = hash(row * 97 + j * 31);
      const x = (offset + j * 32 + ((n >>> 9) % 5)) % 64;
      c.fillStyle = "rgba(20,10,2,.55)";
      c.fillRect(x, row * rowH, 1, rowH - 1);
    }
    for (let k = 0; k < 8; k++) {
      const n = hash(row * 53 + k);
      c.fillStyle = k % 2 ? "rgba(255,230,190,.06)" : "rgba(20,10,0,.08)";
      c.fillRect(n % 64, row * rowH + 2 + ((n >>> 10) % (rowH - 4)), 6, 1);
    }
  }
}

/** Irregular grey stone slabs bedded in dark mortar. */
function flagstone(c: CanvasRenderingContext2D) {
  c.fillStyle = "#3b3934";
  c.fillRect(0, 0, 64, 64);
  const greys = ["#8c8c84", "#83847c", "#95948b", "#797a72", "#9c9b92"];
  for (let gy = 0; gy < 2; gy++)
    for (let gx = 0; gx < 2; gx++) {
      const n = hash(gx * 41 + gy * 17),
        j = (k: number) => ((hash(n + k) >>> 9) % 5) - 2,
        x = gx * 32 + 2,
        y = gy * 32 + 2,
        w = 27 + ((n >>> 4) % 3),
        h = 27 + ((n >>> 11) % 3);
      c.fillStyle = greys[(n >>> 3) % greys.length];
      c.beginPath();
      c.moveTo(x + j(1), y + j(2));
      c.lineTo(x + w + j(3), y + j(4));
      c.lineTo(x + w + j(5), y + h + j(6));
      c.lineTo(x + j(7), y + h + j(8));
      c.closePath();
      c.fill();
      c.strokeStyle = "rgba(255,255,255,.1)";
      c.lineWidth = 1;
      c.stroke();
      for (let k = 0; k < 18; k++) {
        const s = hash(n + k * 13);
        c.fillStyle = k % 3 ? "rgba(40,40,36,.16)" : "rgba(240,240,232,.12)";
        c.fillRect(
          x + 2 + ((s >>> 7) % (w - 4)),
          y + 2 + ((s >>> 15) % (h - 4)),
          1 + ((s >>> 21) % 2),
          1,
        );
      }
    }
}

/** Two-tone checkerboard tiles at 0.5 m squares with grey grout. */
function checker(c: CanvasRenderingContext2D) {
  const light = "#d6cfbf",
    dark = "#3c4248";
  for (let y = 0; y < 2; y++)
    for (let x = 0; x < 2; x++) {
      c.fillStyle = (x + y) % 2 ? dark : light;
      c.fillRect(x * 32, y * 32, 32, 32);
      for (let k = 0; k < 6; k++) {
        const n = hash(x * 17 + y * 29 + k * 5);
        c.fillStyle = k % 2 ? "rgba(255,255,255,.05)" : "rgba(0,0,0,.07)";
        c.fillRect(x * 32 + (n % 28), y * 32 + ((n >>> 9) % 28), 3, 2);
      }
    }
  c.fillStyle = "rgba(150,146,136,.6)";
  for (const o of [0, 32]) {
    c.fillRect(o, 0, 1, 64);
    c.fillRect(0, o, 64, 1);
  }
  c.fillStyle = "rgba(255,255,255,.08)";
  for (const o of [2, 34]) {
    c.fillRect(o, 0, 1, 64);
    c.fillRect(0, o, 64, 1);
  }
  c.fillStyle = "rgba(0,0,0,.3)";
  c.fillRect(0, 63, 64, 1);
  c.fillRect(63, 0, 1, 64);
}

/** Dark metal deck grating: a fine grid of slots between bearing bars. */
function grating(c: CanvasRenderingContext2D) {
  c.fillStyle = "#191c1f";
  c.fillRect(0, 0, 64, 64);
  // Bearing bars every 16 cm, cross rods every 8 cm, slots between them.
  for (let x = 0; x < 64; x += 8) {
    c.fillStyle = "#3f464b";
    c.fillRect(x, 0, 3, 64);
    c.fillStyle = "rgba(255,255,255,.14)";
    c.fillRect(x, 0, 1, 64);
    c.fillStyle = "rgba(0,0,0,.45)";
    c.fillRect(x + 3, 0, 1, 64);
  }
  for (let y = 4; y < 64; y += 16) {
    c.fillStyle = "#4a5157";
    c.fillRect(0, y, 64, 2);
    c.fillStyle = "rgba(255,255,255,.1)";
    c.fillRect(0, y, 64, 1);
    c.fillStyle = "#101315";
    c.fillRect(0, y + 2, 64, 2);
  }
  for (let i = 0; i < 90; i++) {
    const n = hash(i * 7);
    c.fillStyle = i % 2 ? "rgba(200,215,225,.09)" : "rgba(0,0,0,.3)";
    c.fillRect(n % 64, (n >>> 8) % 64, 1 + ((n >>> 16) % 2), 1);
  }
}

/** Packed dirt with straw and grit flecks. */
function earth(c: CanvasRenderingContext2D) {
  c.fillStyle = "#5b4a34";
  c.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 150; i++) {
    const n = hash(i * 3 + 1);
    c.fillStyle = i % 3 ? "rgba(126,102,68,.32)" : "rgba(44,32,20,.38)";
    c.fillRect(
      n % 64,
      (n >>> 8) % 64,
      2 + ((n >>> 16) % 5),
      1 + ((n >>> 21) % 3),
    );
  }
  for (let i = 0; i < 60; i++) {
    const n = hash(i * 11 + 5);
    c.fillStyle = "rgba(206,196,178,.34)";
    c.fillRect(n % 64, (n >>> 8) % 64, 1, 1);
  }
  for (let i = 0; i < 34; i++) {
    const n = hash(i * 7 + 3),
      x = n % 64,
      y = (n >>> 8) % 64;
    c.strokeStyle = i % 2 ? "rgba(198,178,118,.55)" : "rgba(150,128,78,.5)";
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + 2 + ((n >>> 16) % 3), y - 1 + ((n >>> 19) % 3));
    c.stroke();
  }
}

/** Small ceramic tesserae at roughly 5 cm with pale grout. */
function mosaic(c: CanvasRenderingContext2D) {
  c.fillStyle = "#b3aea1";
  c.fillRect(0, 0, 64, 64);
  const tiles = [
    "#a4c2bd",
    "#c7b198",
    "#8d9db3",
    "#d2c7a6",
    "#9db398",
    "#bfa2a0",
  ];
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const n = hash(x * 23 + y * 41);
      c.fillStyle = tiles[(n >>> 3) % tiles.length];
      c.fillRect(x * 4, y * 4, 3, 3);
      c.fillStyle = "rgba(255,255,255,.16)";
      c.fillRect(x * 4, y * 4, 1, 1);
      c.fillStyle = "rgba(0,0,0,.16)";
      c.fillRect(x * 4 + 2, y * 4 + 2, 1, 1);
    }
}

/** The outdoor ground a design may choose, or the compacted-earth variant used
 * for trodden paths on every natural ground. */
export type GroundPattern =
  | "asphalt"
  | "cobble"
  | "sand"
  | "snow"
  | "grass"
  | "rock"
  | "regolith"
  | "seabed"
  | "ice"
  | "moss"
  | "mud"
  | "tile"
  | "packed";

/** Paths follow the street surface on road grounds and are trodden earth on
 * every natural ground. */
export function pathPattern(ground: GroundPattern): GroundPattern {
  return ground === "asphalt" || ground === "cobble" || ground === "tile"
    ? ground
    : "packed";
}

/** Gloss and relief per ground; the surface colour comes from the material. */
export function groundMaterialParams(ground: GroundPattern) {
  switch (ground) {
    case "ice":
      return { roughness: 0.2, metalness: 0.12, glow: 0.3 };
    case "tile":
      return { roughness: 0.5, metalness: 0.02, glow: 0.4 };
    case "snow":
      return { roughness: 0.9, metalness: 0, glow: 0.5 };
    case "seabed":
      return { roughness: 0.92, metalness: 0, glow: 0.4 };
    case "cobble":
      return { roughness: 0.88, metalness: 0, glow: 0.4 };
    default:
      return { roughness: 1, metalness: 0, glow: 0.4 };
  }
}

/** Pale, mostly neutral repeating surfaces; the material colour tints them.
 * One texture tile spans four world metres (see ExteriorDressing.buildGround). */
export function groundTexture(ground: GroundPattern) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const c = canvas.getContext("2d")!;
  paintGround(c, ground);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(70, 70);
  texture.anisotropy = 4;
  return texture;
}

function speckle(
  c: CanvasRenderingContext2D,
  count: number,
  light: string,
  dark: string,
  seed: number,
  size = 1,
) {
  for (let i = 0; i < count; i++) {
    const n = hash(i * 3 + seed);
    c.fillStyle = i % 2 ? light : dark;
    c.fillRect(n % 64, (n >>> 8) % 64, size, size);
  }
}

function paintGround(c: CanvasRenderingContext2D, ground: GroundPattern) {
  const fill = (color: string) => {
    c.fillStyle = color;
    c.fillRect(0, 0, 64, 64);
  };
  switch (ground) {
    case "asphalt":
      fill("#d2d2d2");
      speckle(c, 700, "rgba(255,255,255,.35)", "rgba(0,0,0,.22)", 1);
      c.strokeStyle = "rgba(0,0,0,.2)";
      c.beginPath();
      c.moveTo(5, 0);
      c.lineTo(9, 20);
      c.lineTo(2, 38);
      c.moveTo(9, 20);
      c.lineTo(22, 29);
      c.stroke();
      break;
    case "cobble": {
      fill("#8e8e8e");
      for (let row = 0; row < 4; row++)
        for (let col = 0; col < 4; col++) {
          const n = hash(row * 4 + col + 40),
            shade = 190 + (n % 50),
            x = col * 16 + (row % 2 ? 8 : 0) - 8,
            y = row * 16;
          for (const dx of [0, 64]) {
            c.fillStyle = `rgb(${shade},${shade},${shade - 4})`;
            c.beginPath();
            c.roundRect(x + dx + 1, y + 1, 14, 14, 4);
            c.fill();
          }
        }
      break;
    }
    case "sand":
      fill("#e6e3dc");
      speckle(c, 500, "rgba(255,255,255,.4)", "rgba(120,100,70,.18)", 2);
      c.strokeStyle = "rgba(140,120,90,.16)";
      for (let y = 6; y < 64; y += 14) {
        c.beginPath();
        c.moveTo(0, y);
        c.bezierCurveTo(16, y - 4, 40, y + 4, 64, y);
        c.stroke();
      }
      break;
    case "snow":
      fill("#f4f6f8");
      for (let i = 0; i < 40; i++) {
        const n = hash(i + 90);
        c.fillStyle = "rgba(150,170,200,.16)";
        c.beginPath();
        c.ellipse(n % 64, (n >>> 8) % 64, 5, 2.5, 0, 0, Math.PI * 2);
        c.fill();
      }
      speckle(c, 160, "rgba(255,255,255,.9)", "rgba(190,205,225,.5)", 3);
      break;
    case "grass":
      fill("#c9cdc7");
      for (let i = 0; i < 520; i++) {
        const n = hash(i + 120),
          x = n % 64,
          y = (n >>> 8) % 64;
        c.strokeStyle = i % 2 ? "rgba(255,255,255,.35)" : "rgba(0,0,0,.25)";
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + ((n >>> 16) % 3) - 1, y - 2 - ((n >>> 20) % 3));
        c.stroke();
      }
      break;
    case "rock":
      fill("#bdbdbd");
      c.strokeStyle = "rgba(0,0,0,.4)";
      for (let i = 0; i < 9; i++) {
        const n = hash(i + 150);
        c.beginPath();
        c.moveTo(n % 64, (n >>> 6) % 64);
        c.lineTo((n >>> 12) % 64, (n >>> 18) % 64);
        c.lineTo((n >>> 3) % 64, (n >>> 9) % 64);
        c.stroke();
      }
      for (let i = 0; i < 18; i++) {
        const n = hash(i + 180);
        c.fillStyle = i % 2 ? "rgba(255,255,255,.14)" : "rgba(0,0,0,.14)";
        c.fillRect(n % 56, (n >>> 8) % 56, 6 + (n % 7), 4 + ((n >>> 5) % 6));
      }
      break;
    case "regolith":
      fill("#b8b8b8");
      speckle(c, 600, "rgba(255,255,255,.3)", "rgba(0,0,0,.28)", 4);
      for (let i = 0; i < 5; i++) {
        const n = hash(i + 210),
          x = n % 64,
          y = (n >>> 8) % 64,
          r = 3 + (n % 5);
        c.strokeStyle = "rgba(0,0,0,.3)";
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.stroke();
        c.strokeStyle = "rgba(255,255,255,.3)";
        c.beginPath();
        c.arc(x - 1, y - 1, r, 3.6, 5.2);
        c.stroke();
      }
      break;
    case "seabed":
      fill("#c9d0d2");
      c.strokeStyle = "rgba(0,0,0,.14)";
      for (let y = 0; y < 64; y += 8) {
        c.beginPath();
        for (let x = 0; x <= 64; x += 4)
          c.lineTo(x, y + Math.sin(x / 5 + y) * 2);
        c.stroke();
      }
      speckle(c, 160, "rgba(255,255,255,.5)", "rgba(0,0,0,.15)", 5);
      break;
    case "ice":
      fill("#e8f0f6");
      for (let i = 0; i < 6; i++) {
        const n = hash(i + 240);
        c.strokeStyle = "rgba(255,255,255,.8)";
        c.beginPath();
        c.moveTo(n % 64, 0);
        c.lineTo((n >>> 8) % 64, 32);
        c.lineTo((n >>> 16) % 64, 64);
        c.stroke();
        c.strokeStyle = "rgba(90,120,160,.22)";
        c.beginPath();
        c.moveTo((n % 64) + 1, 0);
        c.lineTo(((n >>> 8) % 64) + 1, 32);
        c.stroke();
      }
      break;
    case "moss":
      fill("#c7ccc2");
      for (let i = 0; i < 70; i++) {
        const n = hash(i + 270);
        c.fillStyle = i % 2 ? "rgba(255,255,255,.2)" : "rgba(0,0,0,.2)";
        c.beginPath();
        c.arc(n % 64, (n >>> 8) % 64, 2 + (n % 4), 0, Math.PI * 2);
        c.fill();
      }
      break;
    case "mud":
      fill("#b7b3ad");
      for (let i = 0; i < 14; i++) {
        const n = hash(i + 300);
        c.fillStyle = i % 3 ? "rgba(0,0,0,.18)" : "rgba(255,255,255,.12)";
        c.beginPath();
        c.ellipse(
          n % 64,
          (n >>> 8) % 64,
          4 + (n % 6),
          2 + ((n >>> 5) % 4),
          (n % 7) / 3,
          0,
          Math.PI * 2,
        );
        c.fill();
      }
      speckle(c, 200, "rgba(255,255,255,.2)", "rgba(0,0,0,.25)", 6);
      break;
    case "tile":
      fill("#9a9a9a");
      for (const [x, y] of [
        [0, 0],
        [32, 0],
        [0, 32],
        [32, 32],
      ]) {
        c.fillStyle = (x + y) % 64 ? "#d8d8d8" : "#cfcfcf";
        c.fillRect(x + 1, y + 1, 30, 30);
      }
      break;
    default:
      // Trodden earth: compacted pale ground with a few pebbles and faint ruts.
      fill("#cfcbc3");
      speckle(c, 420, "rgba(255,255,255,.3)", "rgba(0,0,0,.22)", 7);
      c.strokeStyle = "rgba(0,0,0,.1)";
      for (const y of [18, 44]) {
        c.beginPath();
        c.moveTo(0, y);
        c.lineTo(64, y + 2);
        c.stroke();
      }
      for (let i = 0; i < 8; i++) {
        const n = hash(i + 330);
        c.fillStyle = "rgba(90,85,78,.45)";
        c.fillRect(n % 62, (n >>> 8) % 62, 2, 2);
      }
  }
}
