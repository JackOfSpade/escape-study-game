import {
  CONFIG,
  FURNITURE,
  H,
  W,
  type FurnitureKind,
  type Point,
} from "../model";
import { isRecord } from "../records";
import { parseRunDesign, type RunDesign } from "../run-design-contract.mjs";
export const LAB_LIMITS = {
  entities: 512,
  actions: 512,
  checks: 128,
  ticks: 10800,
  bytes: 1_000_000,
};
export type SpawnKind = "player" | "npc" | "zombie" | FurnitureKind;
export interface Spawn extends Point {
  id: string;
  kind: SpawnKind;
  floor?: number;
  hp?: number;
  maxHp?: number;
  w?: number;
  h?: number;
  angle?: number;
  released?: boolean;
  heading?: Point;
  credential?: boolean;
  keys?: number;
  forceField?: "green" | "red" | "exit";
  /** Start an access door with its leaf already open, as if someone just used it. */
  leafOpen?: boolean;
  freeLimit?: number;
  freeDirection?: -1 | 1;
}
export type Action = { tick: number } & (
  | { type: "move"; id: string; x: number; y: number; stairWalk?: boolean }
  | { type: "walkTo"; id: string; x: number; y: number; stairWalk?: boolean }
  | { type: "jump"; id: "human" }
  | { type: "door" | "grip" | "vault"; id: string; target: string }
  | { type: "spawn"; entity: Spawn }
  | { type: "pause"; paused: boolean }
  | { type: "checkpoint" }
  | { type: "decoy"; floor: number; x: number; y: number }
);
export interface Check {
  name: string;
  mode: "at" | "always" | "eventually";
  tick?: number;
  fromTick?: number;
  query:
    | {
        type: "property";
        id: string;
        field:
          | "x"
          | "y"
          | "hp"
          | "maxHp"
          | "floor"
          | "elevation"
          | "falling"
          | "alive"
          | "latched"
          | "absAngle"
          | "doorOpen";
      }
    | { type: "count"; kind: "npc" | "zombie" }
    | {
        type: "region";
        kind: "npc" | "zombie";
        floor: number;
        x1: number;
        y1: number;
        x2: number;
        y2: number;
      }
    | { type: "separation"; ids: string[] }
    | { type: "event"; event: string }
    | { type: "buildingLayoutErrors" }
    | { type: "environmentErrors" }
    /** Intact furniture of one kind, on one floor or across the building. */
    | { type: "furnitureCount"; kind: FurnitureKind; floor?: number }
    | { type: "soundConnected"; floor: number; a: Point; b: Point }
    /** Simulated world time in seconds. */
    | { type: "worldTime" }
    /** Whether the human's run has ended (dead or escaped). */
    | { type: "humanEnded" }
    /**
     * World advancement after the human died/escaped: seconds since
     * `endedAt`, or cumulative same-floor travel of living NPCs/zombies.
     * Returns -1 until the run has ended.
     */
    | { type: "sinceEnd"; metric: "time" | "npcTravel" | "zombieTravel" };
  op: "eq" | "gte" | "lte";
  expected: number | boolean;
}
export interface Scenario {
  version: 1;
  id: string;
  name: string;
  seed: number;
  template: "arena" | "building";
  layout?: "legacy" | "forward" | "randomized";
  rules?: "force-fields";
  /** Optional fresh-run study tempo; omitted keeps legacy timing. */
  pacing?: "study";
  /** Persisted physical exterior streets; omitted retains historical fixtures. */
  city?: boolean;
  /** Saved synthetic AI choices; never invokes a model or reads a real run. */
  design?: RunDesign;
  simulation: "game" | "physics";
  maxTicks: number;
  startTime: number;
  naturalSpawns: boolean;
  entities: Spawn[];
  deleted: string[];
  maps: { floor: number; rows: string[] }[];
  actions: Action[];
  checks: Check[];
}
const kinds = ["player", "npc", "zombie", ...Object.keys(FURNITURE)];
function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw Error(message);
}
function keys(v: Record<string, unknown>, allowed: string[]) {
  requireThat(
    Object.keys(v).every((key) => allowed.includes(key)),
    `Unknown field: ${Object.keys(v).find((key) => !allowed.includes(key))}`,
  );
}
function number(v: unknown, min: number, max: number) {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}
function integer(v: unknown, min: number, max: number) {
  return number(v, min, max) && Number.isInteger(v);
}
function id(v: unknown) {
  return typeof v === "string" && /^[a-zA-Z0-9][\w-]{0,95}$/.test(v);
}
function point(v: unknown, city = false) {
  return (
    isRecord(v) &&
    number(v.x, city ? -2048 : 0, city ? 2048 : W) &&
    number(v.y, city ? -2048 : 0, city ? 2048 : H)
  );
}
function floor(v: unknown) {
  return integer(v, 0, CONFIG.floors);
}
function spawn(v: unknown, city = false): asserts v is Spawn {
  requireThat(
    isRecord(v) &&
      id(v.id) &&
      kinds.includes(String(v.kind)) &&
      point(v, city && (v.floor === undefined || v.floor === 0)),
    "Entity needs a valid ID, kind and in-bounds position.",
  );
  keys(v, [
    "id",
    "kind",
    "x",
    "y",
    "floor",
    "hp",
    "maxHp",
    "w",
    "h",
    "angle",
    "released",
    "heading",
    "credential",
    "keys",
    "forceField",
    "leafOpen",
    "freeLimit",
    "freeDirection",
  ]);
  requireThat(
    (v.kind === "player") === (v.id === "human"),
    "The player must use ID human; other entities must use different IDs.",
  );
  requireThat(v.floor === undefined || floor(v.floor), "Invalid entity floor.");
  for (const key of ["w", "h"])
    requireThat(
      v[key] === undefined || number(v[key], 0.1, 10),
      "Entity dimensions must be between 0.1 and 10.",
    );
  requireThat(
    v.hp === undefined || number(v.hp, 0, 10000),
    "Invalid entity health.",
  );
  requireThat(
    v.maxHp === undefined || number(v.maxHp, 1, 10000),
    "Invalid maximum health.",
  );
  requireThat(
    v.maxHp === undefined ||
      v.hp === undefined ||
      (v.hp as number) <= (v.maxHp as number),
    "Health exceeds maximum health.",
  );
  requireThat(
    v.angle === undefined || number(v.angle, -180, 180),
    "Angle must be in degrees between -180 and 180.",
  );
  if (v.kind === "door")
    requireThat(
      v.angle === undefined || number(v.angle, -70, 70),
      "Door swing must be between -70 and 70 degrees.",
    );
  requireThat(
    v.keys === undefined || integer(v.keys, 0, 100),
    "Invalid key count.",
  );
  requireThat(
    v.freeLimit === undefined || integer(v.freeLimit, 1, 100),
    "Invalid free-entry limit.",
  );
  requireThat(
    v.forceField === undefined ||
      ((v.kind === "door" || v.kind === "gate") &&
        ["green", "red", "exit"].includes(String(v.forceField))),
    "Invalid force field.",
  );
  requireThat(
    v.leafOpen === undefined ||
      (v.leafOpen === true && v.forceField !== undefined),
    "Only an access door can start with its leaf open.",
  );
  requireThat(
    v.freeDirection === undefined ||
      ((v.freeDirection === -1 || v.freeDirection === 1) &&
        v.forceField !== undefined &&
        v.freeLimit !== undefined),
    "A free-entry direction must be -1 or 1 on a field with a quota.",
  );
  for (const key of ["released", "credential"])
    requireThat(
      v[key] === undefined || typeof v[key] === "boolean",
      "Invalid entity flag.",
    );
  requireThat(
    v.heading === undefined ||
      (isRecord(v.heading) &&
        number(v.heading.x, -1, 1) &&
        number(v.heading.y, -1, 1)),
    "Invalid heading.",
  );
}
/** JSON only: a scenario never imports executable code or a real game save. */
export function parseScenario(value: string | unknown): Scenario {
  if (typeof value === "string")
    requireThat(
      new TextEncoder().encode(value).length <= LAB_LIMITS.bytes,
      "Scenario exceeds 1 MB.",
    );
  const s: unknown = typeof value === "string" ? JSON.parse(value) : value;
  requireThat(
    isRecord(s) &&
      s.version === 1 &&
      id(s.id) &&
      typeof s.name === "string" &&
      s.name.length > 0 &&
      s.name.length <= 160,
    "Unsupported scenario; expected a version 1 Test Lab setup.",
  );
  keys(s, [
    "version",
    "id",
    "name",
    "seed",
    "template",
    "layout",
    "rules",
    "pacing",
    "city",
    "design",
    "simulation",
    "maxTicks",
    "startTime",
    "naturalSpawns",
    "entities",
    "deleted",
    "maps",
    "actions",
    "checks",
  ]);
  requireThat(
    s.rules === undefined || s.rules === "force-fields",
    "Invalid gameplay rules.",
  );
  requireThat(
    s.pacing === undefined || s.pacing === "study",
    'Invalid pacing; only "study" may be set.',
  );
  requireThat(
    s.city === undefined || typeof s.city === "boolean",
    "City must be a boolean.",
  );
  requireThat(
    !s.city ||
      (s.template === "building" &&
        s.layout === "randomized" &&
        s.rules === "force-fields"),
    "A physical city requires a randomized force-field building.",
  );
  requireThat(
    integer(s.seed, 0, 0xffffffff) &&
      ["arena", "building"].includes(String(s.template)) &&
      (s.layout === undefined ||
        ["legacy", "forward", "randomized"].includes(String(s.layout))) &&
      ["game", "physics"].includes(String(s.simulation)),
    "Invalid seed, template or simulation.",
  );
  requireThat(
    s.layout !== "randomized" ||
      (s.template === "building" && s.rules === "force-fields"),
    "Randomized layouts require a building and force-field rules.",
  );
  if (s.design !== undefined) {
    requireThat(
      s.template === "building" &&
        s.layout === "randomized" &&
        s.rules === "force-fields",
      "Authored designs require a randomized force-field building.",
    );
    const design = parseRunDesign(s.design);
    requireThat(
      design.version !== 3 || (s.city === true && s.pacing === "study"),
      "Version 3 environment fixtures require the complete physical city and study pacing.",
    );
  }
  requireThat(
    integer(s.maxTicks, 1, LAB_LIMITS.ticks) &&
      number(s.startTime, 0, 86400) &&
      typeof s.naturalSpawns === "boolean",
    "Invalid test duration or spawn setting.",
  );
  for (const [key, limit] of [
    ["entities", LAB_LIMITS.entities],
    ["actions", LAB_LIMITS.actions],
    ["checks", LAB_LIMITS.checks],
    ["deleted", 512],
    ["maps", 5],
  ] as const)
    requireThat(
      Array.isArray(s[key]) && s[key].length <= limit,
      `Invalid or oversized ${key} list.`,
    );
  const entities = s.entities as unknown[];
  entities.forEach((e) => spawn(e, s.city === true));
  requireThat(
    new Set(entities.map((e) => (e as Spawn).id)).size === entities.length,
    "Duplicate entity IDs.",
  );
  requireThat(
    (s.deleted as unknown[]).every((v) => id(v) && v !== "human"),
    "Invalid deleted entity ID; player cannot be removed.",
  );
  for (const map of s.maps as unknown[])
    requireThat(
      isRecord(map) &&
        floor(map.floor) &&
        Array.isArray(map.rows) &&
        map.rows.length === H &&
        map.rows.every(
          (row) =>
            typeof row === "string" && row.length === W && /^[.#]+$/.test(row),
        ),
      `Maps must have ${H} rows of ${W} floor/wall cells.`,
    );
  requireThat(
    new Set((s.maps as { floor: number }[]).map((m) => m.floor)).size ===
      (s.maps as unknown[]).length,
    "Duplicate floor maps.",
  );
  for (const a of s.actions as unknown[]) {
    requireThat(
      isRecord(a) && integer(a.tick, 1, s.maxTicks as number),
      "Action tick is outside the test duration.",
    );
    keys(a, [
      "tick",
      "type",
      "id",
      "target",
      "entity",
      "x",
      "y",
      "paused",
      "floor",
      "stairWalk",
    ]);
    if (a.type === "decoy")
      requireThat(
        s.simulation === "game" &&
          floor(a.floor) &&
          point(a, s.city === true && a.floor === 0) &&
          Object.keys(a).length === 5,
        "Decoy actions require game simulation, a floor and an in-bounds position.",
      );
    else if (a.type === "spawn") spawn(a.entity, s.city === true);
    else if (a.type === "pause")
      requireThat(
        s.simulation === "game" &&
          typeof a.paused === "boolean" &&
          Object.keys(a).length === 3,
        "Pause actions require game simulation and a boolean paused value.",
      );
    else if (a.type === "move")
      requireThat(
        id(a.id) &&
          number(a.x, -1, 1) &&
          number(a.y, -1, 1) &&
          (a.stairWalk === undefined ||
            (typeof a.stairWalk === "boolean" &&
              s.simulation === "game" &&
              a.id === "human")) &&
          (s.simulation === "physics" || a.id === "human"),
        "Move actions control the player in game mode, or character motors in physics mode.",
      );
    else if (a.type === "walkTo")
      requireThat(
        s.simulation === "game" &&
          a.id === "human" &&
          point(a, s.template === "building") &&
          (a.stairWalk === undefined || typeof a.stairWalk === "boolean") &&
          Object.keys(a).length === (a.stairWalk === undefined ? 5 : 6),
        "WalkTo actions steer the human in game simulation toward a bounded world point.",
      );
    else if (a.type === "jump")
      requireThat(
        s.simulation === "game" &&
          a.id === "human" &&
          Object.keys(a).length === 3,
        "Jump actions control the human in game simulation.",
      );
    else if (["door", "grip", "vault"].includes(String(a.type)))
      requireThat(id(a.id) && id(a.target), "Invalid interaction IDs.");
    else requireThat(a.type === "checkpoint", "Unknown action type.");
  }
  for (const c of s.checks as unknown[]) {
    requireThat(
      isRecord(c) &&
        typeof c.name === "string" &&
        c.name.length > 0 &&
        c.name.length <= 160 &&
        ["at", "always", "eventually"].includes(String(c.mode)),
      "Invalid check name or mode.",
    );
    requireThat(
      ["eq", "gte", "lte"].includes(String(c.op)) &&
        (typeof c.expected === "boolean"
          ? c.op === "eq"
          : number(c.expected, -100000, 100000)),
      "Invalid check comparison.",
    );
    requireThat(
      c.mode !== "at" || integer(c.tick, 1, s.maxTicks as number),
      "An at-tick check needs a tick inside the test duration.",
    );
    requireThat(
      c.fromTick === undefined || integer(c.fromTick, 1, s.maxTicks as number),
      "Invalid check start tick.",
    );
    keys(c, ["name", "mode", "tick", "fromTick", "query", "op", "expected"]);
    const q = c.query;
    requireThat(isRecord(q), "Missing check query.");
    keys(q, [
      "type",
      "id",
      "field",
      "kind",
      "floor",
      "x1",
      "y1",
      "x2",
      "y2",
      "ids",
      "event",
      "a",
      "b",
      "metric",
    ]);
    if (q.type === "worldTime" || q.type === "humanEnded")
      requireThat(
        Object.keys(q).length === 1 &&
          (q.type === "worldTime"
            ? typeof c.expected === "number"
            : typeof c.expected === "boolean"),
        "World time/ended checks take no parameters and a matching expected type.",
      );
    else if (q.type === "sinceEnd")
      requireThat(
        Object.keys(q).length === 2 &&
          ["time", "npcTravel", "zombieTravel"].includes(String(q.metric)) &&
          typeof c.expected === "number",
        "Invalid sinceEnd check.",
      );
    else if (q.type === "property")
      requireThat(
        id(q.id) &&
          [
            "x",
            "y",
            "hp",
            "maxHp",
            "floor",
            "elevation",
            "falling",
            "alive",
            "latched",
            "doorOpen",
            "absAngle",
          ].includes(String(q.field)),
        "Invalid entity property check.",
      );
    else if (q.type === "count" || q.type === "region") {
      requireThat(
        q.kind === "npc" || q.kind === "zombie",
        "Invalid count kind.",
      );
      if (q.type === "region")
        requireThat(
          floor(q.floor) &&
            number(q.x1, s.city ? -2048 : 0, s.city ? 2048 : W) &&
            number(q.x2, s.city ? -2048 : 0, s.city ? 2048 : W) &&
            number(q.y1, s.city ? -2048 : 0, s.city ? 2048 : H) &&
            number(q.y2, s.city ? -2048 : 0, s.city ? 2048 : H) &&
            (q.x1 as number) <= (q.x2 as number) &&
            (q.y1 as number) <= (q.y2 as number),
          "Invalid check region.",
        );
    } else if (q.type === "separation")
      requireThat(
        Array.isArray(q.ids) &&
          q.ids.length >= 2 &&
          q.ids.length <= 128 &&
          q.ids.every(id) &&
          new Set(q.ids).size === q.ids.length,
        "Separation needs at least two distinct IDs.",
      );
    else if (q.type === "event")
      requireThat(id(q.event), "Invalid event type.");
    else if (q.type === "furnitureCount")
      requireThat(
        Object.keys(q).every((k) => ["type", "kind", "floor"].includes(k)) &&
          typeof q.kind === "string" &&
          Object.hasOwn(FURNITURE, q.kind) &&
          (q.floor === undefined || floor(q.floor)),
        "Furniture counts need a known furniture kind and an optional floor.",
      );
    else if (
      q.type === "buildingLayoutErrors" ||
      q.type === "environmentErrors"
    )
      requireThat(
        Object.keys(q).length === 1,
        "Building layout error checks take no parameters.",
      );
    else
      requireThat(
        q.type === "soundConnected" &&
          floor(q.floor) &&
          point(q.a, s.city === true && q.floor === 0) &&
          point(q.b, s.city === true && q.floor === 0),
        "Unknown or invalid check query.",
      );
  }
  // Copy only schema data; callers may freely edit their original draft.
  return structuredClone(s) as unknown as Scenario;
}
export function emptyScenario(): Scenario {
  return {
    version: 1,
    id: "custom-arena",
    name: "Custom arena",
    seed: 7,
    template: "arena",
    simulation: "game",
    maxTicks: 300,
    startTime: 0,
    naturalSpawns: false,
    entities: [{ id: "human", kind: "player", x: 5.5, y: 12.5 }],
    deleted: [],
    maps: [],
    actions: [],
    checks: [],
  };
}
