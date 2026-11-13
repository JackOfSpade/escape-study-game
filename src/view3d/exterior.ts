import { EnvironmentSurfaces } from "./environment-surfaces";
import {
  BackSide,
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Points,
  PointsMaterial,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { BuildingFootprint, Floor } from "../model";
import type { RunNeighborStyle, RunSurroundings } from "../setting-catalog.mjs";
import {
  NEIGHBOR_RIM,
  PLINTH,
  lotCells,
  mix,
  neighborCell,
  neighborCore,
  neighborPlinth,
  neighborStone,
  type Footprint,
  type NeighborEmit,
  type NeighborStyle,
} from "./neighbors";
import { roofFeatureParts } from "./roof-features";
import {
  groundMaterialParams,
  groundTexture,
  pathPattern,
  type GroundPattern,
} from "./textures";
import { WeatherField } from "./weather";

import {
  cityWall,
  inCityRectangle,
  type CityObstacle,
  type CityPlan,
} from "../city-layout";
import {
  cityGroundRectangles,
  cityBackdrop,
  cityLayout,
  exteriorSignature,
  neighbourLotAllowed,
  overlapsPad,
  roadGround,
  sceneryPads,
  shellFootprints,
  siteFootprints,
  streetLayout,
  type SceneryPad,
} from "./exterior-layout";

export {
  exteriorWallTiles,
  outsideBuilding,
  streetLayout,
  cityLayout,
} from "./exterior-layout";

function asphaltTexture() {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  const c = canvas.getContext("2d")!;
  c.fillStyle = "#42494d";
  c.fillRect(0, 0, 96, 96);
  for (let i = 0; i < 2200; i++) {
    const hash = Math.imul(i + 17, 15485863) >>> 0;
    c.fillStyle = i % 3 ? "rgba(9,15,20,.16)" : "rgba(158,164,157,.2)";
    c.fillRect(hash % 96, (hash >>> 8) % 96, 1, 1);
  }
  c.strokeStyle = "rgba(10,15,18,.28)";
  c.beginPath();
  c.moveTo(7, 0);
  c.lineTo(13, 26);
  c.lineTo(3, 49);
  c.moveTo(13, 26);
  c.lineTo(31, 38);
  c.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(35, 35);
  texture.anisotropy = 4;
  return texture;
}

function maybeMap(map: CanvasTexture | undefined) {
  return map ? { map } : {};
}

/** A colour scaled in linear light, returned as sRGB hex. */
function tone(hex: string, factor: number) {
  return `#${new Color(hex).multiplyScalar(factor).getHexString()}`;
}

function messageTexture(title: string, subtitle: string, warning = false) {
  if (typeof document === "undefined") return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 80;
  const c = canvas.getContext("2d")!;
  c.fillStyle = warning ? "#413a28" : "#262d29";
  c.fillRect(0, 0, canvas.width, canvas.height);
  c.strokeStyle = "#aeae84";
  c.strokeRect(3, 3, 378, 74);
  c.fillStyle = "#e1cb92";
  c.font = "600 30px sans-serif";
  c.textAlign = "center";
  c.fillText(title, 192, 38, 360);
  c.font = "16px sans-serif";
  c.fillStyle = "#98a69a";
  c.fillText(subtitle, 192, 62, 360);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

interface FlatRect {
  x: number;
  z: number;
  w: number;
  d: number;
}

/** The ring of streets of a city that has no stored plan (older saves). */
function legacyRoads(floor: Floor): FlatRect[] {
  const city = cityLayout(floor);
  if (!city) return [];
  const rects: FlatRect[] = [
    { x: city.left - 9, z: 15, w: 10, d: 230 },
    { x: city.right + 9, z: 15, w: 10, d: 230 },
    { x: 20, z: city.north - 8, w: 240, d: 10 },
    { x: 20, z: city.south + 9, w: 240, d: 10 },
  ];
  const layout = streetLayout(floor);
  if (layout)
    rects.push({
      x: (layout.left + layout.right) / 2,
      z: (layout.front + 1 + floor.tiles.length) / 2,
      w: layout.right - layout.left,
      d: floor.tiles.length - layout.front - 1,
    });
  return rects;
}

/** The parts of a flat rectangle that lie outside the building footprint,
 * which the continuous ground already cuts out. */
function outsideFootprint(floor: Floor, r: FlatRect): FlatRect[] {
  const b = floor.boundary;
  if (!b) return [r];
  const out: FlatRect[] = [],
    x0 = r.x - r.w / 2,
    x1 = r.x + r.w / 2,
    z0 = r.z - r.d / 2,
    z1 = r.z + r.d / 2,
    add = (ax: number, bx: number, az: number, bz: number) => {
      if (bx - ax > 1e-6 && bz - az > 1e-6)
        out.push({
          x: (ax + bx) / 2,
          z: (az + bz) / 2,
          w: bx - ax,
          d: bz - az,
        });
    };
  if (z1 <= b.top || z0 >= b.bottom) return [r];
  add(x0, x1, z0, Math.min(z1, b.top));
  add(x0, x1, Math.max(z0, b.bottom), z1);
  for (
    let row = Math.max(b.top, Math.floor(z0));
    row < Math.min(b.bottom, Math.ceil(z1));
    row++
  ) {
    const edge = b.rows[row],
      a = Math.max(z0, row),
      c = Math.min(z1, row + 1);
    if (!edge) continue;
    add(x0, Math.min(x1, edge.left), a, c);
    add(Math.max(x0, edge.right), x1, a, c);
  }
  return out;
}

const MUTATION_HORIZON = new Color("#453447");
const MUTATION_ZENITH = new Color("#171629");
/** The densest fog still shows the street ahead of the entrance. */
const FOG_FLOOR = 48;
/** Beyond this many detailed neighbour pieces a block falls back to one mass. */
const PIECE_BUDGET = 6000;

/** A fixed set of merged meshes and two unshadowed practical lights. The city
 * is shared by all floors in world coordinates; no gameplay tiles are changed. */
export class ExteriorDressing {
  readonly group = new Group();
  readonly horizon = new Color("#344552");
  enabled = false;
  private world = new Group();
  private environmentSurfaces?: EnvironmentSurfaces;
  private asphaltMap = asphaltTexture();
  private asphalt = new MeshStandardMaterial({
    ...(this.asphaltMap ? { map: this.asphaltMap } : {}),
    color: "#77838a",
    emissive: "#293b45",
    emissiveIntensity: 0.45,
    roughness: 1,
    fog: false,
  });
  private solid = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.94,
    emissive: "#18232c",
    emissiveIntensity: 0.25,
    fog: false,
  });
  private glass = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.45,
    emissive: "#547080",
    emissiveIntensity: 0.24,
    fog: false,
  });
  private warm = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.65,
    emissive: "#d4b276",
    emissiveIntensity: 0.72,
    fog: false,
  });
  private signMaterial = new MeshBasicMaterial({
    ...maybeMap(
      messageTexture("MERCER CIVIC CENTRE", "RECEPTION  •  STUDY HALL"),
    ),
    color: "#d8cfb2",
    fog: false,
  });
  private quarantineMaterial = new MeshBasicMaterial({
    ...maybeMap(
      messageTexture("EVACUATION SUSPENDED", "QUARANTINE ZONE  •  06:40", true),
    ),
    fog: false,
  });
  private routeMaterial = new MeshBasicMaterial({
    ...maybeMap(
      messageTexture("ROOFTOP ASSEMBLY ↑", "STREET EXITS COMPROMISED", true),
    ),
    fog: false,
  });
  private emergency = new MeshBasicMaterial({ vertexColors: true, fog: false });
  private skyMaterial = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
    uniforms: {
      horizon: { value: this.horizon },
      zenith: { value: new Color("#050b17") },
    },
    vertexShader: `varying float height;
      void main() {
        height = position.y / 150.0;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `uniform vec3 horizon; uniform vec3 zenith;
      varying float height;
      void main() {
        gl_FragColor = vec4(mix(horizon, zenith, pow(clamp(height, 0.0, 1.0), 0.65)), 1.0);
        #include <colorspace_fragment>
      }`,
  });
  private moonMaterial = new MeshBasicMaterial({
    color: "#8c9baf",
    fog: false,
  });
  private sky = new Mesh(new SphereGeometry(700, 32, 16), this.skyMaterial);
  private moon = new Mesh(new SphereGeometry(0.65, 10, 6), this.moonMaterial);
  private entranceLight = new PointLight("#e5bd78", 12, 6.5, 2);
  private streetLight = new PointLight("#9ab4c2", 10, 7, 2);
  private tint = new Color();
  private incidents: {
    x: number;
    y: number;
    z: number;
    seed: number;
    nx: number;
    nz: number;
  }[] = [];
  private smoke?: Points<BufferGeometry, PointsMaterial>;
  private flames?: Points<BufferGeometry, PointsMaterial>;
  private fireLight = new PointLight("#f28b43", 0, 15, 2);
  private shopSigns?: Mesh<BufferGeometry, MeshBasicMaterial>;
  private lightPools?: Mesh<BufferGeometry, MeshBasicMaterial>;
  private signKey = "";
  private canopyLights: BufferGeometry[] = [];
  private canopyBody: BufferGeometry[] = [];
  private canopyMaterial = new MeshBasicMaterial({
    vertexColors: true,
    fog: false,
  });
  /** The designed surroundings of this build, if any. Absent keeps every
   * default look byte for byte. */
  private look?: RunSurroundings;
  private mutation = false;
  private skyHorizon = new Color("#344552");
  private weather = new WeatherField();
  private groundTextures = new Map<string, CanvasTexture>();
  private themedGround = false;
  private pathMaterial?: MeshStandardMaterial;
  private iceMaterial?: MeshStandardMaterial;
  private icePieces: BufferGeometry[] = [];
  private pads: SceneryPad[] = [];
  /** Every real building footprint the outside must respect. */
  private sites: BuildingFootprint[] = [];
  /** Floors and shell cache key of the current build. */
  private dressedFloor?: Floor;
  private dressedFloors?: Floor[];
  private siteKey = "";
  private pieces = 0;
  private fogMix = 1;
  private fogClock = 0;

  constructor() {
    this.group.name = "street-exterior";
    this.sky.name = "gradient-sky";
    this.sky.position.set(22, 0, 17);
    this.sky.renderOrder = -10;
    this.moon.position.set(-35, 65, 80);
    this.entranceLight.castShadow = this.streetLight.castShadow = false;
    this.group.add(
      this.world,
      this.sky,
      this.moon,
      this.entranceLight,
      this.streetLight,
      this.fireLight,
      this.weather.group,
    );
    this.group.visible = false;
  }

  setTheme(mutation: boolean) {
    this.mutation = mutation;
    this.moonMaterial.color.set(mutation ? "#b59ba9" : "#8c9baf");
    this.solid.emissive.set(mutation ? "#3a2833" : "#243440");
    this.applyAtmosphere();
  }

  /** Sky gradient and fog colour: the default night, or the designed one. The
   * surge still pulls a designed palette toward the mutation hue. */
  private applyAtmosphere() {
    if (!this.skyMaterial) return;
    const mutation = !!this.mutation,
      zenith = this.skyMaterial.uniforms.zenith.value as Color,
      look = this.look;
    if (!look) {
      this.horizon.set(mutation ? "#453447" : "#344552");
      this.skyMaterial.uniforms.horizon.value = this.horizon;
      zenith.set(mutation ? "#171629" : "#111e32");
      return;
    }
    const pull = mutation ? 0.3 : 0;
    this.horizon.set(look.fog.color).lerp(MUTATION_HORIZON, pull);
    // Thick fog swallows the horizon band, so the sky meets it without a seam.
    this.skyHorizon
      .set(look.sky.horizon)
      .lerp(MUTATION_HORIZON, pull)
      .lerp(this.horizon, Math.min(1, look.fog.density) * 0.7);
    this.skyMaterial.uniforms.horizon.value = this.skyHorizon;
    zenith.set(look.sky.zenith).lerp(MUTATION_ZENITH, pull);
  }

  /** The fog distances for this frame. A designed fog thickens the air outside
   * and only a little indoors; it always leaves the street in front of the
   * entrance readable, and eases between the two as the player crosses the
   * door. An undesigned run keeps the caller's distances. */
  fogRange(near: number, far: number, outside: boolean, time: number) {
    const density = this.look?.fog.density ?? 0;
    if (!density) return { near, far };
    const dt = Math.min(0.25, Math.max(0, time - (this.fogClock ?? 0)));
    this.fogClock = time;
    const target = outside ? 1 : 0.35;
    let blend = this.fogMix ?? 1;
    blend +=
      Math.sign(target - blend) * Math.min(Math.abs(target - blend), dt * 1.2);
    this.fogMix = blend;
    const strength = density * blend,
      keep = (1 - strength) ** 2;
    return {
      near: near * (1 - strength) + 6 * strength,
      far: FOG_FLOOR + (far - FOG_FLOOR) * keep,
    };
  }

  build(floor: Floor, floors?: Floor[]) {
    this.clear();
    const ground = floors?.[0] ?? floor,
      city = cityLayout(ground);
    this.enabled = this.group.visible = !!city;
    // Remember every site so fake lots can never crowd a real building, and
    // keep a cache key that includes the shells so stamping rebuilds once.
    this.dressedFloor = floor;
    this.dressedFloors = floors;
    this.sites = floors ? shellFootprints(floors) : siteFootprints(floor);
    this.siteKey = floors ? exteriorSignature(floors) : "";
    this.applyLook(city ? ground : undefined);
    if (!city) return;
    this.updateSigns(ground);
    const fogOn = !!ground.city || !!this.look;
    if (this.asphalt.fog !== fogOn) {
      this.asphalt.fog = fogOn;
      this.asphalt.needsUpdate = true;
    }
    const opaque: BufferGeometry[] = [],
      panes: BufferGeometry[] = [],
      lit: BufferGeometry[] = [],
      signals: BufferGeometry[] = [];
    const box = (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
    ) => {
      this.part(out, new BoxGeometry(w, h, d).translate(x, y, z), color);
    };
    if (ground.city)
      this.buildPhysicalCity(ground, ground.city, opaque, panes, lit, signals);
    else this.buildCity(ground, opaque, panes, lit, signals);
    const layout = streetLayout(ground);
    this.canopyLights = [];
    this.canopyBody = [];
    if (layout)
      this.buildArrival(ground, layout, opaque, panes, lit, box, signals);
    else {
      this.entranceLight.intensity = 0;
      this.streetLight.intensity = 0;
    }
    this.merge(opaque, this.solid, "merged-street-facade-props");
    this.merge(panes, this.glass, "dim-exterior-windows");
    this.merge(lit, this.warm, "lit-exterior-windows-practicals");
    this.merge(signals, this.emergency, "city-emergency-signals");
    this.merge(this.icePieces, this.iceStuff(), "themed-ice-neighbors");
    this.icePieces = [];
    this.buildScenery(ground);
    this.merge(this.canopyBody, this.solid, "entrance-canopy");
    this.canopyBody = [];
    this.merge(
      this.canopyLights,
      this.canopyMaterial,
      "entrance-canopy-lights",
    );
    this.canopyLights = [];
    if (ground.environment) {
      this.environmentSurfaces = new EnvironmentSurfaces(
        ground,
        ground.environment,
        "exterior",
      );
      this.world.add(this.environmentSurfaces.group);
    }
  }

  /** Applies (or clears) the designed surroundings: ground and path surfaces,
   * atmosphere, weather and the fog flags of the exterior materials. */
  private applyLook(floor?: Floor) {
    const look = floor?.setting?.surroundings;
    this.look = look;
    this.pieces = 0;
    this.pads = [];
    this.icePieces = [];
    this.fogMix = 1;
    if (look && floor) {
      const known = new Set(floor.setting!.objects.map((o) => o.id));
      this.pads = sceneryPads(
        floor,
        look.scenery.filter((id) => known.has(id)),
      );
    }
    this.applyGround(look);
    for (const material of [
      this.solid,
      this.glass,
      this.warm,
      this.emergency,
    ] as const) {
      const fog = !!look;
      if (material && material.fog !== fog) {
        material.fog = fog;
        material.needsUpdate = true;
      }
    }
    this.weather?.setKind(look?.weather ?? "none");
    this.applyAtmosphere();
  }

  private groundTex(pattern: GroundPattern) {
    if (typeof document === "undefined") return undefined;
    let texture = this.groundTextures.get(pattern);
    if (!texture) {
      texture = groundTexture(pattern);
      this.groundTextures.set(pattern, texture);
    }
    return texture;
  }

  private applyGround(look?: RunSurroundings) {
    if (!look) {
      if (!this.themedGround) return;
      this.themedGround = false;
      this.asphalt.map = this.asphaltMap ?? null;
      this.asphalt.color.set("#77838a");
      this.asphalt.emissive.set("#293b45");
      this.asphalt.roughness = 1;
      this.asphalt.metalness = 0;
      this.asphalt.needsUpdate = true;
      return;
    }
    const params = groundMaterialParams(look.ground);
    this.themedGround = true;
    this.asphalt.map = this.groundTex(look.ground) ?? null;
    this.asphalt.color.set(look.groundColor);
    this.asphalt.emissive.set(tone(look.groundColor, 0.33));
    this.asphalt.roughness = params.roughness;
    this.asphalt.metalness = params.metalness;
    this.asphalt.needsUpdate = true;
  }

  private iceStuff() {
    return (this.iceMaterial ??= new MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.12,
      metalness: 0.1,
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      emissive: "#27394a",
      emissiveIntensity: 0.4,
      fog: true,
    }));
  }

  /** A neighbour look other than buildings, if the design asks for one. */
  private get themedStyle(): NeighborStyle | undefined {
    const style: RunNeighborStyle | undefined = this.look?.neighbors;
    return style && style !== "buildings" ? style : undefined;
  }

  /** A building colour pulled toward the designed neighbour colour. */
  private neighborTone(color: string) {
    return this.look ? mix(color, this.look.neighborColor, 0.8) : color;
  }

  private emitter(
    solid: BufferGeometry[],
    glow: BufferGeometry[],
  ): NeighborEmit {
    return (geometry, color, layer) => {
      this.pieces++;
      this.part(
        layer === "ice" ? this.icePieces : layer === "glow" ? glow : solid,
        geometry,
        color,
      );
    };
  }

  /** Fills one solid lot in the designed neighbour style. Only the outer rim
   * is detailed; the lot's footprint, and so its collision, is never altered.
   * A cell that shares a scenery pad becomes a raised bed instead. */
  private neighborLot(
    lot: Footprint,
    height: number,
    seed: number,
    far: boolean,
    solid: BufferGeometry[],
    glow: BufferGeometry[],
    style: NeighborStyle | undefined = this.themedStyle,
  ) {
    const look = this.look;
    if (!look || !style) return;
    // A fake lot never covers or crowds a real site, including stamped ones.
    if (
      !neighbourLotAllowed(
        { x: lot.x, y: lot.z, w: lot.w, d: lot.d },
        this.sites,
      )
    )
      return;
    const emit = this.emitter(solid, glow),
      { rim, core } = lotCells(lot, NEIGHBOR_RIM, far ? 30 : 12);
    rim.forEach((cell, i) => {
      if (this.pads.some((pad) => overlapsPad(pad, cell)))
        neighborPlinth(cell, look.neighborColor, emit);
      else if (this.pieces > PIECE_BUDGET)
        neighborCore(style, cell, look.neighborColor, emit);
      else
        neighborCell(
          style,
          cell,
          height,
          look.neighborColor,
          seed * 977 + i,
          emit,
          far || this.pieces > PIECE_BUDGET * 0.6,
        );
    });
    if (core) neighborCore(style, core, look.neighborColor, emit);
  }

  /** Flat roads follow the design's path colour. They are laid just above the
   * ground, outside the building footprint, and never raise a physical edge. */
  private buildPaths(floor: Floor) {
    const look = this.look,
      b = floor.boundary;
    if (!look || !b) return;
    const rects = (
      floor.city
        ? floor.city.roads.map((r) => ({ x: r.x, z: r.y, w: r.w, d: r.h }))
        : legacyRoads(floor)
    ).flatMap((r) => outsideFootprint(floor, r));
    if (!rects.length) return;
    const patches = rects.map((r) => {
      const geometry = new PlaneGeometry(r.w, r.d)
          .rotateX(-Math.PI / 2)
          .translate(r.x, -0.02, r.z),
        uv = geometry.getAttribute("uv"),
        p = geometry.getAttribute("position");
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, (p.getX(i) + 118) / 280, (p.getZ(i) + 124) / 280);
      return geometry;
    });
    const pattern = pathPattern(look.ground),
      params = groundMaterialParams(pattern),
      map = this.groundTex(pattern);
    this.pathMaterial?.dispose();
    this.pathMaterial = new MeshStandardMaterial({
      ...(map ? { map } : {}),
      color: look.pathColor,
      emissive: tone(look.pathColor, 0.33),
      emissiveIntensity: 0.45,
      roughness: params.roughness,
      metalness: params.metalness,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
    });
    const mesh = new Mesh(mergeGeometries(patches)!, this.pathMaterial);
    for (const patch of patches) patch.dispose();
    mesh.name = "themed-paths";
    this.world.add(mesh);
  }

  /** Each scenery object, a few times, on a raised bed in a lot beside the
   * street. They are drawn from the same composed recipe the rooms use, are
   * scaled up to read at street distance and never collide. */
  private buildScenery(floor: Floor) {
    const setting = floor.setting;
    if (!setting || !this.pads.length) return;
    const solid: BufferGeometry[] = [],
      lamps: BufferGeometry[] = [];
    for (const pad of this.pads) {
      const object = setting.objects.find((o) => o.id === pad.id);
      if (!object) continue;
      const parts = roofFeatureParts(
        { kind: pad.id as never, x: 0, y: 0, outward: { x: 0, y: 1 } },
        0,
        setting.objects,
      );
      const scale = Math.min(
          4,
          Math.max(
            0.5,
            Math.min(
              5 / Math.max(0.1, object.size.h),
              6.4 / Math.max(0.1, Math.hypot(object.size.w, object.size.d)),
            ),
          ),
        ),
        // The shared builder offsets a deep piece from the parapet; undo it.
        shift = Math.min(0.8, Math.max(0, object.size.d / 2 - 0.3)) - 0.2;
      for (const [list, into] of [
        [parts.solid, solid],
        [parts.lamps, lamps],
      ] as const)
        for (const g of list) {
          g.translate(0, 0, shift)
            .scale(scale, scale, scale)
            .rotateY(pad.angle)
            .translate(pad.x, PLINTH, pad.z);
          into.push(g);
        }
    }
    this.merge(solid, this.solid, "themed-scenery");
    this.merge(lamps, this.emergency, "themed-scenery-lit");
  }

  private updateSigns(floor: Floor) {
    if (typeof document === "undefined" || floor.environment) return;
    const design = floor.exteriorDesign,
      values = [
        design?.buildingName ?? "MERCER CIVIC CENTRE",
        design?.buildingSubtitle ?? "RECEPTION  •  STUDY HALL",
        design?.quarantineTitle ?? "EVACUATION SUSPENDED",
        design?.quarantineSubtitle ?? "QUARANTINE ZONE  •  06:40",
      ],
      key = JSON.stringify(values);
    if (key === this.signKey) return;
    this.signKey = key;
    for (const [material, offset, warning] of [
      [this.signMaterial, 0, false],
      [this.quarantineMaterial, 2, true],
    ] as const) {
      material.map?.dispose();
      material.map =
        messageTexture(values[offset], values[offset + 1], warning) ?? null;
      material.needsUpdate = true;
    }
  }

  private buildArrival(
    floor: Floor,
    layout: NonNullable<ReturnType<typeof streetLayout>>,
    opaque: BufferGeometry[],
    panes: BufferGeometry[],
    lit: BufferGeometry[],
    box: (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
    ) => void,
    signals: BufferGeometry[] = [],
  ) {
    const front = layout.front + 1.025;
    const entrance = layout.entrance;
    const style = floor.setting?.exterior;
    if (style) this.buildCanopy(style, entrance, front, box);
    else {
      box(opaque, entrance, 2.85, front + 0.45, 4.6, 0.18, 1.35, "#3d4c52");
      box(lit, entrance, 2.735, front + 0.48, 3.7, 0.035, 0.7, "#e1c68e");
    }
    box(opaque, entrance, 3.22, front + 0.46, 3.8, 0.6, 0.14, "#27383c");
    // An open site has no facade for the canopy to hang from: it becomes a
    // freestanding awning over the main gate, carried by two posts.
    if (floor.open === true)
      for (const side of [-1, 1]) {
        box(
          opaque,
          entrance + side * 2.1,
          1.5,
          front + 0.55,
          0.14,
          3,
          0.14,
          "#42575c",
        );
        box(
          opaque,
          entrance + side * 2.1,
          0.07,
          front + 0.55,
          0.32,
          0.14,
          0.32,
          "#334549",
        );
      }
    const sign = new Mesh(new PlaneGeometry(3.55, 0.74), this.signMaterial);
    sign.position.set(entrance, 3.22, front + 0.56);
    sign.name = "entrance-sign";
    if (!floor.environment) this.world.add(sign);
    else sign.geometry.dispose();
    this.entranceLight.position.set(entrance, 2.65, front + 0.8);

    // Flat paving and flush markings never suggest an extra physical obstacle.
    const roads = roadGround(this.look?.ground);
    box(
      opaque,
      (layout.left + layout.right) / 2,
      -0.005,
      front + 0.65,
      layout.right - layout.left,
      0.025,
      1.25,
      this.look ? tone(this.look.pathColor, 1.2) : "#7f8580",
    );
    if (roads) {
      box(
        opaque,
        (layout.left + layout.right) / 2,
        0.015,
        front + 1.28,
        layout.right - layout.left,
        0.05,
        0.15,
        "#a0a298",
      );
      for (let x = layout.left; x < layout.right; x += 3.2)
        box(opaque, x + 0.8, 0.005, front + 4.6, 1.4, 0.025, 0.075, "#c2b88d");
    }

    if (!floor.city) {
      // Guardrails sit at the actual solid edge of the open arrival lane, so the
      // visible street extension never implies that the simulation continues.
      const streetRow = floor.tiles[layout.front + 1],
        open = streetRow.flatMap((tile, x) => (tile === 0 ? [x] : []));
      for (const edge of [open[0] + 0.025, open[open.length - 1] + 0.975]) {
        const length = floor.tiles.length - layout.front - 1;
        box(
          opaque,
          edge,
          0.68,
          layout.front + 1 + length / 2,
          0.045,
          0.12,
          length,
          "#697575",
        );
        for (let y = layout.front + 1.2; y < floor.tiles.length; y += 1.8)
          box(opaque, edge, 0.36, y, 0.05, 0.72, 0.05, "#677272");
      }
      // Match the real south collision boundary; the distant asphalt is scenery.
      const southEdge = floor.tiles.length - 0.025,
        x0 = open[0],
        x1 = open[open.length - 1] + 1,
        span = x1 - x0;
      box(opaque, (x0 + x1) / 2, 0.68, southEdge, span, 0.12, 0.045, "#697575");
      box(opaque, (x0 + x1) / 2, 0.36, southEdge, span, 0.06, 0.045, "#697575");
      for (let x = x0 + 0.2; x < x1; x += 1.8)
        box(opaque, x, 0.36, southEdge, 0.05, 0.72, 0.05, "#677272");
    }
    let lights = 0;
    for (const p of floor.city ? [] : layout.props) {
      if (!roads) {
        // Theme-neutral clutter takes the place of cars, lamps and cones.
        const emit = this.emitter(opaque, signals);
        neighborStone(
          p.x,
          p.y,
          Math.max(0.2, Math.min(p.w, p.h) * 0.9),
          this.look!.neighborColor,
          lights + Math.floor(p.x * 7 + p.y * 13),
          emit,
        );
      } else if (p.kind === "car") {
        const body = p.x < entrance ? "#465b67" : "#70564e";
        box(opaque, p.x, 0.48, p.y, 0.86, 0.52, 2.6, body);
        box(opaque, p.x, 0.92, p.y - 0.1, 0.73, 0.46, 1.35, body);
        box(panes, p.x, 0.96, p.y - 0.1, 0.75, 0.3, 1.05, "#354953");
        for (const side of [-1, 1])
          for (const axle of [-0.86, 0.86])
            box(
              opaque,
              p.x + side * 0.36,
              0.24,
              p.y + axle,
              0.2,
              0.4,
              0.43,
              "#22282b",
            );
        for (const side of [-1, 1])
          box(
            panes,
            p.x + side * 0.26,
            0.52,
            p.y - 1.32,
            0.16,
            0.14,
            0.035,
            "#829185",
          );
        box(opaque, p.x, 0.32, p.y + 1.33, 0.76, 0.11, 0.06, "#728080");
      } else if (p.kind === "streetlight") {
        this.part(
          opaque,
          new CylinderGeometry(0.055, 0.08, 3.65, 6).translate(p.x, 1.825, p.y),
          "#596975",
        );
        box(opaque, p.x, 3.66, p.y + 0.23, 0.11, 0.1, 0.65, "#566774");
        box(lit, p.x, 3.6, p.y + 0.49, 0.24, 0.06, 0.36, "#b7c7b2");
        if (lights++ === 0) this.streetLight.position.set(p.x, 3.4, p.y + 0.49);
      } else if (p.kind === "cone") {
        box(opaque, p.x, 0.025, p.y, 0.26, 0.05, 0.26, "#303a3d");
        this.part(
          opaque,
          new ConeGeometry(0.11, 0.42, 6).translate(p.x, 0.25, p.y),
          "#a95e36",
        );
        this.part(
          opaque,
          new CylinderGeometry(0.065, 0.08, 0.075, 6).translate(p.x, 0.23, p.y),
          "#c5c4ad",
        );
      } else {
        box(opaque, p.x, 0.035, p.y, 0.43, 0.05, 0.17, "#8c8871");
        box(opaque, p.x + 0.1, 0.07, p.y, 0.12, 0.07, 0.13, "#4b5b61");
      }
    }
    this.streetLight.intensity = lights ? 10 : 0;
  }

  /** The entrance canopy of a designed building. Every style stays below the
   * entrance sign, whose slot is fixed by the saved layout. Lit parts use the
   * unlit canopy-light material so `canopyGlow` shows as authored. */
  private buildCanopy(
    style: NonNullable<Floor["setting"]>["exterior"],
    entrance: number,
    front: number,
    box: (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
    ) => void,
  ) {
    const glow = style.canopyGlow,
      lamp = (
        x: number,
        y: number,
        z: number,
        w: number,
        h: number,
        d: number,
        color = glow,
      ) => box(this.canopyLights, x, y, z, w, h, d, color);
    if (style.canopy === "none") return;
    if (style.canopy === "flat") {
      box(
        this.canopyBody,
        entrance,
        2.85,
        front + 0.45,
        4.6,
        0.18,
        1.35,
        style.trimColor,
      );
      lamp(entrance, 2.735, front + 0.48, 3.7, 0.035, 0.7);
    } else if (style.canopy === "gabled") {
      const half = 2.3,
        rise = 0.38,
        eave = 2.45,
        angle = Math.atan2(rise, half),
        length = Math.hypot(half, rise);
      for (const side of [-1, 1])
        this.part(
          this.canopyBody,
          new BoxGeometry(length, 0.08, 1.35)
            .rotateZ(-side * angle)
            .translate(
              entrance + (side * half) / 2,
              eave + rise / 2,
              front + 0.45,
            ),
          style.trimColor,
        );
      // The street-facing gable end, a triangular prism closing the roof.
      const sy = rise / 1.5;
      this.part(
        this.canopyBody,
        new CylinderGeometry(1, 1, 0.05, 3)
          .rotateX(-Math.PI / 2)
          .scale(half / 0.866, sy, 1)
          .translate(entrance, eave + 0.5 * sy, front + 1.1),
        tone(style.trimColor, 0.8),
      );
      box(
        this.canopyBody,
        entrance,
        eave - 0.03,
        front + 1.1,
        4.6,
        0.06,
        0.06,
        style.trimColor,
      );
      lamp(entrance, eave - 0.07, front + 0.48, 3.4, 0.03, 0.7);
    } else {
      // Theatre-style marquee: a deep box with a lit fascia and chaser bulbs.
      const top = 2.775,
        bottom = 2.225,
        mid = (top + bottom) / 2,
        cz = front + 0.5,
        depth = 1.6,
        width = 4.8,
        frontZ = cz + depth / 2;
      box(
        this.canopyBody,
        entrance,
        mid,
        cz,
        width,
        top - bottom,
        depth,
        style.trimColor,
      );
      lamp(
        entrance,
        mid,
        frontZ + 0.02,
        width - 0.5,
        0.3,
        0.03,
        tone(glow, 0.5),
      );
      lamp(
        entrance,
        bottom - 0.01,
        cz,
        width - 0.4,
        0.02,
        depth - 0.4,
        tone(glow, 0.7),
      );
      for (let x = -width / 2 + 0.15; x <= width / 2 - 0.1; x += 0.3)
        for (const y of [top - 0.06, bottom + 0.06])
          lamp(entrance + x, y, frontZ + 0.04, 0.09, 0.09, 0.07);
      for (const side of [-1, 1])
        for (let z = cz - depth / 2 + 0.35; z < frontZ - 0.2; z += 0.4)
          for (const y of [top - 0.06, bottom + 0.06])
            lamp(entrance + (side * width) / 2, y, z, 0.07, 0.09, 0.09);
    }
  }

  /** One continuous asphalt mesh under the whole city; patches share a UV
   * mapping so adjoining rectangles never show a seam. */
  private buildGround(floor: Floor) {
    const patches = cityGroundRectangles(floor).map((r) => {
      const geometry = new PlaneGeometry(r.w, r.d)
          .rotateX(-Math.PI / 2)
          .translate(r.x, -0.035, r.z),
        uv = geometry.getAttribute("uv"),
        p = geometry.getAttribute("position");
      for (let i = 0; i < uv.count; i++)
        uv.setXY(i, (p.getX(i) + 118) / 280, (p.getZ(i) + 124) / 280);
      return geometry;
    });
    const ground = new Mesh(mergeGeometries(patches)!, this.asphalt);
    for (const part of patches) part.dispose();
    ground.name = "continuous-city-ground";
    this.world.add(ground);
    this.buildPaths(floor);
  }
  private buildCity(
    floor: Floor,
    opaque: BufferGeometry[],
    panes: BufferGeometry[],
    lit: BufferGeometry[],
    signals: BufferGeometry[],
  ) {
    const city = cityLayout(floor)!;
    const box = (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
      angle = 0,
    ) =>
      this.part(
        out,
        new BoxGeometry(w, h, d).rotateY(angle).translate(x, y, z),
        color,
      );
    this.buildGround(floor);

    const westRoad = city.left - 9,
      eastRoad = city.right + 9,
      northRoad = city.north - 8,
      southRoad = city.south + 9;
    // A perimeter street, adjoining sidewalks and crossing streets. Everything
    // raised here lies outside playable cells, including the arrival queue.
    // Horizontal sidewalks own crossing rectangles; vertical strips stop at
    // their edges, so camera motion never reveals two coplanar top surfaces.
    const roads = roadGround(this.look?.ground),
      sidewalkTone = this.look ? tone(this.look.pathColor, 1.2) : "#6d7675",
      sidewalkWidth = 1.65,
      sidewalkZ = [
        northRoad - 5.6,
        northRoad + 5.6,
        southRoad - 5.6,
        southRoad + 5.6,
      ];
    if (roads)
      for (const x of [westRoad, eastRoad]) {
        for (let z = -100; z < 130; z += 5)
          if (
            ![northRoad, southRoad].some(
              (crossing) => Math.abs(z - crossing) < 11.35,
            )
          )
            box(opaque, x, 0.004, z, 0.1, 0.035, 2.7, "#a5a088");
        for (const side of [-1, 1]) {
          let start = -49;
          for (const crossing of [...sidewalkZ, 81 + sidewalkWidth / 2]) {
            const end = Math.min(81, crossing - sidewalkWidth / 2);
            if (end > start)
              box(
                opaque,
                x + side * 5.6,
                0.025,
                (start + end) / 2,
                sidewalkWidth,
                0.12,
                end - start,
                sidewalkTone,
              );
            start = crossing + sidewalkWidth / 2;
          }
        }
      }
    if (roads)
      for (const z of [northRoad, southRoad]) {
        for (let x = -100; x < 140; x += 5)
          if (
            ![westRoad, eastRoad].some(
              (crossing) => Math.abs(x - crossing) < 11.35,
            )
          )
            box(opaque, x, 0.004, z, 2.7, 0.035, 0.1, "#a5a088");
        for (const side of [-1, 1])
          box(
            opaque,
            22,
            0.025,
            z + side * 5.6,
            155,
            0.12,
            sidewalkWidth,
            sidewalkTone,
          );
        for (const x of [westRoad, eastRoad])
          for (let stripe = 0; stripe < 7; stripe++) {
            box(
              opaque,
              x + 7.5,
              0.015,
              z - 3 + stripe,
              2,
              0.035,
              0.45,
              "#a0a59d",
            );
            box(
              opaque,
              x - 3 + stripe,
              0.015,
              z + 7.5,
              0.45,
              0.035,
              2,
              "#a0a59d",
            );
          }
      }
    // Near blocks have shopfronts, recessed windows, flat roofs and plant.
    // Distant blocks deliberately omit small window geometry.
    for (const [i, b] of city.blocks.entries()) {
      const height = b.stories * 3.15,
        palette = this.neighborTone(b.distant ? "#3e4b57" : b.color);
      if (this.themedStyle) {
        this.neighborLot(
          { x: b.x, z: b.y, w: b.w, d: b.d },
          height,
          i + 3,
          b.distant,
          opaque,
          signals,
        );
        continue;
      }
      box(opaque, b.x, height / 2, b.y, b.w, height, b.d, palette);
      box(
        opaque,
        b.x,
        height + 0.2,
        b.y,
        b.w + 0.25,
        0.45,
        b.d + 0.25,
        b.distant ? "#34424d" : "#384650",
      );
      box(
        opaque,
        b.x + b.w * 0.2,
        height + 0.7,
        b.y - b.d * 0.12,
        b.w * 0.26,
        1.05,
        b.d * 0.28,
        "#47525b",
      );
      if (b.distant) {
        // Sparse upper windows read as a broken power grid at skyline distance.
        if (i % 3 === 0)
          for (let j = 0; j < 4; j++)
            box(
              lit,
              b.x - b.w * 0.3 + j * 1.8,
              height - 4,
              b.y + b.d / 2 + 0.06,
              0.7,
              1,
              0.04,
              "#787c68",
            );
        continue;
      }
      box(opaque, b.x, 0.1, b.y, b.w + 2, 0.22, b.d + 2, "#737b77");
      for (let storey = 0; storey < b.stories; storey++) {
        const y = storey * 3.15 + 1.8;
        for (const side of [-1, 1]) {
          for (let dx = -b.w / 2 + 1.1; dx < b.w / 2 - 0.5; dx += 2.1) {
            if (side === 1 && storey === 0) continue;
            const hash = Math.floor((dx + 20) * 3) + storey * 7 + i * 11,
              litWindow = hash % 13 === 0,
              broken = b.damaged && hash % 4 === 0;
            box(
              litWindow ? lit : panes,
              b.x + dx,
              y,
              b.y + side * (b.d / 2 + 0.06),
              1.12,
              1.65,
              0.035,
              broken ? "#151f26" : litWindow ? "#b6aa7c" : "#385365",
            );
            if (broken)
              box(
                opaque,
                b.x + dx,
                y,
                b.y + side * (b.d / 2 + 0.1),
                0.08,
                1.4,
                0.04,
                "#84959a",
                0.4,
              );
          }
          for (let dz = -b.d / 2 + 1.1; dz < b.d / 2 - 0.5; dz += 2.1) {
            const litWindow = (Math.floor(dz + 20) + storey * 3 + i) % 14 === 0;
            box(
              litWindow ? lit : panes,
              b.x + side * (b.w / 2 + 0.06),
              y,
              b.y + dz,
              0.035,
              1.65,
              1.12,
              litWindow ? "#b5a778" : "#385365",
            );
          }
        }
      }
      // Shuttered storefronts and empty awnings carry an abandoned-city scale.
      for (let dx = -b.w / 2 + 1.8; dx < b.w / 2; dx += 3.4) {
        box(
          opaque,
          b.x + dx,
          1.1,
          b.y + b.d / 2 + 0.04,
          2.7,
          2.15,
          0.1,
          "#333f46",
        );
        box(
          opaque,
          b.x + dx,
          2.35,
          b.y + b.d / 2 + 0.35,
          2.9,
          0.18,
          0.8,
          i % 2 ? "#536256" : "#74574b",
        );
        if (b.damaged)
          for (const tilt of [-0.22, 0.28])
            this.part(
              opaque,
              new BoxGeometry(2.45, 0.18, 0.08)
                .rotateZ(tilt)
                .translate(b.x + dx, 1.15, b.y + b.d / 2 + 0.12),
              "#887453",
            );
      }
      if (b.damaged && i < 8) {
        // Static low-poly smoke stays outside the playable space and needs no
        // per-frame particles. The orange source is visible between blocks.
        box(
          signals,
          b.x - 2,
          0.55,
          b.y + b.d / 2 + 1.4,
          1.7,
          1.1,
          0.6,
          "#ad4626",
        );
        for (let puff = 0; puff < 8; puff++)
          this.part(
            opaque,
            new SphereGeometry(1.1 + puff * 0.24, 7, 5)
              .scale(1, 1.4, 0.8)
              .translate(
                b.x - 2 + puff * 0.38,
                2 + puff * 2.1,
                b.y + b.d / 2 + 1.4,
              ),
            puff < 3 ? "#252b2f" : "#39434a",
          );
      }
    }

    const car = (
      x: number,
      z: number,
      color: string,
      angle = 0,
      burned = false,
    ) => {
      const local = (
        out: BufferGeometry[],
        dx: number,
        y: number,
        dz: number,
        w: number,
        h: number,
        d: number,
        tint: string,
      ) =>
        box(
          out,
          x + dx * Math.cos(angle) + dz * Math.sin(angle),
          y,
          z - dx * Math.sin(angle) + dz * Math.cos(angle),
          w,
          h,
          d,
          tint,
          angle,
        );
      local(opaque, 0, 0.6, 0, 1.65, 0.65, 3.6, burned ? "#303534" : color);
      local(
        opaque,
        0,
        1.12,
        -0.15,
        1.4,
        0.65,
        1.85,
        burned ? "#282e2f" : color,
      );
      local(
        panes,
        0,
        1.21,
        -0.15,
        1.44,
        0.4,
        1.5,
        burned ? "#151c20" : "#2b454f",
      );
      for (const side of [-1, 1]) {
        for (const axle of [-1.15, 1.1])
          local(opaque, side * 0.78, 0.3, axle, 0.22, 0.6, 0.58, "#20282c");
        local(signals, side * 0.52, 0.69, 1.83, 0.27, 0.17, 0.04, "#6e3028");
      }
    };
    // Vehicles stopped in several directions: a collision at the cordon,
    // parked cars with no drivers, and a burned queue on the northern street.
    // A ground with no streets gets scattered stones in their place.
    if (!roads) {
      const emit = this.emitter(opaque, signals);
      for (let i = 0; i < 14; i++)
        neighborStone(
          city.left + 2 + i * 4.3,
          (i % 2 ? southRoad : northRoad) + ((i * 5) % 7) - 3,
          0.5 + (i % 3) * 0.35,
          this.look!.neighborColor,
          i,
          emit,
        );
    }
    for (let i = 0; i < (roads ? 6 : 0); i++) {
      car(
        city.left + 4 + i * 6,
        southRoad + (i % 2 ? 2 : -2),
        ["#65514c", "#63737a", "#74715d"][i % 3],
        i === 3 ? 0.37 : Math.PI / 2,
      );
      car(city.left + i * 7, northRoad - 2, "#52616c", Math.PI / 2, i > 2);
    }
    for (let i = 0; i < (roads ? 3 : 0); i++) {
      car(westRoad - 2, city.north + i * 11, "#596b64", i === 1 ? -0.2 : 0);
      car(eastRoad + 2, city.north + i * 11, "#685653", Math.PI);
    }

    // A deserted medical checkpoint. An open rear door, empty stretcher,
    // abandoned bags and interrupted direction signs tell what happened.
    const ax = city.left + 5,
      az = southRoad - 3;
    if (roads) {
      box(opaque, ax, 1.15, az, 2.05, 1.9, 4.3, "#b2b5aa");
      box(opaque, ax, 0.7, az - 2.35, 2, 0.9, 1, "#a6afa9");
      box(panes, ax, 1.4, az - 2.45, 1.8, 0.7, 0.85, "#345360");
      box(opaque, ax, 1.2, az + 2.17, 1.5, 1.6, 0.08, "#26353a");
      box(opaque, ax + 1.3, 1.2, az + 2.3, 0.8, 1.6, 0.1, "#b9baac", -0.9);
      for (const side of [-1, 1]) {
        box(
          signals,
          ax + side * 1.07,
          1.32,
          az + 0.2,
          0.025,
          0.7,
          0.22,
          "#ad4a3d",
        );
        for (const arm of [-1, 1])
          box(
            signals,
            ax + side * 1.07,
            1.32,
            az + 0.2 + arm * 0.23,
            0.025,
            0.22,
            0.24,
            "#ad4a3d",
          );
        for (const axle of [-1.35, 1.35])
          box(opaque, ax + side, 0.34, az + axle, 0.22, 0.65, 0.65, "#242c2d");
      }
      box(signals, ax - 0.5, 2.17, az - 1, 0.55, 0.16, 0.35, "#76413c");
      box(signals, ax + 0.5, 2.17, az - 1, 0.55, 0.16, 0.35, "#3f647f");
      box(opaque, ax + 2.2, 0.68, az + 2.3, 0.8, 0.16, 1.8, "#6e8580", 0.2);
      for (const side of [-1, 1])
        box(
          opaque,
          ax + 2.2 + side * 0.3,
          0.36,
          az + 2.3,
          0.05,
          0.6,
          1.4,
          "#687a7d",
        );

      // Evacuation bus stopped beyond the cordon; dark windows and a side impact.
      const bx = city.right - 6,
        bz = southRoad + 2;
      box(opaque, bx, 1.45, bz, 7.5, 2.4, 2.4, "#8c8162");
      box(opaque, bx, 2.72, bz, 7.65, 0.18, 2.45, "#77776d");
      for (let i = 0; i < 7; i++)
        for (const side of [-1, 1])
          box(
            panes,
            bx - 2.9 + i * 0.95,
            1.95,
            bz + side * 1.215,
            0.72,
            0.83,
            0.03,
            "#283d48",
          );
      for (const axle of [-2.5, 2.5])
        for (const side of [-1, 1])
          box(
            opaque,
            bx + axle,
            0.5,
            bz + side * 1.15,
            0.85,
            1,
            0.28,
            "#252c2d",
          );
    }

    const cordon = floor.tiles.length + 1.5;
    for (const x of [13, 17, 27, 31]) {
      box(opaque, x, 0.43, cordon, 2.8, 0.86, 0.75, "#838979", 0.08);
      for (let stripe = -1; stripe <= 1; stripe++)
        box(
          opaque,
          x + stripe * 0.72,
          0.52,
          cordon + 0.4,
          0.3,
          0.4,
          0.035,
          "#3e4947",
          0.08,
        );
    }
    for (let x = 11; x <= 33; x += 2.75) {
      box(opaque, x, 1.1, cordon + 0.6, 0.06, 2.2, 0.06, "#58696a");
      if (x < 32)
        for (const y of [0.45, 1, 1.55])
          box(opaque, x + 1.38, y, cordon + 0.6, 2.75, 0.025, 0.025, "#637371");
    }
    if (this.quarantineMaterial && !floor.environment) {
      const notice = new Mesh(
        new PlaneGeometry(5.2, 1.08),
        this.quarantineMaterial,
      );
      notice.position.set(22, 2.55, cordon + 0.54);
      notice.rotation.y = Math.PI;
      notice.name = "evacuation-suspended-sign";
      this.world.add(notice);
    }
    if (this.routeMaterial) {
      const route = new Mesh(new PlaneGeometry(2.6, 0.54), this.routeMaterial);
      route.position.set(18, 1.5, city.south + 0.04);
      route.name = "rooftop-assembly-sign";
      this.world.add(route);
    }
    for (let i = 0; i < 17; i++) {
      const x = 9 + i * 1.7,
        z = cordon - 0.7 + (i % 4) * 0.21;
      box(
        opaque,
        x,
        0.06,
        z,
        0.36,
        0.1,
        0.22,
        i % 3 ? "#9b9a81" : "#675c51",
        i * 0.7,
      );
      if (i % 4 === 0)
        box(opaque, x + 0.2, 0.22, z + 0.3, 0.48, 0.44, 0.3, "#485454", 0.13);
    }
    // Street lights retain a silhouette even where the power grid has failed.
    if (roads)
      for (const x of [westRoad + 5, eastRoad - 5])
        for (const z of [northRoad + 5, 16, southRoad - 5]) {
          box(opaque, x, 2.7, z, 0.12, 5.4, 0.12, "#4d5b64");
          box(opaque, x + 0.65, 5.46, z, 1.42, 0.12, 0.12, "#53626c");
          box(lit, x + 1.1, 5.355, z, 0.45, 0.07, 0.25, "#b7b88c");
        }
  }

  private buildPhysicalCity(
    floor: Floor,
    plan: CityPlan,
    opaque: BufferGeometry[],
    panes: BufferGeometry[],
    lit: BufferGeometry[],
    signals: BufferGeometry[],
  ) {
    const box = (
      out: BufferGeometry[],
      x: number,
      y: number,
      z: number,
      w: number,
      h: number,
      d: number,
      color: string,
    ) => this.part(out, new BoxGeometry(w, h, d).translate(x, y, z), color);
    this.buildGround(floor);
    const hash = (value: number) => {
      let v = Math.imul(value ^ plan.seed, 0x45d9f3b);
      v = Math.imul(v ^ (v >>> 16), 0x45d9f3b);
      return (v ^ (v >>> 16)) >>> 0;
    };
    const roads = roadGround(this.look?.ground),
      themed = !!this.themedStyle;
    for (const [i, block] of cityBackdrop(floor).entries()) {
      const height = block.stories * 3.15;
      if (themed) {
        this.neighborLot(
          { x: block.x, z: block.y, w: block.w, d: block.d },
          height,
          hash(i + 211),
          true,
          opaque,
          signals,
        );
        continue;
      }
      box(
        opaque,
        block.x,
        height / 2,
        block.y,
        block.w,
        height,
        block.d,
        this.neighborTone(block.color),
      );
      box(
        opaque,
        block.x,
        height + 0.45,
        block.y,
        block.w * 0.38,
        0.9,
        block.d * 0.48,
        "#34434b",
      );
      for (let band = 0; band < 3; band++)
        if ((i + band) % 3 === 0) {
          box(
            lit,
            block.x,
            height * (0.35 + band * 0.2),
            block.y + block.d / 2 + 0.035,
            block.w * 0.65,
            0.8,
            0.035,
            "#9b9474",
          );
          box(
            lit,
            block.x + block.w / 2 + 0.035,
            height * (0.4 + band * 0.16),
            block.y,
            0.035,
            0.8,
            block.d * 0.55,
            "#879282",
          );
        }
    }
    // A continuous physical block gets several adjoining addresses and roof
    // heights, never painted gaps that suggest an unwalkable alley is open.
    let address = 0;
    const signParts: BufferGeometry[] = [];
    const facade = (o: CityObstacle) => {
      // A physical-city facade never grows over a real site, stamped ones too.
      if (!neighbourLotAllowed({ x: o.x, y: o.y, w: o.w, d: o.h }, this.sites))
        return;
      const addresses: { x: number; z: number; w: number; d: number }[] = [],
        depth = Math.min(6, o.h / 2),
        sideDepth = Math.min(6, o.w / 2),
        across = Math.max(1, Math.ceil(o.w / 18));
      if (o.w > 2 * sideDepth && o.h > 2 * depth)
        box(
          opaque,
          o.x,
          3,
          o.y,
          o.w - 2 * sideDepth,
          6,
          o.h - 2 * depth,
          "#37454b",
        );
      for (const side of [-1, 1])
        for (let j = 0; j < across; j++)
          addresses.push({
            x: o.x - o.w / 2 + (o.w / across) * (j + 0.5),
            z: o.y + side * (o.h / 2 - depth / 2),
            w: o.w / across,
            d: depth,
          });
      const along = Math.max(1, Math.ceil((o.h - 2 * depth) / 18));
      if (o.h > 2 * depth)
        for (const side of [-1, 1])
          for (let j = 0; j < along; j++)
            addresses.push({
              x: o.x + side * (o.w / 2 - sideDepth / 2),
              z:
                o.y - o.h / 2 + depth + ((o.h - 2 * depth) / along) * (j + 0.5),
              w: sideDepth,
              d: (o.h - 2 * depth) / along,
            });
      for (const [j, part] of addresses.entries()) {
        if (this.pads.some((pad) => overlapsPad(pad, part))) {
          // A scenery bed replaces the address: a low solid plinth that the
          // lot's collision box already explains.
          neighborPlinth(
            { x: part.x, z: part.z, w: part.w, d: part.d },
            this.look!.neighborColor,
            this.emitter(opaque, signals),
          );
          continue;
        }
        const { w, d, x, z } = part,
          id = address++,
          roll = hash(id + 13),
          height = Math.max(7, o.height * (0.62 + (roll % 39) / 100)),
          near =
            Math.hypot(
              Math.max(0, Math.abs(x - 22) - w / 2),
              Math.max(0, Math.abs(z - 25) - d / 2),
            ) < 95;
        box(opaque, x, height / 2, z, w, height, d, this.neighborTone(o.color));
        box(opaque, x, height + 0.15, z, w, 0.3, d, "#34434b");
        if (w > 5 && d > 5)
          box(
            opaque,
            x + w * 0.19,
            height + 0.65,
            z - d * 0.18,
            Math.min(4, w * 0.25),
            1,
            Math.min(3, d * 0.3),
            "#45545c",
          );
        // Window budget depends on nearby addresses, rather than city runway.
        if (!near) continue;
        const floors = Math.min(9, Math.floor(height / 3.15)),
          xStep = Math.max(2.5, w / 9),
          zStep = Math.max(2.5, d / 9);
        for (let level = 0; level < floors; level++) {
          const y = 1.8 + level * 3.15;
          for (const side of [-1, 1]) {
            for (let dx = -w / 2 + 1.2; dx < w / 2 - 0.7; dx += xStep) {
              const broken =
                  o.damaged &&
                  hash(id * 31 + level * 13 + Math.floor(dx * 7)) % 5 === 0,
                powered =
                  !broken &&
                  hash(id * 17 + level + Math.floor(dx * 9)) % 17 === 0;
              box(
                powered ? lit : panes,
                x + dx,
                y,
                z + side * (d / 2 + 0.035),
                Math.min(1.25, xStep * 0.55),
                1.65,
                0.035,
                broken ? "#111b21" : powered ? "#d9bc83" : "#304b5a",
              );
              if (broken)
                box(
                  opaque,
                  x + dx,
                  y,
                  z + side * (d / 2 + 0.07),
                  1.2,
                  0.12,
                  0.045,
                  "#827665",
                );
            }
            for (let dz = -d / 2 + 1.2; dz < d / 2 - 0.7; dz += zStep) {
              const powered =
                hash(id * 13 + level + Math.floor(dz * 11)) % 19 === 0;
              box(
                powered ? lit : panes,
                x + side * (w / 2 + 0.035),
                y,
                z + dz,
                0.035,
                1.65,
                Math.min(1.25, zStep * 0.55),
                powered ? "#c6ab7e" : "#304957",
              );
            }
          }
        }
        if (w > 5) {
          for (let dx = -w / 2 + 2; dx < w / 2 - 1; dx += Math.max(4, w / 5)) {
            box(
              opaque,
              x + dx,
              1.1,
              z + d / 2 + 0.05,
              2.8,
              2.1,
              0.1,
              "#29363d",
            );
            box(
              opaque,
              x + dx,
              2.35,
              z + d / 2 + 0.4,
              3,
              0.2,
              0.8,
              (roll + j) % 2 ? "#665547" : "#4c625a",
            );
          }
        }
        const clamp = (n: number, lo: number, hi: number) =>
            Math.max(lo, Math.min(n, hi)),
          faces = [
            {
              x: x - w / 2 - 0.06,
              z: clamp(35, z - d / 2 + 1.8, z + d / 2 - 1.8),
              nx: -1,
              nz: 0,
              span: d,
            },
            {
              x: x + w / 2 + 0.06,
              z: clamp(35, z - d / 2 + 1.8, z + d / 2 - 1.8),
              nx: 1,
              nz: 0,
              span: d,
            },
            {
              x: clamp(22, x - w / 2 + 1.8, x + w / 2 - 1.8),
              z: z - d / 2 - 0.06,
              nx: 0,
              nz: -1,
              span: w,
            },
            {
              x: clamp(22, x - w / 2 + 1.8, x + w / 2 - 1.8),
              z: z + d / 2 + 0.06,
              nx: 0,
              nz: 1,
              span: w,
            },
          ];
        for (const face of faces) {
          if (
            face.span < 3.8 ||
            cityWall(
              floor,
              face.x + face.nx * 0.15,
              face.z + face.nz * 0.15,
            ) !== false
          )
            continue;
          const { nx, nz } = face,
            entry = hash(id + 83) % 4;
          // Closed shutters, cafe glazing and delivery doors face the actual
          // street; no hollow shop or hidden passable opening is implied.
          box(
            entry === 1 ? panes : opaque,
            face.x,
            1.15,
            face.z,
            nx ? 0.055 : 3.1,
            2.1,
            nz ? 0.055 : 3.1,
            entry === 1 ? "#304d54" : "#3a4645",
          );
          if (entry !== 1)
            for (let stripe = 0; stripe < 7; stripe++)
              box(
                opaque,
                face.x + nx * 0.025,
                0.4 + stripe * 0.25,
                face.z + nz * 0.025,
                nx ? 0.035 : 2.95,
                0.035,
                nz ? 0.035 : 2.95,
                "#68716a",
              );
          box(
            opaque,
            face.x + nx * 0.2,
            2.45,
            face.z + nz * 0.2,
            nx ? 0.55 : 3.4,
            0.16,
            nz ? 0.55 : 3.4,
            entry % 2 ? "#725844" : "#4d6258",
          );
          if (floor.environment) continue;
          const sign = new PlaneGeometry(3.05, 0.6),
            uv = sign.getAttribute("uv"),
            row = hash(id + 41) % 8;
          for (let v = 0; v < uv.count; v++)
            uv.setY(v, (7 - row + uv.getY(v)) / 8);
          sign
            .rotateY(Math.atan2(nx, nz))
            .translate(face.x + nx * 0.055, 2.05, face.z + nz * 0.055);
          this.part(signParts, sign, "#ffffff");
          if (id % 3 === 0) {
            const street = new PlaneGeometry(2.5, 0.38),
              uv = street.getAttribute("uv"),
              row = id % 2 ? 1 : 7;
            for (let v = 0; v < uv.count; v++)
              uv.setY(v, (7 - row + uv.getY(v)) / 8);
            street
              .rotateY(Math.atan2(nx, nz))
              .translate(face.x + nx * 0.04, 3.05, face.z + nz * 0.04);
            this.part(signParts, street, "#ffffff");
          }
        }
      }
    };
    for (const [index, o] of plan.obstacles.entries()) {
      // The real concrete wedge and supported treads belong to StairGallery.
      // Its exact footprint is still a solid urban obstacle for flat walkers.
      if (o.kind === "stair-base") continue;
      if (themed && o.kind === "building") {
        this.neighborLot(
          { x: o.x, z: o.y, w: o.w, d: o.h },
          o.height,
          hash(index + 5),
          Math.hypot(o.x - 22, o.y - 30) > 120,
          opaque,
          signals,
        );
        continue;
      }
      if (!roads && o.kind !== "building") {
        // Wrecks and rubble are boulders where there are no streets to park on.
        this.neighborLot(
          { x: o.x, z: o.y, w: o.w, d: o.h },
          Math.min(o.height, 6),
          hash(index + 9),
          Math.hypot(o.x - 22, o.y - 30) > 120,
          opaque,
          signals,
          "rocks",
        );
        continue;
      }
      if (o.kind === "building") {
        facade(o);
        for (const face of [
          { x: o.x - o.w / 2 - 0.6, z: o.y, nx: -1, nz: 0, span: o.h },
          { x: o.x + o.w / 2 + 0.6, z: o.y, nx: 1, nz: 0, span: o.h },
          { x: o.x, z: o.y - o.h / 2 - 0.6, nx: 0, nz: -1, span: o.w },
          { x: o.x, z: o.y + o.h / 2 + 0.6, nx: 0, nz: 1, span: o.w },
        ])
          if (
            roads &&
            face.span > 3 &&
            cityWall(floor, face.x, face.z) === false
          ) {
            // Low curb paving remains walkable; stop short of intersections so
            // two strips never put coplanar top faces over the same corner.
            for (
              let start = -face.span / 2 + 1.2;
              start < face.span / 2 - 1.2;
              start += 2.1
            ) {
              const length = Math.min(2.075, face.span / 2 - 1.2 - start),
                joint = start + length / 2;
              box(
                opaque,
                face.x + (face.nz ? joint : 0),
                0.015,
                face.z + (face.nx ? joint : 0),
                face.nx ? 1.16 : length,
                0.12,
                face.nz ? 1.16 : length,
                "#68716e",
              );
            }
          }
        continue;
      }
      if (o.kind === "vehicle") {
        if (o.height < 2) {
          box(opaque, o.x, 0.48, o.y, o.w, 0.65, o.h, o.color);
          box(
            opaque,
            o.x,
            1.07,
            o.y - 0.2,
            o.w * 0.85,
            0.55,
            o.h * 0.52,
            o.damaged ? "#303b3e" : o.color,
          );
          box(
            panes,
            o.x,
            1.15,
            o.y - 0.2,
            o.w * 0.87,
            0.35,
            o.h * 0.41,
            "#203740",
          );
          for (const side of [-1, 1]) {
            for (const axle of [-0.3, 0.3])
              box(
                opaque,
                o.x + side * o.w * 0.46,
                0.27,
                o.y + axle * o.h,
                0.2,
                0.48,
                0.55,
                "#20292b",
              );
            box(
              signals,
              o.x + side * o.w * 0.3,
              0.59,
              o.y + o.h / 2 + 0.025,
              0.25,
              0.12,
              0.04,
              "#793c2f",
            );
          }
          if (o.damaged)
            box(opaque, o.x, 0.58, o.y - o.h / 2, 1.3, 0.18, 0.05, "#242b2d");
          continue;
        }
        // Burned service truck, delivery container and crushed cars make a
        // complete physical street cap rather than a transparent map rail.
        box(opaque, o.x, 0.7, o.y, o.w, 1.4, o.h, "#343d3b");
        box(opaque, o.x, 2.05, o.y, o.w * 0.96, 1.3, o.h * 0.94, o.color);
        for (let x = -o.w / 2 + 0.7; x < o.w / 2; x += 1.3)
          box(
            panes,
            o.x + x,
            2.15,
            o.y + o.h / 2 + 0.02,
            0.85,
            0.55,
            0.045,
            "#17272e",
          );
        for (const side of [-1, 1])
          for (let z = -o.h / 2 + 1; z < o.h / 2; z += 2.6)
            box(
              opaque,
              o.x + (side * o.w) / 2,
              0.45,
              o.y + z,
              0.25,
              0.8,
              0.75,
              "#1c2529",
            );
      } else {
        box(opaque, o.x, 0.75, o.y, o.w, 1.5, o.h, o.color);
        const lumps = Math.min(
          12,
          Math.max(3, Math.ceil(Math.max(o.w, o.h) / 2)),
        );
        for (let j = 0; j < lumps; j++) {
          const along = (j + 0.5) / lumps - 0.5,
            x = o.x + (o.w >= o.h ? along * o.w : 0),
            z = o.y + (o.h > o.w ? along * o.h : 0);
          this.part(
            opaque,
            new ConeGeometry(
              Math.min(1.8, Math.min(o.w, o.h) * 0.7),
              o.height,
              5,
            )
              .rotateY((hash(index + j) % 10) * 0.2)
              .translate(x, o.height / 2, z),
            j % 2 ? "#63605a" : "#77756a",
          );
        }
      }
    }
    if (signParts.length) {
      const atlas = document.createElement("canvas");
      atlas.width = 768;
      atlas.height = 768;
      const c = atlas.getContext("2d")!,
        labels = (floor.exteriorDesign && "streetLabels" in floor.exteriorDesign
          ? floor.exteriorDesign.streetLabels
          : undefined) ?? [
          "LARK PHARMACY  •  CLOSED",
          "MERCER AVENUE",
          "NORTHSIDE CAFÉ",
          "HARBOUR LOGISTICS",
          "NO STREET EVACUATION",
          "ROOFTOP ASSEMBLY ↑",
          "MISSING • CALL CIVIC DESK",
          "CIVIC SQUARE  •  06:40",
        ],
        colors = [
          "#315449",
          "#4c514b",
          "#655141",
          "#334d5b",
          "#655a32",
          "#4e5d42",
          "#5d463c",
          "#37525c",
        ];
      for (let row = 0; row < 8; row++) {
        c.fillStyle = colors[row];
        c.fillRect(0, row * 96, 768, 96);
        c.strokeStyle = "#b4b496";
        c.strokeRect(5, row * 96 + 5, 758, 86);
        c.fillStyle = "#dbd7b8";
        c.textAlign = "center";
        c.font = "bold 34px sans-serif";
        c.fillText(labels[row], 384, row * 96 + 60, 735);
      }
      const map = new CanvasTexture(atlas);
      map.colorSpace = SRGBColorSpace;
      const material = new MeshBasicMaterial({
        map,
        vertexColors: true,
        fog: true,
      });
      this.merge(signParts, material, "city-shopfront-signs");
      this.shopSigns = this.world.getObjectByName(
        "city-shopfront-signs",
      ) as Mesh<BufferGeometry, MeshBasicMaterial>;
    }
    // Flush paint is a guide, not a collision edge. Crossings share asphalt.
    for (const approach of roads ? plan.approaches : [])
      for (let i = 1; i < approach.points.length; i++) {
        const a = approach.points[i - 1],
          b = approach.points[i],
          distance = Math.hypot(b.x - a.x, b.y - a.y),
          horizontal = Math.abs(b.x - a.x) > Math.abs(b.y - a.y);
        for (let n = 5; n < distance - 5; n += 8) {
          const t = n / distance;
          box(
            opaque,
            a.x + (b.x - a.x) * t,
            0.004,
            a.y + (b.y - a.y) * t,
            horizontal ? 3.2 : 0.1,
            0.025,
            horizontal ? 0.1 : 3.2,
            "#a29c7d",
          );
        }
      }
    const pools: BufferGeometry[] = [];
    for (const [routeIndex, approach] of plan.approaches.entries()) {
      const corner = approach.points[1],
        towards = approach.points[2],
        length = Math.hypot(towards.x - corner.x, towards.y - corner.y),
        dx = (towards.x - corner.x) / length,
        dz = (towards.y - corner.y) / length,
        nx = -dz,
        nz = dx,
        width = Math.min(
          ...plan.roads
            .filter((r) =>
              inCityRectangle(r, corner.x + dx * 5, corner.y + dz * 5),
            )
            .map((r) => Math.min(r.w, r.h)),
        ),
        wallX = corner.x - dx * (width / 2 - 0.035),
        wallZ = corner.y - dz * (width / 2 - 0.035);
      // Illuminated depot shutters backlight actual distant walkers. At three
      // hundred metres the crowd is small, but never disappears into black.
      box(
        signals,
        wallX,
        1.4,
        wallZ,
        Math.abs(nx) * (width - 0.4) + 0.045,
        2.6,
        Math.abs(nz) * (width - 0.4) + 0.045,
        "#b7a67a",
      );
      for (let n = 0; n < 5; n++)
        box(
          opaque,
          wallX + dx * 0.045,
          0.35 + n * 0.52,
          wallZ + dz * 0.045,
          Math.abs(nx) * (width - 0.4) + 0.06,
          0.035,
          Math.abs(nz) * (width - 0.4) + 0.06,
          "#5a5745",
        );
      // The hidden feeder is a real roofed logistics arcade. New arrivals are
      // physically under its opaque roof before they turn onto the avenue.
      const spawn = approach.points[0],
        feedLength = Math.hypot(corner.x - spawn.x, corner.y - spawn.y),
        fx = (corner.x - spawn.x) / feedLength,
        fz = (corner.y - spawn.y) / feedLength;
      box(
        opaque,
        spawn.x + fx * 1.5,
        3.45,
        spawn.y + fz * 1.5,
        Math.abs(fx) * 3 + width + 0.6,
        0.35,
        Math.abs(fz) * 3 + width + 0.6,
        "#35434a",
      );
      box(
        lit,
        spawn.x + fx * 3.1,
        3.24,
        spawn.y + fz * 3.1,
        Math.abs(fz) * (width - 0.4) + 0.12,
        0.08,
        Math.abs(fx) * (width - 0.4) + 0.12,
        "#948866",
      );
      // Bounded practical fittings repeat along the long street. The poles
      // stand within the adjoining solid addresses, leaving the full road free.
      for (let n = 18; n < (roads ? length - 12 : 0); n += 24) {
        const x = corner.x + dx * n + nx * (width / 2 + 0.12),
          z = corner.y + dz * n + nz * (width / 2 + 0.12);
        box(opaque, x, 2.75, z, 0.12, 5.5, 0.12, "#4f6068");
        box(
          opaque,
          x - nx * 0.7,
          5.55,
          z - nz * 0.7,
          Math.abs(nx) * 1.5 + 0.12,
          0.12,
          Math.abs(nz) * 1.5 + 0.12,
          "#52636a",
        );
        if ((Math.floor(n / 24) + routeIndex) % 4 !== 1) {
          box(
            lit,
            x - nx * 1.15,
            5.45,
            z - nz * 1.15,
            0.42,
            0.075,
            0.42,
            (Math.floor(n / 24) + routeIndex) % 2 ? "#b9c9c6" : "#d4b787",
          );
          this.part(
            pools,
            new PlaneGeometry(width * 1.2, 17)
              .rotateX(-Math.PI / 2)
              .rotateY(Math.atan2(dx, dz))
              .translate(corner.x + dx * n, 0.028, corner.y + dz * n),
            (Math.floor(n / 24) + routeIndex) % 2 ? "#668a94" : "#9b8755",
          );
        }
      }
    }
    if (pools.length) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 64;
      const c = canvas.getContext("2d")!,
        gradient = c.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, "rgba(255,255,255,.6)");
      gradient.addColorStop(0.55, "rgba(255,255,255,.3)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = gradient;
      c.fillRect(0, 0, 64, 64);
      const map = new CanvasTexture(canvas),
        material = new MeshBasicMaterial({
          map,
          transparent: true,
          opacity: 0.3,
          vertexColors: true,
          blending: AdditiveBlending,
          depthWrite: false,
          fog: true,
        });
      this.merge(pools, material, "street-light-pools");
      this.lightPools = this.world.getObjectByName(
        "street-light-pools",
      ) as Mesh<BufferGeometry, MeshBasicMaterial>;
    }
    // A few powered lamps among failed fittings mark the boulevard. Their
    // poles are embedded just inside the real building collision face.
    const nearBuildings = plan.obstacles.filter(
      (o) =>
        o.kind === "building" &&
        Math.hypot(
          Math.max(0, Math.abs(o.x - 22) - o.w / 2),
          Math.max(0, Math.abs(o.y - 30) - o.h / 2),
        ) < 90 &&
        o.w > 3 &&
        o.h > 3,
    );
    for (const [i, o] of (roads ? nearBuildings.slice(0, 12) : []).entries()) {
      const x = o.x - o.w / 2 + 0.12,
        z = o.y - o.h / 2 + 0.15;
      box(opaque, x, 2.5, z, 0.13, 5, 0.13, "#4f6068");
      box(opaque, x - 0.65, 5.05, z, 1.4, 0.13, 0.13, "#4a5a63");
      if (i % 3 !== 1)
        box(
          lit,
          x - 1.1,
          4.95,
          z,
          0.5,
          0.07,
          0.3,
          i % 2 ? "#c8b17a" : "#aec3c5",
        );
    }
    const door = floor.furniture.find((o) => o.id === "main-gate"),
      entrance = door?.x ?? 22,
      front = floor.boundary!.bottom,
      route = new Mesh(new PlaneGeometry(2.6, 0.54), this.routeMaterial),
      suspended = new Mesh(
        new PlaneGeometry(3.2, 0.65),
        this.quarantineMaterial,
      );
    route.name = "rooftop-assembly-sign";
    route.position.set(entrance - 3, 1.7, front + 1.06);
    suspended.name = "evacuation-suspended-sign";
    suspended.position.set(entrance + 4, 1.8, front + 1.06);
    this.world.add(route);
    if (!floor.environment) this.world.add(suspended);
    else suspended.geometry.dispose();
    this.streetLight.position.set(entrance, 5.2, front + 13);
    this.streetLight.intensity = 32;
    this.streetLight.distance = 28;
    this.entranceLight.intensity = 24;
    this.entranceLight.distance = 12;
    this.incidents = [];
    for (const o of nearBuildings.sort(
      (a, b) => Math.hypot(a.x - 22, a.y - 35) - Math.hypot(b.x - 22, b.y - 35),
    )) {
      const clamp = (n: number, lo: number, hi: number) =>
          Math.max(lo, Math.min(n, hi)),
        candidates = [
          {
            x: o.x - o.w / 2 - 0.09,
            z: clamp(front + 7, o.y - o.h / 2 + 0.6, o.y + o.h / 2 - 0.6),
            nx: -1,
            nz: 0,
          },
          {
            x: o.x + o.w / 2 + 0.09,
            z: clamp(front + 7, o.y - o.h / 2 + 0.6, o.y + o.h / 2 - 0.6),
            nx: 1,
            nz: 0,
          },
          {
            x: clamp(22, o.x - o.w / 2 + 0.6, o.x + o.w / 2 - 0.6),
            z: o.y - o.h / 2 - 0.09,
            nx: 0,
            nz: -1,
          },
          {
            x: clamp(22, o.x - o.w / 2 + 0.6, o.x + o.w / 2 - 0.6),
            z: o.y + o.h / 2 + 0.09,
            nx: 0,
            nz: 1,
          },
        ]
          .filter((p) => cityWall(floor, p.x, p.z) === false)
          .sort(
            (a, b) =>
              Math.hypot(a.x - 22, a.z - 35) - Math.hypot(b.x - 22, b.z - 35),
          ),
        face = candidates[0];
      if (!face) continue;
      const { x, z, nx, nz } = face;
      if (this.incidents.some((p) => Math.hypot(p.x - x, p.z - z) < 14))
        continue;
      this.incidents.push({
        x,
        y: 0.5,
        z,
        seed: hash(this.incidents.length + 39),
        nx,
        nz,
      });
      if (!themed)
        box(
          opaque,
          x - nx * 0.06,
          0.85,
          z - nz * 0.06,
          nx ? 0.05 : 1.8,
          1.7,
          nz ? 0.05 : 1.8,
          "#202c2b",
        );
      box(
        signals,
        x,
        0.25,
        z,
        nx ? 0.045 : 0.7,
        0.12,
        nz ? 0.045 : 0.7,
        "#9c4b22",
      );
      if (this.incidents.length === 3) break;
    }
    this.buildParticles();
  }

  private buildParticles() {
    if (!this.incidents.length) return;
    const smokeGeometry = new BufferGeometry(),
      fireGeometry = new BufferGeometry();
    smokeGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(
        new Float32Array(this.incidents.length * 24 * 3),
        3,
      ),
    );
    fireGeometry.setAttribute(
      "position",
      new Float32BufferAttribute(
        new Float32Array(this.incidents.length * 18 * 3),
        3,
      ),
    );
    const sprite = document.createElement("canvas");
    sprite.width = sprite.height = 32;
    const c = sprite.getContext("2d")!,
      gradient = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    gradient.addColorStop(0, "rgba(255,255,255,1)");
    gradient.addColorStop(0.5, "rgba(255,255,255,.5)");
    gradient.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = gradient;
    c.fillRect(0, 0, 32, 32);
    const texture = new CanvasTexture(sprite);
    this.smoke = new Points(
      smokeGeometry,
      new PointsMaterial({
        map: texture,
        color: "#43505a",
        size: 2.9,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    const flameCanvas = document.createElement("canvas");
    flameCanvas.width = 64;
    flameCanvas.height = 96;
    const flameContext = flameCanvas.getContext("2d")!,
      flameGradient = flameContext.createRadialGradient(32, 48, 0, 32, 48, 36);
    flameGradient.addColorStop(0, "rgba(255,241,185,.9)");
    flameGradient.addColorStop(0.25, "rgba(255,185,65,.75)");
    flameGradient.addColorStop(0.6, "rgba(224,87,20,.3)");
    flameGradient.addColorStop(1, "rgba(174,48,10,0)");
    flameContext.fillStyle = flameGradient;
    flameContext.fillRect(0, 0, 64, 96);
    this.flames = new Points(
      fireGeometry,
      new PointsMaterial({
        map: new CanvasTexture(flameCanvas),
        color: "#ffbd6b",
        size: 0.65,
        transparent: true,
        opacity: 0.64,
        blending: AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.smoke.name = "incident-smoke-particles";
    this.flames.name = "incident-fire-particles";
    this.world.add(this.smoke, this.flames);
    const first = this.incidents[0];
    this.fireLight.position.set(first.x, 1.4, first.z);
    this.update(0, true);
  }

  /** Analytic ages recycle a fixed particle pool; no emission arrays grow. */
  update(
    time: number,
    reducedMotion = false,
    view?: { x: number; y: number; z: number; exposed: boolean },
  ) {
    // A stamped site changes the outside; the cache key includes the shells so
    // this rebuilds exactly once, even when the city plan itself is unchanged.
    if (
      this.dressedFloors &&
      this.dressedFloor &&
      exteriorSignature(this.dressedFloors) !== this.siteKey
    )
      this.build(this.dressedFloor, this.dressedFloors);
    // Weather follows the viewer and fades out indoors.
    if (this.weather?.active)
      this.weather.update(
        time,
        view ?? { x: 22, y: 1.6, z: 30, exposed: false },
        reducedMotion,
      );
    if (!this.incidents?.length || !this.smoke || !this.flames) return;
    const clock = reducedMotion ? 0 : time,
      smoke = this.smoke.geometry.getAttribute("position"),
      flames = this.flames.geometry.getAttribute("position");
    for (let i = 0; i < smoke.count; i++) {
      const origin = this.incidents[Math.floor(i / 24)],
        phase = (i % 24) / 24,
        age = (clock * 0.08 + phase + (origin.seed % 997) / 997) % 1,
        angle = i * 2.39996 + clock * 0.13;
      smoke.setXYZ(
        i,
        origin.x +
          origin.nx * (0.15 + age * 1.1) +
          age * 1.5 +
          Math.cos(angle) * (0.2 + age),
        origin.y + 0.6 + age * 11,
        origin.z +
          origin.nz * (0.15 + age * 1.1) +
          Math.sin(angle) * (0.3 + age * 0.8),
      );
    }
    for (let i = 0; i < flames.count; i++) {
      const origin = this.incidents[Math.floor(i / 18)],
        age = (clock * 0.7 + (i % 18) / 18) % 1,
        angle = i * 2.39996;
      flames.setXYZ(
        i,
        origin.x + origin.nx * 0.3 + Math.cos(angle) * (1 - age) * 0.25,
        origin.y + age * 1.5,
        origin.z + origin.nz * 0.3 + Math.sin(angle) * (1 - age) * 0.35,
      );
    }
    smoke.needsUpdate = flames.needsUpdate = true;
    this.smoke.geometry.computeBoundingSphere();
    this.flames.geometry.computeBoundingSphere();
    this.fireLight.intensity = reducedMotion
      ? 4
      : 4.2 + Math.sin(time * 1.7) * 0.45 + Math.sin(time * 2.3) * 0.2;
  }

  private part(out: BufferGeometry[], geometry: BufferGeometry, color: string) {
    this.tint.set(color);
    const count = geometry.getAttribute("position").count,
      colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = this.tint.r;
      colors[i * 3 + 1] = this.tint.g;
      colors[i * 3 + 2] = this.tint.b;
    }
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    out.push(geometry);
  }

  private merge(
    parts: BufferGeometry[],
    material: MeshStandardMaterial | MeshBasicMaterial,
    name: string,
  ) {
    if (!parts.length) return;
    const geometry = mergeGeometries(parts)!;
    for (const part of parts) part.dispose();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.receiveShadow = true;
    this.world.add(mesh);
  }

  private clear() {
    this.environmentSurfaces?.dispose();
    this.environmentSurfaces = undefined;
    this.shopSigns?.material.map?.dispose();
    this.shopSigns?.material.dispose();
    this.shopSigns = undefined;
    this.lightPools?.material.map?.dispose();
    this.lightPools?.material.dispose();
    this.lightPools = undefined;
    this.smoke?.material.map?.dispose();
    this.smoke?.material.dispose();
    this.flames?.material.map?.dispose();
    this.flames?.material.dispose();
    this.smoke = this.flames = undefined;
    this.pathMaterial?.dispose();
    this.pathMaterial = undefined;
    this.pads = [];
    this.icePieces = [];
    this.incidents = [];
    if (this.fireLight) this.fireLight.intensity = 0;
    while (this.world.children.length) {
      const mesh = this.world.children[0] as Mesh<BufferGeometry>;
      mesh.geometry.dispose();
      mesh.removeFromParent();
    }
  }

  dispose() {
    this.clear();
    this.sky.geometry.dispose();
    this.moon.geometry.dispose();
    this.weather?.dispose();
    this.iceMaterial?.dispose();
    for (const texture of this.groundTextures?.values() ?? [])
      texture.dispose();
    this.groundTextures?.clear();
    this.asphaltMap?.dispose();
    this.asphalt.map = null;
    this.signMaterial.map?.dispose();
    this.quarantineMaterial.map?.dispose();
    this.routeMaterial.map?.dispose();
    for (const material of [
      this.asphalt,
      this.solid,
      this.glass,
      this.warm,
      this.signMaterial,
      this.quarantineMaterial,
      this.routeMaterial,
      this.emergency,
      this.canopyMaterial,
      this.skyMaterial,
      this.moonMaterial,
    ])
      material.dispose();
    this.group.removeFromParent();
  }
}
