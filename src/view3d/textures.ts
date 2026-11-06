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
  | "polished";

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
