import { settingErrors } from "./venue";
import { moveBlockingDesks } from "./station-clearance";
import { presetDoorStyle } from "./door-style";
import { pursuitLayout, pursuitLayoutErrors } from "./pursuit-layout";
import { forwardFieldQuota } from "./office-plan";
import {
  buildingLayoutErrors,
  buildingRoof,
  createBuildingFootprint,
} from "./building-layout";
import { carveStairwells } from "./stairwell";
import {
  fieldClearance,
  furnishOffice,
  furnishingErrors,
  pursuitOfficeZones,
} from "./office-layout";
import { rayBodyDistance } from "./visibility";
import { inFurniture, line, solid } from "./spatial";
import {
  CONFIG,
  devPass,
  type Actor,
  type Floor,
  type Furniture,
  type Game,
  type Point,
  event,
} from "./model";

export const SWARM = { cap: 600, interval: 1, batch: 4, speedRatio: 0.5 };
/** Whether this actor's access would admit them; a closed leaf still stops them. */
export function fieldAllows(o: Furniture, a: Pick<Actor, "id" | "access">) {
  const f = o.field;
  return (
    !!f &&
    (o.destroyed ||
      devPass(a) ||
      f.authorized.includes(a.id) ||
      f.crossing.includes(a.id) ||
      (f.exit && a.access.includes(o.floor)) ||
      (f.limit === undefined ? !f.exit : f.used < f.limit))
  );
}
/** A swinging leaf clears the opening about halfway through its travel. */
function leafClear(f: NonNullable<Furniture["field"]>) {
  return (f.leaf?.open ?? 0) >= DOOR_LEAF.passableOpen;
}
/** Passing takes both a personal right and an open leaf. Someone else opening
 * the door leaves it an invisible wall for anyone without access, and someone
 * with access still has to open it. */
export function fieldPassable(o: Furniture, a: Pick<Actor, "id" | "access">) {
  const f = o.field;
  return (
    !!f &&
    fieldAllows(o, a) &&
    (o.destroyed || leafClear(f) || f.crossing.includes(a.id))
  );
}
/** Whether an intact force field lies on the straight segment a->b. */
export function fieldBetween(f: Floor, a: Point, b: Point): boolean {
  const near = f.furniture.filter((o) => {
    if (!o.field || o.destroyed) return false;
    const r = (o.w + o.h) / 2;
    return (
      o.x + r >= Math.min(a.x, b.x) &&
      o.x - r <= Math.max(a.x, b.x) &&
      o.y + r >= Math.min(a.y, b.y) &&
      o.y - r <= Math.max(a.y, b.y)
    );
  });
  if (near.length === 0) return false;
  const d = Math.hypot(b.x - a.x, b.y - a.y),
    n = Math.max(1, Math.ceil(d / 0.15));
  for (let i = 0; i <= n; i++) {
    const p = {
      x: a.x + ((b.x - a.x) * i) / n,
      y: a.y + ((b.y - a.y) * i) / n,
    };
    if (near.some((o) => inFurniture(p, o))) return true;
  }
  return false;
}
/** Whether an actor can plan an interaction, including spending its own key. */
export function canUseField(o: Furniture, a: Actor) {
  return !o.field || fieldAllows(o, a) || (a.keys ?? 0) > 0;
}
export function fieldRouteSignature(f: Floor, a: Actor) {
  return `${(a.keys ?? 0) > 0};${f.furniture
    .filter((o) => o.field)
    .map((o) => `${o.id}:${fieldAllows(o, a)}`)
    .join(";")}`;
}
/** One actor's field access on a floor as a compact token: key possession plus
 * one admission bit per field in furniture order. Route invalidation and floor
 * views share it so both read "has this actor's access changed?" the same way
 * without rebuilding a furniture-wide geometry string. */
export function fieldAccessKey(
  f: Floor,
  a: Pick<Actor, "id" | "access" | "keys">,
) {
  let access = (a.keys ?? 0) > 0 ? "k" : "-";
  for (const o of f.furniture)
    if (o.field) access += fieldAllows(o, a) ? "1" : "0";
  return access;
}
export function useField(g: Game, a: Actor, o: Furniture) {
  if (!o.field) return false;
  if (fieldAllows(o, a)) {
    openDoorLeaf(o, a);
    return true;
  }
  if ((a.keys ?? 0) < 1) {
    if (a.id === "human")
      g.notice = o.field.leaf
        ? "This door is open, but not for you: one key or a solved solo terminal on this floor is required to walk through."
        : "Locked door: one key required, or solve a solo terminal on this floor for access. There is no other way through this wall.";
    return false;
  }
  a.keys = (a.keys ?? 0) - 1;
  o.field.authorized.push(a.id);
  a.path = [];
  a.repath = 0;
  event(
    g,
    "field-key",
    `${a.name} spent one key for personal access through a door.`,
    a.floor,
    a.id,
  );
  if (a.id === "human")
    g.notice = "Key consumed. You can now open this door whenever you need it.";
  openDoorLeaf(o, a);
  return true;
}

/** Fresh-run redesign; historical saves and lab fixtures retain their original rules. */
export function redesign(
  g: Game,
  options: {
    randomized?: boolean;
    blueprint?: import("./run-design-contract.mjs").RunStructureV3;
  } = {},
) {
  g.rules = "force-fields";
  if (options.randomized) {
    const boundary = createBuildingFootprint(
      g.seed,
      options.blueprint?.footprint ?? g.design?.design.footprint,
    );
    for (const f of g.floors) f.boundary = structuredClone(boundary);
  }
  for (const a of g.survivors) {
    a.inventory = [];
    a.keys = 0;
    a.speed = CONFIG.playerSpeed;
  }
  const assigned = new Set<string>();
  for (const f of g.floors) {
    // Generated legacy furniture is replaced: doors become fields and the
    // office pieces are placed again for the new floor plan below.
    f.furniture = f.furniture.filter(
      (o) => o.kind === "door" || o.kind === "gate",
    );
    for (const o of f.furniture) {
      const frame = o.door?.frame ?? o;
      Object.assign(o, {
        x: frame.x,
        y: frame.y,
        w: frame.w,
        h: frame.h,
        angle: 0,
        open: false,
      });
      delete o.door;
      const entrance = /room(\d+)-door$/.exec(o.id);
      o.hp = o.maxHp = o.id === "main-gate" ? 600 : entrance ? 1200 : 900;
      const publicEntry = entrance?.[1] === "2";
      o.field = {
        ...(publicEntry ? { publicEntry: true } : {}),
        authorized: [],
        crossing: [],
        sides: {},
        used: 0,
        exit: !entrance && o.id !== "main-gate",
        ...(entrance && !publicEntry
          ? {
              limit: forwardFieldQuota(g, f, Number(entrance[1])),
              direction: Number(entrance[1]) % 2 === 0 ? -1 : 1,
            }
          : {}),
      };
    }
    // Room peers share a question, with an independent one-use solo answer per station.
    for (const s of f.stations) {
      const original = g.encounters[s.encounter];
      const id = assigned.has(s.encounter) ? `${s.id}-solo` : s.encounter;
      assigned.add(s.encounter);
      g.encounters[id] = {
        ...structuredClone(original),
        id,
        questionRoom: /^(f\d+-room\d+)/.exec(s.id)?.[1],
        mode: "solo",
        reward: "stairs",
        loot: [],
      };
      s.encounter = id;
    }
  }
  // The roof's arrival staircase is carved like the ordinary floors' wells.
  const roof = g.floors[CONFIG.floors];
  if (roof && g.floors.some((f) => f.generation?.version === 2)) {
    if (roof.boundary) buildingRoof(roof);
    else carveStairwells(roof);
  }
  const designed = Boolean(g.design || options.blueprint);
  const floorErrors: string[] = [];
  for (const floor of g.floors)
    if (floor.generation?.version === 2) {
      pursuitLayout(g, floor);
      if (!floor.design)
        moveBlockingDesks(floor, () => !pursuitLayoutErrors(g, floor).length);
      // Fresh runs are furnished from their venue (an office unless the design
      // chose otherwise): a few movable physical pieces per room, kept clear
      // of every field opening and terminal.
      const furnish = () =>
        furnishOffice(
          floor,
          pursuitOfficeZones(floor),
          fieldClearance(floor),
          floor.entry,
          g.seed,
          floor.furniture.filter((o) => /-room\d-door$/.test(o.id)),
        );
      if (designed) {
        // Report every floor's problems together for one repair round.
        try {
          furnish();
        } catch (error) {
          floorErrors.push(
            error instanceof Error ? error.message : String(error),
          );
          continue;
        }
      } else furnish();
      applyDoorDesign(g, floor, options.blueprint);
      // Saved designs bind writing to the furnished building, so their
      // terminals move only around what is already placed.
      if (floor.design)
        moveBlockingDesks(floor, () => !pursuitLayoutErrors(g, floor).length);
      if (g.design || options.blueprint) {
        const errors = [
          ...pursuitLayoutErrors(g, floor),
          ...furnishingErrors(floor),
        ];
        if (errors.length)
          floorErrors.push(
            `Invalid designed floor ${floor.index}: ${errors.join("; ")}`,
          );
      }
    }
  if (floorErrors.length) throw Error(floorErrors.join("; "));
  if (options.randomized) {
    const errors = buildingLayoutErrors(g);
    if (errors.length) throw Error(`Invalid building: ${errors.join("; ")}`);
  }
  if (g.design || options.blueprint) {
    const errors = settingErrors(g.floors[0]?.setting, g.floors[0]?.boundary);
    if (errors.length) throw Error(`Invalid building: ${errors.join("; ")}`);
  }
  const used = new Set(
    g.floors.flatMap((f) => f.stations.map((s) => s.encounter)),
  );
  for (const id of Object.keys(g.encounters))
    if (!used.has(id)) delete g.encounters[id];
  g.notice =
    "Doors stay closed: press E to open one you have access to and it closes behind you; zombies must break them. Access is personal, so a door someone else opened still stops you. E uses a key on a locked door. Solve a solo terminal for stair access and a key.";
}

/** A run design may restyle a door and set its starting health. Study pacing
 * can still raise the hall entrance, so a design cannot shorten that promise. */
function applyDoorDesign(
  g: Game,
  floor: Floor,
  blueprint?: import("./run-design-contract.mjs").RunStructureV3,
) {
  const design = blueprint ?? g.design?.design;
  const designed = design?.floors[floor.index]?.doors;
  for (const o of floor.furniture) {
    if (!o.field) continue;
    const room = /room(\d+)-(?:door|forward)$/.exec(o.id)?.[1];
    const choice =
      o.id === "main-gate"
        ? design?.mainDoor
        : room !== undefined
          ? designed?.[Number(room)]
          : undefined;
    if (!choice) {
      o.doorStyle = presetDoorStyle(o.id, g.seed);
      continue;
    }
    const { health, ...style } = choice;
    o.doorStyle = style;
    o.hp = o.maxHp = health;
  }
}

const FIELD_RADIUS = 0.26;
function paidAccess(o: Furniture, a: Actor) {
  return (
    devPass(a) ||
    o.field!.authorized.includes(a.id) ||
    (o.field!.exit && a.access.includes(o.floor))
  );
}
function fieldSide(o: Furniture, p: Point) {
  const axis = o.h >= o.w ? "x" : "y";
  return Math.sign(p[axis] - o[axis]);
}
/** Reject toward the approach face, choosing clear nearby space in a crowded doorway. */
function ejectFromField(g: Game, o: Furniture, a: Actor, side: number) {
  const floor = g.floors[o.floor];
  const axis = o.h >= o.w ? "x" : "y";
  const along = axis === "x" ? "y" : "x";
  const half = (axis === "x" ? o.w : o.h) / 2;
  let fallback: Point | undefined;
  let chosen: Point | undefined;
  for (let depth = 0; depth <= 8 && !chosen; depth++) {
    for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const p = {
        ...a,
        [axis]: o[axis] + side * (half + FIELD_RADIUS + 0.02 + depth * 0.55),
        [along]: a[along] + offset * 0.55,
      };
      if (solid(floor, p, FIELD_RADIUS, o.id) || !line(floor, a, p, true, o.id))
        continue;
      fallback ??= p;
      if (
        g.survivors.some(
          (b) =>
            b !== a &&
            b.alive &&
            !b.escaped &&
            b.floor === a.floor &&
            Math.hypot(b.x - p.x, b.y - p.y) < 0.52,
        ) ||
        g.zombies.some(
          (z) =>
            z.hp > 0 &&
            z.floor === a.floor &&
            Math.hypot(z.x - p.x, z.y - p.y) < 0.52,
        )
      )
        continue;
      chosen = p;
      break;
    }
  }
  chosen ??= fallback;
  if (!chosen) return;
  a.x = chosen.x;
  a.y = chosen.y;
  a.physics = { x: 0, y: 0, angular: 0, awake: true };
  a.path = [];
  a.repath = 0;
  delete a.vault;
  if (a.id === "human")
    g.notice =
      (a.keys ?? 0) > 0
        ? "Locked door. Press E to spend a key."
        : "Locked door: entry denied. A key or a solved solo terminal on this floor is required.";
  const ev = event(
    g,
    "field-denied",
    `${a.name} was stopped by a locked door.`,
    a.floor,
    a.id,
  );
  ev.position = { x: o.x, y: o.y };
}

/** Resolve actual swept first touches atomically after every native physics substep. */
export function updateFields(g: Game, previous?: ReadonlyMap<string, Point>) {
  for (const floor of g.floors) {
    // One alive-people list per floor, not per field: the filter used to run
    // once for every field on the floor.
    let people: Actor[] | undefined;
    for (const o of floor.furniture) {
      const f = o.field;
      if (!f || o.destroyed) continue;
      if (f.touchVersion !== 1) {
        // Old saves granted everyone in the doorway a grace pass, without reserving
        // capacity. Those uncharged passes cannot bypass the instant admission rule.
        f.crossing = [];
        if (f.limit !== undefined) f.used = Math.min(f.limit, f.used);
        f.touchVersion = 1;
      }
      people ??= g.survivors.filter(
        (a) => a.alive && !a.escaped && a.floor === floor.index,
      );
      f.crossing = f.crossing.filter((id) =>
        people!.some(
          (a) => a.id === id && inFurniture(a, o, FIELD_RADIUS + 0.03),
        ),
      );
      // Anyone whose current and previous position both sit outside this reach
      // cannot touch or sweep across the field, so they are skipped unexamined.
      const reach = Math.max(o.w, o.h) / 2 + FIELD_RADIUS + 1;
      const candidates = people
        .filter((a) => {
          const from = previous?.get(a.id) ?? a;
          return (
            Math.hypot(a.x - o.x, a.y - o.y) <= reach ||
            Math.hypot(from.x - o.x, from.y - o.y) <= reach
          );
        })
        .map((a) => {
          const from = previous?.get(a.id) ?? a;
          const length = Math.hypot(a.x - from.x, a.y - from.y);
          const origin =
            f.sides[a.id] || fieldSide(o, from) || -(f.direction ?? 1);
          const hit =
            length > 1e-9
              ? rayBodyDistance(
                  from,
                  (a.x - from.x) / length,
                  (a.y - from.y) / length,
                  o,
                  FIELD_RADIUS,
                )
              : Infinity;
          const touching = inFurniture(a, o, FIELD_RADIUS + 0.001);
          const axis = o.h >= o.w ? "x" : "y";
          const penetration =
            (axis === "x" ? o.w : o.h) / 2 +
            FIELD_RADIUS -
            origin * (from[axis] - o[axis]);
          const time = inFurniture(from, o, FIELD_RADIUS)
            ? -Math.max(0, penetration)
            : hit / (length || 1);
          return {
            a,
            from,
            origin,
            time,
            contact: touching || hit <= length + 1e-8,
          };
        })
        .filter((c) => c.contact)
        .sort((a, b) => a.time - b.time || a.a.id.localeCompare(b.a.id));
      for (const { a, origin } of candidates) {
        if (paidAccess(o, a) || f.crossing.includes(a.id)) continue;
        if (
          (f.limit === undefined && f.exit) ||
          (f.limit !== undefined && f.used >= f.limit)
        ) {
          // Native contact slop at a closed face is harmless. Actual overlap is
          // removed now, before another physics step or a rendered frame.
          if (inFurniture(a, o, FIELD_RADIUS - 0.01))
            ejectFromField(g, o, a, origin);
          continue;
        }
        if (f.limit === undefined || !leafClear(f)) continue;
        f.crossing.push(a.id);
        if (origin === -(f.direction ?? 1) && !f.visitors?.includes(a.id)) {
          (f.visitors ??= []).push(a.id);
          f.used++;
          const ev = event(
            g,
            "field-entry",
            `${a.name} claimed a free entrance pass on first touch.`,
            floor.index,
            a.id,
          );
          ev.position = { x: o.x, y: o.y };
          if (f.used === f.limit) {
            const sealed = event(
              g,
              "field-sealed",
              "Free passes exhausted. A personal key or a solved solo terminal on this floor is now required.",
              floor.index,
            );
            sealed.position = { x: o.x, y: o.y };
          }
        }
      }
      for (const a of people)
        if (!inFurniture(a, o, FIELD_RADIUS + 0.03))
          f.sides[a.id] = fieldSide(o, a);
    }
  }
}
export const DOOR_LEAF = {
  openSeconds: 0.3,
  closeSeconds: 0.55,
  /** How long it stays open after someone clears the doorway. */
  holdSeconds: 0.35,
  /** How long a door opened with E waits for its opener to walk through. */
  waitSeconds: 3,
  reach: 1.1,
  passableOpen: 0.5,
} as const;
function wantsDoorOpen(o: Furniture, a: Actor) {
  if (inFurniture(a, o, FIELD_RADIUS + 0.2)) return true;
  const axis = o.h >= o.w ? "x" : "y",
    along = axis === "x" ? "y" : "x",
    depth = (axis === "x" ? o.w : o.h) / 2,
    span = (axis === "x" ? o.h : o.w) / 2,
    toward = Math.sign(o[axis] - a[axis]);
  return (
    Math.abs(a[axis] - o[axis]) <= depth + DOOR_LEAF.reach &&
    Math.abs(a[along] - o[along]) <= span + 0.3 &&
    toward * (a.physics?.[axis] ?? 0) > 0.2
  );
}
function startLeaf(o: Furniture, a: Actor) {
  const f = o.field!;
  return (f.leaf ??= {
    open: 0,
    side: -fieldSide(o, a) || 1,
    hold: DOOR_LEAF.holdSeconds,
  });
}
/** Pressing E: the door waits briefly for this actor to walk through. */
function openDoorLeaf(o: Furniture, a: Actor) {
  const leaf = startLeaf(o, a);
  leaf.hold = Math.max(leaf.hold, DOOR_LEAF.waitSeconds);
  leaf.opener = a.id;
  leaf.from = fieldSide(o, a);
}
/** Doors rest closed. The player opens one with E and NPCs open theirs as they
 * walk up; each closes itself once the doorway clears. The leaf never admits
 * anyone by itself, since admission stays personal, and zombies always have to
 * break through, which keeps health a real time budget. */
export function updateDoorLeaves(g: Game, dt: number) {
  for (const floor of g.floors)
    for (const o of floor.furniture) {
      const f = o.field;
      if (!f) continue;
      if (o.destroyed) {
        delete f.leaf;
        continue;
      }
      const people = g.survivors.filter(
        (a) =>
          a.alive && !a.escaped && a.floor === floor.index && fieldAllows(o, a),
      );
      // A person in or walking at a moving door keeps it open, but only NPCs
      // open a closed one by walking up: the player presses E.
      const holder = people.find(
        (a) => (f.leaf || a.id !== "human") && wantsDoorOpen(o, a),
      );
      if (holder) {
        const leaf = startLeaf(o, holder);
        leaf.hold = Math.max(leaf.hold, DOOR_LEAF.holdSeconds);
        leaf.open = Math.min(1, leaf.open + dt / DOOR_LEAF.openSeconds);
        continue;
      }
      const leaf = f.leaf;
      if (!leaf) continue;
      if (leaf.opener) {
        // Closing behind the opener: stop waiting as soon as they are through.
        const opener = people.find((a) => a.id === leaf.opener);
        if (!opener || fieldSide(o, opener) !== leaf.from) {
          leaf.hold = Math.min(leaf.hold, DOOR_LEAF.holdSeconds);
          delete leaf.opener;
          delete leaf.from;
        }
      }
      if (leaf.hold > 0) {
        leaf.hold -= dt;
        leaf.open = Math.min(1, leaf.open + dt / DOOR_LEAF.openSeconds);
        continue;
      }
      leaf.open -= dt / DOOR_LEAF.closeSeconds;
      if (leaf.open <= 0) delete f.leaf;
    }
}
const views = new WeakMap<
  Floor,
  Map<string, { signature: ViewSignature; floor: Floor }>
>();
/** Furniture ids, plus each field's state, at the moment a view was built. */
interface ViewSignature {
  keyed: boolean;
  ids: string[];
  fields: unknown[];
}
function viewMatches(s: ViewSignature, f: Floor, a: Actor, keyed: boolean) {
  if (s.keyed !== keyed || s.ids.length !== f.furniture.length) return false;
  let k = 0;
  for (let i = 0; i < f.furniture.length; i++) {
    const o = f.furniture[i];
    if (s.ids[i] !== o.id) return false;
    if (!o.field) continue;
    const v = s.fields;
    if (
      v[k++] !== o.destroyed ||
      v[k++] !== o.x ||
      v[k++] !== o.y ||
      v[k++] !== o.w ||
      v[k++] !== o.h ||
      v[k++] !== o.angle ||
      v[k++] !== o.open ||
      v[k++] !== fieldAllows(o, a)
    )
      return false;
  }
  return true;
}
function viewSignature(f: Floor, a: Actor, keyed: boolean): ViewSignature {
  const fields: unknown[] = [];
  for (const o of f.furniture)
    if (o.field)
      fields.push(
        o.destroyed,
        o.x,
        o.y,
        o.w,
        o.h,
        o.angle,
        o.open,
        fieldAllows(o, a),
      );
  return { keyed, ids: f.furniture.map((o) => o.id), fields };
}
const virtual = new WeakSet<Floor>();
/** Actor-specific navigation views keep personal access out of shared geometry. */
export function survivorFloor(f: Floor, p: Point): Floor {
  if (
    virtual.has(f) ||
    !("access" in p) ||
    !("id" in p) ||
    !f.furniture.some((o) => o.field)
  )
    return f;
  const a = p as Actor;
  // The view shares every non-field object by reference, so only fields and
  // the set of objects decide whether it must be rebuilt.
  const keyed = (a.keys ?? 0) > 0;
  // A view depends only on which fields this actor's access answers the same
  // way, so actors with the same answer share one view, and with it one route
  // graph. Keying by id built a private full graph for every NPC.
  const access = fieldAccessKey(f, a);
  let map = views.get(f);
  if (!map) views.set(f, (map = new Map()));
  const old = map.get(access);
  if (
    old &&
    old.floor.tiles === f.tiles &&
    viewMatches(old.signature, f, a, keyed)
  )
    return old.floor;
  const view: Floor = {
    ...f,
    furniture: f.furniture
      .filter((o) => !o.field || !fieldAllows(o, a))
      .map((o) => {
        if (!o.field || (a.keys ?? 0) < 1) return o;
        return {
          ...o,
          door: {
            frame: { x: o.x, y: o.y, w: o.w, h: o.h },
            hinge: { x: o.x, y: o.y },
            latched: true,
            swung: false,
            side: 0,
          },
        } as Furniture;
      }),
  };
  virtual.add(view);
  map.set(access, { signature: viewSignature(f, a, keyed), floor: view });
  return view;
}
