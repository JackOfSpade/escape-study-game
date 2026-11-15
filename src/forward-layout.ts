import { roofIndexOf } from "./model";
import { canPlace } from "./spatial";
import {
  type Floor,
  type Furniture,
  type Point,
  rand,
  distance,
} from "./model";
/** Upgrade fresh generated floors only. Restored worlds retain their physical geometry. */
export function forwardLayout(f: Floor, seed: number) {
  if (f.index >= roofIndexOf(f)) return;
  const random = { rng: (seed ^ Math.imul(f.index + 1, 0x45d9f3b)) >>> 0 };
  const upper = 12 + Math.floor(rand(random) * 3),
    lower = 16 + Math.floor(rand(random) * 2);
  f.generation = { version: 2, upperDivider: upper, lowerDivider: lower };
  for (let x = 2; x < 42; x++)
    if (x < 17 || x > 26) {
      for (let y = 12; y <= 17; y++) f.tiles[y][x] = 0;
      f.tiles[upper][x] = 1;
      f.tiles[lower][x] = 1;
    }
  // Keep annex partitions out of the randomized transverse hall.
  for (const r of f.rooms ?? [])
    if (r.innerMouth) {
      const x = Math.floor(r.innerMouth.x);
      for (let y = 2; y < upper; y++) f.tiles[y][x] = 1;
      const y = Math.floor(r.innerMouth.y);
      f.tiles[y][x] = 0;
    }
  const addDoor = (id: string, p: Point, w: number, h: number) => {
    for (let y = Math.floor(p.y - h / 2); y < Math.ceil(p.y + h / 2); y++)
      for (let x = Math.floor(p.x - w / 2); x < Math.ceil(p.x + w / 2); x++)
        f.tiles[y][x] = 0;
    const door: Furniture = {
      id,
      floor: f.index,
      kind: "door",
      x: p.x,
      y: p.y,
      w,
      h,
      hp: 240,
      maxHp: 240,
      speed: 0,
      rotation: 0,
      destroyed: false,
      movers: [],
      moved: 0,
      credited: [],
      turning: 0,
      open: false,
    };
    f.furniture.push(door);
  };
  for (const side of [0, 1]) {
    const x = (side === 0 ? 6 : 33) + Math.floor(rand(random) * 5) + 0.5;
    const bottom = f.rooms!.find((r) => r.index === 2 + side)!,
      top = f.rooms!.find((r) => r.index === side)!;
    bottom.forwardExit = { x, y: lower + 0.5 };
    top.forwardEntry = { x, y: upper + 0.5 };
    addDoor(
      `f${f.index}-room${bottom.index}-forward`,
      bottom.forwardExit,
      3,
      1,
    );
    addDoor(`f${f.index}-room${top.index}-rear`, top.forwardEntry, 3, 1);
    // Two distinct openings lead out of each upper room, ahead of its study stations.
    const outer = side === 0 ? 17 : 26;
    top.forwardExit = { x: outer + 0.5, y: 3.5 };
    addDoor(`f${f.index}-room${top.index}-forward`, top.forwardExit, 1, 1);
    if (top.innerMouth) {
      const inner = Math.floor(top.innerMouth.x);
      addDoor(
        `f${f.index}-room${top.index}-forward-inner`,
        { x: inner + 0.5, y: 3.5 },
        1,
        1,
      );
      for (let x = Math.min(inner, outer) + 1; x < Math.max(inner, outer); x++)
        f.tiles[3][x] = 0;
    }
  }
  // Keep movable objects off new walls, terminals and the forward door frames.
  for (const o of f.furniture) {
    if (o.kind === "door" || canPlace(f, o, o)) continue;
    const room = Number(/room(\d+)/.exec(o.id)?.[1]);
    const left = room % 2 === 0,
      top = room < 2;
    const candidates: Point[] = [];
    for (let y = top ? 5 : lower + 1; y < (top ? upper : 27); y++)
      for (let x = left ? 3 : 28; x < (left ? 16 : 41); x++)
        candidates.push({ x: x + 0.5, y: y + 0.5 });
    candidates.sort((a, b) => distance(a, o) - distance(b, o));
    const p = candidates.find(
      (p) => canPlace(f, o, p) && !f.stations.some((s) => distance(p, s) < 1),
    );
    if (!p) throw Error(`No valid initial furniture pose: ${o.id}`);
    Object.assign(o, p);
  }
}
