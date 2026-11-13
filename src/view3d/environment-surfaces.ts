import {
  CanvasTexture,
  Group,
  InstancedBufferAttribute,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
} from "three";
import type { Floor } from "../model";
import {
  expandContentText,
  type Drawing,
  type EnvironmentManifest,
  type RepeatFragment,
  type SurfaceContent,
  type SurfaceSlot,
} from "../environment-contract.mjs";
import {
  ON_AIR_LABEL_CONTEXT,
  surfaceWorldPose,
} from "../environment-surfaces";
import { InstancePool } from "./instances";
import type { InteriorLightmap } from "./interior-lightmap";

export const ENVIRONMENT_ATLAS_EDGE = 2048;
/** Street signs are read from a distance, so the atlas needs mipmaps and the
 * steepest anisotropic filtering three.js will clamp to on this device. */
export const ENVIRONMENT_ATLAS_ANISOTROPY = 8;
const GUTTER = 4;

/** A view may drop authored slots (for example shop signs above rock lots)
 * before any atlas space or instance is spent on them. */
export type SurfaceFilter = (surface: SurfaceSlot) => boolean;

interface Tile {
  surface: SurfaceSlot;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface EnvironmentAtlasPage {
  width: number;
  height: number;
  tiles: Tile[];
}

/** Stable pages, never one texture per inscription. Keep each image's physical
 * aspect ratio inside a padded tile, including very narrow object labels. */
export function environmentAtlasPages(
  surfaces: readonly SurfaceSlot[],
): EnvironmentAtlasPage[] {
  const groups = new Map<
    string,
    { width: number; height: number; slots: SurfaceSlot[] }
  >();
  for (const surface of [...surfaces].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const { width, height } = surface.binding,
      ratio = width / height,
      large = width >= 0.5 && height >= 0.35,
      cell =
        ratio >= 3
          ? [512, 128]
          : ratio >= 1.4
            ? [large ? 512 : 256, 256]
            : ratio < 0.8
              ? [256, large ? 384 : 256]
              : [256, 256],
      key = cell.join("/");
    let group = groups.get(key);
    if (!group) {
      group = { width: cell[0], height: cell[1], slots: [] };
      groups.set(key, group);
    }
    group.slots.push(surface);
  }
  const pages: EnvironmentAtlasPage[] = [];
  for (const [key, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    void key;
    const columns = Math.floor(ENVIRONMENT_ATLAS_EDGE / group.width),
      rows = Math.floor(ENVIRONMENT_ATLAS_EDGE / group.height),
      capacity = columns * rows;
    for (let start = 0; start < group.slots.length; start += capacity) {
      const slots = group.slots.slice(start, start + capacity),
        usedColumns = Math.min(columns, slots.length),
        page: EnvironmentAtlasPage = {
          width: usedColumns * group.width,
          height: Math.ceil(slots.length / usedColumns) * group.height,
          tiles: [],
        };
      slots.forEach((surface, index) => {
        const ratio = surface.binding.width / surface.binding.height,
          width = Math.min(
            group.width - GUTTER * 2,
            (group.height - GUTTER * 2) * ratio,
          ),
          height = width / ratio;
        page.tiles.push({
          surface,
          x: (index % usedColumns) * group.width + (group.width - width) / 2,
          y:
            Math.floor(index / usedColumns) * group.height +
            (group.height - height) / 2,
          width,
          height,
        });
      });
      pages.push(page);
    }
  }
  return pages;
}

/** An interpreter for validated drawing data. It executes only these four
 * drawing primitives; strings are never parsed as SVG, HTML, paths or code. */
export function paintEnvironmentDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  width: number,
  height: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  if (drawing.background !== "transparent") {
    ctx.fillStyle = drawing.background;
    ctx.fillRect(0, 0, width, height);
  }
  for (const primitive of drawing.primitives) {
    ctx.save();
    ctx.globalAlpha = primitive.opacity;
    ctx.lineWidth = primitive.width * Math.min(width, height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    if (primitive.kind === "stroke" || primitive.kind === "polygon") {
      primitive.points.forEach((point, index) => {
        if (index === 0) ctx.moveTo(point.x * width, point.y * height);
        else ctx.lineTo(point.x * width, point.y * height);
      });
      if (primitive.kind === "polygon") ctx.closePath();
    } else {
      const w = primitive.w * width,
        h = primitive.h * height;
      ctx.translate(primitive.x * width + w / 2, primitive.y * height + h / 2);
      ctx.rotate((primitive.rotation * Math.PI) / 180);
      if (primitive.kind === "rect") ctx.rect(-w / 2, -h / 2, w, h);
      else ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    }
    if (primitive.kind !== "stroke" && primitive.fill) {
      ctx.fillStyle = primitive.fill;
      ctx.fill();
    }
    const stroke =
      primitive.kind === "stroke" ? primitive.color : primitive.stroke;
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** Include long unbroken names too. Nothing is elided; the full saved text is
 * also available through the occlusion-aware look caption. */
function wrapText(ctx: CanvasRenderingContext2D, value: string, width: number) {
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line && ctx.measureText(`${line} ${word}`).width <= width) {
        line += ` ${word}`;
        continue;
      }
      if (line) lines.push(line);
      line = "";
      for (const character of word) {
        if (line && ctx.measureText(line + character).width > width) {
          lines.push(line);
          line = "";
        }
        line += character;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function paintText(
  ctx: CanvasRenderingContext2D,
  title: string,
  body: string,
  width: number,
  height: number,
  ink: string,
  outlined: boolean,
) {
  if (!title && !body) return;
  let size = Math.min(26, height * 0.22),
    titleLines: string[] = [],
    bodyLines: string[] = [];
  const measure = () => {
    ctx.font = `600 ${size * 1.16}px sans-serif`;
    titleLines = wrapText(ctx, title, width);
    ctx.font = `400 ${size}px sans-serif`;
    bodyLines = wrapText(ctx, body, width);
    return (
      titleLines.length * size * 1.4 +
      bodyLines.length * size * 1.24 +
      (title && body ? size * 0.3 : 0)
    );
  };
  while (measure() > height && size > 0.0001) size *= 0.88;
  ctx.fillStyle = ink;
  ctx.strokeStyle = "#172627";
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  let top = 0;
  const draw = (lines: string[], title: boolean) => {
    ctx.font = `${title ? "600" : "400"} ${size * (title ? 1.16 : 1)}px sans-serif`;
    ctx.lineWidth = Math.max(0.5, size * 0.12);
    for (const line of lines) {
      if (outlined) ctx.strokeText(line, 0, top, width);
      ctx.fillText(line, 0, top, width);
      top += size * (title ? 1.4 : 1.24);
    }
  };
  draw(titleLines, true);
  if (title && body) top += size * 0.3;
  draw(bodyLines, false);
}

export function paintEnvironmentSurface(
  ctx: CanvasRenderingContext2D,
  slot: SurfaceSlot,
  content: SurfaceContent,
  fragments: RepeatFragment[],
  width: number,
  height: number,
) {
  const title = expandContentText(content.title, fragments),
    body = expandContentText(content.body, fragments),
    graffiti = slot.role === "graffiti",
    board = slot.role.includes("whiteboard"),
    litSign =
      slot.role === "furniture-label" &&
      slot.context.includes(ON_AIR_LABEL_CONTEXT),
    exterior = slot.scope === "exterior",
    margin = Math.min(width, height) * 0.055,
    innerWidth = width - margin * 2,
    innerHeight = height - margin * 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  ctx.clip();
  if (litSign) {
    const glow = ctx.createRadialGradient(
      width / 2,
      height / 2,
      0,
      width / 2,
      height / 2,
      Math.max(width, height) * 0.6,
    );
    glow.addColorStop(0, "#ff4a32");
    glow.addColorStop(1, "#b3140c");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
  } else if (!graffiti) {
    ctx.fillStyle = board ? "#dce6de" : exterior ? "#2c403d" : "#e6dfc7";
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = exterior ? "#bac8a1" : "#738379";
    ctx.lineWidth = Math.max(1, margin * 0.25);
    ctx.strokeRect(
      margin * 0.35,
      margin * 0.35,
      width - margin * 0.7,
      height - margin * 0.7,
    );
  }
  ctx.translate(margin, margin);
  const hasText = !!(title || body),
    hasArt = !!content.drawing,
    sideBySide = hasArt && hasText && innerWidth / innerHeight >= 1.4,
    artWidth = sideBySide ? innerWidth * 0.45 : innerWidth,
    artHeight = hasText && !sideBySide ? innerHeight * 0.56 : innerHeight;
  if (content.drawing) {
    ctx.save();
    if (sideBySide) ctx.translate(innerWidth - artWidth, 0);
    paintEnvironmentDrawing(ctx, content.drawing, artWidth, artHeight);
    ctx.restore();
  }
  if (hasText) {
    if (hasArt && !sideBySide) ctx.translate(0, artHeight + margin);
    paintText(
      ctx,
      title,
      body,
      sideBySide ? innerWidth * 0.5 : innerWidth,
      hasArt && !sideBySide ? innerHeight - artHeight - margin : innerHeight,
      litSign ? "#fff4e2" : exterior || graffiti ? "#f0ebd1" : "#263a38",
      graffiti,
    );
  }
  ctx.restore();
}

/** One draw call per atlas page. Geometry and texture ownership stays with this
 * floor/exterior group, and moving/destroyed hosts use the saved binding. */
export class EnvironmentSurfaces {
  readonly group = new Group();
  private readonly pools: InstancePool[] = [];
  private readonly textures: CanvasTexture[] = [];
  private readonly bindings: {
    surface: SurfaceSlot;
    pool: InstancePool;
    index: number;
  }[] = [];
  private disposed = false;

  constructor(
    private readonly floor: Floor,
    environment: EnvironmentManifest,
    scope: SurfaceSlot["scope"],
    lightmap?: InteriorLightmap,
    /** Applied before pages and instances exist: a hidden slot costs nothing. */
    include: SurfaceFilter = () => true,
  ) {
    this.group.name = `environment-surfaces-${scope}-${floor.index}`;
    const surfaces = environment.surfaces.filter(
        (s) => s.floor === floor.index && s.scope === scope && include(s),
      ),
      content = new Map(
        environment.entries.map((entry) => [entry.surfaceId, entry]),
      ),
      pages = environmentAtlasPages(surfaces);
    for (const surface of surfaces)
      if (!content.has(surface.id))
        throw Error(`Missing saved surface content: ${surface.id}`);
    for (const [pageIndex, page] of pages.entries()) {
      let texture: CanvasTexture | undefined;
      if (typeof document !== "undefined") {
        const canvas = document.createElement("canvas");
        canvas.width = page.width;
        canvas.height = page.height;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          for (const tile of page.tiles) {
            const entry = content.get(tile.surface.id);
            if (!entry)
              throw Error(`Missing saved surface content: ${tile.surface.id}`);
            ctx.save();
            ctx.translate(tile.x, tile.y);
            paintEnvironmentSurface(
              ctx,
              tile.surface,
              entry,
              environment.fragments,
              tile.width,
              tile.height,
            );
            ctx.restore();
          }
          texture = new CanvasTexture(canvas);
          texture.colorSpace = SRGBColorSpace;
          // Minified street signs alias into noise without mipmaps.
          texture.generateMipmaps = true;
          texture.minFilter = LinearMipmapLinearFilter;
          texture.magFilter = LinearFilter;
          texture.anisotropy = ENVIRONMENT_ATLAS_ANISOTROPY;
          texture.name = `environment-atlas-${scope}-${floor.index}-${pageIndex}`;
          this.textures.push(texture);
        }
      }
      const material = new MeshStandardMaterial({
        color: "white",
        map: texture ?? null,
        roughness: 0.96,
        alphaTest: 0.025,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
        ...(scope === "exterior"
          ? {
              emissive: "#a7b7a4",
              emissiveMap: texture ?? null,
              emissiveIntensity: 0.28,
            }
          : {}),
      });
      lightmap?.patch(material);
      const previous = material.onBeforeCompile;
      material.onBeforeCompile = (shader, renderer) => {
        previous(shader, renderer);
        shader.vertexShader = shader.vertexShader
          .replace(
            "#include <common>",
            "#include <common>\nattribute vec4 environmentUv;",
          )
          .replace(
            "#include <uv_vertex>",
            "#include <uv_vertex>\n#ifdef USE_MAP\nvMapUv = environmentUv.xy + vMapUv * environmentUv.zw;\n#endif\n#ifdef USE_EMISSIVEMAP\nvEmissiveMapUv = environmentUv.xy + vEmissiveMapUv * environmentUv.zw;\n#endif",
          );
      };
      material.customProgramCacheKey = () => `environment-atlas-v1-${scope}`;
      const geometry = new PlaneGeometry(1, 1),
        rects = new Float32Array(page.tiles.length * 4);
      page.tiles.forEach((tile, index) =>
        rects.set(
          [
            tile.x / page.width,
            1 - (tile.y + tile.height) / page.height,
            tile.width / page.width,
            tile.height / page.height,
          ],
          index * 4,
        ),
      );
      geometry.setAttribute(
        "environmentUv",
        new InstancedBufferAttribute(rects, 4),
      );
      const pool = new InstancePool(
        this.group,
        geometry,
        material,
        page.tiles.length,
        false,
      );
      pool.mesh.name = `environment-atlas-page-${pageIndex}`;
      pool.mesh.userData = {
        surfaceIds: page.tiles.map((t) => t.surface.id),
        width: page.width,
        height: page.height,
      };
      this.pools.push(pool);
      for (const tile of page.tiles)
        this.bindings.push({
          surface: tile.surface,
          pool,
          index: pool.allocate(),
        });
    }
    this.group.userData = {
      surfaces: surfaces.length,
      atlasPages: pages.length,
      texturePixels: pages.reduce((n, page) => n + page.width * page.height, 0),
      surfaceIds: surfaces.map((s) => s.id),
    };
    this.sync();
  }

  sync() {
    if (this.disposed) return;
    for (const { surface, pool, index } of this.bindings) {
      const pose = surfaceWorldPose(this.floor, surface);
      if (!pose) {
        pool.hide(index);
        continue;
      }
      pool.set(
        index,
        pose.x,
        pose.z,
        pose.y,
        surface.binding.width,
        surface.binding.height,
        1,
        pose.yaw,
        "#ffffff",
        0,
        pose.pitch,
      );
    }
    this.pools.forEach((pool) => pool.flush());
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.pools.forEach((pool) => pool.dispose());
    this.textures.forEach((texture) => texture.dispose());
    this.group.removeFromParent();
  }
}
