import {
  BoxGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedBufferAttribute,
  LinearFilter,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SphereGeometry,
  SRGBColorSpace,
} from "three";
import type { Floor, Furniture, Point } from "../model";
import {
  PROP_CATALOG,
  SCENE_LIMITS,
  type ScenePropDesign,
} from "../scene-catalog.mjs";
import type { RunObjectAxis, RunObjectMotion } from "../setting-catalog.mjs";
import type { ResolvedSceneProp } from "../authored-scene";
import {
  AXIS_SHAPES,
  motionPhase,
  objectGeometry,
  partMotion,
  partTilt,
  type PartMotionPose,
} from "./object-shapes";
import {
  furnitureSurfaceHeightOf,
  furnitureSurfaceBoundsOf,
  surfacePart,
} from "./furniture-height";
import { InstancePool } from "./instances";
import {
  PROP_LABEL_FACES as LABEL_FACES,
  furnitureLabelFace,
  propSurfaceFace,
} from "../environment-faces";
import type { InteriorLightmap } from "./interior-lightmap";

type Shape = "box" | "cylinder" | "cone" | "sphere";
export interface PropPart {
  shape: Shape;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  color: string;
}
type PropAppearance = Pick<
  ScenePropDesign,
  "kind" | "scale" | "color" | "accent" | "condition"
>;
/** Geometry stays inside the same catalog envelope checked by the realizer. */
export function authoredPropParts(prop: PropAppearance): PropPart[] {
  const size = PROP_CATALOG[prop.kind],
    w = size.w * prop.scale,
    h = size.h * prop.scale,
    d = size.d * prop.scale,
    parts: PropPart[] = [],
    color = prop.color,
    accent = prop.accent,
    ink = "#263234",
    part = (
      shape: Shape,
      x: number,
      y: number,
      z: number,
      width: number,
      height: number,
      depth: number,
      tint = color,
    ) => {
      parts.push({
        shape,
        x: x * w,
        y: y * h,
        z: z * d,
        w: width * w,
        h: height * h,
        d: depth * d,
        color: tint,
      });
    };
  switch (prop.kind) {
    case "mug":
      part("cylinder", -0.08, 0.45, 0, 0.8, 0.9, 0.9);
      part("cylinder", -0.08, 0.905, 0, 0.68, 0.012, 0.76, ink);
      part("box", 0.4, 0.48, 0, 0.16, 0.38, 0.13, accent);
      part("box", 0.31, 0.68, 0, 0.3, 0.08, 0.13, accent);
      part("box", 0.31, 0.29, 0, 0.3, 0.08, 0.13, accent);
      break;
    case "book":
      part("box", 0, 0.12, 0, 1, 0.24, 1);
      part("box", 0.025, 0.5, 0, 0.92, 0.52, 0.94, "#d5d0b6");
      part("box", 0, 0.86, 0, 1, 0.24, 1);
      part("box", -0.46, 0.5, 0, 0.08, 0.8, 1, accent);
      break;
    case "papers":
      for (let i = 0; i < 3; i++)
        part(
          "box",
          (i - 1) * 0.025,
          0.13 + i * 0.24,
          (i - 1) * 0.02,
          0.93,
          0.2,
          0.94,
          i === 2 ? color : accent,
        );
      break;
    case "pen":
      part("box", 0, 0.5, -0.03, 0.7, 0.7, 0.82);
      part("box", 0, 0.5, 0.43, 0.35, 0.35, 0.12, ink);
      part("box", 0, 0.84, -0.25, 0.95, 0.2, 0.35, accent);
      break;
    case "photo":
      part("box", 0, 0.5, -0.44, 1, 1, 0.12, accent);
      part("box", -0.46, 0.5, 0, 0.08, 1, 1);
      part("box", 0.46, 0.5, 0, 0.08, 1, 1);
      part("box", 0, 0.045, 0, 0.84, 0.09, 1);
      part("box", 0, 0.955, 0, 0.84, 0.09, 1);
      break;
    case "note":
      part("box", 0, 0.4, 0, 1, 0.8, 1);
      break;
    case "plant":
      part("cylinder", 0, 0.19, 0, 0.66, 0.38, 0.66);
      part("cylinder", 0, 0.385, 0, 0.59, 0.018, 0.59, "#403b2b");
      part("box", 0, 0.61, 0, 0.04, 0.45, 0.04, "#5b6650");
      for (const [x, y, z] of [
        [-0.2, 0.6, 0.1],
        [0.21, 0.72, 0.04],
        [-0.1, 0.87, -0.13],
      ])
        part(
          "sphere",
          x,
          y,
          z,
          0.51,
          0.25,
          0.48,
          prop.condition === "damaged" ? "#8d7950" : accent,
        );
      break;
    case "bottle":
      part("cylinder", 0, 0.34, 0, 0.96, 0.68, 0.96);
      part("cone", 0, 0.72, 0, 0.93, 0.18, 0.93);
      part("cylinder", 0, 0.86, 0, 0.36, 0.24, 0.36);
      part("cylinder", 0, 0.96, 0, 0.44, 0.08, 0.44, accent);
      break;
    case "phone":
      part("box", 0, 0.45, 0, 1, 0.9, 1);
      part("box", 0, 0.92, 0, 0.84, 0.08, 0.82, accent);
      break;
    case "box":
      part("box", 0, 0.47, 0, 1, 0.94, 1);
      part("box", 0, 0.96, 0, 1, 0.06, 0.97, accent);
      part("box", 0, 0.995, 0, 0.15, 0.008, 0.97, "#b7a67f");
      break;
    case "lamp":
      part("cylinder", 0, 0.04, 0, 0.9, 0.08, 0.9, accent);
      part("cylinder", 0, 0.48, 0, 0.07, 0.86, 0.07, accent);
      part("cone", 0, 0.8, 0, 1, 0.4, 1);
      break;
    case "trophy":
      part("box", 0, 0.08, 0, 0.9, 0.16, 0.9, accent);
      part("cylinder", 0, 0.38, 0, 0.14, 0.48, 0.14);
      part("sphere", 0, 0.76, 0, 0.92, 0.46, 0.92);
      break;
    case "headphones": {
      // Upright studio cans: a box-segment headband arc between two cups.
      for (let k = 0; k <= 6; k++) {
        const t = (k * Math.PI) / 6;
        part(
          "box",
          0.36 * Math.cos(t),
          0.5 + 0.38 * Math.sin(t),
          0,
          0.15,
          0.17,
          0.3,
          k === 3 ? accent : "#2b2f33",
        );
      }
      for (const side of [-1, 1]) {
        part("sphere", side * 0.4, 0.3, 0, 0.18, 0.5, 0.82, color);
        part("sphere", side * 0.33, 0.3, 0, 0.1, 0.38, 0.66, accent);
        part("box", side * 0.4, 0.55, 0, 0.08, 0.1, 0.2, "#2b2f33");
      }
      break;
    }
    case "record":
      // The disc slides out from under the printed sleeve; the sleeve top
      // stays below the label plane so authored text is not buried.
      part("cylinder", 0.2, 0.2, 0, 0.6, 0.4, 0.6, "#14151a");
      part("cylinder", 0.2, 0.41, 0, 0.22, 0.02, 0.22, accent);
      part("box", -0.175, 0.69, 0, 0.59, 0.58, 1);
      part("box", -0.485, 0.69, 0, 0.03, 0.58, 1, accent);
      break;
    case "cassette":
      part("box", 0, 0.485, 0, 1, 0.97, 1);
      part("box", 0, 0.985, -0.44, 0.9, 0.03, 0.1, accent);
      part("box", 0, 0.98, 0.44, 0.52, 0.02, 0.12, ink);
      for (const side of [-1, 1])
        part("cylinder", side * 0.14, 0.985, 0.44, 0.14, 0.03, 0.1, "#d9d4c4");
      break;
  }
  if (prop.condition !== "intact") {
    // Scrapes sit on the top-facing envelope and cannot change collision shape.
    const flat = [
      "book",
      "papers",
      "pen",
      "note",
      "phone",
      "box",
      "record",
      "cassette",
    ].includes(prop.kind);
    if (flat) {
      part("box", -0.17, 0.993, 0.08, 0.29, 0.006, 0.025, ink);
      part("box", -0.07, 0.993, -0.05, 0.18, 0.006, 0.025, accent);
      if (prop.condition === "damaged")
        part("box", 0.17, 0.993, -0.07, 0.025, 0.006, 0.58, ink);
    } else {
      const face = LABEL_FACES[prop.kind]!;
      part(
        "box",
        -face.w * 0.2,
        face.y,
        face.z + 0.002,
        face.w * 0.2,
        face.h * 0.08,
        0.003,
        ink,
      );
      if (prop.condition === "damaged")
        part(
          "box",
          -face.w * 0.12,
          face.y,
          face.z + 0.003,
          face.w * 0.03,
          face.h * 0.6,
          0.003,
          ink,
        );
    }
  }
  return parts;
}

interface Label {
  title: string;
  text: string;
  owner: string | null;
  color: string;
  accent: string;
  condition: string;
  photo?: boolean;
}
interface Binding {
  pool: InstancePool;
  slot: number;
  furniture?: Furniture;
  prop?: ResolvedSceneProp;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  angle: number;
  color: string;
  rotationX?: number;
  /** A composed part's own colour, tilt and motion. Level, still parts leave
   * this out and cost nothing per frame beyond the shared diffing. */
  fixed?: Color;
  tilt?: {
    pitch: number;
    roll: number;
    motion: RunObjectMotion;
    rate: number;
    phase: number;
    glow: boolean;
  };
}
type Finish = "matte" | "metal" | "glass" | "glow";
/** Dark parts stay readable under the room lighting; glow keeps its colour. */
function readable(color: string, finish: Finish) {
  const value = new Color(color);
  if (finish === "glow") return value;
  const hsl = { h: 0, s: 0, l: 0 };
  value.getHSL(hsl);
  if (hsl.l < 0.16) value.setHSL(hsl.h, hsl.s, 0.16);
  return value;
}
const CELL_W = 256,
  CELL_H = 128,
  COLUMNS = 8;

function labelAtlas(labels: Label[]) {
  if (!labels.length || typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = COLUMNS * CELL_W;
  canvas.height = Math.max(1, Math.ceil(labels.length / COLUMNS)) * CELL_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  const inkFor = (hex: string) => {
    const color = new Color(hex);
    return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722 > 0.22
      ? "#182b2b"
      : "#f1ead4";
  };
  labels.forEach((label, i) => {
    const x = (i % COLUMNS) * CELL_W,
      y = Math.floor(i / COLUMNS) * CELL_H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, CELL_W, CELL_H);
    ctx.clip();
    ctx.fillStyle = label.color;
    ctx.fillRect(x, y, CELL_W, CELL_H);
    ctx.strokeStyle = label.accent;
    ctx.lineWidth = 5;
    ctx.strokeRect(x + 4, y + 4, CELL_W - 8, CELL_H - 8);
    if (label.photo) {
      ctx.fillStyle = label.accent;
      ctx.fillRect(x + 12, y + 12, CELL_W - 24, 48);
      ctx.fillStyle = "#dfc5a4";
      for (const px of [0.4, 0.59]) {
        ctx.beginPath();
        ctx.arc(x + CELL_W * px, y + 31, 9, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(x + CELL_W * px - 11, y + 41, 22, 19);
      }
    }
    const draw = (value: string, top: number, size: number, lines: number) => {
      ctx.fillStyle = inkFor(label.color);
      ctx.font = `${size >= 15 ? "600" : "400"} ${size}px sans-serif`;
      ctx.textAlign = "left";
      const rows: string[] = [];
      let row = "";
      for (const word of value.split(/\s+/)) {
        const next = row ? `${row} ${word}` : word;
        if (row && ctx.measureText(next).width > CELL_W - 24) {
          rows.push(row);
          row = word;
        } else row = next;
      }
      if (row) rows.push(row);
      if (rows.length > lines)
        rows.splice(lines - 1, rows.length, rows.slice(lines - 1).join(" "));
      rows.forEach((text, index) =>
        ctx.fillText(text, x + 12, y + top + index * (size + 2), CELL_W - 24),
      );
    };
    draw(label.title, label.photo ? 77 : 25, 16, 1);
    draw(
      label.text,
      label.photo ? 94 : 46,
      label.photo ? 10 : 12,
      label.photo ? 2 : 4,
    );
    if (label.owner) draw(label.owner, 116, 10, 1);
    if (!["intact", "kept"].includes(label.condition)) {
      ctx.globalAlpha = 0.3;
      ctx.strokeStyle = label.accent;
      ctx.lineWidth = 2;
      for (
        let scratch = 0;
        scratch < (label.condition === "worn" ? 3 : 7);
        scratch++
      ) {
        ctx.beginPath();
        ctx.moveTo(x + 4 + scratch * 31, y + 5);
        ctx.lineTo(x + 13 + scratch * 31, y + 11 + (scratch % 3) * 4);
        ctx.stroke();
      }
    }
    ctx.restore();
  });
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.generateMipmaps = false;
  texture.minFilter = texture.magFilter = LinearFilter;
  texture.name = "authored-scene-label-atlas";
  return texture;
}

/** World placement of a scene given in local coordinates. */
export function authoredPlacement(local: Point, origin: Point) {
  return { x: local.x + origin.x, z: local.y + origin.y };
}

/** A bounded saved dressing manifest: at most five draw calls per floor. */
export class AuthoredScene {
  readonly group = new Group();
  private readonly parts: Binding[] = [];
  private readonly pools: InstancePool[] = [];
  private readonly material: MeshStandardMaterial;
  private readonly labelMaterial: MeshStandardMaterial;
  private readonly atlas?: CanvasTexture;
  private readonly extraMaterials: (
    MeshStandardMaterial | MeshBasicMaterial
  )[] = [];
  private readonly motionPose: PartMotionPose = { yaw: 0, lift: 0, glow: 1 };
  private readonly tint = new Color();
  private disposed = false;

  constructor(
    private readonly floor: Floor,
    lightmap: InteriorLightmap,
    origin?: Point,
  ) {
    this.group.name = "authored-scene";
    if (origin) {
      // A stamped site's scene is authored in its local coordinates.
      const at = authoredPlacement({ x: 0, y: 0 }, origin);
      this.group.position.set(at.x, 0, at.z);
    }
    this.material = new MeshStandardMaterial({
      color: "white",
      roughness: 0.86,
    });
    lightmap.patch(this.material);
    const geometries = {
        box: new BoxGeometry(1, 1, 1),
        cylinder: new CylinderGeometry(0.5, 0.5, 1, 12),
        cone: new ConeGeometry(0.5, 1, 12),
        sphere: new SphereGeometry(0.5, 10, 6),
      },
      pools = Object.fromEntries(
        Object.entries(geometries).map(([shape, geometry]) => {
          const pool = new InstancePool(
            this.group,
            geometry,
            this.material,
            SCENE_LIMITS.props * 16 + SCENE_LIMITS.furniture * 8,
            false,
          );
          pool.mesh.name = `authored-scene-${shape}`;
          this.pools.push(pool);
          return [shape, pool];
        }),
      ) as Record<Shape, InstancePool>,
      composedTotal = (floor.scene?.props ?? []).reduce(
        (n, p) => n + (p.object?.parts.length ?? 0),
        0,
      ),
      composedPools = new Map<string, InstancePool>(),
      composedMaterials: Partial<
        Record<Finish, MeshStandardMaterial | MeshBasicMaterial>
      > = {},
      composedPool = (
        shape: Shape | "wedge" | "torus",
        axis: RunObjectAxis,
        finish: Finish,
      ) => {
        const key = `${shape}:${AXIS_SHAPES.includes(shape as never) ? axis : "up"}:${finish}`;
        let pool = composedPools.get(key);
        if (!pool) {
          let material = composedMaterials[finish];
          if (!material) {
            if (finish === "matte") material = this.material;
            else {
              material =
                finish === "glow"
                  ? new MeshBasicMaterial({ color: "white" })
                  : new MeshStandardMaterial({
                      color: "white",
                      roughness: finish === "glass" ? 0.12 : 0.4,
                      metalness: finish === "metal" ? 0.3 : 0,
                      transparent: finish === "glass",
                      opacity: finish === "glass" ? 0.4 : 1,
                      depthWrite: finish !== "glass",
                    });
              if (material instanceof MeshStandardMaterial)
                lightmap.patch(material);
              this.extraMaterials.push(material);
            }
            composedMaterials[finish] = material;
          }
          pool = new InstancePool(
            this.group,
            objectGeometry(
              shape,
              AXIS_SHAPES.includes(shape as never) ? axis : "up",
            ),
            material,
            composedTotal,
            false,
          );
          pool.mesh.name = `authored-scene-composed-${key.replaceAll(":", "-")}`;
          this.pools.push(pool);
          composedPools.set(key, pool);
        }
        return pool;
      },
      labels: Label[] = [],
      labelBindings: Omit<Binding, "pool" | "slot">[] = [],
      hosts = new Map(floor.furniture.map((f) => [f.id, f])),
      label = (value: Label, binding: Omit<Binding, "pool" | "slot">) => {
        if (!floor.environment) {
          labels.push(value);
          labelBindings.push(binding);
        }
      };
    for (const room of floor.scene?.rooms ?? []) {
      const { plaque } = room;
      label(
        {
          title: room.title,
          text: room.description,
          owner: room.owner,
          color: room.palette.surface,
          accent: room.palette.accent,
          condition: room.condition,
        },
        {
          x: plaque.x,
          y: 1.65,
          z: plaque.y,
          w: 1.12,
          h: 0.5,
          d: 1,
          angle: -Math.atan2(plaque.nx, plaque.ny),
          color: "#ffffff",
        },
      );
    }
    for (const authored of floor.scene?.furniture ?? []) {
      const host = hosts.get(authored.id),
        appearance = host?.appearance;
      if (!host || !appearance) continue;
      const room = floor.scene!.rooms.find((r) => r.room === appearance.room)!,
        face = furnitureLabelFace(host);
      if (appearance.label || appearance.owner)
        label(
          {
            title: appearance.label ?? "",
            text: "",
            owner: appearance.owner,
            color: appearance.color,
            accent: room.palette.accent,
            condition: appearance.condition,
          },
          {
            furniture: host,
            x: 0,
            y: face.y,
            z: face.z,
            w: face.w,
            h: face.h,
            d: 1,
            angle: 0,
            color: "#ffffff",
          },
        );
      // A composed host is scuffed on its real top part, if it has one.
      const top =
        host.kind === "custom" && host.object
          ? surfacePart(host.object)
          : undefined;
      if (
        (appearance.condition !== "intact" || room.condition !== "kept") &&
        (host.kind !== "custom" || top)
      ) {
        const surface = furnitureSurfaceBoundsOf(host, host.w, host.h),
          offsetX = top?.x ?? 0,
          offsetZ = top?.y ?? 0;
        for (let n = 0; n < (room.condition === "ransacked" ? 5 : 2); n++) {
          const pool = pools.box;
          this.parts.push({
            pool,
            slot: pool.allocate(),
            furniture: host,
            x: offsetX + surface.w * (-0.25 + n * 0.1),
            y: furnitureSurfaceHeightOf(host) + 0.003,
            z: offsetZ + surface.d * (-0.2 + (n % 2) * 0.12),
            w: Math.min(0.13, surface.w * 0.11),
            h: 0.002,
            d: 0.009,
            angle: 0,
            color: room.palette.accent,
          });
        }
      }
    }
    for (const prop of floor.scene?.props ?? []) {
      const host = hosts.get(prop.furnitureId);
      if (!host) continue;
      if (prop.object) {
        // A design-invented prop: its own recipe parts, scaled with the
        // placement. x across, y back to front, z the bottom; the part
        // centre then maps to (x, elevation, depth) in the prop's frame.
        const k = prop.scale;
        prop.object.parts.forEach((p, i) => {
          const pool = composedPool(p.shape, p.axis, p.finish),
            grow = 0.0004 * (i + 1),
            tilt = partTilt(p),
            animated = p.motion !== "none";
          this.parts.push({
            furniture: host,
            prop,
            pool,
            slot: pool.allocate(),
            x: p.x * k,
            y: (p.z + p.h / 2) * k,
            z: p.y * k,
            w: p.w * k + grow,
            h: p.h * k + grow,
            d: p.d * k + grow,
            angle: 0,
            color: p.color,
            fixed: readable(p.color, p.finish),
            tilt:
              tilt || animated
                ? {
                    pitch: tilt?.pitch ?? 0,
                    roll: tilt?.roll ?? 0,
                    motion: p.motion,
                    rate: p.rate,
                    phase: motionPhase(i),
                    glow: p.finish === "glow",
                  }
                : undefined,
          });
        });
        if (!(prop.label || prop.text || prop.owner)) continue;
        const face = propSurfaceFace(prop);
        label(
          {
            title: prop.label ?? "",
            text: prop.text ?? "",
            owner: prop.owner,
            color: prop.color,
            accent: prop.accent,
            condition: prop.condition,
          },
          {
            furniture: host,
            prop,
            x: face.x,
            y: face.z,
            z: face.y,
            w: face.width,
            h: face.height,
            d: 1,
            angle: 0,
            color: "#ffffff",
            rotationX: face.pitch,
          },
        );
        continue;
      }
      for (const part of authoredPropParts(prop as PropAppearance)) {
        const pool = pools[part.shape];
        this.parts.push({
          ...part,
          furniture: host,
          prop,
          pool,
          slot: pool.allocate(),
          angle: 0,
        });
      }
      if (!(prop.label || prop.text || prop.owner || prop.kind === "photo"))
        continue;
      // Every upright label attaches to a real face: pots, lamp feet and trophy
      // pedestals do not get a floating card halfway up their empty stems.
      const face = LABEL_FACES[prop.kind],
        onPhoto = prop.kind === "photo";
      label(
        {
          title: prop.label ?? "",
          text: prop.text ?? "",
          owner: prop.owner,
          color: prop.color,
          accent: prop.accent,
          condition: prop.condition,
          photo: onPhoto,
        },
        {
          furniture: host,
          prop,
          x: prop.kind === "mug" ? -prop.w * 0.08 : 0,
          y: face ? prop.h * face.y : prop.h * 0.985,
          z: face ? prop.d * face.z : 0,
          w: prop.w * (face ? face.w : 0.76),
          h: face ? prop.h * face.h : prop.d * 0.78,
          d: 1,
          angle: 0,
          color: "#ffffff",
          rotationX: face ? 0 : -Math.PI / 2,
        },
      );
    }
    this.atlas = labelAtlas(labels);
    this.labelMaterial = new MeshStandardMaterial({
      color: "white",
      map: this.atlas ?? null,
      roughness: 0.94,
    });
    lightmap.patch(this.labelMaterial);
    const bake = this.labelMaterial.onBeforeCompile;
    this.labelMaterial.onBeforeCompile = (shader, renderer) => {
      bake(shader, renderer);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec4 authoredLabelUv;",
        )
        .replace(
          "#include <uv_vertex>",
          "#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = authoredLabelUv.xy + vMapUv * authoredLabelUv.zw;\n#endif",
        );
    };
    this.labelMaterial.customProgramCacheKey = () =>
      "authored-scene-lightmap-atlas-v1";
    const geometry = new PlaneGeometry(1, 1),
      capacity = Math.max(1, labels.length),
      rows = Math.max(1, Math.ceil(labels.length / COLUMNS)),
      rects = new Float32Array(capacity * 4);
    for (let i = 0; i < labels.length; i++)
      rects.set(
        [
          (i % COLUMNS) / COLUMNS,
          1 - (Math.floor(i / COLUMNS) + 1) / rows,
          1 / COLUMNS,
          1 / rows,
        ],
        i * 4,
      );
    geometry.setAttribute(
      "authoredLabelUv",
      new InstancedBufferAttribute(rects, 4),
    );
    const cards = new InstancePool(
      this.group,
      geometry,
      this.labelMaterial,
      capacity,
      false,
    );
    cards.mesh.name = "authored-scene-labels";
    this.pools.push(cards);
    labelBindings.forEach((binding) =>
      this.parts.push({ ...binding, pool: cards, slot: cards.allocate() }),
    );
    this.group.userData = {
      furniture: floor.scene?.furniture.length ?? 0,
      props: floor.scene?.props.length ?? 0,
      labels: labels.length,
      drawCallBudget: (floor.environment ? 4 : 5) + composedPools.size,
    };
    this.sync();
  }

  /** `time` (seconds) and `calm` (reduced flash) drive composed part motion;
   * the caller's game clock keeps it in step with the rest of the scene. */
  sync(time = performance.now() / 1000, calm = true) {
    if (this.disposed) return;
    const present = new Set(this.floor.furniture);
    for (const part of this.parts) {
      const host = part.furniture;
      if (host && (host.destroyed || !present.has(host))) {
        part.pool.hide(part.slot);
        continue;
      }
      const prop = part.prop,
        turn = prop?.angle ?? 0,
        c = Math.cos(turn),
        s = Math.sin(turn),
        x = (prop?.x ?? 0) + part.x * c - part.z * s,
        z = (prop?.y ?? 0) + part.x * s + part.z * c,
        angle = host?.angle ?? 0,
        hc = Math.cos(angle),
        hs = Math.sin(angle);
      const tilt = part.tilt;
      let lift = 0,
        yaw = 0,
        tint: Color | string = part.fixed ?? part.color;
      if (tilt && tilt.motion !== "none") {
        const moved = partMotion(
          tilt.motion,
          tilt.rate,
          tilt.phase,
          time,
          calm,
          this.motionPose,
        );
        lift = moved.lift;
        yaw = moved.yaw;
        if (tilt.glow && part.fixed)
          tint = this.tint.copy(part.fixed).multiplyScalar(moved.glow);
      }
      part.pool.set(
        part.slot,
        host ? host.x + x * hc - z * hs : part.x,
        (prop?.top ?? 0) + part.y + lift,
        host ? host.y + x * hs + z * hc : part.z,
        part.w,
        part.h,
        part.d,
        angle + turn + part.angle + yaw,
        tint,
        tilt ? -tilt.roll : 0,
        tilt ? tilt.pitch : (part.rotationX ?? 0),
        !!tilt,
      );
    }
    this.pools.forEach((pool) => pool.flush());
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pools.forEach((pool) => pool.dispose(false));
    this.material.dispose();
    this.extraMaterials.forEach((material) => material.dispose());
    this.labelMaterial.dispose();
    this.atlas?.dispose();
    this.group.removeFromParent();
  }
}
