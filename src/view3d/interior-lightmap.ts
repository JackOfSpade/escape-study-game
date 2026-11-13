import {
  ClampToEdgeWrapping,
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  type Material,
  RGBAFormat,
  Vector2,
} from "three";
import {
  ambientTexels,
  DEFAULT_LIT_FIXTURE,
  fixturePools,
  LIGHTMAP_RES,
  type FixturePool,
  type InteriorLighting,
  WALL_SAMPLE_HEIGHTS,
} from "../interior-lighting";
import { CONFIG } from "../model";
import { floorCols, floorRows } from "../site";
import { FLOOR_HEIGHT } from "../stair-route";

const BANDS = CONFIG.floors + 1;
/** Smallest atlas, in lightmap texels; a build grows it to its floor's raster. */
const MIN_TEXELS = 1;
/** Irradiance per unit of zone power on surfaces lamps do not reach directly. */
const ROOM_BOUNCE = 0.6;

interface Band {
  ambient: Float32Array;
  covered: Uint8Array;
  warm: Float32Array;
  cool: Float32Array;
  ceilingWarm: Float32Array;
  ceilingCool: Float32Array;
  /** Light vectors for each baked wall height, as x then z arrays. */
  walls: Float32Array[];
  pools: Map<string, FixturePool>;
  /** Share of each fixture currently drawn by a real practical light. */
  removed: Map<string, number>;
}

/** Every powered ceiling fixture lights its own room at any distance. Light
 * is baked per floor into small textures (occluded by real walls) and added
 * to the indirect irradiance of interior materials: the floor pool, the glow
 * on the ceiling around the lamp, and the wash down its walls. The three
 * nearest practical point lights take over their fixture's share of all three
 * up close, so a lamp never brightens or dims as the player approaches it. */
export class InteriorLightmap {
  readonly texture: DataTexture;
  readonly sidesTexture: DataTexture;
  readonly overTexture: DataTexture;
  readonly uniforms = {
    interiorLightmap: { value: null as DataTexture | null },
    /** rg: wall light vector at 1.2 m. ba: at 2.4 m. */
    interiorLmSides: { value: null as DataTexture | null },
    /** rg: warm and cool ceiling irradiance. ba: wall light vector at 0.2 m. */
    interiorLmOver: { value: null as DataTexture | null },
    /** Hemisphere intensity per unit of zone power (0 outdoors). */
    interiorLmAmbient: { value: 0 },
    /** Zone power the global hemisphere fill already represents. */
    interiorLmPlayer: { value: 1 },
    interiorLmPool: { value: 1 },
    interiorLmSky: { value: new Color("#b5c8d2") },
    interiorLmGround: { value: new Color("#3f494c") },
    interiorLmWarm: { value: new Color("#f2d7a3") },
    interiorLmCool: { value: new Color("#9dbfc7") },
    /** Lightmap atlas size in texels (x = columns, y = rows per floor). */
    interiorLmSize: { value: new Vector2(MIN_TEXELS, MIN_TEXELS) },
  };
  /** Atlas size in texels; grows with the widest floor that is built. */
  private cols = MIN_TEXELS;
  private rows = MIN_TEXELS;
  private data = new Uint16Array(this.cols * this.rows * BANDS * 4);
  private sidesData = new Uint16Array(this.cols * this.rows * BANDS * 4);
  private overData = new Uint16Array(this.cols * this.rows * BANDS * 4);
  private bands = new Map<number, Band>();
  /** Lit-lamp colour currently loaded into `interiorLmWarm`. */
  private warmColour = DEFAULT_LIT_FIXTURE;

  constructor() {
    const texture = (data: Uint16Array, name: string) => {
      const map = new DataTexture(
        data,
        this.cols,
        this.rows * BANDS,
        RGBAFormat,
        HalfFloatType,
      );
      map.magFilter = map.minFilter = LinearFilter;
      map.wrapS = map.wrapT = ClampToEdgeWrapping;
      map.generateMipmaps = false;
      map.name = name;
      map.needsUpdate = true;
      return map;
    };
    this.texture = texture(this.data, "interior-lightmap");
    this.sidesTexture = texture(this.sidesData, "interior-lightmap-sides");
    this.overTexture = texture(this.overData, "interior-lightmap-over");
    this.uniforms.interiorLightmap.value = this.texture;
    this.uniforms.interiorLmSides.value = this.sidesTexture;
    this.uniforms.interiorLmOver.value = this.overTexture;
  }

  private markUploaded() {
    for (const map of [this.texture, this.sidesTexture, this.overTexture])
      map.needsUpdate = true;
  }

  /** One atlas is shared by every floor, so the warm tint of the baked lamps
   * follows the floor in view. The uniform's Color is reused, never rebuilt. */
  setWarmColour(colour: string) {
    if (colour === this.warmColour) return;
    this.warmColour = colour;
    this.uniforms.interiorLmWarm.value.set(colour);
  }

  /** Grow the atlas so a floor larger than the legacy raster fits. Bands baked
   * for the old stride move into the wider one so other floors keep their
   * light, then every band is re-uploaded. */
  private resize(cols: number, rows: number) {
    if (cols <= this.cols && rows <= this.rows) return;
    const fromCols = this.cols,
      fromRows = this.rows;
    this.cols = Math.max(cols, this.cols);
    this.rows = Math.max(rows, this.rows);
    const texels = this.cols * this.rows;
    this.data = new Uint16Array(texels * BANDS * 4);
    this.sidesData = new Uint16Array(texels * BANDS * 4);
    this.overData = new Uint16Array(texels * BANDS * 4);
    for (const [map, data] of [
      [this.texture, this.data],
      [this.sidesTexture, this.sidesData],
      [this.overTexture, this.overData],
    ] as const) {
      map.image = { data, width: this.cols, height: this.rows * BANDS };
      map.dispose();
      map.needsUpdate = true;
    }
    this.uniforms.interiorLmSize.value.set(this.cols, this.rows);
    for (const band of this.bands.values()) {
      band.ambient = this.restripe(
        band.ambient,
        Float32Array,
        fromCols,
        fromRows,
      );
      band.covered = this.restripe(
        band.covered,
        Uint8Array,
        fromCols,
        fromRows,
      );
      band.warm = this.restripe(band.warm, Float32Array, fromCols, fromRows);
      band.cool = this.restripe(band.cool, Float32Array, fromCols, fromRows);
      band.ceilingWarm = this.restripe(
        band.ceilingWarm,
        Float32Array,
        fromCols,
        fromRows,
      );
      band.ceilingCool = this.restripe(
        band.ceilingCool,
        Float32Array,
        fromCols,
        fromRows,
      );
      band.walls = band.walls.map((channel) =>
        this.restripe(channel, Float32Array, fromCols, fromRows),
      );
    }
    for (const index of this.bands.keys()) this.write(index);
  }

  /** Copy a band baked at one atlas stride into the current atlas stride. */
  private restripe<T extends Float32Array | Uint8Array>(
    source: T,
    type: new (size: number) => T,
    fromCols: number,
    fromRows: number,
  ) {
    const target = new type(this.cols * this.rows),
      width = Math.min(fromCols, this.cols),
      rows = Math.min(fromRows, this.rows);
    for (let y = 0; y < rows; y++)
      target.set(
        source.subarray(y * fromCols, y * fromCols + width),
        y * this.cols,
      );
    return target;
  }

  build(index: number, plan: InteriorLighting) {
    if (index < 0 || index >= BANDS) return;
    const { floor } = plan,
      cols = floorCols(floor) * LIGHTMAP_RES,
      rows = floorRows(floor) * LIGHTMAP_RES;
    this.resize(cols, rows);
    const texels = this.cols * this.rows,
      source = ambientTexels(plan),
      ambient = new Float32Array(texels),
      covered = new Uint8Array(texels);
    // A floor smaller than the atlas occupies its top-left corner.
    for (let y = 0; y < Math.min(rows, this.rows); y++) {
      const from = y * cols,
        to = from + Math.min(cols, this.cols);
      ambient.set(source.values.subarray(from, to), y * this.cols);
      covered.set(source.covered.subarray(from, to), y * this.cols);
    }
    const band: Band = {
      ambient,
      covered,
      warm: new Float32Array(texels),
      cool: new Float32Array(texels),
      ceilingWarm: new Float32Array(texels),
      ceilingCool: new Float32Array(texels),
      walls: Array.from(
        { length: WALL_SAMPLE_HEIGHTS.length * 2 },
        () => new Float32Array(texels),
      ),
      pools: new Map(),
      removed: new Map(),
    };
    for (const pool of fixturePools(plan)) {
      band.pools.set(pool.fixture.id, pool);
      this.accumulate(band, pool, 1);
    }
    this.bands.set(index, band);
    this.write(index);
  }

  clear(index: number) {
    this.bands.delete(index);
    const texels = this.cols * this.rows,
      start = index * texels * 4;
    for (const data of [this.data, this.sidesData, this.overData])
      data.fill(0, start, start + texels * 4);
    this.markUploaded();
  }

  reset() {
    this.bands.clear();
    this.setWarmColour(DEFAULT_LIT_FIXTURE);
    for (const data of [this.data, this.sidesData, this.overData]) data.fill(0);
    this.markUploaded();
  }

  /** `weights` is the share of each fixture now drawn by a practical light;
   * every other fixture keeps its full baked contribution. */
  setPracticals(index: number, weights: ReadonlyMap<string, number>) {
    const band = this.bands.get(index);
    if (!band) return;
    let changed = false;
    for (const id of new Set([...band.removed.keys(), ...weights.keys()])) {
      const before = band.removed.get(id) ?? 0,
        after = weights.get(id) ?? 0,
        pool = band.pools.get(id);
      if (!pool || after === before) continue;
      // A lamp fading in or out is at least 5 m away, so coarse steps are not
      // visible, and each one re-uploads every lightmap texture.
      if (after > 0 && Math.abs(after - before) < 1 / 16) continue;
      this.accumulate(band, pool, before - after);
      if (after > 0) band.removed.set(id, after);
      else band.removed.delete(id);
      changed = true;
    }
    if (changed) this.write(index);
  }

  /** Texel index of a world point in the atlas, or undefined outside it. */
  private texel(x: number, y: number) {
    const col = Math.floor(x * LIGHTMAP_RES),
      row = Math.floor(y * LIGHTMAP_RES);
    if (col < 0 || row < 0 || col >= this.cols || row >= this.rows)
      return undefined;
    return row * this.cols + col;
  }

  /** Baked floor irradiance (warm + cool) and zone level, for tests. */
  sample(index: number, x: number, y: number) {
    const band = this.bands.get(index),
      i = this.texel(x, y);
    if (!band || i === undefined) return undefined;
    return {
      zone: band.ambient[i],
      pool: band.warm[i] + band.cool[i],
      covered: !!band.covered[i],
    };
  }

  /** Baked ceiling irradiance and wall light vectors, for tests. */
  surface(index: number, x: number, y: number) {
    const band = this.bands.get(index),
      i = this.texel(x, y);
    if (!band || i === undefined) return undefined;
    return {
      ceiling: band.ceilingWarm[i] + band.ceilingCool[i],
      walls: WALL_SAMPLE_HEIGHTS.map((_, layer) => ({
        x: band.walls[layer * 2][i],
        y: band.walls[layer * 2 + 1][i],
      })),
    };
  }

  private accumulate(band: Band, pool: FixturePool, scale: number) {
    const target = pool.warm ? band.warm : band.cool,
      ceiling = pool.warm ? band.ceilingWarm : band.ceilingCool;
    for (let y = 0; y < pool.h; y++)
      for (let x = 0; x < pool.w; x++) {
        const source = y * pool.w + x;
        const i = (pool.y0 + y) * this.cols + pool.x0 + x;
        const v = pool.values[source];
        if (v) target[i] = Math.max(0, target[i] + v * scale);
        const c = pool.ceiling[source];
        if (c) ceiling[i] = Math.max(0, ceiling[i] + c * scale);
        for (let channel = 0; channel < band.walls.length; channel++) {
          const w = pool.walls[channel][source];
          if (w) band.walls[channel][i] += w * scale;
        }
      }
  }

  private write(index: number) {
    const band = this.bands.get(index)!,
      texels = this.cols * this.rows,
      offset = index * texels * 4,
      half = DataUtils.toHalfFloat;
    for (let i = 0; i < texels; i++) {
      const o = offset + i * 4;
      this.data[o] = half(band.ambient[i]);
      this.data[o + 1] = half(band.warm[i]);
      this.data[o + 2] = half(band.cool[i]);
      this.data[o + 3] = half(band.covered[i]);
      this.sidesData[o] = half(band.walls[2][i]);
      this.sidesData[o + 1] = half(band.walls[3][i]);
      this.sidesData[o + 2] = half(band.walls[4][i]);
      this.sidesData[o + 3] = half(band.walls[5][i]);
      this.overData[o] = half(band.ceilingWarm[i]);
      this.overData[o + 1] = half(band.ceilingCool[i]);
      this.overData[o + 2] = half(band.walls[0][i]);
      this.overData[o + 3] = half(band.walls[1][i]);
    }
    this.markUploaded();
  }

  /** Adds the baked irradiance to a lit material's indirect diffuse term. */
  patch(material: Material) {
    const uniforms = this.uniforms;
    material.customProgramCacheKey = () => "interior-lightmap";
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vLmWorld;\nvarying vec3 vLmNormal;",
        )
        .replace(
          "#include <project_vertex>",
          `#include <project_vertex>
vec4 lmWorld = vec4( transformed, 1.0 );
vec3 lmNormal = objectNormal;
#ifdef USE_INSTANCING
lmWorld = instanceMatrix * lmWorld;
lmNormal = mat3( instanceMatrix ) * lmNormal;
#endif
vLmWorld = ( modelMatrix * lmWorld ).xyz;
vLmNormal = mat3( modelMatrix ) * lmNormal;`,
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          `#include <common>
varying vec3 vLmWorld;
varying vec3 vLmNormal;
uniform sampler2D interiorLightmap;
uniform sampler2D interiorLmSides;
uniform sampler2D interiorLmOver;
uniform float interiorLmAmbient;
uniform float interiorLmPlayer;
uniform float interiorLmPool;
uniform vec3 interiorLmSky;
uniform vec3 interiorLmGround;
uniform vec3 interiorLmWarm;
uniform vec3 interiorLmCool;
uniform vec2 interiorLmSize;
vec3 interiorLightmapIrradiance() {
  vec3 n = normalize( vLmNormal );
  // Sample just off the surface so a wall face reads its own room's texels.
  vec3 p = vLmWorld + n * 0.3;
  float band = clamp( floor( p.y / ${FLOOR_HEIGHT.toFixed(2)} ), 0.0, ${(BANDS - 1).toFixed(1)} );
  float z = clamp( p.z * ${LIGHTMAP_RES.toFixed(1)}, 0.5, interiorLmSize.y - 0.5 );
  vec2 uv = vec2(
    p.x * ${LIGHTMAP_RES.toFixed(1)} / interiorLmSize.x,
    ( band * interiorLmSize.y + z ) / ( interiorLmSize.y * ${BANDS.toFixed(1)} )
  );
  vec4 lm = texture2D( interiorLightmap, uv );
  vec4 sides = texture2D( interiorLmSides, uv );
  vec4 over = texture2D( interiorLmOver, uv );
  vec3 hemi = mix( interiorLmGround, interiorLmSky, 0.5 * n.y + 0.5 );
  vec3 pool = lm.g * interiorLmWarm + lm.b * interiorLmCool;
  vec3 ceilingGlow = over.r * interiorLmWarm + over.g * interiorLmCool;
  // Walls share the ceiling's lamps, so they share its warm and cool balance.
  vec3 tint = ceilingGlow / max( over.r + over.g, 1e-4 );
  float height = vLmWorld.y - band * ${FLOOR_HEIGHT.toFixed(2)};
  vec2 light = height < ${WALL_SAMPLE_HEIGHTS[1].toFixed(1)}
    ? mix( over.ba, sides.rg, clamp( ( height - ${WALL_SAMPLE_HEIGHTS[0].toFixed(1)} ) / ${(WALL_SAMPLE_HEIGHTS[1] - WALL_SAMPLE_HEIGHTS[0]).toFixed(1)}, 0.0, 1.0 ) )
    : mix( sides.rg, sides.ba, clamp( ( height - ${WALL_SAMPLE_HEIGHTS[1].toFixed(1)} ) / ${(WALL_SAMPLE_HEIGHTS[2] - WALL_SAMPLE_HEIGHTS[1]).toFixed(1)}, 0.0, 1.0 ) );
  // Light bounced around a powered room. It follows the zone's power, never a
  // lamp's share, so it stays constant while a practical takes over.
  vec3 bounce = ${ROOM_BOUNCE.toFixed(2)} * lm.r * ( 1.0 - max( n.y, 0.0 ) ) * interiorLmWarm;
  vec3 lamps = max( n.y, 0.0 ) * pool + max( -n.y, 0.0 ) * ceilingGlow
    + max( dot( n.xz, light ), 0.0 ) * tint + bounce;
  return lm.a * ( interiorLmAmbient * ( lm.r - interiorLmPlayer ) * hemi
    + interiorLmPool * lamps );
}`,
        )
        .replace(
          "#include <lights_fragment_end>",
          `#if defined( RE_IndirectDiffuse )
irradiance += interiorLightmapIrradiance();
#endif
#include <lights_fragment_end>`,
        );
    };
    material.needsUpdate = true;
  }

  dispose() {
    this.bands.clear();
    this.texture.dispose();
    this.sidesTexture.dispose();
    this.overTexture.dispose();
  }
}
