import { doorStyle } from "./door-style";
import { fieldAllows } from "./force-fields";
import { drawBlood } from "./blood";
import { camera } from "./camera";
import { displayScale } from "./display-scale";
import { human, nearestGrip } from "./engine";
import {
  CONFIG,
  HELIPAD,
  distance,
  type Game,
  H,
  type Point,
  W,
} from "./model";
import { BODY_RADIUS } from "./physics";
import { wall } from "./spatial";
import {
  drawDebris,
  drawFurniture,
  drawWorkstation,
  terrainCanvas,
} from "./office-art";
import { spectating, type SpectatorView } from "./spectator";
import { type Stairwell, stairwell } from "./stairwell";
import { playerCanSee, sightRadius, visibilityPolygon } from "./visibility";
import { stairContactCues } from "./zombie-stairs";
import { npcSpeechBubble, speechLines } from "./speech-bubbles";

/** How long an object visibly reacts to a zombie strike in the 2D view. */
const STRIKE_SHAKE_SECONDS = 0.35;
/** Sideways offset of the 2D impact shake. Only a recent strike shakes an
 * object: lasting damage, including authored wear, shows as cracks and holds
 * still. */
export function strikeShake(
  o: { struckAt?: number },
  time: number,
  reducedFlash = false,
) {
  if (reducedFlash || o.struckAt === undefined) return 0;
  const since = time - o.struckAt;
  return since >= 0 && since < STRIKE_SHAKE_SECONDS
    ? Math.sin(time * 39) * 0.025
    : 0;
}
const tileMemory = new WeakMap<
  Game["survivors"][number],
  {
    source: string[];
    masks: Map<number, Uint8Array>;
    outside: Map<number, Set<string>>;
    length: number;
  }
>();
/** Sample sight independently of canvas drawing, including between minimap draws. */
export function rememberVisibleTiles(g: Game) {
  if (spectating(g)) return;
  const a = human(g),
    floor = g.floors[a.floor],
    radius = sightRadius(floor);
  let memory = tileMemory.get(a);
  if (!memory || memory.source !== a.seen || memory.length !== a.seen.length) {
    const masks = new Map<number, Uint8Array>();
    const outside = new Map<number, Set<string>>();
    for (const id of a.seen) {
      const m = /^tile-(\d+)-(-?\d+)-(-?\d+)$/.exec(id);
      if (!m) continue;
      const f = Number(m[1]),
        tx = Number(m[2]),
        ty = Number(m[3]);
      if (tx < 0 || tx >= W || ty < 0 || ty >= H) {
        let tiles = outside.get(f);
        if (!tiles) outside.set(f, (tiles = new Set()));
        tiles.add(`${tx},${ty}`);
        continue;
      }
      let mask = masks.get(f);
      if (!mask) masks.set(f, (mask = new Uint8Array(W * H)));
      mask[ty * W + tx] = 1;
    }
    memory = { source: a.seen, masks, outside, length: a.seen.length };
    tileMemory.set(a, memory);
  }
  let mask = memory.masks.get(a.floor);
  if (!mask) memory.masks.set(a.floor, (mask = new Uint8Array(W * H)));
  const pt = { x: 0, y: 0 };
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x]) continue;
      pt.x = x + 0.5;
      pt.y = y + 0.5;
      if (playerCanSee(floor, a, pt, radius)) {
        a.seen.push(`tile-${a.floor}-${x}-${y}`);
        mask[y * W + x] = 1;
      }
    }
  // Fresh runs can continue into the physical streets beyond the office grid.
  // Keep only nearby outside cells in memory as the player walks, rather than
  // scanning the entire neighbourhood on every frame.
  if (floor.city) {
    let outside = memory.outside.get(a.floor);
    if (!outside) memory.outside.set(a.floor, (outside = new Set()));
    const r = radius;
    for (let y = Math.floor(a.y - r); y <= Math.floor(a.y + r); y++)
      for (let x = Math.floor(a.x - r); x <= Math.floor(a.x + r); x++) {
        if (x >= 0 && x < W && y >= 0 && y < H) continue;
        const key = `${x},${y}`;
        if (outside.has(key)) continue;
        pt.x = x + 0.5;
        pt.y = y + 0.5;
        if (playerCanSee(floor, a, pt, r)) {
          a.seen.push(`tile-${a.floor}-${x}-${y}`);
          outside.add(key);
        }
      }
  }
  memory.length = a.seen.length;
}
/** In-world object names: the furniture kind, spaced and upper-cased. */
export function objectName(kind: string) {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2").toUpperCase();
}
export const normal = {
  wall: "#354547",
  edge: "#536361",
  ink: "#d6e4d8",
  accent: "#6ff2b2",
  terminal: "#54cec7",
  danger: "#ef7865",
  furniture: "#9a8065",
  sky: "#0b1418",
  dim: "#121e22",
};
export const mutation = {
  wall: "#53405a",
  edge: "#887068",
  ink: "#f9e6bc",
  accent: "#e9c76e",
  terminal: "#e4a0e4",
  danger: "#ff7585",
  furniture: "#b18478",
  sky: "#160f24",
  dim: "#20162e",
};
let lightCanvas: HTMLCanvasElement | undefined;
/** A persistent orientation map. Only the floor cells the player has seen and
 * the walls bordering those cells are drawn; unexplored space stays blank. */
export function renderMinimap(canvas: HTMLCanvasElement, g: Game) {
  const ctx = canvas.getContext("2d")!,
    dpr = Math.min(devicePixelRatio || 1, 2),
    rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  if (
    canvas.width !== Math.floor(rect.width * dpr) ||
    canvas.height !== Math.floor(rect.height * dpr)
  ) {
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
  }
  const a = human(g),
    f = g.floors[a.floor],
    p = g.surge.state === "active" ? mutation : normal;
  rememberVisibleTiles(g);
  const memory = tileMemory.get(a),
    mask = memory?.masks.get(a.floor),
    outside = memory?.outside.get(a.floor),
    known = (x: number, y: number) =>
      x >= 0 && x < W && y >= 0 && y < H
        ? !!mask?.[y * W + x]
        : !!outside?.has(`${x},${y}`),
    open = (x: number, y: number) => !wall(f, x + 0.5, y + 0.5),
    { scale, ox, oy } = camera(
      rect.width,
      rect.height,
      a,
      displayScale(g.settings.displayScale),
    );
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = p.sky;
  ctx.fillRect(0, 0, rect.width, rect.height);
  ctx.save();
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  const bounds = f.city?.bounds,
    x1 = Math.max(Math.floor(-ox / scale) - 1, Math.floor(bounds?.left ?? 0)),
    x2 = Math.min(
      Math.ceil((rect.width - ox) / scale) + 1,
      Math.ceil(bounds?.right ?? W),
    ),
    y1 = Math.max(Math.floor(-oy / scale) - 1, Math.floor(bounds?.top ?? 0)),
    y2 = Math.min(
      Math.ceil((rect.height - oy) / scale) + 1,
      Math.ceil(bounds?.bottom ?? H),
    );
  // Every discovered cell keeps the same brightness after the player leaves.
  // Unknown cells receive no overlay, texture, or outline.
  ctx.fillStyle = p.wall;
  for (let y = y1; y < y2; y++)
    for (let x = x1; x < x2; x++)
      if (known(x, y) && open(x, y)) ctx.fillRect(x, y, 1, 1);
  ctx.fillStyle = p.edge;
  for (let y = y1; y < y2; y++)
    for (let x = x1; x < x2; x++)
      if (
        !open(x, y) &&
        ((known(x - 1, y) && open(x - 1, y)) ||
          (known(x + 1, y) && open(x + 1, y)) ||
          (known(x, y - 1) && open(x, y - 1)) ||
          (known(x, y + 1) && open(x, y + 1)))
      )
        ctx.fillRect(x, y, 1, 1);
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(a.x, a.y, 0.48, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}
/** Draw the player's view, or, with a spectator view after the run ends, the
 * whole of one floor: no fog, no light mask, no interaction prompts. */
export function render(
  canvas: HTMLCanvasElement,
  g: Game,
  view?: SpectatorView,
) {
  const ctx = canvas.getContext("2d")!,
    dpr = Math.min(devicePixelRatio || 1, 2),
    rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return;
  if (
    canvas.width !== Math.floor(rect.width * dpr) ||
    canvas.height !== Math.floor(rect.height * dpr)
  ) {
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const p = g.surge.state === "active" ? mutation : normal;
  ctx.fillStyle = p.sky;
  ctx.fillRect(0, 0, rect.width, rect.height);
  const a = human(g),
    spectator = !!view,
    floorIndex = view?.floor ?? a.floor,
    { scale, ox, oy } = camera(
      rect.width,
      rect.height,
      view ? view.focus : a,
      (view?.zoom ?? 1) * displayScale(g.settings.displayScale),
    );
  ctx.translate(ox, oy);
  ctx.scale(scale, scale);
  const f = g.floors[floorIndex],
    radius = sightRadius(f);
  const visible = spectator
    ? () => true
    : (pt: Point) => playerCanSee(f, a, pt, radius);
  // The player's sight polygon clips the world and lights it; the spectator
  // view has neither.
  const polygon = spectator ? [] : visibilityPolygon(f, a, radius);
  ctx.save();
  if (!spectator) {
    // Clip world geometry and effects. Labels for visible sources are drawn in a
    // separate overlay so their glyphs are not cut off at the visibility boundary.
    // Previously explored geometry is remembered internally but never drawn as
    // current vision through a wall or beyond the finite viewing radius.
    ctx.beginPath();
    polygon.forEach((p, i) =>
      i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y),
    );
    ctx.closePath();
    ctx.clip();
    rememberVisibleTiles(g);
  }
  const theme = g.surge.state === "active" ? "mutation" : "normal";
  if (f.city) {
    ctx.fillStyle = "#353e43";
    for (const road of f.city.roads)
      ctx.fillRect(road.x - road.w / 2, road.y - road.h / 2, road.w, road.h);
    for (const block of f.city.obstacles) {
      ctx.fillStyle = block.kind === "building" ? p.wall : "#61584b";
      ctx.fillRect(
        block.x - block.w / 2,
        block.y - block.h / 2,
        block.w,
        block.h,
      );
    }
    // The stored office raster owns only the building and its masonry ring.
    // Do not paint the retired grid border over the physical city streets.
    ctx.save();
    ctx.beginPath();
    const b = f.boundary!;
    for (let y = b.top - 1; y <= b.bottom; y++) {
      const row = b.rows[Math.max(b.top, Math.min(b.bottom - 1, y))];
      ctx.rect(row.left - 1, y, row.right - row.left + 2, 1);
    }
    ctx.rect(20, b.top - 2, 4, 2);
    ctx.clip();
  }
  // Carpet, vinyl and wall textures are one cached image; the clip limits it to sight.
  ctx.drawImage(terrainCanvas(f, theme, g.seed), 0, 0, W, H);
  if (f.city) ctx.restore();
  ctx.globalAlpha = 1;
  drawBlood(ctx, f);
  const healthBars: {
    x: number;
    y: number;
    width: number;
    health: number;
    color: string;
  }[] = [];
  const labels: {
    text: string;
    x: number;
    y: number;
    color: string;
    size: number;
  }[] = [];
  const spoken: { text: string; x: number; y: number }[] = [];
  const label = (
    text: string,
    x: number,
    y: number,
    color = p.ink,
    size = 0.45,
  ) => {
    labels.push({ text, x, y, color, size });
  };
  /** A staircase: treads between two strings, lit toward the open side. An
   * ascending flight brightens as it climbs; a descending one sinks into shade. */
  const drawStairs = (well: Stairwell) => {
    const { x, y, w, h, open } = well,
      treads = 6,
      depth = h / treads;
    ctx.save();
    ctx.fillStyle = p.sky;
    ctx.fillRect(x, y, w, h);
    for (let i = 0; i < treads; i++) {
      const ty = open > 0 ? y + h - (i + 1) * depth : y + i * depth,
        t = i / (treads - 1),
        shade = well.kind === "up" ? 0.5 + 0.5 * t : 0.9 - 0.7 * t;
      ctx.globalAlpha = shade;
      ctx.fillStyle = p.edge;
      ctx.fillRect(x + 0.14, ty + 0.02, w - 0.28, depth - 0.04);
      ctx.globalAlpha = Math.min(1, shade + 0.25);
      ctx.fillStyle = p.ink;
      ctx.fillRect(
        x + 0.14,
        open > 0 ? ty + depth - 0.08 : ty + 0.02,
        w - 0.28,
        0.06,
      );
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.wall;
    ctx.fillRect(x, y, 0.14, h);
    ctx.fillRect(x + w - 0.14, y, 0.14, h);
    ctx.restore();
  };
  const wellVisible = (well: Stairwell) =>
    visible(well.mouth) || visible(well.marker);
  if (floorIndex === CONFIG.floors) {
    if (visible(HELIPAD)) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 0.15;
      ctx.beginPath();
      ctx.arc(HELIPAD.x, HELIPAD.y, 3.8, 0, Math.PI * 2);
      ctx.stroke();
      label("H", HELIPAD.x, 11.4, p.accent, 2.5);
      if (g.time < g.helicopter.until) {
        ctx.fillStyle = p.edge;
        ctx.fillRect(17.8, 8.5, 7.4, 1.5);
        ctx.fillStyle = p.ink;
        ctx.fillRect(21, 5.5, 0.3, 8);
        label(`${4 - g.helicopter.passengers.length} SEATS`, HELIPAD.x, 14.7);
      }
    }
  } else {
    const well = stairwell(f, "up");
    if (wellVisible(well)) {
      drawStairs(well);
      if (!spectator && !a.access.includes(a.floor))
        label(
          "ACCESS REQUIRED",
          well.mouth.x,
          well.mouth.y + 0.6,
          p.danger,
          0.3,
        );
    }
  }
  if (floorIndex > 0) {
    const well = stairwell(f, "down");
    if (wellVisible(well)) drawStairs(well);
  }
  for (const room of f.rooms ?? []) {
    const mouth = room.innerMouth;
    if (mouth) {
      const labelPoint = {
        x: mouth.x + (room.side === "left" ? -2 : 2),
        y: mouth.y - 2,
      };
      if (visible(labelPoint))
        label("INNER ARCHIVE", labelPoint.x, labelPoint.y, p.ink, 0.3);
    }
  }
  for (const s of f.stations) {
    if (!visible(s)) continue;
    const e = g.encounters[s.encounter];
    drawWorkstation(ctx, s.x, s.y, theme);
    ctx.fillStyle = "#101b20";
    ctx.fillRect(s.x - 0.4, s.y - 0.35, 0.8, 0.5);
    ctx.fillStyle = e.state === "consumed" ? p.edge : p.terminal;
    ctx.shadowColor = p.terminal;
    ctx.shadowBlur = e.state === "consumed" ? 0 : 8;
    ctx.fillRect(s.x - 0.32, s.y - 0.3, 0.64, 0.35);
    ctx.shadowBlur = 0;
    ctx.fillStyle = p.furniture;
    ctx.fillRect(s.x - 0.48, s.y + 0.25, 0.96, 0.14);
    if (!spectator && distance(a, s) < 2)
      label(
        e.state === "consumed"
          ? "E · RECORD"
          : `E · ${e.mode === "shared" ? "SHARED" : "SOLO"} ${e.reward === "loot" ? "CACHE" : "ACCESS"}`,
        s.x,
        s.y - 0.8,
        p.terminal,
        0.38,
      );
  }
  for (const o of f.furniture) {
    if (!visible(o)) continue;
    if (o.kind === "gate" && o.turning < 0) continue;
    const x = o.x - o.w / 2,
      y = o.y - o.h / 2;
    if (o.destroyed) {
      drawDebris(ctx, o, theme);
      continue;
    }
    if (o.field) {
      const green = fieldAllows(o, a),
        color = green ? "#55ef9b" : "#ff6274",
        health = Math.max(0, Math.min(1, o.hp / Math.max(1, o.maxHp))),
        damage = 1 - health;
      ctx.save();
      // The door's own colour; its outline shows personal access.
      ctx.globalAlpha = o.field.leaf ? 0.2 : 0.35 + 0.55 * health;
      ctx.fillStyle = doorStyle(o).color;
      ctx.fillRect(x, y, o.w, o.h);
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = color;
      ctx.lineWidth = 0.07;
      ctx.strokeRect(x, y, o.w, o.h);
      if (damage > 0.1) {
        ctx.translate(o.x, o.y);
        const tall = o.h >= o.w,
          span = tall ? o.h : o.w,
          across = tall ? o.w : o.h;
        if (!tall) ctx.rotate(Math.PI / 2);
        ctx.strokeStyle = "#e3f7ee";
        ctx.lineWidth = 0.035;
        ctx.globalAlpha = 0.45 + damage * 0.45;
        for (let i = 0; i < Math.ceil(damage * 6); i++) {
          const yy = -span * 0.4 + (i / 6) * span * 0.8;
          ctx.beginPath();
          ctx.moveTo(-across * 0.43, yy);
          ctx.lineTo(-across * 0.1, yy + span * 0.035);
          ctx.lineTo(across * 0.12, yy - span * 0.03);
          ctx.lineTo(across * 0.43, yy + span * 0.02);
          ctx.stroke();
        }
      }
      ctx.restore();
      if (health < 1 || (!spectator && distance(a, o) < 3))
        healthBars.push({
          x: o.x,
          y: y + o.h + 0.18,
          width: Math.max(1.6, Math.min(3.2, o.w + 0.8)),
          health,
          color: health <= 0.3 ? "#ffd166" : color,
        });
      // The bar is the field's only status. Text appears only when the field
      // is red for the player and no key could open it.
      if (!spectator && !green && !(a.keys ?? 0))
        label("KEY REQUIRED", o.x, y - 0.4, color, 0.32);
      continue;
    }
    if (o.kind === "door" && o.open && !o.door) {
      ctx.strokeStyle = p.furniture;
      ctx.lineWidth = 0.12;
      ctx.beginPath();
      ctx.moveTo(o.x - 0.45, o.y - o.h / 2);
      ctx.lineTo(o.x + 1.2, o.y - o.h / 2);
      ctx.stroke();
      continue;
    }
    const damage = 1 - o.hp / o.maxHp;
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.rotate(o.angle ?? 0);
    ctx.translate(strikeShake(o, g.time, g.settings.reducedFlash), 0);
    drawFurniture(ctx, o, theme);
    if (damage > 0.2) {
      ctx.strokeStyle = p.sky;
      ctx.lineWidth = 0.07;
      ctx.beginPath();
      ctx.moveTo(-o.w / 3, -o.h / 2);
      ctx.lineTo(0.1, 0);
      ctx.lineTo(-0.1, o.h / 3);
      ctx.stroke();
    }
    if (damage > 0.65) {
      ctx.beginPath();
      ctx.moveTo(o.w / 3, -o.h / 2);
      ctx.lineTo(-0.2, 0.1);
      ctx.lineTo(o.w / 4, o.h / 2);
      ctx.stroke();
    }
    ctx.restore();
  }
  for (const e of g.effects) {
    if (e.until <= g.time || e.floor !== floorIndex || !visible(e)) continue;
    ctx.strokeStyle = e.kind === "bubble" ? p.terminal : p.accent;
    ctx.globalAlpha = g.settings.reducedFlash
      ? 0.3
      : 0.3 + Math.sin(g.time * 3) * 0.1;
    ctx.lineWidth = 0.12;
    ctx.beginPath();
    ctx.arc(e.x, e.y, e.radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  for (const s of g.survivors) {
    if (s.floor !== floorIndex || s.escaped || !visible(s)) continue;
    ctx.save();
    ctx.translate(s.x, s.y);
    ctx.fillStyle = s.alive
      ? s.id === "human"
        ? p.accent
        : "#b5c6cf"
      : p.danger;
    ctx.beginPath();
    ctx.arc(0, 0, BODY_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = s.id === "human" ? p.ink : p.wall;
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(s.heading.x * 0.1, s.heading.y * 0.1);
    ctx.lineTo(s.heading.x * 0.55, s.heading.y * 0.55);
    ctx.stroke();
    if (s.id === "human" && s.alive) {
      ctx.strokeStyle = p.accent;
      ctx.lineWidth = 0.04;
      ctx.beginPath();
      ctx.arc(
        0,
        0,
        0.6 + (g.settings.reducedFlash ? 0 : Math.sin(g.time * 3) * 0.04),
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
    ctx.restore();
    if (s.id !== "human" && (spectator || distance(a, s) < 5))
      label(s.name, s.x, s.y - 0.6, p.ink, 0.4);
    const speech =
      s.alive && s.id !== "human" ? npcSpeechBubble(g, s.id) : undefined;
    if (speech && (spectator || g.settings.view === "top-down"))
      spoken.push({ text: speech.text, x: s.x, y: s.y - 1.0 });
  }
  for (const z of g.zombies) {
    if (z.floor !== floorIndex || z.hp <= 0 || !visible(z)) continue;
    ctx.fillStyle = "#96a534";
    ctx.beginPath();
    ctx.arc(z.x, z.y, BODY_RADIUS, 0, Math.PI * 2);
    ctx.fill();
    const target = z.target ?? z.path[0];
    const heading = target
      ? Math.atan2(target.y - z.y, target.x - z.x)
      : Math.PI / 2;
    ctx.strokeStyle = p.wall;
    ctx.lineWidth = 0.1;
    ctx.beginPath();
    ctx.moveTo(z.x + Math.cos(heading) * 0.1, z.y + Math.sin(heading) * 0.1);
    ctx.lineTo(z.x + Math.cos(heading) * 0.55, z.y + Math.sin(heading) * 0.55);
    ctx.stroke();
  }
  for (const contact of spectator ? [] : stairContactCues(g, a, radius)) {
    ctx.strokeStyle = p.danger;
    ctx.lineWidth = 0.08;
    ctx.globalAlpha = g.settings.reducedFlash ? 0.55 : 0.9;
    for (const offset of [-0.2, 0, 0.2]) {
      ctx.beginPath();
      ctx.moveTo(contact.position.x + offset - 0.1, contact.position.y - 0.25);
      ctx.lineTo(contact.position.x + offset + 0.1, contact.position.y + 0.2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  if (!spectator) {
    drawLight();
    // The held or nearest reachable object shows only its name.
    const ob =
      f.furniture.find((o) => o.id === a.grip?.object) ?? nearestGrip(g, a);
    if (ob && distance(a, ob) < 2.8 && playerCanSee(f, a, ob, radius))
      label(objectName(ob.kind), ob.x, ob.y - ob.h / 2 - 0.4, p.ink, 0.38);
  }
  ctx.restore();
  // Visibility was checked at each source before queuing. Only text extends
  // beyond the fog mask; unseen entities still contribute no labels.
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.textAlign = "center";
  ctx.strokeStyle = p.sky;
  ctx.lineWidth = 0.07;
  ctx.lineJoin = "round";
  for (const bar of healthBars) {
    ctx.fillStyle = p.sky;
    ctx.fillRect(
      bar.x - bar.width / 2 - 0.04,
      bar.y - 0.04,
      bar.width + 0.08,
      0.22,
    );
    ctx.fillStyle = "#52636b";
    ctx.fillRect(bar.x - bar.width / 2, bar.y, bar.width, 0.14);
    ctx.fillStyle = bar.color;
    ctx.fillRect(bar.x - bar.width / 2, bar.y, bar.width * bar.health, 0.14);
  }
  for (const { text, x, y, color, size } of labels) {
    ctx.font = `500 ${size}px ui-monospace,monospace`;
    ctx.fillStyle = color;
    ctx.strokeText(text, x, y);
    ctx.fillText(text, x, y);
  }
  for (const speech of spoken) {
    const lines = speechLines(speech.text, 34),
      width = 6.8,
      height = lines.length * 0.38 + 0.3;
    ctx.fillStyle = "rgba(10,23,27,.96)";
    ctx.strokeStyle = p.terminal;
    ctx.lineWidth = 0.04;
    ctx.fillRect(speech.x - width / 2, speech.y - height, width, height);
    ctx.strokeRect(speech.x - width / 2, speech.y - height, width, height);
    ctx.fillStyle = p.ink;
    ctx.font = "500 0.3px ui-monospace,monospace";
    lines.forEach((line, i) =>
      ctx.fillText(
        line,
        speech.x,
        speech.y - height + 0.4 + i * 0.38,
        width - 0.3,
      ),
    );
  }
  ctx.restore();
  /** Ray-cast player light stops only at walls; dark floors stay dark during
   * mutation. The spectator view skips it: the whole floor is lit. */
  function drawLight() {
    lightCanvas ??= document.createElement("canvas");
    if (
      lightCanvas.width !== canvas.width ||
      lightCanvas.height !== canvas.height
    ) {
      lightCanvas.width = canvas.width;
      lightCanvas.height = canvas.height;
    }
    const lc = lightCanvas.getContext("2d")!;
    lc.setTransform(dpr, 0, 0, dpr, 0, 0);
    lc.globalCompositeOperation = "source-over";
    lc.clearRect(0, 0, rect.width, rect.height);
    lc.fillStyle = `rgba(0,0,0,${f.dark > 0.8 ? 0.78 : 0.47})`;
    lc.fillRect(0, 0, rect.width, rect.height);
    lc.translate(ox, oy);
    lc.scale(scale, scale);
    lc.globalCompositeOperation = "destination-out";
    const lights = [
      { x: a.x, y: a.y, r: radius },
      ...g.effects
        .filter(
          (e) => e.kind === "flare" && e.until > g.time && e.floor === a.floor,
        )
        .map((e) => ({ x: e.x, y: e.y, r: e.radius })),
    ];
    for (const light of lights) {
      lc.beginPath();
      const points =
        light === lights[0] ? polygon : visibilityPolygon(f, light, light.r);
      points.forEach((p, i) =>
        i === 0 ? lc.moveTo(p.x, p.y) : lc.lineTo(p.x, p.y),
      );
      lc.closePath();
      const grad = lc.createRadialGradient(
        light.x,
        light.y,
        0,
        light.x,
        light.y,
        light.r,
      );
      grad.addColorStop(0, "rgba(255,255,255,.98)");
      grad.addColorStop(0.45, "rgba(255,255,255,.9)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      lc.fillStyle = grad;
      lc.fill();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lightCanvas, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(ox, oy);
    ctx.scale(scale, scale);
  }
}
