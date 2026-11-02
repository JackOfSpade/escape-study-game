import {
  ACESFilmicToneMapping,
  BoxGeometry,
  BufferGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  OctahedronGeometry,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Scene,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { doorFrame } from "../doors";
import { human } from "../engine";
import { doorLeaves, doorSeeThrough, doorStyle } from "../door-style";
import { fieldAllows } from "../force-fields";
import { floorSectors } from "../floor-plan";
import {
  CONFIG,
  H,
  W,
  type Actor,
  type Floor,
  type Furniture,
  type FurnitureKind,
  type Game,
  type Item,
  type Point,
  type Station,
  type Zombie,
} from "../model";
import { floorZone } from "../office-art";
import { mutation, normal } from "../render";
import { stairwell } from "../stairwell";
import { npcSpeechBubble, speechLines } from "../speech-bubbles";
import { playerCanSee, sightRadius } from "../visibility";
import {
  GeometryChangeCache,
  geometrySignature,
  wallRectangles,
} from "./geometry";
import { InstancePool } from "./instances";
import { furnitureHeight } from "./furniture-height";
import { lootSlot } from "./targeting";
import { AdaptiveResolution } from "./resolution";
import { GpuTimer } from "./gpu-timer";
import {
  createMotion,
  setLimbPose,
  panelIsLit,
  updateMotion,
  zombieStrike,
  type Motion,
} from "./animation";
import { floorTexture, type FloorFinish } from "./textures";
import { BuildingShell, isPerimeterWall } from "./building";
import { StairGallery } from "./stair-gallery";
import { InteriorAtmosphere } from "./interior-atmosphere";
import { FLOOR_HEIGHT, sampleStairRoute } from "../stair-route";
import {
  ExteriorDressing,
  exteriorWallTiles,
  outsideBuilding,
} from "./exterior";

type Tint = "body" | "edge" | "dark" | "metal" | "screen" | "skin" | "leaf";
function parsedPalette(palette: typeof normal) {
  return {
    wall: new Color(palette.wall),
    edge: new Color(palette.edge),
    ink: new Color(palette.ink),
    accent: new Color(palette.accent),
    terminal: new Color(palette.terminal),
    danger: new Color(palette.danger),
    furniture: new Color(palette.furniture),
    sky: new Color(palette.sky),
    dim: new Color(palette.dim),
    metal: new Color("#a3afb1"),
    leaf: new Color("#6c8d59"),
    skin: new Color("#c2c5ac"),
    zombieSkin: new Color("#91a86b"),
    zombieBody: new Color("#3f5141"),
    zombieEye: new Color("#bdc98b"),
    trousers: new Color("#283b43"),
    shirt: new Color("#739dac"),
    allowed: new Color("#55ef9b"),
    blocked: new Color("#ff6274"),
    medkit: new Color("#e5ece5"),
    wood: new Color(palette === normal ? "#8a6a4a" : "#9a6a5c"),
    fabric: new Color(palette === normal ? "#55667a" : "#7a5670"),
    white: new Color(palette === normal ? "#c2c8c4" : "#cdbbb0"),
    pot: new Color("#a2583a"),
  };
}
const PALETTES = {
  normal: parsedPalette(normal),
  mutation: parsedPalette(mutation),
};
type Palette = ReturnType<typeof parsedPalette>;
const DOOR_OPEN_ANGLE = Math.PI * 0.55;
type Batch = "box" | "head" | "screen" | "field" | "panel" | "eye";
interface Part {
  batch: Batch;
  slot: number;
  x: number;
  y: number;
  z: number;
  w: number;
  h: number;
  d: number;
  tint: Tint;
  anchor?: "frame";
  role?:
    "bar" | "pane" | "debris" | "leg" | "arm" | "damage" | "door" | "accent";
  /** Swings around this hinge with a door's leaf. */
  leaf?: { x: number; z: number; sign: number };
}
/** A frame, its leaves and a status light whose colour shows personal access
 * and whose length shows the door's remaining health. */
function doorParts(
  parts: Part[],
  o: Furniture,
  part: (
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    tint?: Tint,
    batch?: Batch,
    role?: Part["role"],
  ) => void,
) {
  const style = doorStyle(o),
    vertical = o.h > o.w,
    span = vertical ? o.h : o.w,
    depth = vertical ? o.w : o.h,
    place = (along: number, across = 0) =>
      vertical ? { x: across, z: along } : { x: along, z: across },
    box = (
      along: number,
      across: number,
      y: number,
      width: number,
      height: number,
      thick: number,
      tint: Tint,
      batch: Batch,
      role?: Part["role"],
      leaf?: Part["leaf"],
    ) => {
      const at = place(along, across);
      part(
        at.x,
        y,
        at.z,
        vertical ? thick : width,
        height,
        vertical ? width : thick,
        tint,
        batch,
        role,
      );
      if (leaf) parts[parts.length - 1].leaf = leaf;
    };
  for (const sign of [-1, 1])
    box((sign * span) / 2, 0, 1.2, 0.13, 2.4, depth, "metal", "box");
  box(0, 0, 2.35, span - 0.13, 0.09, depth, "metal", "box");
  // Under the header on both faces, where the lintel cannot hide it.
  for (const sign of [-1, 1])
    box(
      0,
      (sign * depth) / 2 - sign * 0.03,
      2.25,
      span - 0.14,
      0.07,
      0.05,
      "screen",
      "screen",
      "bar",
    );
  const seeThrough = doorSeeThrough(style),
    damage = o.hp / Math.max(1, o.maxHp);
  for (const { hinge, extend, width } of doorLeaves(span - 0.14)) {
    const at = place(hinge),
      leaf = { x: at.x, z: at.z, sign: (vertical ? -1 : 1) * extend },
      size = width - 0.012,
      middle = hinge + (extend * width) / 2,
      along = (share: number) => hinge + extend * width * share,
      slab = (
        center: number,
        y: number,
        long: number,
        height: number,
        thick = 0.09,
        tint: Tint = "body",
        batch: Batch = "box",
        role: Part["role"] | null = "door",
      ) =>
        box(
          center,
          0,
          y,
          long,
          height,
          thick,
          tint,
          batch,
          role ?? undefined,
          leaf,
        );
    if (style.material === "glass" || style.window === "full") {
      slab(middle, 0.13, size, 0.18);
      slab(middle, 2.21, size, 0.16);
      slab(along(0.06), 1.15, size * 0.1, 1.94);
      slab(along(0.94), 1.15, size * 0.1, 1.94);
      slab(middle, 1.15, size * 0.78, 1.94, 0.04, "screen", "field", "pane");
    } else if (style.window === "half") {
      slab(middle, 0.62, size, 1.16);
      slab(middle, 2.2, size, 0.16);
      slab(along(0.06), 1.65, size * 0.1, 0.9);
      slab(along(0.94), 1.65, size * 0.1, 0.9);
      slab(middle, 1.65, size * 0.78, 0.9, 0.04, "screen", "field", "pane");
    } else {
      slab(middle, 1.16, size, 2.26);
      if (style.window === "slit")
        slab(along(0.5), 1.62, size * 0.2, 0.62, 0.11, "dark", "box", null);
    }
    if (style.material === "wood" && !seeThrough) {
      slab(along(0.3), 0.62, size * 0.32, 0.78, 0.105, "body", "box", "accent");
      slab(along(0.7), 0.62, size * 0.32, 0.78, 0.105, "body", "box", "accent");
    }
    if (style.material === "fire")
      slab(middle, 0.3, size * 0.92, 0.1, 0.105, "body", "box", "accent");
    if (style.material === "security") {
      for (const height of [0.45, 1.14, 1.83])
        slab(middle, height, size * 0.94, 0.08, 0.105, "body", "box", "accent");
    }
    if (style.material === "steel")
      slab(middle, 0.22, size * 0.94, 0.26, 0.105, "body", "box", "accent");
    slab(along(0.88), 1.05, 0.06, 0.2, 0.17, "metal", "box", null);
    if (damage < 0.65) {
      slab(along(0.34), 1.4, size * 0.5, 0.05, 0.11, "dark", "box", "damage");
      slab(along(0.62), 0.75, size * 0.42, 0.05, 0.11, "dark", "box", "damage");
    }
    if (damage < 0.35) {
      slab(along(0.48), 1.9, size * 0.34, 0.26, 0.112, "dark", "box", null);
      slab(along(0.28), 0.42, size * 0.24, 0.3, 0.112, "dark", "box", null);
    }
  }
}
interface Visual {
  parts: Part[];
  frame: number;
  present: number;
  visible: boolean;
  kind: string;
  w?: number;
  h?: number;
  destroyed?: boolean;
  damageStage?: number;
  field?: boolean;
  door?: boolean;
  motion?: Motion;
  label?: Sprite;
  speech?: Sprite;
  speechId?: string;
}
interface Panel {
  x: number;
  y: number;
  slot: number;
  lit: boolean;
}
interface FloorSceneState {
  root: Group;
  staticWorld: Group;
  pools: Record<Batch, InstancePool>;
  poolList: InstancePool[];
  visuals: Map<object, Visual>;
  panels: Panel[];
  geometry: GeometryChangeCache;
}
const FINISHES: FloorFinish[] = [
  "carpet",
  "carpetAlt",
  "lino",
  "concrete",
  "roof",
];
const WHITE = new Color(0xffffff);

/** Presentation only. Each floor is stacked at its real storey elevation. */
export class FirstPersonView {
  readonly renderer: WebGLRenderer;
  /** Agent benchmark hook for the complete rendered frame. */
  get drawCalls() {
    return this.renderer.info.render.calls;
  }
  /** Number of actual shown actor slots in the current rendered frame. */
  get visibleActors() {
    let count = 0;
    for (const context of this.floorScenes.values()) {
      if (!context.root.visible) continue;
      for (const visual of context.visuals.values())
        if (
          visual.visible &&
          (visual.kind === "zombie" || visual.kind === "survivor")
        )
          count++;
    }
    return count;
  }
  // The body already keeps the eye farther than 10 cm from solid surfaces.
  // Avoid spending most of a conventional depth buffer on an unused 5 cm
  // near range, especially while viewing the city at shallow angles.
  readonly camera = new PerspectiveCamera(75, 1, 0.1, 900);
  private scene = new Scene();
  private fill = new HemisphereLight("#b5c8d2", "#3f494c", 1.1);
  private moon = new DirectionalLight("#91abc9", 0.38);
  private localLights = Array.from(
    { length: 4 },
    () => new PointLight("#d6e5cd", 1.8, 4.5, 2),
  );
  private floorScenes = new Map<Floor, FloorSceneState>();
  private floorRoot = new Group();
  private staticWorld = new Group();
  private building = new BuildingShell();
  private gallery = new StairGallery();
  private exterior = new ExteriorDressing();
  private atmosphere = new InteriorAtmosphere();
  private pools!: Record<Batch, InstancePool>;
  private poolList: InstancePool[] = [];
  private visuals = new Map<object, Visual>();
  private panels: Panel[] = [];
  private nearestPanels: (Panel | undefined)[] = Array(4);
  private nearestDistances = new Float64Array(4);
  private labels = new Map<string, SpriteMaterial>();
  // Shared materials/textures survive floor travel; only view disposal frees them.
  private materials = {
    box: new MeshStandardMaterial({ color: "white", roughness: 0.88 }),
    head: new MeshStandardMaterial({
      color: "white",
      roughness: 0.85,
      flatShading: true,
    }),
    screen: new MeshStandardMaterial({
      color: "white",
      emissive: normal.terminal,
      emissiveIntensity: 0.5,
      roughness: 0.5,
    }),
    field: new MeshStandardMaterial({
      color: "white",
      emissive: "#203a31",
      transparent: true,
      opacity: 0.24,
      depthWrite: false,
      roughness: 0.55,
    }),
    panel: new MeshStandardMaterial({
      color: "#b5c4b1",
      emissive: "#d5e3c9",
      emissiveIntensity: 1.2,
      roughness: 0.7,
    }),
    eye: new MeshStandardMaterial({
      color: "white",
      emissive: "#738957",
      emissiveIntensity: 0.4,
      roughness: 1,
    }),
    wall: new MeshStandardMaterial({ color: normal.edge, roughness: 0.92 }),
    ceiling: new MeshStandardMaterial({ color: "#929b93", roughness: 1 }),
    stairs: new MeshStandardMaterial({ color: normal.edge, roughness: 0.8 }),
  };
  private floorMaterials = new Map<FloorFinish, MeshStandardMaterial>();
  private geometry = new GeometryChangeCache();
  private run?: Game;
  private theme = "";
  private architectureKey = "";
  private shellKey = "";
  private frame = 0;
  private tint = new Color();
  private limbPose = { x: 0, y: 0, rotation: 0 };
  private target = new Vector3();
  private scratchPoint: Point = { x: 0, y: 0 };
  private adaptive: AdaptiveResolution;
  private gpuTimer: GpuTimer;
  private pixelRatio: number;
  private lastWidth = 0;
  private lastHeight = 0;
  private disposed = false;

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.gpuTimer = new GpuTimer(
      this.renderer.getContext() as WebGL2RenderingContext,
    );
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.autoClear = false;
    this.renderer.info.autoReset = false;
    this.pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 1.5);
    this.adaptive = new AdaptiveResolution(this.pixelRatio);
    this.renderer.setPixelRatio(this.pixelRatio);

    this.moon.position.set(-12, 24, 8);
    this.moon.castShadow = false;
    this.scene.add(
      this.camera,
      this.fill,
      this.moon,
      this.moon.target,
      this.building.group,
      this.gallery.group,
      this.exterior.group,
      this.atmosphere.group,
    );
    // Interior surfaces and bodies receive every powered lamp's baked light.
    for (const material of [
      this.materials.box,
      this.materials.head,
      this.materials.screen,
      this.materials.wall,
      this.materials.ceiling,
      this.materials.stairs,
    ])
      this.atmosphere.lightmap.patch(material);
    const lm = this.atmosphere.lightmap.uniforms;
    lm.interiorLmSky.value = this.fill.color;
    lm.interiorLmGround.value = this.fill.groundColor;
    this.scene.background = new Color(normal.sky);
    this.scene.fog = new Fog(normal.sky, 2, 12);
    for (const finish of FINISHES)
      this.floorMaterials.set(
        finish,
        new MeshStandardMaterial({
          color: finish === "lino" ? "#969b8d" : "#89939b",
          map: floorTexture(finish),
          roughness: 0.98,
        }),
      );
    for (const material of this.floorMaterials.values())
      this.atmosphere.lightmap.patch(material);
  }

  render(game: Game, yaw: number, pitch: number, dt: number, stalled = false) {
    if (this.disposed) return;
    const start = performance.now(),
      a = human(game),
      floor = game.floors[a.floor],
      theme = game.surge.state === "active" ? "mutation" : "normal",
      palette = PALETTES[theme];
    if (this.run !== game) {
      this.clearFloor();
      this.run = game;
    }
    this.useFloor(floor);
    for (const context of this.floorScenes.values())
      context.root.visible = false;
    this.floorRoot.visible = true;
    if (this.geometry.changed(floor)) this.buildStatic(floor);
    if (theme !== this.theme) {
      this.theme = theme;
      this.exterior.setTheme(theme === "mutation");
      (this.scene.background as Color).copy(palette.sky);
      (this.scene.fog as Fog).color.copy(palette.sky);
      this.materials.wall.color.copy(palette.edge);
      this.materials.stairs.color.copy(palette.edge);
      this.materials.screen.emissive.copy(palette.terminal);
    }
    const fog = this.scene.fog as Fog,
      outside = this.exterior.enabled && outsideBuilding(floor, a.x, a.y);
    // Architectural depth, rather than an opaque near fog curtain, closes
    // rooms. City sightlines must survive through real perimeter windows.
    const city = game.floors[0].city;
    fog.near = city ? 100 : 38;
    fog.far = city ? 700 : 170;
    fog.color.copy(this.exterior.enabled ? this.exterior.horizon : palette.sky);
    (this.scene.background as Color).copy(fog.color);
    this.fill.intensity = outside ? 1.1 : 0.95 + (1 - floor.dark) * 0.22;
    this.moon.intensity = outside ? 0.8 : floor.boundary ? 0.12 : 0.7;
    const elevation = floor.index * FLOOR_HEIGHT;
    this.moon.target.position.set(a.x, elevation, a.y);
    this.moon.position.set(a.x - 12, elevation + 24, a.y + 8);
    this.resize();
    const horizontal = Math.cos(pitch),
      route =
        !a.elevated && a.stairTravel?.walked !== undefined
          ? sampleStairRoute(game, a.stairTravel)
          : undefined,
      eyeX = route?.x ?? a.x,
      eyeY = (a.elevated?.feet ?? route?.y ?? elevation) + 1.6,
      eyeZ = route?.z ?? a.y;
    this.camera.position.set(eyeX, eyeY, eyeZ);
    this.target.set(
      eyeX + horizontal * Math.cos(yaw),
      eyeY + Math.sin(pitch),
      eyeZ + horizontal * Math.sin(yaw),
    );
    this.camera.lookAt(this.target);
    this.exterior.update(game.time, game.settings.reducedFlash);
    this.gallery.update(game);
    this.atmosphere.group.visible = !!floor.boundary;
    if (floor.boundary) {
      this.atmosphere.update(game, this.camera, dt);
      if (!outside)
        this.fill.intensity = 0.22 + this.atmosphere.currentLight * 0.22;
    } else this.atmosphere.phone.visible = false;
    // The global fill tracks the player's own zone; the lightmap corrects
    // every other surface to its own zone's power and lamps.
    const lm = this.atmosphere.lightmap.uniforms;
    lm.interiorLmAmbient.value = floor.boundary && !outside ? 0.22 : 0;
    lm.interiorLmPlayer.value = this.atmosphere.currentLight;
    lm.interiorLmPool.value = game.surge.state === "active" ? 0.75 : 1;
    this.sync(game, a, floor, palette);
    this.syncPanels(game, a, floor);
    for (const pool of this.poolList) pool.flush();
    if (a.stairTravel && (a.elevated || a.stairTravel.walked !== undefined)) {
      // The real destination is drawn before crossing its threshold. Retain
      // both floor scenes so arriving changes simulation ownership only.
      const destination = game.floors[a.stairTravel.toFloor];
      if (destination && destination !== floor) {
        this.useFloor(destination);
        this.floorRoot.visible = true;
        if (this.geometry.changed(destination)) this.buildStatic(destination);
        this.sync(game, a, destination, palette);
        this.syncPanels(game, a, destination);
        for (const pool of this.poolList) pool.flush();
        this.useFloor(floor);
        this.syncPanels(game, a, floor);
      }
    }
    if (a.floor > 0 && game.floors[0].city) {
      // Upper windows and the open emergency gallery overlook the same real
      // street population. Keep their bodies at ground height; actual slabs,
      // facades and city blocks depth-test them instead of lifting them onto
      // the player's current floor or drawing hidden indoor occupants.
      const ground = game.floors[0];
      this.useFloor(ground);
      this.floorRoot.visible = true;
      if (this.geometry.changed(ground)) this.buildStatic(ground);
      this.sync(game, a, ground, palette, true);
      for (const pool of this.poolList) pool.flush();
      this.useFloor(floor);
    }
    this.renderer.info.reset();
    this.gpuTimer.begin();
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.gpuTimer.end();
    const next = this.adaptive.update(
      performance.now() - start,
      dt,
      Math.min(globalThis.devicePixelRatio || 1, 1.5),
      { gpuMs: this.gpuTimer.milliseconds, stalled },
    );
    if (next !== this.pixelRatio) {
      this.pixelRatio = next;
      this.renderer.setPixelRatio(next);
      this.lastWidth = 0;
    }
    if (this.canvas.dataset.rendered !== "true")
      this.canvas.dataset.rendered = "true";
  }

  private resize() {
    const width = Math.max(1, this.canvas.clientWidth),
      height = Math.max(1, this.canvas.clientHeight);
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private useFloor(floor: Floor) {
    let context = this.floorScenes.get(floor);
    if (!context) {
      this.floorRoot = new Group();
      this.floorRoot.name = `floor-${floor.index}`;
      this.floorRoot.position.y = floor.index * FLOOR_HEIGHT;
      this.staticWorld = new Group();
      this.floorRoot.add(this.staticWorld);
      this.scene.add(this.floorRoot);
      this.visuals = new Map();
      this.panels = [];
      this.geometry = new GeometryChangeCache();
      this.createPools();
      context = {
        root: this.floorRoot,
        staticWorld: this.staticWorld,
        pools: this.pools,
        poolList: this.poolList,
        visuals: this.visuals,
        panels: this.panels,
        geometry: this.geometry,
      };
      this.floorScenes.set(floor, context);
    } else {
      this.floorRoot = context.root;
      this.staticWorld = context.staticWorld;
      this.pools = context.pools;
      this.poolList = context.poolList;
      this.visuals = context.visuals;
      this.panels = context.panels;
      this.geometry = context.geometry;
    }
    for (const light of this.localLights) {
      light.visible = !floor.boundary;
      this.floorRoot.add(light);
    }
  }

  private createPools() {
    this.pools = {
      box: new InstancePool(
        this.floorRoot,
        new BoxGeometry(1, 1, 1),
        this.materials.box,
        8192,
      ),
      head: new InstancePool(
        this.floorRoot,
        new OctahedronGeometry(0.5, 1),
        this.materials.head,
        1024,
      ),
      screen: new InstancePool(
        this.floorRoot,
        new BoxGeometry(1, 1, 1),
        this.materials.screen,
        1024,
        false,
      ),
      field: new InstancePool(
        this.floorRoot,
        new BoxGeometry(1, 1, 1),
        this.materials.field,
        256,
        false,
      ),
      panel: new InstancePool(
        this.floorRoot,
        new BoxGeometry(1, 1, 1),
        this.materials.panel,
        256,
        false,
      ),
      eye: new InstancePool(
        this.floorRoot,
        new BoxGeometry(1, 1, 1),
        this.materials.eye,
        1024,
        false,
      ),
    };
    this.poolList = Object.values(this.pools);
  }

  private updateArchitecture(game: Game) {
    const key = JSON.stringify(
      game.floors.map((f) => [
        f.index,
        f.boundary,
        f.stairs,
        f.entry,
        f.city && [f.city.version, f.city.seed, f.city.bounds],
      ]),
    );
    if (key !== this.architectureKey) {
      this.exterior.build(game.floors[0], game.floors);
      this.gallery.build(game);
      this.architectureKey = key;
    }
    // The shell is already built for every storey. Visiting a floor must not
    // re-merge the city or recreate its signs in the middle of a stair walk.
    // Value signatures still catch synthetic/editor occupancy changes.
    const shellKey =
      key + game.floors.map((f) => geometrySignature(f.tiles)).join("|");
    if (shellKey !== this.shellKey) {
      this.building.build(game.floors);
      this.shellKey = shellKey;
    }
  }

  private buildStatic(floor: Floor) {
    this.clearStatic();
    if (this.run) this.updateArchitecture(this.run);
    else {
      this.exterior.build(floor);
      this.building.build([floor]);
    }
    const boxes: BufferGeometry[] = [];
    const interiorTiles = exteriorWallTiles(floor).map((row, z) =>
      row.map((tile, x) =>
        isPerimeterWall(floor, x, z) ||
        (floor.boundary &&
          ((floor.index < CONFIG.floors && z < floor.boundary.top) ||
            (floor.index > 0 && z >= floor.boundary.bottom)) &&
          x >= 21 &&
          x <= 22)
          ? 0
          : tile,
      ),
    );
    for (const r of wallRectangles(interiorTiles))
      boxes.push(
        new BoxGeometry(r.w, 2.8, r.h).translate(
          r.x + r.w / 2,
          1.4,
          r.y + r.h / 2,
        ),
      );
    // A carved doorway is an open simulation tile, but the architectural wall
    // continues above its frame. Anchor lintels to the fixed frame, not its leaf.
    for (const object of floor.furniture) {
      if (!(
        object.door ||
        object.field ||
        object.kind === "door" ||
        object.kind === "gate"
      ))
        continue;
      const frame = doorFrame(object),
        vertical = frame.h > frame.w,
        span = vertical ? frame.h : frame.w,
        cx = vertical ? Math.floor(frame.x) + 0.5 : frame.x,
        cz = vertical ? frame.y : Math.floor(frame.y) + 0.5;
      boxes.push(
        new BoxGeometry(
          vertical ? 1 : span + 0.3,
          2.8 - 2.49,
          vertical ? span + 0.3 : 1,
        ).translate(cx, (2.8 + 2.49) / 2, cz),
      );
    }
    this.addMerged(boxes, this.materials.wall, "walls", true);
    const surfaces = new Map<FloorFinish, BufferGeometry[]>();
    const ceilings: BufferGeometry[] = [];
    // The city owns all ground-level outdoor asphalt. Upper-floor well
    // approaches still need their local floor finish beside the stair deck.
    // Never stack a second nearly coplanar floor over the same outside lane.
    const ownsFinish = (x: number, y: number) =>
      !floor.boundary ||
      !outsideBuilding(floor, x + 0.5, y + 0.5) ||
      (floor.index > 0 && floor.tiles[y][x] === 0);
    for (const finish of FINISHES) surfaces.set(finish, []);
    for (let y = 0; y < H; y++) {
      let x = 0;
      while (x < W) {
        if (!ownsFinish(x, y)) {
          x++;
          continue;
        }
        const finish = floorZone(floor, x, y),
          start = x;
        while (x < W && floorZone(floor, x, y) === finish && ownsFinish(x, y))
          x++;
        const plane = new PlaneGeometry(x - start, 1)
          .rotateX(-Math.PI / 2)
          .translate((start + x) / 2, -0.025, y + 0.5);
        const uv = plane.getAttribute("uv"),
          position = plane.getAttribute("position");
        for (let i = 0; i < uv.count; i++)
          uv.setXY(i, position.getX(i), position.getZ(i));
        surfaces.get(finish)!.push(plane);
        if (
          floor.index < CONFIG.floors &&
          finish !== "concrete" &&
          finish !== "roof"
        )
          ceilings.push(
            new PlaneGeometry(x - start, 1)
              .rotateX(Math.PI / 2)
              .translate((start + x) / 2, 2.82, y + 0.5),
          );
      }
    }
    for (const finish of FINISHES)
      this.addMerged(
        surfaces.get(finish)!,
        this.floorMaterials.get(finish)!,
        "floor",
        false,
      );
    this.addMerged(ceilings, this.materials.ceiling, "ceiling", false);
    const treads: BufferGeometry[] = [];
    for (const kind of ["up", "down"] as const) {
      if (
        (kind === "up" && floor.index === CONFIG.floors) ||
        (kind === "down" && floor.index === 0)
      )
        continue;
      if (floor.boundary) continue;
      const well = stairwell(floor, kind);
      for (let i = 0; i < 6; i++) {
        const depth = well.h / 6,
          height = kind === "up" ? (i + 1) * 0.13 : (6 - i) * 0.045,
          z =
            well.open > 0
              ? well.y + well.h - (i + 0.5) * depth
              : well.y + (i + 0.5) * depth;
        treads.push(
          new BoxGeometry(well.w - 0.2, height, depth - 0.025).translate(
            well.marker.x,
            height / 2,
            z,
          ),
        );
      }
    }
    this.addMerged(treads, this.materials.stairs, "stairs", true);
    if (floor.boundary) this.atmosphere.build(floor, this.run?.seed ?? 0);
    else if (floor.index < CONFIG.floors) this.buildPanels(floor);
    this.theme = "";
  }

  private addMerged(
    parts: BufferGeometry[],
    material: MeshStandardMaterial,
    name: string,
    shadow: boolean,
  ) {
    if (!parts.length) return;
    const geometry = mergeGeometries(parts)!;
    for (const part of parts) part.dispose();
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = shadow;
    mesh.receiveShadow = true;
    this.staticWorld.add(mesh);
  }

  private buildPanels(floor: Floor) {
    const add = (x: number, y: number) => {
      const ix = Math.floor(x),
        iy = Math.floor(y);
      if (
        floor.tiles[iy]?.[ix] !== 0 ||
        floorZone(floor, ix, iy) === "concrete"
      )
        return;
      if (this.panels.some((p) => Math.hypot(p.x - x, p.y - y) < 2.2)) return;
      this.panels.push({ x, y, slot: this.pools.panel.allocate(), lit: true });
    };
    const sectors = floorSectors(floor);
    for (const sector of sectors) {
      for (const room of sector.rooms) {
        const r = room.rect;
        add((r.x1 + r.x2 + 1) / 2, (r.y1 + r.y2 + 1) / 2);
        if (r.y2 - r.y1 > 4) add((r.x1 + r.x2 + 1) / 2, r.y1 + 1.5);
      }
      for (const r of sector.blocks)
        for (let y = r.y1 + 2; y <= r.y2; y += 5)
          for (let x = r.x1 + 2; x <= r.x2; x += 5) add(x + 0.5, y + 0.5);
    }
    if (!sectors.length)
      for (let y = 4; y < 28; y += 5)
        for (let x = 4; x < 42; x += 6) add(x + 0.5, y + 0.5);
  }

  private syncPanels(game: Game, a: Actor, floor: Floor) {
    if (floor.boundary) {
      for (const light of this.localLights) light.intensity = 0;
      return;
    }
    this.nearestDistances.fill(Infinity);
    this.nearestPanels.fill(undefined);
    for (let i = 0; i < this.panels.length; i++) {
      const panel = this.panels[i];
      panel.lit = panelIsLit(
        i,
        game.time,
        floor.dark,
        game.surge.state === "active",
        game.settings.reducedFlash,
      );
      if (panel.lit)
        this.pools.panel.set(
          panel.slot,
          panel.x,
          2.775,
          panel.y,
          0.42,
          0.045,
          1.15,
          0,
          WHITE,
        );
      else this.pools.panel.hide(panel.slot);
      const distance = Math.hypot(panel.x - a.x, panel.y - a.y);
      if (!panel.lit || distance > 6 || !playerCanSee(floor, a, panel))
        continue;
      for (let j = 0; j < 4; j++)
        if (distance < this.nearestDistances[j]) {
          for (let k = 3; k > j; k--) {
            this.nearestDistances[k] = this.nearestDistances[k - 1];
            this.nearestPanels[k] = this.nearestPanels[k - 1];
          }
          this.nearestDistances[j] = distance;
          this.nearestPanels[j] = panel;
          break;
        }
    }
    for (let i = 0; i < 4; i++) {
      const light = this.localLights[i],
        panel = this.nearestPanels[i];
      light.intensity = panel ? 1.4 + (1 - floor.dark) * 0.8 : 0;
      if (panel) light.position.set(panel.x, 2.5, panel.y);
    }
  }

  private visual(object: object, kind: string) {
    let visual = this.visuals.get(object);
    if (!visual || visual.kind !== kind) {
      if (visual) this.release(visual);
      visual = {
        kind,
        parts: [],
        frame: this.frame,
        present: this.frame,
        visible: true,
      };
      this.visuals.set(object, visual);
    }
    visual.frame = visual.present = this.frame;
    visual.visible = true;
    return visual;
  }

  private part(
    parts: Part[],
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    tint: Tint = "body",
    batch: Batch = "box",
    role?: Part["role"],
    anchor?: Part["anchor"],
  ) {
    parts.push({
      batch,
      slot: this.pools[batch].allocate(),
      x,
      y,
      z,
      w,
      h,
      d,
      tint,
      role,
      anchor,
    });
  }

  private markPresent(object: object) {
    const visual = this.visuals.get(object);
    if (visual) visual.present = this.frame;
  }

  private sync(
    game: Game,
    a: Actor,
    floor: Floor,
    palette: Palette,
    exteriorOnly = false,
  ) {
    this.frame++;
    // Static objects rely on depth-tested walls for occlusion. A centre-point
    // LOS query can hide a visible door face or a desk extending around a corner.
    const fogDistance = sightRadius(floor) + 3;
    if (!exteriorOnly) {
      for (const o of floor.furniture) {
        this.markPresent(o);
        if (
          Math.hypot(o.x - a.x, o.y - a.y) >
            fogDistance + Math.hypot(o.w, o.h) / 2 ||
          (o.kind === "gate" && o.turning < 0)
        )
          continue;
        this.furniture(o, a, palette);
      }
      for (const station of floor.stations) {
        this.markPresent(station);
        if (Math.hypot(station.x - a.x, station.y - a.y) <= fogDistance + 0.6)
          this.station(station, game, palette);
        const encounter = game.encounters[station.encounter];
        if (encounter?.state === "consumed" && encounter.reward === "loot")
          for (let i = 0; i < encounter.loot.length; i++) {
            const item = encounter.loot[i];
            this.markPresent(item);
            lootSlot(station, i, this.scratchPoint);
            if (
              Math.hypot(
                this.scratchPoint.x - a.x,
                this.scratchPoint.y - a.y,
              ) <=
              fogDistance + 0.14
            )
              this.loot(item, this.scratchPoint, palette);
          }
      }
      for (const actor of game.survivors)
        if (actor.floor === floor.index && !actor.escaped && actor !== a) {
          this.markPresent(actor);
          if (playerCanSee(floor, a, actor))
            this.actor(actor, game, palette, a);
        }
    }
    for (const zombie of game.zombies)
      if (zombie.floor === floor.index) {
        this.markPresent(zombie);
        const exteriorStairView =
          game.floors[0].city &&
          (a.elevated || a.stairTravel?.walked !== undefined) &&
          outsideBuilding(game.floors[a.floor], a.x, a.y) &&
          zombie.floor === 0;
        if (
          exteriorOnly || exteriorStairView
            ? outsideBuilding(floor, zombie.x, zombie.y) &&
              Math.hypot(zombie.x - a.x, zombie.y - a.y) < this.camera.far
            : playerCanSee(floor, a, zombie)
        )
          this.actor(zombie, game, palette, a);
      }
    for (const [object, visual] of this.visuals) {
      if (
        visual.speech &&
        npcSpeechBubble(game, (object as Actor).id)?.id !== visual.speechId
      )
        this.clearSpeech(visual);
      // Removed zombies retain a short, view-only collapse, without resurrecting a sim entity.
      if (
        visual.present !== this.frame &&
        visual.kind === "zombie" &&
        visual.visible &&
        visual.motion
      ) {
        const zombie = object as Zombie;
        if (zombie.hp <= 0) {
          visual.motion.deathAt ??= game.time;
          if (
            game.time - visual.motion.deathAt < 0.8 &&
            playerCanSee(floor, a, zombie)
          ) {
            this.actor(zombie, game, palette, a);
            continue;
          }
        }
      }
      if (visual.present !== this.frame) {
        this.release(visual);
        this.visuals.delete(object);
      } else if (visual.frame !== this.frame && visual.visible) {
        for (const p of visual.parts) this.pools[p.batch].hide(p.slot);
        if (visual.label) visual.label.visible = false;
        if (visual.speech) visual.speech.visible = false;
        visual.visible = false;
      }
    }
  }

  private furniture(o: Furniture, a: Actor, palette: Palette) {
    const visual = this.visual(o, o.kind),
      appearance = o.appearance,
      roomPalette = appearance
        ? this.run?.floors[o.floor].scene?.rooms.find(
            (room) => room.room === appearance.room,
          )?.palette
        : undefined,
      health = Math.max(0, Math.min(1, o.hp / Math.max(1, o.maxHp))),
      damageStage = health < 0.35 ? 2 : health < 0.65 ? 1 : 0;
    if (
      visual.w !== o.w ||
      visual.h !== o.h ||
      visual.destroyed !== o.destroyed ||
      visual.field !== !!o.field ||
      visual.door !== !!o.door ||
      visual.damageStage !== damageStage
    ) {
      this.release(visual);
      visual.parts.length = 0;
      visual.w = o.w;
      visual.h = o.h;
      visual.destroyed = o.destroyed;
      visual.field = !!o.field;
      visual.door = !!o.door;
      visual.damageStage = damageStage;
      this.furnitureParts(visual.parts, o);
    }
    const frame = doorFrame(o),
      fieldColor = fieldAllows(o, a) ? palette.allowed : palette.blocked,
      style = o.field ? doorStyle(o) : undefined,
      swing = o.field?.leaf
        ? o.field.leaf.side * o.field.leaf.open * DOOR_OPEN_ANGLE
        : 0;
    for (const p of visual.parts) {
      const swung = p.leaf ? p.leaf.sign * swing : 0,
        swungCos = Math.cos(swung),
        swungSin = Math.sin(swung),
        leafX = p.leaf
          ? p.leaf.x + (p.x - p.leaf.x) * swungCos - (p.z - p.leaf.z) * swungSin
          : p.x,
        leafZ = p.leaf
          ? p.leaf.z + (p.x - p.leaf.x) * swungSin + (p.z - p.leaf.z) * swungCos
          : p.z,
        anchor = p.anchor === "frame" ? frame : o,
        angle = p.anchor === "frame" ? 0 : (o.angle ?? 0) + swung,
        c = Math.cos(o.field ? 0 : angle),
        s = Math.sin(o.field ? 0 : angle),
        bar = p.role === "bar",
        vertical = o.h > o.w,
        x = bar && !vertical ? leafX - (o.w * (1 - health)) / 2 : leafX,
        z = bar && vertical ? leafZ - (o.h * (1 - health)) / 2 : leafZ,
        broken = !o.field && !o.door && health < 0.45,
        lean =
          p.role === "damage"
            ? 0.38
            : o.destroyed
              ? 0.18
              : broken && (p.role === "leg" || p.tint === "edge")
                ? 0.12
                : 0;
      const authoredColor =
        !o.field && appearance
          ? p.tint === "body"
            ? appearance.color
            : p.tint === "metal"
              ? roomPalette?.metal
              : p.tint === "edge"
                ? roomPalette?.accent
                : undefined
          : undefined;
      const doorColor =
        p.role === "door"
          ? style?.color
          : p.role === "accent"
            ? style?.accent
            : p.role === "pane"
              ? "#a9d3df"
              : undefined;
      if (authoredColor) this.tint.set(authoredColor);
      else if (doorColor) this.tint.set(doorColor);
      else
        this.tint.copy(
          o.field && p.tint === "screen"
            ? fieldColor
            : this.color(p.tint, palette, o.kind),
        );
      if (p.role === "door" || (p.tint === "body" && !o.field))
        this.tint.multiplyScalar(0.45 + 0.55 * health);
      this.pools[p.batch].set(
        p.slot,
        anchor.x + x * c - z * s,
        p.y - (broken && p.role === "leg" ? 0.07 : 0),
        anchor.y + x * s + z * c,
        p.w * (bar && !vertical ? health : 1),
        p.h,
        p.d * (bar && vertical ? health : 1),
        angle,
        this.tint,
        lean,
      );
    }
  }

  private furnitureParts(parts: Part[], o: Furniture) {
    const { w, h: d } = o,
      height = furnitureHeight(o.kind);
    const part = (
      x: number,
      y: number,
      z: number,
      width: number,
      h: number,
      depth: number,
      tint: Tint = "body",
      batch: Batch = "box",
      role?: Part["role"],
      anchor?: Part["anchor"],
    ) => this.part(parts, x, y, z, width, h, depth, tint, batch, role, anchor);
    if (o.destroyed) {
      part(
        -w * 0.2,
        0.08,
        -d * 0.12,
        w * 0.55,
        0.1,
        d * 0.55,
        "body",
        "box",
        "debris",
      );
      part(
        w * 0.24,
        0.12,
        d * 0.2,
        w * 0.28,
        0.15,
        d * 0.4,
        "dark",
        "box",
        "debris",
      );
      part(
        w * 0.1,
        0.2,
        -d * 0.25,
        w * 0.16,
        0.35,
        d * 0.15,
        "metal",
        "box",
        "debris",
      );
      return;
    }
    if (o.field) {
      doorParts(parts, o, part);
      return;
    }
    const health = o.hp / Math.max(1, o.maxHp);
    if (health < 0.65) {
      // Dark diagonal fractures and a dropped panel stay readable under the room lighting.
      part(
        -w * 0.12,
        height * 0.58,
        d * 0.515,
        w * 0.46,
        0.035,
        0.025,
        "dark",
        "box",
        "damage",
      );
      part(
        w * 0.15,
        height * 0.4,
        d * 0.515,
        w * 0.34,
        0.03,
        0.025,
        "dark",
        "box",
        "damage",
      );
      if (health < 0.35)
        part(
          w * 0.32,
          0.085,
          d * 0.22,
          w * 0.27,
          0.1,
          d * 0.37,
          "body",
          "box",
          "debris",
        );
    }
    if (o.kind === "door" || o.kind === "gate") {
      // The leaf uses the real hinged body pose; trim remains in the saved frame.
      // Small clearances keep the closed leaf's surfaces distinct from its jambs.
      part(0, height / 2, 0, w - 0.018, height - 0.024, d - 0.018);
      const frame = doorFrame(o),
        vertical = frame.h > frame.w,
        span = vertical ? frame.h : frame.w;
      for (const sign of [-1, 1])
        part(
          vertical ? 0 : (sign * span) / 2,
          height / 2,
          vertical ? (sign * span) / 2 : 0,
          0.15,
          height,
          0.15,
          "edge",
          "box",
          undefined,
          "frame",
        );
      part(
        0,
        height + 0.07,
        0,
        vertical ? 0.18 : span,
        0.14,
        vertical ? span : 0.18,
        "edge",
        "box",
        undefined,
        "frame",
      );
      part(
        w > d ? w * 0.4 : w * 0.65,
        1.08,
        d > w ? d * 0.4 : d * 0.65,
        0.1,
        0.08,
        0.1,
        "metal",
      );
      return;
    }
    switch (o.kind) {
      case "desk":
      case "table":
      case "cafeTable":
      case "coffeeTable":
      case "reception":
        part(0, height, 0, w, 0.1, d);
        for (const x of [-1, 1])
          for (const z of [-1, 1])
            part(
              x * w * 0.4,
              height / 2,
              z * d * 0.38,
              0.075,
              height,
              0.075,
              "metal",
              "box",
              "leg",
            );
        if (o.kind === "desk" || o.kind === "reception") {
          part(0, height * 0.6, -d * 0.4, w * 0.85, height * 0.6, 0.08, "edge");
          part(-w * 0.28, height * 0.55, 0, w * 0.25, height * 0.78, d * 0.7);
          for (let i = 0; i < 2; i++)
            part(
              -w * 0.28,
              height * (0.35 + i * 0.3),
              d * 0.36,
              w * 0.18,
              0.02,
              0.03,
              "metal",
            );
        }
        break;
      case "chair":
      case "officeChair":
      case "sofa":
      case "armchair":
        part(0, height, 0, w, 0.15, d);
        // The back and arms join inside the seat's silhouette. Equal outer
        // widths produce competing coplanar faces wherever these boxes overlap.
        part(0, height + 0.3, -d * 0.4, w - 0.028, 0.58, d * 0.16, "edge");
        if (o.kind === "officeChair") {
          part(0, height / 2, 0, 0.08, height, 0.08, "metal");
          part(0, 0.09, 0, w * 0.75, 0.07, 0.08, "metal");
          part(0, 0.09, 0, 0.08, 0.07, d * 0.75, "metal");
          for (const sign of [-1, 1]) {
            part(sign * w * 0.4, 0.06, 0, 0.12, 0.1, 0.12, "dark");
            part(0, 0.06, sign * d * 0.4, 0.12, 0.1, 0.12, "dark");
          }
        } else
          for (const x of [-1, 1])
            for (const z of [-1, 1])
              part(
                x * w * 0.36,
                height / 2,
                z * d * 0.33,
                0.07,
                height,
                0.07,
                "metal",
                "box",
                "leg",
              );
        if (o.kind !== "chair")
          for (const sign of [-1, 1])
            part(
              sign * (w * 0.44 - 0.012),
              height + 0.14,
              0,
              w * 0.12,
              0.25,
              d * 0.8,
              "edge",
            );
        if (o.kind === "sofa")
          for (const sign of [-1, 1])
            part(
              sign * w * 0.24,
              height + 0.1,
              0,
              w * 0.44,
              0.12,
              d * 0.75,
              "edge",
            );
        break;
      case "shelf":
        // Backing and shelves fit between the side panels; their edges no
        // longer share the panels' exposed outer faces.
        part(
          0,
          height / 2,
          -d * 0.44,
          w * 0.84 - 0.028,
          height - 0.028,
          d * 0.1,
          "dark",
        );
        for (const sign of [-1, 1])
          part(sign * w * 0.46, height / 2, 0, w * 0.08, height, d);
        for (let i = 0; i < 4; i++) {
          part(0, 0.08 + (i * height) / 3, 0, w * 0.84, 0.07, d);
          if (i < 3)
            for (let j = 0; j < 3; j++)
              part(
                (j - 1) * w * 0.23,
                0.27 + (i * height) / 3,
                -d * 0.05,
                w * 0.15,
                0.29,
                d * 0.7,
                j % 2 ? "edge" : "metal",
              );
        }
        break;
      case "plant":
        part(0, 0.22, 0, w * 0.65, 0.44, d * 0.65);
        part(0, 0.62, 0, 0.07, 0.5, 0.07, "dark");
        part(0, 0.95, 0, w * 0.9, 0.75, d * 0.9, "leaf", "head");
        part(
          w * 0.24,
          0.75,
          d * 0.16,
          w * 0.65,
          0.55,
          d * 0.65,
          "leaf",
          "head",
        );
        break;
      case "screen":
      case "whiteboard":
      case "partition":
        part(
          0,
          height * 0.65,
          0,
          w,
          height * 0.7,
          d,
          o.kind === "whiteboard" ? "metal" : "edge",
        );
        for (const sign of [-1, 1]) {
          part(
            sign * w * 0.36,
            height * 0.2,
            0,
            0.07,
            height * 0.4,
            0.07,
            "metal",
          );
          part(
            sign * w * 0.36,
            0.07,
            0,
            0.08,
            0.09,
            Math.max(d, 0.45),
            "metal",
          );
        }
        if (o.kind === "screen")
          part(
            0,
            height * 0.64,
            d * 0.51,
            w * 0.86,
            height * 0.5,
            0.025,
            "screen",
            "screen",
          );
        if (o.kind === "whiteboard") {
          part(
            0,
            height * 0.65,
            d * 0.52,
            w * 0.92,
            height * 0.6,
            0.025,
            "skin",
          );
          part(0, height * 0.32, d * 0.65, w * 0.85, 0.035, 0.12, "metal");
          part(
            -w * 0.17,
            height * 0.74,
            d * 0.52 + 0.025,
            w * 0.45,
            0.025,
            0.012,
            "dark",
          );
          part(
            -w * 0.08,
            height * 0.64,
            d * 0.52 + 0.025,
            w * 0.62,
            0.025,
            0.012,
            "dark",
          );
        }
        break;
      case "fridge":
      case "cabinet":
      case "drawers":
      case "vending":
        part(0, height / 2, 0, w, height, d);
        if (o.kind === "drawers")
          for (let i = 0; i < 3; i++) {
            part(
              0,
              height * (0.18 + i * 0.29),
              d * 0.51,
              w * 0.86,
              0.025,
              0.025,
              "dark",
            );
            part(
              0,
              height * (0.26 + i * 0.29),
              d * 0.54,
              w * 0.25,
              0.035,
              0.035,
              "metal",
            );
          }
        else {
          part(0, height * 0.72, d * 0.51, w * 0.85, 0.025, 0.015, "dark");
          part(
            w * 0.3,
            height * 0.56,
            d * 0.54,
            0.04,
            height * 0.23,
            0.05,
            "metal",
          );
          if (o.kind === "cabinet")
            part(0, height / 2, d * 0.51, 0.025, height * 0.9, 0.025, "dark");
          if (o.kind === "vending") {
            part(
              -w * 0.1,
              height * 0.58,
              d * 0.52,
              w * 0.6,
              height * 0.62,
              0.03,
              "dark",
            );
            for (let i = 0; i < 3; i++)
              part(
                -w * 0.1,
                height * (0.4 + i * 0.18),
                d * 0.54,
                w * 0.5,
                0.07,
                0.03,
                "screen",
                "screen",
              );
            part(
              0,
              height * 0.12,
              d * 0.52,
              w * 0.6,
              height * 0.12,
              0.03,
              "dark",
            );
          }
        }
        break;
      case "cooler":
        part(0, 0.4, 0, w * 0.85, 0.8, d * 0.85, "metal");
        part(0, 0.98, 0, w * 0.6, 0.45, d * 0.6, "screen", "head");
        part(0, 0.61, d * 0.46, w * 0.45, 0.2, 0.03, "dark");
        for (const sign of [-1, 1])
          part(sign * w * 0.15, 0.68, d * 0.52, 0.055, 0.08, 0.08, "screen");
        break;
      case "printer":
        part(0, 0.35, 0, w * 0.85, 0.7, d * 0.85);
        part(0, 0.83, 0, w, 0.26, d, "metal");
        part(0, 0.99, -d * 0.1, w * 0.85, 0.06, d * 0.62, "dark");
        part(0, 0.83, d * 0.51, w * 0.6, 0.07, 0.04, "dark");
        part(
          w * 0.28,
          0.98,
          d * 0.3,
          w * 0.15,
          0.04,
          d * 0.18,
          "screen",
          "screen",
        );
        break;
      case "coffeeMaker":
        part(0, 0.39, 0, w, 0.78, d);
        part(0, 0.92, -d * 0.1, w * 0.75, 0.34, d * 0.65, "dark");
        part(0, 0.78, d * 0.26, w * 0.4, 0.3, d * 0.38, "metal");
        part(0, 0.62, d * 0.28, w * 0.65, 0.05, d * 0.5, "dark");
        break;
      case "microwave":
        part(0, 0.35, 0, w * 0.9, 0.7, d * 0.9);
        part(0, 0.85, 0, w, 0.35, d, "metal");
        part(-w * 0.1, 0.85, d * 0.51, w * 0.65, 0.24, 0.03, "dark");
        part(w * 0.37, 0.85, d * 0.53, 0.035, 0.2, 0.04, "metal");
        break;
      case "box":
        part(0, height / 2, 0, w, height, d);
        part(0, height + 0.008, 0, w * 0.14, 0.015, d - 0.028, "edge");
        part(
          0,
          height * 0.55,
          d * 0.51,
          w * 0.32,
          height * 0.35,
          0.015,
          "skin",
        );
        break;
    }
  }

  private station(station: Station, game: Game, palette: Palette) {
    const visual = this.visual(station, "station");
    if (!visual.parts.length) {
      this.part(visual.parts, 0, 0.76, 0, 0.98, 0.1, 0.65);
      for (const sign of [-1, 1])
        this.part(visual.parts, sign * 0.38, 0.38, 0, 0.06, 0.76, 0.5, "metal");
      this.part(visual.parts, 0, 0.93, -0.17, 0.08, 0.3, 0.08, "metal");
      this.part(visual.parts, 0, 1.18, -0.17, 0.7, 0.45, 0.1, "dark");
      this.part(
        visual.parts,
        0,
        1.18,
        -0.112,
        0.61,
        0.36,
        0.025,
        "screen",
        "screen",
      );
      this.part(visual.parts, 0, 0.83, 0.15, 0.55, 0.04, 0.2, "dark");
    }
    const consumed = game.encounters[station.encounter]?.state === "consumed";
    for (const p of visual.parts)
      this.pools[p.batch].set(
        p.slot,
        station.x + p.x,
        p.y,
        station.y + p.z,
        p.w,
        p.h,
        p.d,
        0,
        consumed && p.batch === "screen"
          ? palette.edge
          : this.color(p.tint, palette),
      );
  }

  private loot(item: Item, position: Point, palette: Palette) {
    const visual = this.visual(item, item.kind);
    if (!visual.parts.length) {
      this.part(visual.parts, 0, 0.93, 0, 0.2, 0.24, 0.18, "screen", "screen");
      if (item.kind === "medkit") {
        this.part(visual.parts, 0, 0.93, 0.096, 0.12, 0.035, 0.015, "skin");
        this.part(visual.parts, 0, 0.93, 0.096, 0.035, 0.12, 0.015, "skin");
      }
    }
    for (const p of visual.parts)
      this.pools[p.batch].set(
        p.slot,
        position.x + p.x,
        p.y,
        position.y + p.z,
        p.w,
        p.h,
        p.d,
        0,
        item.kind === "medkit"
          ? p.tint === "skin"
            ? palette.danger
            : palette.medkit
          : palette.accent,
      );
  }

  private actor(
    actor: Actor | Zombie,
    game: Game,
    palette: Palette,
    player: Actor,
  ) {
    const zombie = !("alive" in actor),
      visual = this.visual(actor, zombie ? "zombie" : "survivor");
    if (!visual.parts.length) {
      // Human proportions: 1.75 m overall, 23 cm head, distinct shoulders and hips.
      this.part(visual.parts, 0, 1.19, 0, 0.24, 0.55, 0.46);
      this.part(visual.parts, 0.005, 1.63, 0, 0.23, 0.23, 0.23, "skin", "head");
      for (const sign of [-1, 1]) {
        this.part(
          visual.parts,
          0,
          1.15,
          sign * 0.305,
          0.14,
          0.57,
          0.14,
          "body",
          "box",
          "arm",
        );
        this.part(
          visual.parts,
          0,
          0.45,
          sign * 0.13,
          0.18,
          0.82,
          0.18,
          "dark",
          "box",
          "leg",
        );
      }
      if (zombie) {
        // Small exposed rips break the dark jacket silhouette. Both eyes share
        // one faint emissive instance batch rather than per-zombie lights.
        this.part(visual.parts, 0.127, 1.2, -0.12, 0.012, 0.12, 0.07, "skin");
        this.part(visual.parts, 0.127, 1.04, 0.16, 0.012, 0.08, 0.05, "skin");
        for (const sign of [-1, 1])
          this.part(
            visual.parts,
            0.116,
            1.665,
            sign * 0.05,
            0.02,
            0.022,
            0.026,
            "skin",
            "eye",
          );
      }
      visual.motion = createMotion(actor.x, actor.y, game.time, actor.hp);
    }
    const motion = visual.motion!;
    updateMotion(motion, actor.x, actor.y, game.time, actor.hp);
    const strike = zombie
        ? zombieStrike(motion, (actor as Zombie).cooldown, game.time)
        : 0,
      target = zombie
        ? ((actor as Zombie).target ?? actor.path[0])
        : (actor as Actor).heading,
      angle = zombie
        ? target
          ? Math.atan2(target.y - actor.y, target.x - actor.x)
          : Math.PI / 2
        : Math.atan2(target?.y ?? 0, target?.x ?? 1),
      health = Math.max(0, Math.min(1, actor.hp / (zombie ? 60 : 100))),
      amplitude = Math.min(1, motion.speed / 1.6),
      stride = Math.sin(motion.phase) * amplitude * (zombie ? 0.32 : 0.48),
      sway = zombie
        ? Math.sin(motion.phase * 0.5) * amplitude * 0.035
        : Math.sin(motion.phase) * amplitude * 0.012,
      flinch = Math.max(0, (motion.flinchUntil - game.time) / 0.22) * 0.22,
      dead = actor.hp <= 0 || (!zombie && !(actor as Actor).alive),
      collapse = dead
        ? Math.min(
            1,
            Math.max(0, (game.time - (motion.deathAt ??= game.time)) / 0.55),
          )
        : 0,
      lean = collapse * 1.48 + flinch + (dead ? 0 : strike * 0.12),
      c = Math.cos(angle),
      s = Math.sin(angle),
      cl = Math.cos(lean),
      sl = Math.sin(lean);
    for (const p of visual.parts) {
      let x = p.x,
        y = p.y,
        rotation = -lean;
      const sign = Math.sign(p.z);
      if (p.role === "leg" || p.role === "arm") {
        const swing =
          p.role === "leg"
            ? stride * sign
            : zombie
              ? 1.15 +
                strike * 0.48 +
                Math.sin(motion.phase + sign) * amplitude * 0.12
              : -stride * sign * 0.8;
        setLimbPose(
          this.limbPose,
          p.role === "leg" ? 0.86 : 1.435,
          p.h,
          swing,
          lean,
        );
        x = this.limbPose.x;
        y = this.limbPose.y;
        rotation = this.limbPose.rotation;
      } else {
        const fallenX = x * cl + (y - 0.18) * sl;
        y = 0.18 + (y - 0.18) * cl - x * sl;
        x = fallenX;
      }
      const color =
        p.batch === "eye"
          ? palette.zombieEye
          : p.tint === "skin"
            ? zombie
              ? palette.zombieSkin
              : palette.skin
            : p.tint === "dark"
              ? palette.trousers
              : zombie
                ? palette.zombieBody
                : palette.shirt;
      this.tint.copy(color).lerp(palette.danger, (1 - health) * 0.32);
      this.pools[p.batch].set(
        p.slot,
        actor.x + x * c - p.z * s,
        y + (dead ? 0 : sway),
        actor.y + x * s + p.z * c,
        p.w,
        p.h,
        p.d,
        angle,
        this.tint,
        rotation,
      );
    }
    if (!zombie) {
      this.label(visual, actor as Actor, player, dead);
      this.speechBubble(visual, actor as Actor, player, game, dead);
    }
  }

  private clearSpeech(visual: Visual) {
    if (visual.speech) {
      visual.speech.removeFromParent();
      visual.speech.material.map?.dispose();
      visual.speech.material.dispose();
    }
    delete visual.speech;
    delete visual.speechId;
  }

  private speechBubble(
    visual: Visual,
    actor: Actor,
    player: Actor,
    game: Game,
    dead: boolean,
  ) {
    const line = npcSpeechBubble(game, actor.id);
    if (
      !line ||
      dead ||
      Math.hypot(actor.x - player.x, actor.y - player.y) > 10
    ) {
      this.clearSpeech(visual);
      return;
    }
    if (visual.speechId !== line.id) {
      this.clearSpeech(visual);
      const lines = speechLines(line.text, 36),
        canvas = document.createElement("canvas");
      canvas.width = 640;
      canvas.height = 36 + lines.length * 34;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "rgba(10,23,27,.94)";
      context.beginPath();
      context.roundRect(2, 2, 636, canvas.height - 4, 18);
      context.fill();
      context.strokeStyle = "#b4d7cb";
      context.lineWidth = 3;
      context.stroke();
      context.fillStyle = "#eaf2dc";
      context.textAlign = "center";
      context.font = "500 27px sans-serif";
      lines.forEach((text, i) => context.fillText(text, 320, 36 + i * 34, 596));
      const map = new CanvasTexture(canvas);
      map.colorSpace = SRGBColorSpace;
      const material = new SpriteMaterial({
        map,
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      });
      visual.speech = new Sprite(material);
      visual.speech.name = "npc-speech-bubble";
      visual.speech.userData = {
        text: line.text,
        actorId: actor.id,
        requestId: line.id,
      };
      visual.speech.center.set(0.5, 0);
      // Keep even a full sentence between the speaker's head and the office
      // ceiling, so architecture cannot clip the last lines of its bubble.
      visual.speech.scale.set(
        3.0,
        Math.min(0.94, (3.0 * canvas.height) / canvas.width),
        1,
      );
      visual.speechId = line.id;
      this.floorRoot.add(visual.speech);
    }
    visual.speech!.visible = true;
    if (visual.label) visual.label.visible = false;
    visual.speech!.position.set(
      actor.x,
      Math.min(2.18, 2.72 - visual.speech!.scale.y),
      actor.y,
    );
  }

  private label(visual: Visual, actor: Actor, player: Actor, dead: boolean) {
    const inRange =
      !dead && Math.hypot(actor.x - player.x, actor.y - player.y) <= 7;
    if (!inRange) {
      if (visual.label) visual.label.visible = false;
      return;
    }
    if (!visual.label) {
      let material = this.labels.get(actor.name);
      if (!material) {
        const canvas = document.createElement("canvas");
        canvas.width = 256;
        canvas.height = 48;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "rgba(10,18,22,.74)";
        ctx.fillRect(0, 0, 256, 48);
        ctx.font = "500 25px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = "#d6e4d8";
        ctx.fillText(actor.name, 128, 25, 244);
        const texture = new CanvasTexture(canvas);
        texture.colorSpace = SRGBColorSpace;
        material = new SpriteMaterial({
          map: texture,
          transparent: true,
          depthWrite: false,
          toneMapped: false,
          fog: true,
        });
        this.labels.set(actor.name, material);
      }
      visual.label = new Sprite(material);
      visual.label.scale.set(1.12, 0.21, 1);
      this.floorRoot.add(visual.label);
    }
    visual.label.visible = true;
    visual.label.position.set(actor.x, 1.98, actor.y);
  }

  private color(tint: Tint, palette: Palette, kind?: FurnitureKind): Color {
    switch (tint) {
      case "edge":
        return palette.edge;
      case "dark":
        return palette.dim;
      case "metal":
        return palette.metal;
      case "screen":
        return palette.terminal;
      case "skin":
        return palette.ink;
      case "leaf":
        return palette.leaf;
      default:
        switch (kind) {
          case "desk":
          case "table":
          case "cafeTable":
          case "coffeeTable":
          case "reception":
          case "chair":
          case "shelf":
          case "box":
            return palette.wood;
          case "sofa":
          case "armchair":
          case "officeChair":
          case "partition":
            return palette.fabric;
          case "fridge":
          case "cabinet":
          case "drawers":
          case "cooler":
          case "printer":
          case "microwave":
            return palette.white;
          case "plant":
            return palette.pot;
          default:
            return palette.furniture;
        }
    }
  }

  private release(visual: Visual) {
    this.clearSpeech(visual);
    for (const part of visual.parts) this.pools[part.batch].release(part.slot);
    visual.label?.removeFromParent();
    delete visual.label;
  }

  private clearStatic() {
    while (this.staticWorld.children.length) {
      const mesh = this.staticWorld.children[0] as Mesh<
        BufferGeometry,
        MeshStandardMaterial
      >;
      mesh.removeFromParent();
      mesh.geometry.dispose();
    }
    if (this.pools)
      for (const panel of this.panels) this.pools.panel.release(panel.slot);
    this.panels.length = 0;
  }

  private clearFloor() {
    this.atmosphere.reset();
    for (const context of this.floorScenes.values()) {
      for (const visual of context.visuals.values()) this.clearSpeech(visual);
      for (const child of context.staticWorld.children)
        (child as Mesh).geometry.dispose();
      for (const pool of context.poolList) pool.dispose(false);
      context.root.removeFromParent();
    }
    this.floorScenes.clear();
    this.poolList = [];
    this.visuals = new Map();
    this.panels = [];
    this.theme = "";
    this.architectureKey = "";
    this.shellKey = "";
    this.renderer.renderLists.dispose();
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFloor();
    this.exterior.dispose();
    this.atmosphere.dispose();
    this.building.dispose();
    this.gallery.dispose();
    for (const material of Object.values(this.materials)) material.dispose();
    for (const material of this.floorMaterials.values()) {
      material.map?.dispose();
      material.dispose();
    }
    for (const material of this.labels.values()) {
      material.map?.dispose();
      material.dispose();
    }
    this.labels.clear();
    this.gpuTimer.dispose();
    this.renderer.dispose();
  }
}
