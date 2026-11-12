import { type Floor, type Game, type Point, distance } from "./model";
import { floorCols, floorRows } from "./site";
import { wall } from "./spatial";

// Four cells per world unit: permanent coverage has a fixed upper bound of
// cols*rows*16 characters per floor, rather than one saved object per footstep.
export const BLOOD_RESOLUTION = 4;
const marks = "abcdefghijklmnop";
const stride = 0.28;
export function footprintPose(mark: string) {
  const code = marks.indexOf(mark);
  if (code >= 0)
    return {
      angle: (Math.floor(code / 2) * Math.PI) / 4,
      side: code % 2 ? 1 : -1,
    };
  // Previously saved droplets have no direction. Preserve their locations as
  // small footprints rather than discarding an existing run's trail.
  return /^[123]$/.test(mark)
    ? { angle: 0, side: Number(mark) % 2 ? -1 : 1 }
    : undefined;
}
function stain(f: Floor, p: Point, angle: number, right: boolean) {
  if (wall(f, p.x, p.y)) return;
  const width = floorCols(f) * BLOOD_RESOLUTION,
    height = floorRows(f) * BLOOD_RESOLUTION,
    x = Math.floor(p.x * BLOOD_RESOLUTION),
    y = Math.floor(p.y * BLOOD_RESOLUTION);
  if (x < 0 || x >= width || y < 0 || y >= height) return;
  const rows = (f.blood ??= []),
    row = (rows[y] ?? "").padEnd(width, "0"),
    direction = ((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8,
    mark = marks[direction * 2 + Number(right)];
  rows[y] = row.slice(0, x) + mark + row.slice(x + 1);
}
export function recordZombieTrails(g: Game) {
  for (const z of g.zombies) {
    if (z.hp <= 0) continue;
    const previous = z.bloodStep;
    if (
      !previous ||
      previous.floor !== z.floor ||
      distance(previous, z) > 1.5
    ) {
      z.bloodStep = { x: z.x, y: z.y, floor: z.floor };
      continue;
    }
    const d = distance(previous, z),
      steps = Math.floor(d / stride),
      angle = Math.atan2(z.y - previous.y, z.x - previous.x);
    for (let i = 1; i <= steps; i++)
      stain(
        g.floors[z.floor],
        {
          x: previous.x + ((z.x - previous.x) * i * stride) / d,
          y: previous.y + ((z.y - previous.y) * i * stride) / d,
        },
        angle,
        (i % 2 === 1) !== !!previous.right,
      );
    if (steps)
      z.bloodStep = {
        x: previous.x + ((z.x - previous.x) * steps * stride) / d,
        y: previous.y + ((z.y - previous.y) * steps * stride) / d,
        floor: z.floor,
        right: steps % 2 ? !previous.right : !!previous.right,
      };
  }
}
const layers = new WeakMap<
  Floor,
  { canvas: HTMLCanvasElement; rows: (string | undefined)[] }
>();
export function drawBlood(ctx: CanvasRenderingContext2D, f: Floor) {
  if (!f.blood) return;
  const cols = floorCols(f),
    rows = floorRows(f),
    width = cols * BLOOD_RESOLUTION,
    height = rows * BLOOD_RESOLUTION;
  let layer = layers.get(f);
  if (
    !layer ||
    layer.canvas.width !== cols * 32 ||
    layer.canvas.height !== rows * 32
  ) {
    const canvas = document.createElement("canvas");
    canvas.width = cols * 32;
    canvas.height = rows * 32;
    layer = { canvas, rows: [] };
    layers.set(f, layer);
  }
  const ink = layer.canvas.getContext("2d")!;
  for (let y = 0; y < height; y++) {
    const row = f.blood[y];
    if (row === layer.rows[y]) continue;
    ink.clearRect(0, y * 8, layer.canvas.width, 8);
    for (let x = 0; x < Math.min(width, row?.length ?? 0); x++) {
      const pose = footprintPose(row![x]);
      if (!pose) continue;
      const c = Math.cos(pose.angle),
        s = Math.sin(pose.angle);
      ink.save();
      ink.translate(x * 8 + 4 - s * pose.side, y * 8 + 4 + c * pose.side);
      ink.rotate(pose.angle);
      ink.fillStyle = "#823034";
      // A narrow forefoot and separate heel, rather than a round blood drop.
      ink.beginPath();
      ink.ellipse(0.65, 0, 1.15, 0.65, 0, 0, Math.PI * 2);
      ink.fill();
      ink.fillStyle = "#672227";
      ink.beginPath();
      ink.ellipse(-1.15, 0, 0.55, 0.5, 0, 0, Math.PI * 2);
      ink.fill();
      ink.restore();
    }
    layer.rows[y] = row;
  }
  ctx.drawImage(layer.canvas, 0, 0, cols, rows);
}
