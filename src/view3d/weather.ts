import {
  AdditiveBlending,
  BufferGeometry,
  CanvasTexture,
  Color,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Points,
  PointsMaterial,
  SRGBColorSpace,
} from "three";
import type { RunWeather } from "../setting-catalog.mjs";

/** Hard cap on live particles for every kind. */
export const WEATHER_MAX_PARTICLES = 600;

interface Style {
  count: number;
  /** Metres per second; negative falls, positive rises. */
  vy: number;
  /** Steady horizontal drift (x, z) in metres per second. */
  wind: [number, number];
  /** Side-to-side wander in metres. */
  wobble: number;
  size: number;
  color: string;
  /** A second colour mixed in by particle (leaves, embers). */
  color2?: string;
  opacity: number;
  glow: boolean;
  streak?: number;
}

const STYLES: Record<Exclude<RunWeather, "none">, Style> = {
  rain: {
    count: 560,
    vy: -24,
    wind: [1.5, 0.6],
    wobble: 0,
    size: 0.05,
    color: "#aebfd6",
    opacity: 0.5,
    glow: false,
    streak: 0.7,
  },
  snow: {
    count: 600,
    vy: -1.5,
    wind: [0.5, 0.2],
    wobble: 0.6,
    size: 0.11,
    color: "#ffffff",
    opacity: 0.9,
    glow: false,
  },
  bubbles: {
    count: 320,
    vy: 1,
    wind: [0.1, 0],
    wobble: 0.25,
    size: 0.16,
    color: "#bfe9ff",
    opacity: 0.55,
    glow: false,
  },
  dust: {
    count: 460,
    vy: -0.06,
    wind: [1.6, 0.5],
    wobble: 0.35,
    size: 0.08,
    color: "#cfae78",
    opacity: 0.4,
    glow: false,
  },
  embers: {
    count: 300,
    vy: 1.5,
    wind: [0.5, 0.2],
    wobble: 0.5,
    size: 0.1,
    color: "#ff8a3a",
    color2: "#ffd27a",
    opacity: 0.95,
    glow: true,
  },
  spores: {
    count: 320,
    vy: 0.12,
    wind: [0.15, 0.1],
    wobble: 0.7,
    size: 0.12,
    color: "#a6ffb5",
    color2: "#d9b8ff",
    opacity: 0.75,
    glow: true,
  },
  ash: {
    count: 440,
    vy: -0.55,
    wind: [0.7, 0.3],
    wobble: 0.45,
    size: 0.11,
    color: "#a3a29f",
    color2: "#5c5b59",
    opacity: 0.7,
    glow: false,
  },
  leaves: {
    count: 240,
    vy: -0.9,
    wind: [1.2, 0.5],
    wobble: 1.1,
    size: 0.2,
    color: "#b97b2e",
    color2: "#6f8f3a",
    opacity: 0.95,
    glow: false,
  },
};

const hash = (i: number) => {
  let v = Math.imul(i + 0x9e3779b9, 0x45d9f3b);
  v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296;
};

/** Half-width of the box of air that follows the viewer, and its height. */
const SPAN = 22;
const HEIGHT = 16;

/** A bounded particle volume that follows the camera. Every particle's
 * position is an analytic function of time, its fixed seed and the viewer, so
 * nothing is allocated per frame and a reload looks identical. */
export class WeatherField {
  readonly group = new Group();
  private kind: RunWeather = "none";
  private style?: Style;
  private points?: Points<BufferGeometry, PointsMaterial>;
  private lines?: LineSegments<BufferGeometry, LineBasicMaterial>;
  private seeds = new Float32Array(0);
  private sprite?: CanvasTexture;
  private level = 0;
  private lastTime = 0;

  constructor() {
    this.group.name = "weather";
    this.group.visible = false;
  }

  get active() {
    return this.kind !== "none";
  }

  /** Number of live particles for the current kind. */
  get count() {
    return this.style?.count ?? 0;
  }

  setKind(kind: RunWeather) {
    if (kind === this.kind) return;
    this.clear();
    this.kind = kind;
    if (kind === "none") return;
    const style = STYLES[kind],
      count = Math.min(WEATHER_MAX_PARTICLES, style.count);
    this.style = { ...style, count };
    this.seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++)
      for (let k = 0; k < 4; k++) this.seeds[i * 4 + k] = hash(i * 7 + k * 131);
    const geometry = new BufferGeometry(),
      vertices = style.streak ? count * 2 : count;
    geometry.setAttribute(
      "position",
      new Float32BufferAttribute(new Float32Array(vertices * 3), 3),
    );
    if (style.streak) {
      this.lines = new LineSegments(
        geometry,
        new LineBasicMaterial({
          color: style.color,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        }),
      );
      this.lines.frustumCulled = false;
      this.group.add(this.lines);
    } else {
      const colors = new Float32Array(count * 3),
        a = new Color(style.color),
        b = new Color(style.color2 ?? style.color),
        mixed = new Color();
      for (let i = 0; i < count; i++) {
        mixed.copy(a).lerp(b, this.seeds[i * 4 + 3]);
        mixed.toArray(colors, i * 3);
      }
      geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
      this.points = new Points(
        geometry,
        new PointsMaterial({
          ...spriteMap(this.makeSprite()),
          vertexColors: true,
          size: style.size,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          ...(style.glow ? { blending: AdditiveBlending } : {}),
        }),
      );
      this.points.frustumCulled = false;
      this.group.add(this.points);
    }
    this.level = 0;
  }

  private makeSprite() {
    if (typeof document === "undefined") return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 32;
    const c = canvas.getContext("2d");
    if (!c) return undefined;
    const gradient = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.55, "rgba(255,255,255,.55)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = gradient;
    c.fillRect(0, 0, 32, 32);
    this.sprite = new CanvasTexture(canvas);
    this.sprite.colorSpace = SRGBColorSpace;
    return this.sprite;
  }

  /** Position every particle around the viewer. `exposed` is false indoors,
   * where the weather fades out instead of falling through the ceiling. A
   * reduced-motion player gets a still field. */
  update(
    time: number,
    view: { x: number; y: number; z: number; exposed: boolean },
    reducedMotion = false,
  ) {
    const style = this.style;
    if (!style) {
      this.group.visible = false;
      return;
    }
    const dt = Math.min(0.25, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const target = view.exposed ? 1 : 0;
    this.level += Math.sign(target - this.level) * Math.min(1, dt * 1.5);
    this.level = Math.min(1, Math.max(0, this.level));
    if (Math.abs(target - this.level) < 0.02) this.level = target;
    this.group.visible = this.level > 0;
    if (!this.group.visible) return;
    const clock = reducedMotion ? 0 : time,
      material = (this.points?.material ?? this.lines!.material) as
        PointsMaterial | LineBasicMaterial;
    material.opacity = style.opacity * this.level;
    const geometry = (this.points ?? this.lines!).geometry,
      position = geometry.getAttribute("position"),
      size = SPAN * 2,
      bottom = view.y - 4;
    for (let i = 0; i < style.count; i++) {
      const sx = this.seeds[i * 4],
        sy = this.seeds[i * 4 + 1],
        sz = this.seeds[i * 4 + 2],
        sw = this.seeds[i * 4 + 3];
      const wobble = style.wobble
        ? Math.sin(clock * (0.6 + sw) + sx * 40) * style.wobble
        : 0;
      const rawX = sx * size + (style.wind[0] * clock + wobble),
        rawZ =
          sz * size +
          (style.wind[1] * clock +
            (style.wobble
              ? Math.cos(clock * (0.5 + sw) + sz * 40) * style.wobble
              : 0)),
        rawY = sy * HEIGHT + style.vy * clock;
      // Wrap into a box that stays centred on the viewer, so particles leave
      // one face as new ones enter the opposite one.
      const x = view.x - SPAN + wrap(rawX - (view.x - SPAN), size),
        z = view.z - SPAN + wrap(rawZ - (view.z - SPAN), size),
        y = bottom + wrap(rawY - bottom, HEIGHT);
      if (style.streak) {
        position.setXYZ(i * 2, x, y, z);
        position.setXYZ(
          i * 2 + 1,
          x - (style.wind[0] / -style.vy) * style.streak,
          y + style.streak,
          z - (style.wind[1] / -style.vy) * style.streak,
        );
      } else position.setXYZ(i, x, y, z);
    }
    position.needsUpdate = true;
  }

  private clear() {
    for (const object of [this.points, this.lines]) {
      if (!object) continue;
      object.geometry.dispose();
      object.material.dispose();
      object.removeFromParent();
    }
    this.sprite?.dispose();
    this.sprite = this.points = this.lines = undefined;
    this.style = undefined;
    this.kind = "none";
  }

  dispose() {
    this.clear();
    this.group.removeFromParent();
  }
}

function spriteMap(map: CanvasTexture | undefined) {
  return map ? { map } : {};
}

function wrap(value: number, period: number) {
  return ((value % period) + period) % period;
}
