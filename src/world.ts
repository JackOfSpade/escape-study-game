import { withOriginalDesks } from "./station-clearance";
import { redesign } from "./force-fields";
import { forwardLayout } from "./forward-layout";
import { ensureDoor } from "./doors";
import { eligible, initialStudy } from "./curriculum";
import {
  type Actor,
  type Encounter,
  type Floor,
  type Game,
  type Item,
  type Roadmap,
  type StudyState,
  CONFIG,
  FURNITURE,
  H,
  rand,
  W,
} from "./model";
import { makeNpcProfile } from "./npc-cognition";
import { applyStudyPacing } from "./study-pacing";
import { spawnGrace } from "./study-pacing";
import { compileOutdoorPlan, createCityPlan, outdoorSite } from "./city-layout";
import { checkOutdoorGeometry } from "./outdoor-plan.mjs";
import { cityZombieSpeed, initCityInvasion } from "./city-invasion";
import {
  parseSavedRunDesign,
  parseRunStructure,
  runStructureFingerprint,
  environmentSurfaceFingerprint,
  type RunDesign,
  type RunStructureV3,
  type SavedRunDesign,
} from "./run-design-contract.mjs";
import {
  buildEnvironmentSurfaces,
  ENVIRONMENT_BUILDER_VERSION,
} from "./environment-surfaces";
import { bindDesignedEnvironment } from "./environment-save";
import {
  groundExtractionPad,
  isOpenSite,
  isSolidOpenFloor,
  siteFormOf,
} from "./open-site";
import type { SurfaceSlot } from "./environment-contract.mjs";

type WorldBlueprint = RunDesign | RunStructureV3;

/** The drawn outdoors of a version 3 design, if it has one. */
export function designedOutdoors(
  blueprint: unknown,
): import("./outdoor-plan.mjs").OutdoorPlan | undefined {
  const setting =
    blueprint && typeof blueprint === "object"
      ? (blueprint as { setting?: { outdoors?: unknown } }).setting
      : undefined;
  return setting?.outdoors as
    import("./outdoor-plan.mjs").OutdoorPlan | undefined;
}
/** Only a fresh run opts into a new neighbourhood; saves retain their exact city. */
export function populateCity(
  g: Game,
  invasion = true,
  blueprint?: WorldBlueprint,
) {
  const floor = g.floors[0];
  if (!floor.boundary) return g;
  const outdoors = designedOutdoors(blueprint ?? g.design?.design);
  floor.city = outdoors
    ? compileOutdoorPlan(floor, outdoors, g.seed)
    : createCityPlan(
        floor,
        g.seed,
        spawnGrace(g) * cityZombieSpeed(g),
        blueprint?.city ?? g.design?.design.city,
      );
  if (invasion) initCityInvasion(g);
  return g;
}
export function actor(id: string, name: string, index: number): Actor {
  const result: Actor = {
    id,
    name,
    // Keep the solid-body arrival queue clear of the physical entrance.
    x: id === "human" ? 19.5 : 21.3 + ((Math.max(1, index) - 1) % 3) * 0.65,
    y:
      id === "human"
        ? 30.5
        : 26.4 + Math.floor((Math.max(1, index) - 1) / 3) * 0.6,
    floor: 0,
    hp: 100,
    alive: true,
    escaped: false,
    heading: { x: 0, y: -1 },
    speed: id === "human" ? CONFIG.playerSpeed : CONFIG.npcSpeed,
    access: [],
    inventory:
      id === "human"
        ? [
            { id: "starter-med", kind: "medkit", weight: 2, charges: 1 },
            { id: "starter-flare", kind: "flare", weight: 1, charges: 2 },
          ]
        : [],
    path: [],
    repath: 0,
    cooldown: 0,
    thought: 0,
    milestone: 0,
    skill: 0.4 + (index % 7) * 0.08,
    risk: 0.2 + (index % 5) * 0.15,
    social: 0.25 + (index % 4) * 0.2,
    role: ["builder", "analyst", "rusher", "medic", "skeptic"][index % 5],
    seen: [],
  };
  if (id !== "human")
    result.technical = makeNpcProfile(id, result.skill, result.role);
  return result;
}
const names = [
  "Maya",
  "Theo",
  "June",
  "Idris",
  "Sora",
  "Alex",
  "Priya",
  "Finn",
  "Lena",
  "Omar",
  "Kit",
  "Nia",
  "Remy",
  "Ash",
  "Val",
  "Bo",
  "Rae",
  "Sam",
  "Zoe",
];
const floorNames = [
  "RECEPTION / INTAKE",
  "PRODUCT & RESEARCH",
  "SYSTEMS / OPERATIONS",
  "EXECUTIVE ARCHIVE",
  "ROOFTOP / EXTRACTION",
];
export function createPlayableGame(
  seed: number,
  r: Roadmap,
  study?: StudyState,
  design?: SavedRunDesign,
): Game {
  const saved = design ? parseSavedRunDesign(design) : undefined;
  let g = buildPlayableGame(seed, r, study, saved?.design, saved);
  if (saved?.design.version === 3) {
    const expected = saved.design.environment.surfaceFingerprint,
      matches = (game: Game) =>
        environmentSurfaceFingerprint(buildEnvironmentSurfaces(game)) ===
        expected;
    if (!matches(g)) {
      g = withOriginalDesks(() =>
        buildPlayableGame(seed, r, study, saved.design, saved),
      );
      if (!matches(g))
        throw Error(
          "Saved environment inventory does not match this generated building",
        );
    }
    bindDesignedEnvironment(g);
  }
  return g;
}

function buildPlayableGame(
  seed: number,
  r: Roadmap,
  study?: StudyState,
  blueprint?: WorldBlueprint,
  saved?: SavedRunDesign,
): Game {
  const g = buildGame(seed, r, study, { layout: "forward" }, blueprint, saved);
  redesign(g, {
    randomized: true,
    ...(blueprint?.version === 3 ? { blueprint } : {}),
  });
  // An open site extracts on its ground floor; the stair marker it keeps for
  // egress validation becomes the pickup pad, so no staircase can be climbed.
  if (isOpenSite(g)) g.extraction = groundExtractionPad(g.floors[0]);
  // Fresh live runs use the study-friendly world tempo; legacy factories keep
  // historical timing for reproducible fixtures.
  let depth = 1;
  try {
    depth = eligible(r, g.study).depth;
  } catch {
    // A temporarily unavailable curriculum question must not prevent the
    // physical world from starting. Generation keeps its own eligibility gate.
  }
  applyStudyPacing(g, depth, blueprint?.pacing);
  populateCity(g, true, blueprint);
  // The opening view presents the approaching street horde immediately.
  // Refuge is just behind the player, where the other survivors are entering.
  g.survivors[0].heading = { x: 0, y: 1 };
  g.notice = `${blueprint ? `${blueprint.opening} ` : ""}Zombies are already approaching. The entrance is behind you; they will reach it in about three minutes.`;
  return g;
}

declare const provisionalBrand: unique symbol;
/** Inspection data only: the incomplete Game is not exposed or serializable. */
export interface ProvisionalRun {
  readonly [provisionalBrand]: true;
  readonly builderVersion: string;
  readonly structureFingerprint: string;
  readonly surfaceFingerprint: string;
  readonly surfaces: SurfaceSlot[];
}
const provisionalRuns = new WeakMap<
  ProvisionalRun,
  { game: Game; structure: RunStructureV3; surfaces: SurfaceSlot[] }
>();

export function previewDesignedRun(
  seed: number,
  roadmap: Roadmap,
  study: StudyState | undefined,
  proposed: RunStructureV3,
): ProvisionalRun {
  const structure = parseRunStructure(proposed),
    game = buildPlayableGame(seed, roadmap, study, structure);
  // Judge a drawn outdoors against the building it was built around. Only
  // proposals are judged, so a saved design always restarts as it was.
  const outdoors = designedOutdoors(structure);
  if (outdoors) {
    const errors = checkOutdoorGeometry(outdoors, outdoorSite(game.floors[0]));
    if (errors.length) throw Error(`Run design: ${errors.join(" ")}`);
  }
  const surfaces = buildEnvironmentSurfaces(game),
    token = Object.freeze({
      builderVersion: ENVIRONMENT_BUILDER_VERSION,
      structureFingerprint: runStructureFingerprint(structure),
      surfaceFingerprint: environmentSurfaceFingerprint(surfaces),
      surfaces: structuredClone(surfaces),
    }) as ProvisionalRun;
  provisionalRuns.set(token, { game, structure, surfaces });
  return token;
}

/**
 * The playable game behind a structure proposal, for previews, GameTest runs
 * and checks that need the built world before an environment is accepted.
 * Imported data stays validated: the structure goes through parseRunStructure.
 */
export function structureGame(
  seed: number,
  roadmap: Roadmap,
  study: StudyState | undefined,
  proposed: RunStructureV3,
): Game {
  return buildPlayableGame(
    seed,
    roadmap,
    study,
    parseRunStructure(structuredClone(proposed)),
  );
}

export function finalizeDesignedRun(
  token: ProvisionalRun,
  proposed: SavedRunDesign,
): Game {
  const candidate = provisionalRuns.get(token);
  if (!candidate)
    throw Error("This provisional run is unavailable or already accepted");
  const saved = parseSavedRunDesign(proposed);
  if (saved.design.version !== 3)
    throw Error("A provisional run requires a complete version 3 design");
  const { environment, ...structure } = saved.design;
  if (
    runStructureFingerprint(structure) !==
      runStructureFingerprint(candidate.structure) ||
    environmentSurfaceFingerprint(environment.surfaces) !==
      environmentSurfaceFingerprint(candidate.surfaces)
  )
    throw Error(
      "Accepted writing does not match the provisional building and surface inventory",
    );
  candidate.game.design = saved;
  bindDesignedEnvironment(candidate.game);
  provisionalRuns.delete(token);
  return candidate.game;
}
/** Legacy layout remains the default for existing scenario/benchmark compatibility. */
export function createGame(
  seed: number,
  r: Roadmap,
  study?: StudyState,
  options: { layout?: "legacy" | "forward"; design?: SavedRunDesign } = {},
): Game {
  const design = options.design
    ? parseSavedRunDesign(options.design)
    : undefined;
  if (design?.design.version === 3)
    throw Error(
      "Version 3 designs require createPlayableGame and their complete physical-city inventory",
    );
  return buildGame(seed, r, study, options, design?.design, design);
}

function buildGame(
  seed: number,
  r: Roadmap,
  study: StudyState | undefined,
  options: { layout?: "legacy" | "forward" },
  blueprint?: WorldBlueprint,
  design?: SavedRunDesign,
): Game {
  const g: Game = {
    ...(design ? { design } : {}),
    schema: 1,
    id: `run-${crypto.randomUUID()}`,
    seed,
    rng: seed,
    time: 0,
    seq: 0,
    status: "ready",
    floors: [],
    survivors: [
      actor("human", "You", 0),
      ...names.slice(0, CONFIG.npcs).map((n, i) => actor(`npc-${i}`, n, i + 1)),
    ],
    zombies: [],
    encounters: {},
    events: [],
    surge: {
      state: "calm",
      anchor: 0,
      quietDelay: 0,
      started: 0,
      duration: 0,
      lastDeath: 0,
      lastEnd: 0,
    },
    nextSpawn: CONFIG.spawnGraceSeconds,
    spawned: 0,
    helicopter: { trip: 0, next: 240, until: 0, passengers: [] },
    effects: [],
    study: study ?? initialStudy(r),
    settings: {
      displayScale: 1,
      volume: 0.45,
      captions: false,
      reducedFlash: false,
    },
    stats: { breaches: 0, rescued: 0, deaths: 0 },
    notice:
      "10 seconds before zombies spawn. E releases the entrance latch; push to enter.",
  };
  if (blueprint)
    for (let i = 0; i < blueprint.roster.length; i++) {
      const a = g.survivors[i + 1];
      Object.assign(a, blueprint.roster[i]);
      a.technical = makeNpcProfile(a.id, a.skill, a.role);
    }
  g.surge.quietDelay =
    CONFIG.quietMin + rand(g) * (CONFIG.quietMax - CONFIG.quietMin);
  for (let fi = 0; fi <= CONFIG.floors; fi++)
    g.floors.push(generateFloor(g, fi, blueprint));
  if (options.layout === "forward")
    for (const floor of g.floors)
      // Open sites have no upper storeys to carve; their layers stay solid.
      if (!isSolidOpenFloor(floor)) forwardLayout(floor, seed);
  for (const floor of g.floors)
    for (const o of floor.furniture) {
      if (o.id === "main-gate") ensureDoor(o, floor);
      o.initial = { x: o.x, y: o.y, w: o.w, h: o.h };
    }
  return g;
}
export function loot(g: Game): Item[] {
  return Array.from({ length: 3 }, (_, i) => ({
    id: `item-${g.id}-${Math.floor(rand(g) * 1e9)}-${i}`,
    kind: (
      [
        "medkit",
        "bubble",
        "flare",
        "repulsor",
        "weapon",
        "decoy",
        "battery",
      ] as const
    )[Math.floor(rand(g) * 7)],
    weight: i === 0 ? 2 : 1,
    charges: 1,
  }));
}
/**
 * A solid, unreachable layer above an open site's ground: no stations,
 * furniture, rooms, doors, stairs or roof cover, and no authored floor.
 */
function solidOpenFloor(index: number, blueprint: WorldBlueprint): Floor {
  return {
    open: true,
    ...("setting" in blueprint && blueprint.setting
      ? { setting: structuredClone(blueprint.setting) }
      : {}),
    index,
    tiles: Array.from({ length: H }, () => Array(W).fill(1)),
    stations: [],
    furniture: [],
    dark: 0,
    name:
      index === CONFIG.floors ? blueprint.roofName : blueprint.floors[0].name,
    rooms: [],
    doors: [],
    stairs: { x: 21.5, y: 3.5 },
    entry: { x: 21.5, y: 26.5 },
  };
}
function generateFloor(
  g: Game,
  index: number,
  blueprint?: WorldBlueprint,
): Floor {
  const open = siteFormOf(blueprint) === "open";
  // An open site authors only its ground floor; construction above stays solid.
  if (open && index > 0) return solidOpenFloor(index, blueprint!);
  const tiles = Array.from({ length: H }, () => Array(W).fill(1));
  for (let y = 2; y < 28; y++) for (let x = 2; x < 42; x++) tiles[y][x] = 0;
  const floor: Floor = {
    ...(open ? { open: true as const } : {}),
    ...(blueprint && index < CONFIG.floors
      ? { design: structuredClone(blueprint.floors[index]) }
      : {}),
    ...(blueprint && index === 0
      ? { exteriorDesign: structuredClone(blueprint.exterior) }
      : {}),
    ...(blueprint && "setting" in blueprint && blueprint.setting
      ? { setting: structuredClone(blueprint.setting) }
      : {}),
    index,
    tiles,
    stations: [],
    furniture: [],
    dark: index === 0 ? 0.1 : index % 3 === 2 ? 0.95 : 0.5,
    name: blueprint
      ? index === CONFIG.floors
        ? blueprint.roofName
        : blueprint.floors[index].name
      : floorNames[index],
    layout: (["archive", "switchback", "gallery"] as const)[
      (g.seed + index) % 3
    ],
    rooms: [],
    doors: [],
    stairs: { x: 21.5, y: 3.5 },
    entry: { x: 21.5, y: 26.5 },
  };
  if (index === CONFIG.floors) {
    // The roof has a defensible stair approach and finite movable cover for
    // passengers waiting for a later helicopter, rather than an empty death box.
    for (let x = 2; x < 42; x++) if (x < 21 || x > 23) tiles[22][x] = 1;
    for (const [i, kind] of (
      ["shelf", "fridge", "sofa", "desk"] as const
    ).entries()) {
      const spec = FURNITURE[kind];
      floor.furniture.push({
        id: `roof-cover-${i}`,
        floor: index,
        kind,
        x: [22.5, 10, 33, 37][i],
        y: [20.5, 18.5, 19.5, 24.5][i],
        w: spec.w,
        h: spec.h,
        hp: spec.hp,
        maxHp: spec.hp,
        speed: spec.speed,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      });
    }
    return floor;
  }
  for (let y = 2; y < 28; y++) for (const x of [17, 26]) tiles[y][x] = 1;
  for (let x = 2; x < 42; x++)
    if (x < 17 || x > 26) for (const y of [14, 16]) tiles[y][x] = 1;
  // Every ordinary floor has a long-study annex. Its narrow passage permits
  // successive real objects; it does not provide health or invulnerability.
  const annexRoom = floor.layout === "gallery" ? 1 : 0;
  if (floor.layout === "switchback")
    for (const [y, gap] of [
      [12, 18],
      [18, 23],
    ])
      for (let x = 18; x <= 25; x++)
        if (x < gap || x > gap + 2) tiles[y][x] = 1;
  for (let room = 0; room < 4; room++) {
    const left = room % 2 === 0,
      upper = room < 2,
      dx = left ? 17 : 26,
      dy = (upper ? 8 : 22) + Math.floor(rand(g) * 3) - 1;
    const annex = room === annexRoom,
      innerX = left ? 13 : 31;
    if (annex) {
      for (let y = 2; y < 14; y++) tiles[y][innerX] = 1;
      for (const y of [dy, dy + 2])
        for (let x = Math.min(dx, innerX); x <= Math.max(dx, innerX); x++)
          tiles[y][x] = 1;
      for (let x = Math.min(dx, innerX); x <= Math.max(dx, innerX); x++)
        tiles[dy + 1][x] = 0;
    } else {
      tiles[dy][dx] = 0;
      tiles[dy + 2][dx] = 0;
    }
    tiles[dy + 1][dx] = 0;
    floor.rooms!.push({
      index: room,
      side: left ? "left" : "right",
      ...(annex ? { innerMouth: { x: innerX + 0.5, y: dy + 1.5 } } : {}),
    });
    floor.doors.push({ x: dx + 0.5, y: dy + 1.5 });
    const shared = room === 0 || room === 3,
      rx = left ? (annex ? 5.5 : 8.5) : 34.5,
      ry = upper ? 6.5 : 20.5;
    const id = `f${index}-room${room}`;
    const e: Encounter = {
      id,
      runId: g.id,
      floor: index,
      mode: shared ? "shared" : "solo",
      reward: room === 2 ? "loot" : "stairs",
      state: "available",
      workspace: "",
      revision: 0,
      history: [],
      group: [],
      tutor: [],
      submissions: [],
      contributors: [],
      chatCursor: 0,
      chatOpen: false,
      recentSpeakers: [],
      npcProgress: 0,
      loot: loot(g),
      scroll: 0,
      selection: [0, 0],
    };
    g.encounters[id] = e;
    floor.furniture.push({
      id: `${id}-door`,
      floor: index,
      kind: "door",
      x: dx + 0.5,
      y: dy + 1.5,
      w: 1,
      h: annex ? 1 : 3,
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
    });
    const count = shared ? 5 : room === 1 ? 6 : 3;
    for (let i = 0; i < count; i++) {
      const encounterId = shared || i === 0 ? id : `${id}-solo${i}`;
      if (encounterId !== id)
        g.encounters[encounterId] = {
          ...structuredClone(e),
          id: encounterId,
          loot: loot(g),
        };
      floor.stations.push({
        id: `${id}-station${i}`,
        encounter: encounterId,
        x: rx + (i % 3) * 2,
        y: ry + Math.floor(i / 3) * 2,
      });
    }
    for (let i = 0; i < 7; i++) {
      const kind = (
          ["shelf", "fridge", "sofa", "desk", "chair", "shelf", "desk"] as const
        )[i],
        spec = FURNITURE[kind];
      floor.furniture.push({
        id: `${id}-${kind}${i}`,
        floor: index,
        x: annex
          ? (left
              ? [4.5, 3.5, 9.5, 4.5, 3.5, 11.5, 8.5]
              : [39.5, 40.5, 35.5, 39.5, 40.5, 33.5, 35.5])[i]
          : i === 5
            ? left
              ? 14.5
              : 29.5
            : left
              ? 4.5 + (i % 3) * 3.5
              : 32 + (i % 3) * 3.5,
        y: annex
          ? [4.5, 12, 4.5, 10.5, 13, 4.5, 13][i]
          : i === 5
            ? dy + 1.5
            : (upper ? 10 : 24) + Math.floor(i / 3) * 1.25,
        kind,
        w: i === 5 ? spec.h : spec.w,
        h: i === 5 ? spec.w : spec.h,
        hp: spec.hp,
        maxHp: spec.hp,
        speed: spec.speed,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      });
    }
  }
  // A shared cluster can legitimately finish with only one qualifying solver.
  // Budget independent one-use opportunities for the initial population rather
  // than counting its five stations as five guaranteed credentials. Extra solo
  // stations occupy the lower-left study room from the start; nothing respawns.
  const mandatoryCount = new Set(
    floor.stations
      .filter((s) => g.encounters[s.encounter].reward === "stairs")
      .map((s) => s.encounter),
  ).size;
  const needed = Math.max(0, g.survivors.length - mandatoryCount);
  const capacitySlots = Array.from({ length: 12 }, (_, i) => ({
    x: i === 11 ? 4.5 : 4.5 + (i % 6) * 2,
    y: i === 11 ? 20.5 : i < 6 ? 18.5 : 22.5,
  }));
  if (needed > capacitySlots.length)
    throw new Error(
      "Floor template lacks initial mandatory terminal capacity.",
    );
  for (const [i, point] of capacitySlots.slice(0, needed).entries()) {
    const id = `f${index}-room2-access${i}`;
    g.encounters[id] = {
      ...structuredClone(g.encounters[`f${index}-room2`]),
      id,
      reward: "stairs",
      loot: [],
    };
    floor.stations.push({ id: `${id}-station`, encounter: id, ...point });
  }
  const annexDoor = floor.doors[annexRoom],
    spec = FURNITURE.fridge;
  floor.furniture.push({
    id: `f${index}-corridor-fridge`,
    floor: index,
    kind: "fridge",
    x: 21.5,
    y: annexDoor.y,
    w: spec.w,
    h: spec.h,
    hp: spec.hp,
    maxHp: spec.hp,
    speed: spec.speed,
    rotation: 0,
    destroyed: false,
    movers: [],
    moved: 0,
    credited: [],
    turning: 0,
  });
  if (index === 0) {
    for (let y = 29; y < H; y++) for (let x = 18; x <= 25; x++) tiles[y][x] = 0;
    tiles[28][21] = 0;
    tiles[28][22] = 0;
    const spec = FURNITURE.gate;
    floor.furniture.push({
      id: "main-gate",
      floor: 0,
      x: 22,
      y: 28.5,
      kind: "door",
      w: spec.w,
      h: 1,
      hp: spec.hp,
      maxHp: spec.hp,
      speed: 0,
      rotation: 0,
      destroyed: false,
      movers: [],
      moved: 0,
      credited: [],
      turning: 0,
    });
  }
  return floor;
}
