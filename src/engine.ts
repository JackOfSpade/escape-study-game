import { BARRICADE_ATTACK } from "./barricade-combat";
import {
  planZombieRoute,
  prepareZombieSearch,
  zombieSearchRandom,
} from "./zombie-search";
import { doorwayMotion } from "./door-traffic";
import { studyLoopDecision } from "./npc-study-loop";
import {
  SWARM,
  fieldAllows,
  useField,
  canUseField,
  fieldRouteSignature,
  fieldBetween,
} from "./force-fields";
import { planVault } from "./vault";
import { recordZombieTrails } from "./blood";
import {
  DOOR_SWING,
  doorClosingDrive,
  doorClosingMotion,
  doorFrame,
  doorHandle,
  doorPose,
  doorPushDirection,
  ensureDoor,
  unlatchDoor,
} from "./doors";
import { EQUIPMENT, itemTargets, itemUseIssue } from "./equipment";
import {
  doorwayGoal,
  explorationCell,
  observeDoorEntry,
  rememberPlace,
} from "./exploration";
import { furnitureRoute, handlingPositions } from "./fortification";
import { localPoint, surfacePoint, worldPoint } from "./furniture-geometry";
import { chooseFurnitureYield } from "./furniture-yield";
import { canGrip, gripPoint } from "./handling";
import { interruptLearningAttempt } from "./learner";
import {
  type Actor,
  type Encounter,
  type Floor,
  type Furniture,
  type Game,
  type Point,
  type Zombie,
  CONFIG,
  FURNITURE,
  HELIPAD,
  HELIPAD_RADIUS,
  distance,
  event,
  rand,
} from "./model";
import { survivorPath, walkSegment } from "./navigation";
import { humanActive, markEnded, simulationActive } from "./simulation-state";
import {
  helicopterInterval,
  npcThinkingScale,
  spawnGrace,
  swarmPacing,
} from "./study-pacing";
import {
  hasHumanStudyContext,
  npcReasoningAvailable,
  recordNpcActivity,
  recordNpcWork,
  taskSkill,
  npcThinkingRate,
} from "./npc-cognition";
import { rememberThreats, rememberedThreats } from "./npc-threat-memory";
import {
  beginPhysics,
  cancelPhysics,
  finishPhysics,
  physicsActive,
  physicsFloor,
  physicsKick,
  physicsMove,
  physicsElevated,
  ZOMBIE_PUSH,
} from "./physics";
import {
  canPlace,
  inFurniture,
  line,
  move,
  path,
  solid,
  soundGain,
  wall,
  beginFurnitureIndex,
  endFurnitureIndex,
  furnitureNear,
  stationSpot,
} from "./spatial";
import {
  advanceStairs,
  beginStairs,
  enterCityStairBase,
  enterStairs,
  stairwellAt,
  ensureWalkingBody,
  settleElevated,
} from "./stair-travel";
import { STAIRWELL_RADIUS, stairwell } from "./stairwell";
import { actorOnFloor } from "./stair-route";
import {
  chooseRetreat,
  routeContacts,
  unsafeReturn,
} from "./survivor-strategy";
import { chooseTaskStation } from "./task-strategy";
import { canSee, rayBodyDistance, sightRadius } from "./visibility";
import { ZombieIndex } from "./zombie-index";
import { zombieStairArrival } from "./zombie-stairs";
import { sectorAt } from "./floor-plan";
import { cityApproachTarget, spawnCityReinforcements } from "./city-invasion";
import { jumpElevated, stepElevated } from "./elevated-physics";
export interface Input {
  x: number;
  y: number;
  grab: boolean;
  /** One-shot jump request, consumed by this simulation tick. */
  jump?: boolean;
  /** First-person walking follows the physical stair/gallery instead of a timer. */
  stairWalk?: boolean;
}
/** Zombie walking speed multiplier while the Surge is active. */
const SURGE_SPEED_MULTIPLIER = 1.35;
export const human = (g: Game) => g.survivors[0];
export function nearestFurniture(g: Game, a: Actor, grip = false) {
  return g.floors[a.floor].furniture
    .filter(
      (o) =>
        !o.destroyed &&
        o.kind !== "gate" &&
        o.kind !== "door" &&
        (!grip || canGrip(g.floors[a.floor], a, o)),
    )
    .sort((b, c) => distance(a, b) - distance(a, c))[0];
}
/** Human E selects the nearest reachable surface, including the end of long cover. */
export function nearestGrip(g: Game, a: Actor) {
  return g.floors[a.floor].furniture
    .filter(
      (o) => !o.field && o.kind !== "gate" && canGrip(g.floors[a.floor], a, o),
    )
    .sort(
      (b, c) => distance(a, gripPoint(a, b)) - distance(a, gripPoint(a, c)),
    )[0];
}
export function nearestStation(g: Game, a: Actor) {
  return g.floors[a.floor].stations
    .filter((s) => canReachStation(g, a, s))
    .sort((b, c) => distance(a, b) - distance(a, c))[0];
}
export function canReachStation(
  g: Game,
  a: Actor,
  station: Point,
  range = 1.9,
) {
  return (
    a.alive &&
    !a.escaped &&
    !a.vault &&
    distance(a, station) < range &&
    canSee(g.floors[a.floor], a, station, range)
  );
}
export function nearbyDoor(g: Game, a: Actor) {
  return g.floors[a.floor].furniture
    .filter(
      (o) =>
        o.kind === "door" &&
        !o.destroyed &&
        distance(a, doorFrame(o)) < 1.9 &&
        canSee(g.floors[a.floor], a, doorFrame(o), 1.9, o.id),
    )
    .sort((b, c) => distance(a, b) - distance(a, c))[0];
}
export function toggleDoor(g: Game, a: Actor, id: string, open?: boolean) {
  const f = g.floors[a.floor],
    door = f.furniture.find(
      (o) => o.id === id && o.kind === "door" && !o.destroyed,
    );
  if (
    !door ||
    !a.alive ||
    a.escaped ||
    distance(a, doorFrame(door)) > 1.9 ||
    !canSee(f, a, doorFrame(door), 1.9, door.id)
  )
    return false;
  if (open === false) return false;
  if (door.field) return useField(g, a, door);
  ensureDoor(door, f); // Closing is a physical push back into the latch.
  if (!unlatchDoor(door)) return true;

  a.noiseUntil = g.time + 1;
  a.noiseLevel = 8;
  event(
    g,
    "door",
    `${a.name} released a door latch. Push to swing it open.`,
    a.floor,
    a.id,
  );
  return true;
}
export function claimStation(g: Game, a: Actor, stationId: string) {
  if (a.stairTravel) return false;
  const station = g.floors[a.floor].stations.find((s) => s.id === stationId);
  if (!station || !canReachStation(g, a, station)) return false;
  const e = g.encounters[station.encounter];
  if (e.mode === "solo" && e.owner && e.owner !== a.id) return false;
  if (
    g.survivors.some(
      (b) =>
        b.id !== a.id &&
        b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        b.station === station.id &&
        distance(b, station) < 1.3,
    )
  )
    return false;
  a.station = station.id;
  a.intent = e.id;
  a.activity = "studying";
  if (a.id === "human" && e.state !== "consumed") e.humanEngaged = true;
  if (e.mode === "solo" && e.state !== "consumed") e.owner ??= a.id;
  return true;
}
export function releaseStation(a: Actor) {
  delete a.station;
}
function death(g: Game, a: Actor, cause?: string) {
  a.alive = false;
  a.hp = 0;
  delete a.stairTravel;
  g.stats.deaths++;
  g.surge.lastDeath = g.time;
  if (g.surge.state === "calm") {
    g.surge.anchor = Math.max(g.time, g.surge.lastEnd);
    g.surge.quietDelay =
      CONFIG.quietMin + rand(g) * (CONFIG.quietMax - CONFIG.quietMin);
  }
  const ev = event(
    g,
    "death",
    cause
      ? `${a.name} ${cause} on Floor ${a.floor + 1}.`
      : `${a.name} ${a.id === "human" ? "were" : "was"} lost on Floor ${a.floor + 1}.`,
    a.floor,
    a.id,
  );
  if (a.intent && g.encounters[a.intent])
    g.encounters[a.intent].history.push({
      seq: ev.seq,
      author: a.id,
      kind: "activity",
      text: ev.text,
      at: g.time,
      revision: g.encounters[a.intent].revision,
    });
  if (a.id === "human") {
    if (g.status === "playing") markEnded(g);
    g.status = "dead";
    g.notice =
      "The run ended. Your terminal work and learning evidence are preserved.";
  }
}
/** Shared survivor damage path, including an explicit cause for fatal falls. */
export function damageSurvivor(
  g: Game,
  a: Actor,
  amount: number,
  cause?: string,
) {
  if (!a.alive || a.escaped || !Number.isFinite(amount) || amount <= 0) return;
  a.hp -= amount;
  if (a.hp <= 0) death(g, a, cause);
}

// Gameplay anchors informed by adult fall-height research, not mortality odds.
// Keep short-fall injury meaningful; see docs/FALL_DAMAGE.md for the calibration.
const FALL_DAMAGE_CURVE = [
  [2.5, 0],
  [3.6, 17],
  [7.2, 50],
  [10.8, 75],
  [14.4, 95],
  [15, 100],
] as const;

export function fallDamage(drop: number) {
  if (drop <= FALL_DAMAGE_CURVE[0][0]) return 0;
  for (let i = 1; i < FALL_DAMAGE_CURVE.length; i++) {
    const [height, damage] = FALL_DAMAGE_CURVE[i],
      [previousHeight, previousDamage] = FALL_DAMAGE_CURVE[i - 1];
    if (drop <= height)
      return (
        previousDamage +
        ((drop - previousHeight) / (height - previousHeight)) *
          (damage - previousDamage)
      );
  }
  return 100;
}

export function tickSurge(g: Game) {
  const s = g.surge;
  if (s.state === "calm" && g.time >= s.anchor + s.quietDelay) {
    s.state = "warning";
    s.started = g.time;
    s.duration =
      CONFIG.surgeMin + rand(g) * (CONFIG.surgeMax - CONFIG.surgeMin);
    event(
      g,
      "surge-warning",
      "An escalating pulse rises through the building.",
    );
  } else if (s.state === "warning" && g.time >= s.started + CONFIG.warning) {
    s.state = "active";
    s.started = g.time;
    event(g, "surge-active", "The Surge transformed the horde.");
  } else if (s.state === "active" && g.time >= s.started + s.duration) {
    s.state = "calm";
    s.lastEnd = g.time;
    s.anchor = Math.max(g.time, s.lastDeath);
    s.quietDelay =
      CONFIG.quietMin + rand(g) * (CONFIG.quietMax - CONFIG.quietMin);
    event(g, "surge-end", "The pulse subsides.");
  }
}
export function stairs(g: Game, a: Actor, down = false) {
  return beginStairs(g, a, down);
}
export function canBoard(g: Game, a: Actor) {
  return (
    !a.stairTravel &&
    a.floor === CONFIG.floors &&
    a.alive &&
    !a.escaped &&
    distance(a, HELIPAD) <= HELIPAD_RADIUS &&
    g.time < g.helicopter.until &&
    g.helicopter.passengers.length < 4
  );
}
export function board(g: Game, a: Actor) {
  if (!canBoard(g, a)) return false;
  g.helicopter.passengers.push(a.id);
  a.escaped = true;
  delete a.handling;
  delete a.station;
  a.path = [];
  g.stats.rescued++;
  event(
    g,
    "board",
    `${a.name} boarded pickup ${g.helicopter.trip}.`,
    a.floor,
    a.id,
  );
  if (a.id === "human") {
    if (g.status === "playing") markEnded(g);
    g.status = "escaped";
    g.notice = "You made it. Your work survives with you.";
  }
  return true;
}
export function vault(g: Game, a: Actor, obstacleId?: string): boolean {
  if (
    !a.alive ||
    a.escaped ||
    a.vault ||
    a.stairTravel ||
    a.elevated ||
    a.cooldown > 0
  )
    return false;
  const f = g.floors[a.floor];
  // Search reachable surfaces, not object centers. A nearby
  // chair beside/behind the player must not swallow Space at a long barricade.
  if (!obstacleId) {
    const candidates = f.furniture
      .filter((o) => !o.destroyed && o.kind !== "door" && o.kind !== "gate")
      .sort(
        (b, c) =>
          distance(a, surfacePoint(a, b)) - distance(a, surfacePoint(a, c)),
      );
    return candidates.some((o) => vault(g, a, o.id));
  }
  const o = f.furniture.find(
    (o) =>
      o.id === obstacleId &&
      !o.destroyed &&
      o.kind !== "door" &&
      o.kind !== "gate",
  );
  if (!o || distance(a, surfacePoint(a, o)) > 1.2) return false;
  const route = planVault(g, a, o);
  if (!route) return false;
  const { to, obstacles } = route;
  delete a.grip;
  delete a.handling;
  a.vault = {
    from: { x: a.x, y: a.y },
    to,
    left: o.kind === "chair" || o.kind === "officeChair" ? 0.45 : 1.1,
    duration: o.kind === "chair" || o.kind === "officeChair" ? 0.45 : 1.1,
    obstacle: o.id,
    obstacles,
  };
  event(g, "vault", `${a.name} climbed over ${o.kind}.`, a.floor, a.id);
  return true;
}
function advanceVault(a: Actor, dt: number) {
  const v = a.vault!;
  v.left -= dt;
  const p = 1 - Math.max(0, v.left) / v.duration;
  a.x = v.from.x + (v.to.x - v.from.x) * p;
  a.y = v.from.y + (v.to.y - v.from.y) * p;
  if (v.left <= 0) {
    delete a.vault;
    a.path = [];
    a.repath = 0;
    a.cooldown = 0.3;
  }
}
export function rotate(g: Game, a: Actor) {
  const o = nearestFurniture(g, a, true);
  if (
    !o ||
    !canGrip(g.floors[a.floor], a, o) ||
    o.turning > 0 ||
    g.survivors.some((b) => b.grip?.object === o.id)
  )
    return false;
  const f = g.floors[a.floor];
  if (
    !canPlace(f, o, o, o.h, o.w) ||
    g.zombies.some(
      (z) =>
        z.hp > 0 &&
        z.floor === a.floor &&
        inFurniture(z, { ...o, w: o.h, h: o.w }, 0.22),
    ) ||
    g.survivors.some(
      (b) =>
        b.floor === a.floor &&
        b.alive &&
        !b.escaped &&
        inFurniture(b, { ...o, w: o.h, h: o.w }, 0.25),
    )
  )
    return false;
  o.initial ??= { x: o.x, y: o.y, w: o.w, h: o.h, angle: o.angle };
  [o.w, o.h] = [o.h, o.w];
  o.rotation = (o.rotation + 1) % 2;
  o.turning = 1.2;
  event(g, "rotate", `${a.name} rotated a ${o.kind}.`, a.floor, a.id);
  if (!physicsActive(g)) defenseCredit(g, a, o);
  return true;
}
function defenseCredit(g: Game, a: Actor, o: Furniture) {
  if (o.credited.length || !o.initial) return;
  if (o.moved < 0.8 && o.w === o.initial.w && o.h === o.initial.h) return;
  const f = g.floors[a.floor];
  for (const d of f.doors) {
    if (distance(d, o) > 8 || !inFurniture({ x: o.x, y: d.y }, o, 0.22))
      continue;
    const left = d.x < 22;
    const station = f.stations.find(
      (s) =>
        (left ? s.x < 17 : s.x > 26) &&
        Math.abs(s.y - d.y) < 9 &&
        g.encounters[s.encounter].mode === "shared" &&
        g.encounters[s.encounter].state !== "consumed",
    );
    if (!station) continue;
    const e = g.encounters[station.encounter];
    // Compare this furniture's added protection with the physical door open.
    // A closed existing door must not hide a useful second defensive layer.
    const geometry = {
      ...f,
      furniture: f.furniture.map((x) =>
        x.kind === "door" && distance(doorFrame(x), d) < 0.1
          ? { ...x, destroyed: true }
          : x,
      ),
    };
    const before = path(
      {
        ...geometry,
        furniture: geometry.furniture.map((x) =>
          x.id === o.id
            ? { ...x, ...o.initial, angle: o.initial?.angle ?? 0 }
            : x,
        ),
      },
      { x: 21.5, y: d.y },
      station,
    );
    const after = path(geometry, { x: 21.5, y: d.y }, station);
    if (!before.length || after.length) continue;
    const participants = g.survivors.filter(
      (b) =>
        b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        (b.id === a.id || b.handling === o.id) &&
        (b.id === a.id || canGrip(f, b, o)),
    );
    for (const participant of participants) {
      if (!e.contributors.includes(participant.id))
        e.contributors.push(participant.id);
      o.credited.push(participant.id);
      const ev = event(
        g,
        "defense",
        `${participant.name} helped seal an approach with a ${o.kind}.`,
        a.floor,
        participant.id,
        e.id,
      );
      e.history.push({
        seq: ev.seq,
        author: participant.id,
        kind: "defense",
        text: ev.text,
        at: g.time,
        revision: e.revision,
        refs: [o.id],
      });
    }
  }
}
/** E toggles a persistent grip at the selected end/surface. */
export function toggleGrip(g: Game, a: Actor, id?: string) {
  if (a.grip) {
    delete a.grip;
    delete a.handling;
    return true;
  }
  if (g.paused || !a.alive || a.escaped || a.vault || a.stairTravel)
    return false;
  const o = id
    ? g.floors[a.floor].furniture.find((o) => o.id === id)
    : nearestGrip(g, a);
  if (!o || o.turning > 0 || !canGrip(g.floors[a.floor], a, o)) return false;
  a.grip = o.door
    ? {
        object: o.id,
        local: localPoint(doorHandle(o), o),
        length: Math.max(0.35, distance(a, doorHandle(o))),
      }
    : { object: o.id, local: localPoint(a, o) };
  a.handling = o.id;
  return true;
}
/** Quasistatic rigid-body drag: off-center force rotates about the held end.
 * Small swept steps reject walls, furniture and bodies before committing a pose. */
export function dragFurniture(
  g: Game,
  a: Actor,
  dx: number,
  dy: number,
  dt: number,
) {
  const f = g.floors[a.floor],
    grip = a.grip,
    o = f.furniture.find((o) => o.id === grip?.object);
  if (!o || !grip || !canGrip(f, a, o)) {
    delete a.grip;
    delete a.handling;
    return false;
  }
  if (!(dx || dy)) return true;
  if (physicsActive(g)) {
    const n = Math.hypot(dx, dy);
    physicsMove(g, a, (dx / n) * a.speed * dt, (dy / n) * a.speed * dt);
    if (!o.movers.includes(a.id)) o.movers.push(a.id);
    return true;
  }

  const n = Math.hypot(dx, dy),
    amount = a.speed * Math.min(dt, 0.1),
    delta = { x: (dx / n) * amount, y: (dy / n) * amount },
    steps = Math.max(1, Math.ceil(amount / 0.025));
  let moved = false;
  for (let i = 0; i < steps; i++) {
    const r = worldPoint(grip.local, { x: 0, y: 0, angle: o.angle }),
      d = { x: delta.x / steps, y: delta.y / steps },
      inertia = (o.w * o.w + o.h * o.h) / 12,
      turn = (r.x * d.y - r.y * d.x) / (inertia + r.x * r.x + r.y * r.y),
      angle = (o.angle ?? 0) + turn,
      rotated = worldPoint(grip.local, { x: 0, y: 0, angle }),
      nextActor = { x: a.x + d.x, y: a.y + d.y },
      pose = { x: nextActor.x - rotated.x, y: nextActor.y - rotated.y, angle };
    if (
      !canPlace(f, o, pose, o.w, o.h, angle) ||
      solid(f, nextActor, 0.22, o.id) ||
      inFurniture(nextActor, { ...o, ...pose }, 0.22) ||
      g.survivors.some(
        (b) =>
          b !== a &&
          b.alive &&
          !b.escaped &&
          b.floor === a.floor &&
          inFurniture(b, { ...o, ...pose }, 0.23),
      ) ||
      g.zombies.some(
        (z) =>
          z.hp > 0 &&
          z.floor === a.floor &&
          inFurniture(z, { ...o, ...pose }, 0.22),
      )
    )
      break;
    o.initial ??= { x: o.x, y: o.y, w: o.w, h: o.h, angle: o.angle };
    o.moved += distance(o, pose) + (Math.abs(turn) * Math.hypot(o.w, o.h)) / 2;
    Object.assign(o, pose);
    Object.assign(a, nextActor);
    o.lastMoveTick = g.tick;
    o.lastBy = a.id;
    if (!o.movers.includes(a.id)) o.movers.push(a.id);
    a.noiseUntil = g.time + 1;
    a.noiseLevel = 8;
    moved = true;
  }
  if (moved) defenseCredit(g, a, o);
  return moved;
}
export function pushFurniture(
  g: Game,
  a: Actor,
  dx: number,
  dy: number,
  dt: number,
) {
  const f = g.floors[a.floor];
  let o = a.handling
    ? f.furniture.find((x) => x.id === a.handling)
    : nearestFurniture(g, a, true);
  if (!o || !canGrip(f, a, o) || o.turning > 0) {
    delete a.handling;
    return false;
  }
  o.initial ??= { x: o.x, y: o.y, w: o.w, h: o.h, angle: o.angle };
  a.handling = o.id;
  if (!o.movers.includes(a.id)) o.movers.push(a.id);
  if (g.tick !== undefined && o.lastMoveTick === g.tick) return false;
  const handlers = g.survivors.filter(
    (b) => (b.id === a.id || b.handling === o!.id) && canGrip(f, b, o!),
  );
  const speed = o.speed * (1 + 0.45 * Math.min(handlers.length - 1, 2)),
    n = Math.hypot(dx, dy) || 1,
    p = { x: o.x + (dx / n) * speed * dt, y: o.y + (dy / n) * speed * dt };
  const probe = { x: p.x + (dx / n) * 0.025, y: p.y + (dy / n) * 0.025 };
  if (!canPlace(f, o, probe)) {
    // Forgiving axis alignment still takes handling time and moves the actor.
    // It cannot shrink an object or snap it through a wall/another object.
    const horizontal = Math.abs(dx) >= Math.abs(dy),
      value = horizontal ? o.y : o.x,
      snap = Math.round(value - 0.5) + 0.5,
      delta = snap - value;
    if (Math.abs(delta) > 1e-7 && Math.abs(delta) < 0.18) {
      const aligned = { x: o.x, y: o.y };
      if (horizontal)
        aligned.y += Math.sign(delta) * Math.min(Math.abs(delta), speed * dt);
      else
        aligned.x += Math.sign(delta) * Math.min(Math.abs(delta), speed * dt);
      if (canPlace(f, o, aligned)) Object.assign(p, aligned);
    }
  }
  if (
    canPlace(f, o, p) &&
    !g.survivors.some(
      (b) =>
        b.id !== a.id &&
        b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        inFurniture(b, { ...o!, ...p }, 0.23) &&
        !handlers.includes(b),
    ) &&
    !g.zombies.some(
      (z) =>
        z.hp > 0 &&
        z.floor === a.floor &&
        inFurniture(z, { ...o!, ...p }, 0.22),
    )
  ) {
    const shift = { x: p.x - o.x, y: p.y - o.y };
    const positions = handlers.map((b) => {
      const next = { x: b.x, y: b.y };
      move(f, next, shift.x, shift.y, o!.id);
      return next;
    });
    if (
      positions.some(
        (next, i) =>
          distance(next, {
            x: handlers[i].x + shift.x,
            y: handlers[i].y + shift.y,
          }) > 1e-6 || inFurniture(next, { ...o!, ...p }, 0.22),
      )
    )
      return false;
    o.x = p.x;
    o.y = p.y;
    o.lastMoveTick = g.tick;
    o.moved += Math.hypot(shift.x, shift.y);
    o.lastBy = a.id;
    a.noiseUntil = g.time + 1;
    a.noiseLevel = 8;
    handlers.forEach((b, i) => {
      Object.assign(b, positions[i]);
      if (!o!.movers.includes(b.id)) o!.movers.push(b.id);
    });
    if (!physicsActive(g)) defenseCredit(g, a, o);
    return true;
  }
  return false;
}
export function doorPullCandidate(g: Game, a: Actor, target: Point) {
  const f = g.floors[a.floor];
  return f.furniture.find((o) => {
    const d = o.door;
    if (
      !d ||
      d.latched ||
      o.destroyed ||
      distance(a, d.frame) > 1.9 ||
      distance(a, surfacePoint(a, o)) > 0.9
    )
      return false;
    const n = distance(a, target) || 1;
    if (
      rayBodyDistance(a, (target.x - a.x) / n, (target.y - a.y) / n, o, 0.26) >=
      n
    )
      return false;
    const resisted =
      Math.abs(o.angle ?? 0) > 0.1 &&
      Math.abs(o.physics?.angular ?? 0) < 0.2 &&
      distance(a, surfacePoint(a, o)) < 0.4;
    const visible = f.furniture.some(
      (other) =>
        other !== o &&
        !other.destroyed &&
        canSee(f, a, other, sightRadius(f), other.id) &&
        !canPlace(
          { ...f, furniture: [other] },
          o,
          doorPose(o, (d.frame.x < 22 ? -1 : 1) * DOOR_SWING),
          o.w,
          o.h,
          (d.frame.x < 22 ? -1 : 1) * DOOR_SWING,
        ),
    );
    if (!resisted && !visible) return false;
    const inside = d.frame.x < 22 ? -1 : 1;
    if (d.frame.h < d.frame.w) return false;
    const inward = -inside;
    if (
      !d.latched &&
      d.side === inward &&
      Math.abs(o.angle ?? 0) > DOOR_SWING * 0.96
    )
      return false;
    const arc = (sign: number) =>
      [0.3, 0.6, 0.9, DOOR_SWING].every((angle) =>
        canPlace(f, o, doorPose(o, sign * angle), o.w, o.h, sign * angle),
      );
    return !arc(inside) && arc(inward);
  });
}
/** Pull a blocked outward swing inward using the same exposed physical handle as the player. */
function pullDoorOnRoute(g: Game, a: Actor, target: Point, dt: number) {
  const f = g.floors[a.floor];
  if (a.grip && !f.furniture.find((o) => o.id === a.grip!.object)?.door)
    return false;
  let o = a.pullingDoor && f.furniture.find((o) => o.id === a.pullingDoor!.id);
  if (a.pullingDoor && (!o || o.destroyed || g.time >= a.pullingDoor.until)) {
    delete a.pullingDoor;
    delete a.grip;
    a.path = [];
    a.repath = 0;
    return false;
  }
  if (!o) {
    o = doorPullCandidate(g, a, target);
    if (!o) return false;
    a.pullingDoor = {
      id: o.id,
      until: g.time + 8,
      inside: o.door!.frame.x < 22 ? -1 : 1,
    };
    a.path = [];
    a.repath = 0;
  }
  const state = a.pullingDoor!,
    d = o.door!,
    inward = -state.inside;
  if (
    !d.latched &&
    d.side === inward &&
    Math.abs(o.angle ?? 0) > DOOR_SWING * 0.96
  ) {
    delete a.grip;
    delete a.pullingDoor;
    a.path = [];
    a.repath = 0;
    return false;
  }
  if (d.latched && !toggleDoor(g, a, o.id, true)) return false;
  if (a.grip?.object !== o.id) {
    if (!canGrip(f, a, o)) {
      const handle = doorHandle(o),
        approach = {
          x: handle.x + state.inside * 0.6,
          y: Math.max(
            d.frame.y - d.frame.h / 2 + 0.28,
            Math.min(d.frame.y + d.frame.h / 2 - 0.28, handle.y - 0.07),
          ),
        };
      const route = survivorPath(f, a, approach),
        p = route.find((p) => distance(a, p) > 0.05);
      if (p && !p.action) {
        const n = distance(a, p) || 1;
        physicsMove(
          g,
          a,
          ((p.x - a.x) / n) * Math.min(n, a.speed * dt),
          ((p.y - a.y) / n) * Math.min(n, a.speed * dt),
        );
      }
      return true;
    }
    if (a.grip) toggleGrip(g, a);
    if (!toggleGrip(g, a, o.id)) return false;
  }
  physicsMove(g, a, state.inside * a.speed * dt, 0);
  return true;
}
/** A body at a terminal looks at its screen, not along its last step. */
function faceStation(a: Actor, station: Point) {
  const d = distance(a, station) || 1;
  a.heading = { x: (station.x - a.x) / d, y: (station.y - a.y) / d };
}
function follow(
  g: Game,
  a: Actor,
  target: Point,
  dt: number,
  allowExit = true,
) {
  const f = g.floors[a.floor];
  if (pullDoorOnRoute(g, a, target, dt)) return;
  const geometry = f.furniture
    .map(
      (o) =>
        `${o.id}/${o.x}/${o.y}/${o.w}/${o.h}/${o.angle ?? 0}/${o.open}/${o.destroyed}/${o.turning < 0}/${o.field ? fieldAllows(o, a) : ""}`,
    )
    .join(";");
  if (
    a.routeGeometry !== undefined &&
    a.routeGeometry !== geometry &&
    a.path[0] &&
    ((!a.path[0].action && !walkSegment(f, a, a.path[0])) ||
      solid(
        f,
        a.path[0],
        0.22,
        a.path[0].action === "door" ? a.path[0].obstacle : undefined,
        true,
      ))
  ) {
    a.path = [];
    a.repath = 0;
  }
  a.routeGeometry = geometry;
  if (!a.navTarget || distance(a.navTarget, target) > 0.75) {
    a.navTarget = { ...target };
    a.repath = 0;
    a.path = [];
    delete a.routeProgress;
  }
  a.repath -= dt;
  if (!a.path.length && a.repath <= 0) {
    a.path = survivorPath(f, a, target);
    if (!a.path.length && distance(a, target) > 0.5) {
      // A closed door can sit immediately beside a barricade. Open its visible
      // reachable side first, then replan the vault with that door actually open.
      const doors = f.furniture
        .filter(
          (o) =>
            o.kind === "door" &&
            (o.id !== "main-gate" || a.y >= 28) &&
            !o.open &&
            !o.destroyed &&
            canUseField(o, a) &&
            (!o.field || !fieldAllows(o, a)) &&
            canSee(f, a, o, sightRadius(f), o.id),
        )
        .sort((b, c) => distance(a, b) - distance(a, c));
      for (const door of doors) {
        const route = survivorPath(f, a, door);
        if (route.length) {
          a.path = route;
          break;
        }
      }
    }
    a.repath = 0.8 + rand(g) * 0.4;
  }
  // A door's approach node is a routing aid, not a required stopping place.
  // Release an already reachable next latch before backing into the queue to
  // visit that node. Contact still supplies all of the opening motion.
  const nextDoor = a.path.slice(0, 2).find((p) => p.action === "door");
  const latch =
    nextDoor &&
    f.furniture.find(
      (o) =>
        o.id === nextDoor.obstacle &&
        !o.open &&
        !o.destroyed &&
        (!o.field || !fieldAllows(o, a)),
    );
  if (
    latch &&
    distance(a, doorFrame(latch)) < 1.9 &&
    toggleDoor(g, a, latch.id, true)
  ) {
    a.path = [];
    a.repath = 0;
  }
  const portal = doorwayMotion(g, a, target);
  if (portal) {
    const gap = distance(a, portal.point);
    const amount = Math.min(a.speed * dt, gap, portal.forwardLimit);
    a.heading = {
      x: (portal.point.x - a.x) / (gap || 1),
      y: (portal.point.y - a.y) / (gap || 1),
    };
    physicsMove(g, a, a.heading.x * amount, a.heading.y * amount, portal.steer);
    if (amount > 0.001) {
      a.noiseUntil = g.time + 0.4;
      a.noiseLevel = a.activity === "fleeing" ? 6 : 3;
    }
    return;
  }
  // Grid corners guide around walls; they are not shared arrival points.
  // Skip directly to a visible later node so a crowd can fan out toward its
  // distinct destinations instead of squeezing through the same cell centre.
  let shortcut = 0;
  for (let i = 0; i < Math.min(a.path.length, 8); i++) {
    if (a.path[i].action) break;
    if (walkSegment(f, a, a.path[i])) shortcut = i;
  }
  if (shortcut) a.path.splice(0, shortcut);
  while (
    a.path.length > 1 &&
    (!a.path[0].action ||
      (a.path[0].action === "door" &&
        f.furniture.some(
          (o) =>
            o.id === a.path[0].obstacle &&
            (o.open || (o.field && fieldAllows(o, a))) &&
            !o.destroyed,
        ))) &&
    distance(a, a.path[0]) < 0.4 &&
    walkSegment(f, a, a.path[1])
  )
    a.path.shift();
  let p = a.path[0];
  if (p && distance(a, p) < 0.04) {
    a.path.shift();
    p = a.path[0];
  }
  if (!p) {
    const push = doorPushDirection(f, a, target);
    if (push) {
      physicsMove(g, a, push.x * a.speed * dt, push.y * a.speed * dt, true);
      return;
    }
    if (
      allowExit &&
      distance(a, target) > 0.5 &&
      roomAt(a, f) >= 0 &&
      roomAt(a, f) !== roomAt(target, f)
    )
      clearExit(g, a, dt, target);
    return;
  }
  const d = distance(a, p),
    k = Math.min(a.speed * dt, d) / (d || 1);
  a.heading = { x: (p.x - a.x) / (d || 1), y: (p.y - a.y) / (d || 1) };
  if (p.action) {
    const obstacle = f.furniture.find(
      (o) => o.id === p.obstacle && !o.destroyed && !o.open,
    );
    if (obstacle) {
      if (p.action === "door") {
        if (!toggleDoor(g, a, obstacle.id, true)) {
          a.path = [];
          a.repath = 0.5;
          return;
        }
      } else {
        // A temporary recovery is not an invalid route. Keep the exact legal
        // action ready so expiry does not add a second path-retry delay.
        if (a.cooldown > 0) return;
        if (!vault(g, a, obstacle.id)) {
          a.path = [];
          a.repath = 0.5;
        }
        return;
      }
    }
  }
  const before = { x: a.x, y: a.y };
  if (!physicsMove(g, a, (p.x - a.x) * k, (p.y - a.y) * k, true))
    move(f, a, (p.x - a.x) * k, (p.y - a.y) * k);
  if (distance(before, a) > 0.001) {
    a.noiseUntil = g.time + 0.4;
    a.noiseLevel = a.activity === "fleeing" ? 6 : 3;
    a.blockedTime = 0;
  } else a.blockedTime = (a.blockedTime ?? 0) + dt;
  if (a.blockedTime > 0.5) {
    a.path = [];
    a.repath = 0;
    a.blockedTime = 0;
  }
  if (!p.action && a.path[0] === p) trackRouteProgress(g, a, p);
}

/**
 * Contact with a standing body can push an NPC back every tick, so it keeps
 * "moving" without approaching its waypoint. After 0.8 s without net progress
 * step sideways (away from the blocker, never into a doorway) and replan from there.
 */
function trackRouteProgress(g: Game, a: Actor, p: Point) {
  const gap = distance(a, p),
    progress = a.routeProgress;
  if (!progress || distance(progress, p) > 0.05) {
    a.routeProgress = { x: p.x, y: p.y, best: gap, at: g.time };
    return;
  }
  if (gap < progress.best - 0.05) {
    progress.best = gap;
    progress.at = g.time;
    return;
  }
  if (g.time - progress.at <= 0.8) return;
  const f = g.floors[a.floor],
    heading = a.heading;
  let blocker: Actor | undefined;
  for (const b of g.survivors)
    if (
      b !== a &&
      b.alive &&
      !b.escaped &&
      b.floor === a.floor &&
      distance(a, b) <= 1 &&
      (b.x - a.x) * heading.x + (b.y - a.y) * heading.y > 0 &&
      (!blocker || distance(a, b) < distance(a, blocker))
    )
      blocker = b;
  const n = { x: -heading.y, y: heading.x };
  let sides = [1, -1];
  if (blocker) {
    const away = (s: number) =>
      distance({ x: a.x + s * n.x, y: a.y + s * n.y }, blocker!);
    if (away(-1) > away(1)) sides = [-1, 1];
  }
  for (const side of sides)
    for (const reach of [0.7, 1.0, 1.3]) {
      const c = {
        x: a.x + side * n.x * reach,
        y: a.y + side * n.y * reach,
      };
      if (
        !solid(f, c, 0.25) &&
        walkSegment(f, a, c) &&
        !g.survivors.some(
          (b) =>
            b !== a &&
            b.alive &&
            !b.escaped &&
            b.floor === a.floor &&
            distance(b, c) < 0.6,
        ) &&
        !g.zombies.some(
          (z) => z.hp > 0 && z.floor === a.floor && distance(z, c) < 0.6,
        ) &&
        !f.furniture.some(
          (o) => o.field && !o.destroyed && inFurniture(c, o, 0.3),
        )
      ) {
        a.path = [c];
        a.repath = 0.3;
        delete a.routeProgress;
        return;
      }
    }
  a.path = [];
  a.repath = 0;
  a.routeProgress = { x: p.x, y: p.y, best: gap, at: g.time };
}

function yieldFurniture(g: Game, a: Actor, dt: number) {
  if (
    a.furnitureYield &&
    (a.furnitureYield.floor !== a.floor ||
      g.time >= a.furnitureYield.until ||
      distance(a, a.furnitureYield.target) < 0.25 ||
      a.defensePlan)
  )
    delete a.furnitureYield;
  if (!a.furnitureYield) {
    const target = chooseFurnitureYield(g, a);
    if (target)
      a.furnitureYield = { floor: a.floor, target, until: g.time + 4 };
  }
  if (!a.furnitureYield) return false;
  a.activity = "waiting";
  delete a.station;
  follow(g, a, a.furnitureYield.target, dt, false);
  return true;
}
function furnitureClaimed(g: Game, a: Actor, o: Furniture, existing = false) {
  return g.survivors.some(
    (b, i) =>
      b !== a &&
      b.alive &&
      !b.escaped &&
      b.floor === a.floor &&
      (b.grip?.object === o.id ||
        (b.defensePlan?.object === o.id &&
          !(
            existing &&
            a.defensePlan &&
            a.defensePlan.encounter !== "egress" &&
            a.defensePlan.encounter === b.defensePlan.encounter &&
            distance(a.defensePlan.target, b.defensePlan.target) < 0.01
          ) &&
          (!existing || i < g.survivors.indexOf(a)))),
  );
}
function releaseFurniturePlan(a: Actor) {
  delete a.defensePlan;
  delete a.handling;
  a.path = [];
  a.repath = 0;
  delete a.navTarget;
}
function fortify(g: Game, a: Actor, e: Encounter, dt: number) {
  const f = g.floors[a.floor],
    room = Number(/room(\d+)/.exec(e.id)?.[1]),
    outer = f.doors[room];
  if (!outer) return false;
  const metadata = f.rooms?.find((r) => r.index === room),
    mouth = metadata?.innerMouth ?? outer;
  const target = { x: mouth.x + (mouth.x < 22 ? -1.1 : 1.1), y: mouth.y };
  if (a.defensePlan?.encounter !== e.id) delete a.defensePlan;
  if (!a.defensePlan) {
    if (g.time < (a.defenseRetryAt ?? 0)) return false;
    const candidates = f.furniture
      .filter(
        (o) =>
          o.id.startsWith(`f${a.floor}-room${room}-`) &&
          o.kind === "shelf" &&
          !o.destroyed &&
          !o.credited.length &&
          !furnitureClaimed(g, a, o) &&
          o.h > o.w &&
          canSee(f, a, o, sightRadius(f), o.id) &&
          distance(o, target) > 0.05,
      )
      .sort((b, c) => distance(b, target) - distance(c, target));
    for (const object of candidates) {
      const route = furnitureRoute(f, object, target, a);
      if (route.length) {
        a.defensePlan = {
          encounter: e.id,
          object: object.id,
          target,
          route,
          idle: 0,
        };
        break;
      }
    }
    if (!a.defensePlan) {
      a.defenseRetryAt = g.time + 12;
      return false;
    }
  }
  return followFurniturePlan(g, a, dt);
}
function followFurniturePlan(g: Game, a: Actor, dt: number) {
  const f = g.floors[a.floor],
    plan = a.defensePlan!;
  const object = f.furniture.find((o) => o.id === plan.object);
  if (!object || object.destroyed || furnitureClaimed(g, a, object, true)) {
    releaseFurniturePlan(a);
    return false;
  }
  // Real floor friction stops a released object where it is left, so placement
  // must reach the waypoint itself rather than rely on coasting.
  while (plan.route.length && distance(object, plan.route[0]) < 0.03) {
    plan.route.shift();
    delete plan.bestDistance;
    delete plan.bestApproach;
    plan.idle = 0;
  }
  const next = plan.route[0];
  if (!next) {
    releaseFurniturePlan(a);
    a.defenseRetryAt = g.time + 12;
    return false;
  }
  const remaining = distance(object, next);
  if (
    plan.bestDistance === undefined ||
    remaining < plan.bestDistance - 0.002
  ) {
    plan.bestDistance = remaining;
    plan.idle = 0;
  } else plan.idle += dt;
  const approach = handlingPositions(f, object, next, a).find(
    (p) =>
      !g.survivors.some(
        (b) =>
          b !== a &&
          b.alive &&
          !b.escaped &&
          b.floor === a.floor &&
          distance(p, b) < 0.48,
      ),
  );
  if (approach) {
    const approaching = distance(a, approach);
    if (
      plan.bestApproach === undefined ||
      approaching < plan.bestApproach - 0.02
    ) {
      plan.bestApproach = approaching;
      plan.idle = 0;
    }
    if (distance(a, approach) > 0.18) follow(g, a, approach, dt, false);
    else {
      a.handling = object.id;
      const horizontal =
        Math.abs(next.x - object.x) >= Math.abs(next.y - object.y);
      const delta = horizontal ? next.x - object.x : next.y - object.y;
      pushFurniture(
        g,
        a,
        horizontal ? Math.sign(delta) : 0,
        horizontal ? 0 : Math.sign(delta),
        Math.min(dt, Math.abs(delta) / (object.speed * 1.9)),
      );
    }
  }
  if (plan.idle > 6) {
    releaseFurniturePlan(a);
    a.defenseRetryAt = g.time + 12;
    return false;
  }
  return true;
}

function roomAt(p: Point, f?: Floor) {
  if (f?.generation?.sectors) return sectorAt(f, p)?.room ?? -1;
  if (f?.generation?.stages)
    return (
      f.generation.stages.find((s) => p.y > s.front + 1 && p.y < s.rear)
        ?.room ?? -1
    );
  return p.x < 17 ? (p.y < 15 ? 0 : 2) : p.x > 27 ? (p.y < 15 ? 1 : 3) : -1;
}
function clearExit(g: Game, a: Actor, dt: number, target?: Point) {
  const f = g.floors[a.floor];
  if (a.path.length && a.defensePlan?.encounter !== "egress") return false;
  const destination = target ?? a.defensePlan?.exit ?? f.stairs;
  if (survivorPath(f, a, destination).length) {
    if (a.defensePlan?.encounter === "egress") releaseFurniturePlan(a);
    return false;
  }
  if (a.defensePlan?.encounter !== "egress") {
    if (g.time < (a.defenseRetryAt ?? 0)) return false;
    releaseFurniturePlan(a);
    if (a.x >= 17 && a.x <= 27) return false;
    const side = a.x < 17 ? 0 : 1,
      room = (a.y < 15 ? 0 : 2) + side,
      door = f.doors[room];
    if (!door) return false;
    const doorObject = f.furniture.find(
      (o) => o.kind === "door" && distance(doorFrame(o), door) < 0.1,
    );
    if (
      doorObject &&
      !doorObject.open &&
      canSee(f, a, doorObject, sightRadius(f), doorObject.id)
    ) {
      if (toggleDoor(g, a, doorObject.id, true)) return true;
    }
    const doorApproach = { x: door.x + (side === 0 ? -1.05 : 1.05), y: door.y };
    if (
      distance(a, doorApproach) > 0.4 &&
      survivorPath(f, a, doorApproach).length
    ) {
      follow(g, a, doorApproach, dt, false);
      return true;
    }
    const mouth = f.rooms?.find((r) => r.index === room)?.innerMouth;
    // Layered cover can deny a vault landing well inside the outer door.
    // Work from the visible inner layer outward, moving each real object
    // toward the room interior before trying the ordinary exit route again.
    const relaxed = survivorPath(
      { ...f, furniture: f.furniture.filter((o) => o.speed <= 0) },
      a,
      destination,
    );
    const blockers = new Set<string>();
    for (let i = 0; i < relaxed.length; i++) {
      const from = i ? relaxed[i - 1] : a,
        to = relaxed[i],
        d = distance(from, to);
      if (!d) continue;
      for (const o of f.furniture)
        if (
          o.speed > 0 &&
          !o.destroyed &&
          rayBodyDistance(
            from,
            (to.x - from.x) / d,
            (to.y - from.y) / d,
            o,
            0.26,
          ) < d
        )
          blockers.add(o.id);
    }
    const candidates = f.furniture
      .filter(
        (o) =>
          o.id.startsWith(`f${a.floor}-room${room}-`) &&
          !o.destroyed &&
          o.speed > 0 &&
          blockers.has(o.id) &&
          !furnitureClaimed(g, a, o) &&
          canSee(f, a, o, sightRadius(f), o.id) &&
          ((mouth && distance(o, mouth) < 2) || distance(o, door) < 4),
      )
      .sort((b, c) => distance(a, b) - distance(a, c));
    let chosen:
      { object: Furniture; target: Point; route: Point[] } | undefined;
    for (const object of candidates) {
      const inner = mouth && object.h > object.w && distance(object, mouth) < 2;
      const target = {
        x: object.x + (side === 0 ? -1 : 1) * (inner ? 2.3 : 0.9),
        y: object.y,
      };
      const route = furnitureRoute(f, object, target, a);
      if (route.length) {
        chosen = { object, target, route };
        break;
      }
    }
    if (!chosen) {
      // After moving an opaque inner shelf, walk/vault to its cleared mouth
      // before choosing an outer layer that is still hidden from this side.
      const inspect = mouth && {
        x: mouth.x + (side === 0 ? -0.9 : 0.9),
        y: mouth.y,
      };
      if (
        inspect &&
        distance(a, inspect) > 0.3 &&
        survivorPath(f, a, inspect).length
      ) {
        follow(g, a, inspect, dt, false);
        return true;
      }
      // A reserved or presently immovable exit must not trigger a fresh
      // relaxed navigation graph for every survivor on every simulation tick.
      a.defenseRetryAt = g.time + 2;
      return false;
    }
    const { object, target, route } = chosen;
    a.defensePlan = {
      encounter: "egress",
      object: object.id,
      target,
      route,
      idle: 0,
      exit: destination,
    };
  }
  return followFurniturePlan(g, a, dt);
}
function npc(g: Game, a: Actor, dt: number) {
  // Taking an already available escape wins over retreating from a nearby
  // threat. Boarding still uses the same physical range and atomic seat check.
  if (a.floor === CONFIG.floors && board(g, a)) {
    a.activity = "climbing";
    return;
  }
  const f = g.floors[a.floor];
  observeDoorEntry(f, a);
  if (g.rules === "force-fields") {
    const admission = fieldRouteSignature(f, a);
    if (a.fieldRouteSignature !== admission) {
      a.path = [];
      a.repath = 0;
      delete a.navTarget;
      delete a.station;
      delete a.taskSearch;
      a.fieldRouteSignature = admission;
    }
  }

  const sighted = g.zombies
    .filter(
      (z) =>
        z.floor === a.floor &&
        z.hp > 0 &&
        canSee(f, a, z, Math.min(9, sightRadius(f))),
    )
    .sort((b, c) => distance(a, b) - distance(a, c));
  // An intact force field is cover: a zombie behind it cannot reach the
  // survivor until it breaks through, so it does not trigger a retreat.
  const enemies = sighted.filter((z) => !fieldBetween(f, a, z));
  let near: Zombie | undefined = enemies.sort(
    (b, c) => distance(a, b) - distance(a, c),
  )[0];
  for (const st of f.stations)
    if (canSee(f, a, st) && !a.seen.includes(st.id)) a.seen.push(st.id);
  for (const station of f.stations) {
    const cache = g.encounters[station.encounter];
    if (
      cache.state === "consumed" &&
      cache.reward === "loot" &&
      cache.contributors.includes(a.id) &&
      distance(a, station) < 1.9
    ) {
      const item = cache.loot.find(
        (i) =>
          a.inventory.reduce((n, j) => n + j.weight, 0) + i.weight <=
          CONFIG.capacity,
      );
      if (item) takeLoot(g, a, cache.id, item.id);
    }
  }
  if (a.hp < 65) {
    const med = a.inventory.find((i) => i.kind === "medkit");
    if (med) useItem(g, a, med.id);
  }
  if (near && distance(a, near) < 4) {
    const defense = a.inventory.find(
      (i) =>
        i.kind === "weapon" ||
        i.kind === "repulsor" ||
        (i.kind === "bubble" && a.hp < 60),
    );
    if (defense) useItem(g, a, defense.id);
  }
  if (
    f.dark > 0.8 &&
    !g.effects.some(
      (e) =>
        e.kind === "flare" &&
        e.until > g.time &&
        e.floor === a.floor &&
        canSee(f, e, a, Math.min(e.radius, 5)),
    )
  ) {
    const light = a.inventory.find(
      (i) => i.kind === "flare" || i.kind === "battery",
    );
    if (light) useItem(g, a, light.id);
  }
  near = enemies.find((z) => z.hp > 0);
  // Memory keeps every sighting so a study loop can plan around a zombie that
  // may break a field; retreat planning ignores positions covered by a field.
  rememberThreats(g, a, sighted);
  const remembered = rememberedThreats(g, a);
  const liveThreats = enemies.filter((z) => z.hp > 0),
    liveIds = new Set(liveThreats.map((z) => z.id));
  const planningThreats = [
    ...liveThreats,
    ...remembered.filter(
      (p) =>
        !liveIds.has(p.id) &&
        !sighted.some((z) => z.id === p.id) &&
        !fieldBetween(f, a, p),
    ),
  ];
  let attention = 0.4;
  delete a.handling;
  const pickup =
    a.floor === CONFIG.floors &&
    g.time < g.helicopter.until &&
    g.helicopter.passengers.length < 4;
  if (pickup && a.pickupTrip !== g.helicopter.trip) {
    a.pickupTrip = g.helicopter.trip;
    delete a.fleeTarget;
    a.fleeUntil = 0;
  }
  // A study loop plans around every sighted zombie, field-covered ones
  // included: a field between the survivor and its station can be broken.
  const loopThreats = [
    ...sighted,
    ...remembered.filter((p) => !sighted.some((z) => z.id === p.id)),
  ];
  const studyLoop = studyLoopDecision(g, a, loopThreats);
  if (studyLoop?.mode === "move") {
    a.activity = "fleeing";
    delete a.station;
    follow(g, a, studyLoop.target, dt);
    if (a.intent && npcReasoningAvailable(g.encounters[a.intent], a))
      a.thought +=
        dt *
        0.2 *
        npcThinkingRate(a, g.encounters[a.intent]) *
        npcThinkingScale(g);
    return;
  }
  const loopWork = studyLoop?.mode === "work";
  const reactionDistance = 3 + (1 - a.risk) * 2 + (a.hp < 45 ? 0.8 : 0);
  let immediateThreat =
    !loopWork && near && near.hp > 0 && distance(a, near) < reactionDistance;
  const committedRetreat =
    !loopWork &&
    a.activity === "fleeing" &&
    a.fleeTarget &&
    a.fleeFloor === a.floor &&
    g.time < (a.fleeUntil ?? 0) &&
    distance(a, a.fleeTarget) > 0.8;
  if (
    !loopWork &&
    !immediateThreat &&
    !committedRetreat &&
    a.activity === "fleeing" &&
    planningThreats.length > 0 &&
    unsafeReturn(g, a, planningThreats)
  )
    immediateThreat = true;
  if (
    !immediateThreat &&
    !committedRetreat &&
    a.defensePlan?.encounter === "egress" &&
    clearExit(g, a, dt)
  ) {
    a.activity = "defending";
    return;
  }
  if (immediateThreat || committedRetreat) {
    delete a.furnitureYield;
    attention = near && near.hp > 0 && distance(a, near) < 2 ? 0.05 : 0.2;
    if (a.pullingDoor) {
      delete a.pullingDoor;
      delete a.grip;
    }
    a.activity = "fleeing";
    delete a.station;
    if (
      !a.fleeTarget ||
      a.fleeFloor !== a.floor ||
      g.time >= (a.fleeUntil ?? 0) ||
      distance(a, a.fleeTarget) < 0.8 ||
      enemies.some((z) => z.hp > 0 && distance(z, a.fleeTarget!) < 1.1) ||
      (a.path.length > 0 &&
        enemies.some(
          (z) =>
            z.hp > 0 &&
            !a.fleeRouteThreats?.includes(z.id) &&
            routeContacts(a, a.path, [z]) > 0,
        ))
    ) {
      a.fleeTarget = chooseRetreat(g, a, planningThreats, pickup);
      // Hold a direction long enough to avoid frame-by-frame rerolls, but
      // reconsider before a moving pack can cut off a three-second retreat.
      a.fleeUntil = g.time + 1;
      a.fleeFloor = a.floor;
      // A changed threat can invalidate the route even when the replacement
      // destination is close to the old one. Follow must honor the new choice.
      a.path = [];
      a.repath = 0;
      delete a.navTarget;
      const route = a.fleeTarget ? survivorPath(f, a, a.fleeTarget) : [];
      a.fleeRouteThreats = planningThreats
        .filter((z) => routeContacts(a, route, [z]) > 0)
        .map((z) => z.id);
    }
    if (a.fleeTarget) follow(g, a, a.fleeTarget, dt);
    if (a.hp < 45) {
      const med = a.inventory.find((i) => i.kind === "medkit");
      if (med) useItem(g, a, med.id);
    }
  } else if (yieldFurniture(g, a, dt)) {
    attention = 0.2;
  } else if (a.floor === CONFIG.floors) {
    a.activity = "climbing";
    delete a.station;
    follow(g, a, HELIPAD, dt);
    board(g, a);
  } else if (a.access.includes(a.floor)) {
    a.activity = "climbing";
    delete a.station;
    a.intent = undefined;
    if (clearExit(g, a, dt)) {
      a.activity = "defending";
      return;
    }
    if (a.stairwell === "up" && !a.stairTravel) {
      // A cancelled flight restarts only after stepping out and back in.
      const well = stairwell(f, "up");
      follow(g, a, { x: well.mouth.x, y: well.mouth.y + well.open * 1.0 }, dt);
    } else follow(g, a, f.stairs, dt);
    if (!a.stairTravel && !a.stairwell) stairs(g, a);
  } else {
    // Local exploration: choose visible available stations, never use a station remotely.
    const candidates = f.stations.filter(
      (s) =>
        a.seen.includes(s.id) &&
        g.encounters[s.encounter].state !== "consumed" &&
        (!g.encounters[s.encounter].owner ||
          g.encounters[s.encounter].owner === a.id ||
          g.encounters[s.encounter].mode === "shared") &&
        (g.encounters[s.encounter].reward === "stairs" ||
          (a.inventory.reduce((n, i) => n + i.weight, 0) < 3 &&
            (a.role === "medic" || a.risk > 0.65))),
    );
    let e = a.intent ? g.encounters[a.intent] : undefined;
    if (
      !e ||
      e.state === "consumed" ||
      e.floor !== a.floor ||
      (e.mode === "solo" && e.owner && e.owner !== a.id)
    ) {
      const previousIntent = a.intent;
      let chosen: (typeof candidates)[number] | undefined;
      const search = a.taskSearch;
      if (
        !search ||
        search.floor !== a.floor ||
        search.seen !== a.seen.length ||
        g.time >= search.after
      ) {
        chosen = chooseTaskStation(g, a, candidates);
        a.taskSearch = {
          floor: a.floor,
          seen: a.seen.length,
          after: chosen ? 0 : g.time + 1,
          station: enemies.some((z) => z.hp > 0) ? chosen?.id : undefined,
        };
      }
      e = chosen ? g.encounters[chosen.encounter] : undefined;
      a.intent = e?.id;
      // Replacing an occupied task invalidates every waypoint, even if the
      // new destination matches an older cached navTarget.
      if (previousIntent !== a.intent) {
        a.path = [];
        a.repath = 0;
        delete a.navTarget;
      }
      delete a.station;
      a.thought = 0;
      a.milestone = 0;
    }
    if (!e) {
      a.activity = "exploring";
      delete a.station;
      a.failedExplore = (a.failedExplore ?? [])
        .filter((v) => v.until > g.time)
        .slice(-24);
      const failed = (p: Point) =>
        a.failedExplore!.some(
          (v) => v.floor === a.floor && distance(v.point, p) < 0.4,
        );
      if (a.exploringDoor && a.exploringDoor.floor !== a.floor) {
        delete a.exploringDoor;
        delete a.target;
      }
      if (a.target && distance(a, a.target) < (a.exploringDoor ? 0.35 : 0.7)) {
        rememberPlace(a, `explored-${a.floor}-${a.target.x}-${a.target.y}`);
        if (a.exploringDoor) {
          delete a.exploringDoor;
        }
        delete a.target;
      }
      const standingIn = a.stairTravel ? undefined : stairwellAt(g, a);
      if (standingIn) {
        const well = stairwell(f, standingIn);
        a.target = { x: well.mouth.x, y: well.mouth.y + well.open * 1.0 };
      } else if (f.layout !== "pursuit" && a.y >= 28) {
        a.target = { ...f.entry };
      }
      if (!a.target) {
        const entry = f.furniture
          .filter(
            (o) =>
              o.kind === "door" &&
              o.id !== "main-gate" &&
              !a.seen.includes(`entered-door-${o.id}`) &&
              !failed(doorFrame(o)) &&
              canSee(f, a, doorFrame(o), sightRadius(f), o.id),
          )
          .map((door) => ({ door, goal: doorwayGoal(f, a, door) }))
          .filter(
            (entry): entry is { door: Furniture; goal: Point } =>
              !!entry.goal && !failed(entry.goal),
          )
          .sort(
            (b, c) =>
              distance(a, doorFrame(b.door)) - distance(a, doorFrame(c.door)),
          )[0];
        if (entry) {
          a.target = { ...entry.goal };
          a.exploringDoor = {
            id: entry.door.id,
            floor: a.floor,
            goal: { ...entry.goal },
          };
          a.repath = 0;
        }
      }
      if (!a.target) {
        const visibleRange = f.dark > 0.8 ? 5.4 : f.dark > 0.3 ? 8 : 11;
        const candidates: { point: Point; score: number }[] = [];
        for (let y = 3; y < 28; y++)
          for (let x = 3; x < 42; x++) {
            if (!explorationCell(f, x, y)) continue;
            const p = { x: x + 0.5, y: y + 0.5 };
            if (
              distance(a, p) < 1 ||
              distance(a, p) > visibleRange ||
              solid(f, p) ||
              failed(p) ||
              !canSee(f, a, p, visibleRange) ||
              a.seen.includes(`explored-${a.floor}-${p.x}-${p.y}`)
            )
              continue;
            candidates.push({
              point: p,
              score:
                (x < 17 || x > 26 ? 4 : 0) + distance(a, p) * 0.1 + rand(g) * 4,
            });
          }
        a.target = candidates.sort((b, c) => c.score - b.score)[0]?.point;
        a.repath = 0;
      }
      // Keep this exploration destination until arrival. Recomputing the
      // opposite hall end from current Y flipped direction at the midline.
      if (!a.target) {
        const preferred = { x: 21.5, y: a.y > 15 ? 10 : 23 };
        const options: Point[] = [preferred];
        for (let y = 3; y < 28; y += 2)
          for (let x = 18; x < 26; x++)
            options.push({ x: x + 0.5, y: y + 0.5 });
        a.target = options
          .filter((p) => !solid(f, p) && !failed(p) && distance(a, p) > 1)
          .sort((b, c) => distance(b, preferred) - distance(c, preferred))[0];
      }
      if (!a.target) return;
      const before = { x: a.x, y: a.y };
      follow(g, a, a.target, dt);
      if (g.rules === "force-fields") {
        const gap = distance(a, a.target);
        if (
          !a.exploreProgress ||
          distance(a.exploreProgress.target, a.target) > 0.05
        ) {
          a.exploreProgress = { target: { ...a.target }, best: gap };
          a.exploreStall = 0;
        } else if (gap < a.exploreProgress.best - 0.15) {
          a.exploreProgress.best = gap;
          a.exploreStall = 0;
        } else if (!a.vault) a.exploreStall = (a.exploreStall ?? 0) + dt;
      } else {
        a.exploreStall =
          distance(before, a) < 0.001 && !a.vault
            ? (a.exploreStall ?? 0) + dt
            : 0;
      }
      if (
        (a.exploreStall ?? 0) > 3 &&
        a.target &&
        distance(a, a.target) > 0.7
      ) {
        a.failedExplore.push({
          point: { ...a.target },
          floor: a.floor,
          until: g.time + 30,
        });
        if (a.exploringDoor) {
          const door = f.furniture.find((o) => o.id === a.exploringDoor!.id);
          if (door)
            a.failedExplore.push({
              point: { x: doorFrame(door).x, y: doorFrame(door).y },
              floor: a.floor,
              until: g.time + 30,
            });
          delete a.exploringDoor;
        }
        delete a.target;
        delete a.navTarget;
        a.path = [];
        a.repath = 0;
        a.exploreStall = 0;
      }
    } else {
      // Cautious solo students also prepare their physical room before work.
      // This never substitutes for their own puzzle or grants a credential.
      // Shared defenders can help a full group without occupying a seat.
      if (
        (a.defensePlan?.encounter === e.id ||
          (e.mode === "solo"
            ? a.role === "builder" || a.risk < 0.7
            : !e.contributors.includes(a.id) &&
              (a.role === "builder" || (a.social > 0.7 && a.risk < 0.7)))) &&
        fortify(g, a, e, dt)
      ) {
        a.activity = "defending";
        if (npcReasoningAvailable(e, a))
          a.thought += dt * 0.15 * npcThinkingRate(a, e) * npcThinkingScale(g);
        return;
      }
      // Reserve a stable physical station. Re-sorting and indexing on every frame
      // made agents switch destinations whenever their relative distances changed.
      const stations = f.stations.filter((s) => s.encounter === e!.id);
      const usable = stations.filter(
        (s) =>
          !g.survivors.some(
            (b) =>
              b.id !== a.id &&
              b.alive &&
              !b.escaped &&
              b.floor === a.floor &&
              b.station === s.id &&
              b.intent === e!.id &&
              b.activity !== "fleeing",
          ),
      );
      let st = usable.find((s) => s.id === a.station);
      if (!st) {
        st =
          g.rules === "force-fields"
            ? chooseTaskStation(g, a, usable)
            : (usable.find(
                (s) =>
                  a.taskSearch?.floor === a.floor &&
                  s.id === a.taskSearch.station,
              ) ??
              (enemies.some((z) => z.hp > 0)
                ? chooseTaskStation(g, a, usable)
                : undefined) ??
              usable.sort((b, c) => distance(a, b) - distance(a, c))[0]);
        a.station = st?.id;
        if (st)
          a.taskSearch = {
            floor: a.floor,
            seen: a.seen.length,
            after: 0,
            station: st.id,
          };
      }
      if (!st) {
        // A full station cluster is not remotely usable. Look for another
        // opportunity, or physically help defend this shared encounter.
        const other =
          g.rules === "force-fields"
            ? chooseTaskStation(
                g,
                a,
                candidates.filter((s) => s.encounter !== e!.id),
              )
            : candidates.find((s) => s.encounter !== e!.id);
        if (other) {
          a.intent = undefined;
          a.path = [];
          a.repath = 0;
          delete a.navTarget;
          delete a.station;
          delete a.target;
        }
        a.activity = "waiting";
        return;
      }
      a.activity = "studying";
      const room = Number(/room(\d+)/.exec(e.id)?.[1]);
      const roomDoor = f.furniture.find(
        (o) =>
          o.kind === "door" &&
          distance(doorFrame(o), f.doors[room] ?? { x: -100, y: -100 }) < 0.1,
      );
      if (roomDoor?.door && !roomDoor.door.latched) {
        const frame = doorFrame(roomDoor),
          attempt = `${roomDoor.id}/${roomDoor.door.release ?? 0}`;
        if (
          !a.closingDoor &&
          a.doorCloseAttempt !== attempt &&
          Math.abs(roomDoor.angle ?? 0) > 0.06 &&
          (room % 2 === 0 ? a.x < frame.x - 0.7 : a.x > frame.x + 0.7) &&
          distance(a, frame) < 1.9
        ) {
          a.closingDoor = { id: roomDoor.id, until: g.time + 6 };
          a.doorCloseAttempt = attempt;
        }
        if (a.closingDoor?.id === roomDoor.id && g.time < a.closingDoor.until) {
          const { approach } = doorClosingMotion(roomDoor);
          if (distance(a, approach) < 0.25) a.closingDoor.pushing = true;
          if (!a.closingDoor.pushing) follow(g, a, approach, dt);
          else {
            const drive = doorClosingDrive(roomDoor, a),
              n = Math.hypot(drive.x, drive.y) || 1;
            const amount = Math.min(n, a.speed * dt);
            physicsMove(g, a, (drive.x / n) * amount, (drive.y / n) * amount);
          }
          return;
        }
      }
      delete a.closingDoor;
      const spot = stationSpot(f, st);
      follow(g, a, spot, dt);
      if (distance(a, spot) < 0.3) faceStation(a, st);
      if (distance(a, st) < 1.3 && !a.vault && claimStation(g, a, st.id)) {
        attention = 1;
        if (e.mode === "solo") e.owner ??= a.id;
        if (e.state === "available") e.state = "in-progress";
        if (npcReasoningAvailable(e, a) && a.thought > 24 * (a.milestone + 1)) {
          a.milestone++;
          const mistake = rand(g) > 0.6 + taskSkill(a, e) * 0.3;
          e.npcProgress += recordNpcWork(g, e, a, mistake);
          if (!e.contributors.includes(a.id)) e.contributors.push(a.id);
          if (mistake) a.thought = Math.max(0, a.thought - 15);
        }
        if (e.npcProgress >= 1 && e.state !== "consumed") {
          // NPC-only outcomes are world simulation, never learner evidence. Human-involved work requires the completion adapter.
          const humanWork = hasHumanStudyContext(e);
          if (!humanWork)
            complete(
              g,
              e.id,
              `npc-sim-${e.id}`,
              e.contributors,
              "Simulated NPC-only outcome; no runtime execution or human mastery.",
            );
        }
      }
    }
  }
  if (
    a.intent &&
    g.encounters[a.intent]?.state !== "consumed" &&
    npcReasoningAvailable(g.encounters[a.intent], a)
  )
    a.thought +=
      dt *
      attention *
      npcThinkingRate(a, g.encounters[a.intent]) *
      npcThinkingScale(g) *
      (1 + (a.role === "analyst" ? 0.2 : 0));
}
export function complete(
  g: Game,
  id: string,
  submissionId: string,
  contributors: string[],
  provenance: string,
) {
  const e = g.encounters[id];
  if (!e || e.state === "consumed") return false;
  e.state = "consumed";
  // A one-use world lock is unavailable for unfinished study. A later valid
  // assessment may still settle this exact attempt, without binding the next task here.
  if (g.study.learner) interruptLearningAttempt(g.study.learner, e);
  e.accepted = submissionId;
  const submission = e.submissions.find((s) => s.id === submissionId);
  if (submission) {
    submission.status = "complete";
    submission.feedback = provenance;
    e.workspace = submission.content;
    e.revision = submission.revision;
  }
  e.chatOpen = false;
  for (const id of e.studyOnly ? [] : new Set(contributors)) {
    const a = g.survivors.find((s) => s.id === id);
    if (
      !a ||
      !a.alive ||
      a.escaped ||
      (a.id === "human" && (g.status === "dead" || g.status === "escaped"))
    )
      continue;
    if (g.rules === "force-fields") a.keys = (a.keys ?? 0) + 1;
    if (e.reward === "stairs" && !a.access.includes(e.floor))
      a.access.push(e.floor);
  }
  const ev = event(
    g,
    "completion",
    e.studyOnly
      ? `Study question completed. ${provenance}`
      : `${e.mode === "shared" ? "Shared" : "Solo"} ${e.reward === "stairs" ? "stair credential" : "cache"} unlocked. ${provenance}`,
    e.floor,
    undefined,
    e.id,
  );
  e.history.push({
    seq: ev.seq,
    author: "system",
    kind: "completion",
    text: ev.text,
    at: g.time,
    revision: e.revision,
  });
  if (submissionId === `npc-sim-${e.id}` && !hasHumanStudyContext(e))
    e.simulatedOutcome = structuredClone({
      id: submissionId,
      runId: g.id,
      revision: e.revision,
      workspace: e.workspace,
      at: g.time,
      cutoff: ev.seq,
      contributors: [...new Set(contributors.filter((id) => id !== "human"))],
      ...(e.problem ? { problem: e.problem } : {}),
      work: (e.npcWork ?? []).filter((w) => w.seq <= ev.seq).slice(-16),
    });
  return true;
}
// Resolve physical crowding with bounded local steps. New arrivals are placed
// in free outside slots; this also lets legacy overlapping saves separate by
// walking, without teleporting or passing through a wall/barricade.
function clearWallSegment(f: Floor, a: Point, b: Point) {
  const samples = Math.max(1, Math.ceil(distance(a, b) / 0.15));
  for (let i = 0; i <= samples; i++)
    for (const dx of [-0.22, 0.22])
      for (const dy of [-0.22, 0.22])
        if (
          wall(
            f,
            a.x + ((b.x - a.x) * i) / samples + dx,
            a.y + ((b.y - a.y) * i) / samples + dy,
          )
        )
          return false;
  return true;
}
function moveZombie(
  g: Game,
  z: Zombie,
  toward: Point,
  amount: number,
  crowd: ZombieIndex,
) {
  const f = physicsActive(g) ? physicsFloor(g, z.floor) : g.floors[z.floor],
    others = crowd
      .near(z.floor, z, Math.max(1, 0.52 + amount))
      .filter((o) => o !== z);
  const overlap = (p: Point) =>
    others.reduce((n, o) => n + Math.max(0, 0.52 - distance(o, p)) ** 2, 0);
  const oldOverlap = overlap(z),
    angle = Math.atan2(toward.y - z.y, toward.x - z.x);
  const parity = Number(z.id.replace(/\D/g, "")) % 2 ? 1 : -1;
  for (const offset of [
    0,
    (Math.PI / 6) * parity,
    (-Math.PI / 6) * parity,
    (Math.PI / 3) * parity,
    (-Math.PI / 3) * parity,
    (Math.PI / 2) * parity,
    (-Math.PI / 2) * parity,
  ]) {
    const p = { x: z.x, y: z.y };
    move(
      f,
      p,
      Math.cos(angle + offset) * amount,
      Math.sin(angle + offset) * amount,
    );
    if (distance(p, z) < 0.0001) continue;
    if (!clearWallSegment(f, p, toward)) continue;
    const nextOverlap = overlap(p);
    if (
      nextOverlap > 0.0000001 &&
      (oldOverlap < 0.0000001 || nextOverlap >= oldOverlap - 0.000001)
    )
      continue;
    Object.assign(z, p);
    return true;
  }
  // Give the front of a queue room to align with a narrow opening. A
  // follower may step back or sideways at normal speed; it still observes
  // solid geometry and body separation. This also unwinds existing arches.
  const destination = z.target ?? toward;
  const rank = (a: Zombie) => distance(a, destination);
  const leader = others
    .filter(
      (o) =>
        distance(o, z) < 1 &&
        (rank(o) < rank(z) - 0.01 ||
          (Math.abs(rank(o) - rank(z)) <= 0.01 && o.id < z.id)),
    )
    .sort((a, b) => rank(a) - rank(b))[0];
  if (leader) {
    const away = Math.atan2(z.y - leader.y, z.x - leader.x);
    for (const offset of [
      0,
      Math.PI / 4,
      -Math.PI / 4,
      Math.PI / 2,
      -Math.PI / 2,
    ]) {
      const p = { x: z.x, y: z.y };
      move(
        f,
        p,
        Math.cos(away + offset) * amount,
        Math.sin(away + offset) * amount,
      );
      if (distance(p, z) < 0.0001 || distance(p, leader) <= distance(z, leader))
        continue;
      const nextOverlap = overlap(p);
      if (
        nextOverlap > 0.0000001 &&
        (oldOverlap < 0.0000001 || nextOverlap >= oldOverlap - 0.000001)
      )
        continue;
      Object.assign(z, p);
      return true;
    }
  }
  return false;
}
function strikeSurvivor(
  g: Game,
  z: Zombie,
  prey: Actor,
  floor: number,
  position: Point,
) {
  const hit = event(
    g,
    "survivor-hit",
    "A zombie attack struck a survivor.",
    floor,
    z.id,
  );
  hit.position = { x: position.x, y: position.y };
  if (floor !== z.floor) hit.stairContact = true;
  z.cooldown = 0.95;
  damageSurvivor(g, prey, g.surge.state === "active" ? 21 : 14);
}
function strikeFurniture(
  g: Game,
  z: Zombie,
  ob: Furniture,
  floor: number,
  position: Point,
) {
  ob.hp -=
    g.surge.state === "active"
      ? BARRICADE_ATTACK.surgeDamage
      : BARRICADE_ATTACK.damage;
  const hit = event(
    g,
    "barricade-hit",
    ob.field
      ? "A zombie struck a door."
      : "A zombie struck a barricade.",
    floor,
    z.id,
  );
  hit.position = { x: position.x, y: position.y };
  if (floor !== z.floor) hit.stairContact = true;
  z.cooldown = BARRICADE_ATTACK.cooldown;
  if (ob.hp <= 0) {
    ob.destroyed = true;
    ob.hp = 0;
    g.stats.breaches++;
    event(
      g,
      "breach",
      `A ${ob.field ? "door" : ob.kind === "gate" ? "main entrance" : ob.kind} broke apart.`,
      floor,
    ).position = { x: position.x, y: position.y };
  }
}
/** Keep city and indoor queues on the same physical face/slot attack budget. */
function contactFurniture(
  g: Game,
  z: Zombie,
  ob: Furniture,
  contacts: Map<string, number>,
) {
  const surface = surfacePoint(z, ob),
    horizontal =
      Math.abs(z.x - ob.x) / (ob.w / 2) > Math.abs(z.y - ob.y) / (ob.h / 2),
    face = horizontal
      ? z.x < ob.x
        ? "west"
        : "east"
      : z.y < ob.y
        ? "north"
        : "south",
    slots = Math.max(1, Math.floor(horizontal ? ob.h : ob.w)),
    key = `${ob.id}/${face}`,
    n = contacts.get(key) ?? 0,
    positionKey = `${key}/${Math.floor(horizontal ? surface.y : surface.x)}`;
  if (n >= slots || contacts.has(positionKey)) return;
  contacts.set(key, n + 1);
  contacts.set(positionKey, 1);
  if (z.cooldown <= 0) strikeFurniture(g, z, ob, z.floor, z);
}

function zombie(
  g: Game,
  z: Zombie,
  dt: number,
  contacts: Map<string, number>,
  crowd: ZombieIndex,
) {
  z.stagger = Math.max(0, z.stagger - dt);
  z.cooldown = Math.max(0, z.cooldown - dt);
  if (z.hp <= 0 || z.stagger > 0) return;
  const arrival = zombieStairArrival(g, z, crowd);
  if (arrival) {
    if (arrival.kind === "cancel") delete z.stairUntil;
    else {
      if (arrival.kind === "arrive") {
        z.floor = arrival.floor;
        Object.assign(z, arrival.position);
        delete z.stairUntil;
        z.path = [];
        delete z.target;
        z.memory = 0;
        z.repath = 0;
        event(
          g,
          "horde-climb",
          "The horde reached a higher floor.",
          z.floor,
          z.id,
        );
      } else if (arrival.kind === "furniture" || arrival.kind === "survivor") {
        const key = `stair-exit/${z.floor}/${arrival.floor}`;
        if (!contacts.has(key)) {
          contacts.set(key, 1);
          if (z.cooldown <= 0) {
            if (arrival.kind === "furniture")
              strikeFurniture(
                g,
                z,
                arrival.object,
                arrival.floor,
                arrival.position,
              );
            else
              strikeSurvivor(
                g,
                z,
                arrival.actor,
                arrival.floor,
                arrival.position,
              );
          }
        }
      }
      return;
    }
  }
  const f = g.floors[z.floor];
  prepareZombieSearch(g, z);
  let prey = g.survivors
    .filter(
      (a) =>
        actorOnFloor(g, a, z.floor) &&
        a.alive &&
        !a.escaped &&
        canSee(f, z, a, 12, a.vault?.obstacle),
    )
    .sort((a, b) => distance(a, z) - distance(b, z))[0];
  const decoy = g.effects
    .filter(
      (e) =>
        e.kind === "decoy" &&
        e.until > g.time &&
        e.floor === z.floor &&
        distance(e, z) < e.radius * soundGain(f, z, e),
    )
    .sort((a, b) => distance(z, a) - distance(z, b))[0];
  if (prey) {
    z.target = { x: prey.x, y: prey.y };
    z.memory = g.time + 9;
  } else {
    const heard =
      z.repath <= 0
        ? g.survivors
            .filter(
              (a) =>
                actorOnFloor(g, a, z.floor) &&
                a.alive &&
                !a.escaped &&
                (a.noiseUntil ?? 0) > g.time &&
                distance(a, z) < (a.noiseLevel ?? 0),
            )
            .sort((a, b) => distance(z, a) - distance(z, b))
            .slice(0, 3)
            .find(
              (a) => distance(a, z) < (a.noiseLevel ?? 0) * soundGain(f, z, a),
            )
        : undefined;
    if (heard) {
      // Sound gives a rough location, not the survivor's exact live position.
      z.target = {
        x: Math.floor(heard.x / 2) * 2 + 1,
        y: Math.floor(heard.y / 2) * 2 + 1,
      };
      z.memory = g.time + 5;
    } else if (z.target && (g.time > z.memory || distance(z, z.target) < 0.8)) {
      z.target = undefined;
      z.repath = 0;
    }
  }
  const target = decoy ?? z.target;
  const bubble = g.effects.find(
    (e) =>
      e.kind === "bubble" &&
      e.until > g.time &&
      e.floor === z.floor &&
      canSee(f, e, z, e.radius + 0.5),
  );
  if (bubble) {
    const d = distance(z, bubble) || 1;
    move(
      f,
      z,
      ((z.x - bubble.x) / d) * dt * 3,
      ((z.y - bubble.y) / d) * dt * 3,
    );
    return;
  }
  const surge = g.surge.state === "active";
  const zombieStep =
    (g.rules === "force-fields"
      ? CONFIG.playerSpeed * SWARM.speedRatio
      : CONFIG.zombieSpeed * (surge ? SURGE_SPEED_MULTIPLIER : 1)) * dt;
  if (
    prey &&
    distance(z, prey) < 0.78 &&
    line(f, z, prey, true, prey.vault?.obstacle) &&
    z.cooldown <= 0
  ) {
    strikeSurvivor(g, z, prey, z.floor, z);
    return;
  }
  const approach = cityApproachTarget(g, z);
  const cityDoor = approach
    ? f.furniture.find((object) => object.id === "main-gate")
    : undefined;
  const preyRow = prey && f.boundary?.rows[Math.floor(prey.y)];
  const shelteredPrey =
    prey &&
    cityDoor &&
    !cityDoor.destroyed &&
    preyRow &&
    f.boundary &&
    prey.y >= f.boundary.top &&
    prey.y < f.boundary.bottom &&
    prey.x >= preyRow.left &&
    prey.x < preyRow.right;
  if (approach && (!prey || shelteredPrey) && !decoy) {
    const door = cityDoor;
    if (
      approach.finalDoor &&
      door &&
      !door.destroyed &&
      distance(z, surfacePoint(z, door)) <= 0.42 + 1e-6
    ) {
      contactFurniture(g, z, door, contacts);
      return;
    }
    const d = distance(z, approach.point);
    if (d > 1e-7) {
      const probe = {
          x: z.x + ((approach.point.x - z.x) / d) * 0.55,
          y: z.y + ((approach.point.y - z.y) / d) * 0.55,
        },
        obstacle = (furnitureNear(f, probe, 0.23) ?? f.furniture).find((o) =>
          inFurniture(probe, o, 0.23),
        );
      if (obstacle && !(obstacle.door && !obstacle.door.latched)) {
        const close = distance(z, surfacePoint(z, obstacle)) <= 0.42,
          shove =
            obstacle.speed > 0 &&
            !obstacle.field &&
            FURNITURE[obstacle.kind].resist < ZOMBIE_PUSH;
        if (close && !shove) {
          contactFurniture(g, z, obstacle, contacts);
          return;
        }
        if (close && z.cooldown <= 0)
          strikeFurniture(g, z, obstacle, z.floor, z);
      }
    }
    if (d > 1e-7)
      moveZombie(g, z, approach.point, Math.min(approach.speed * dt, d), crowd);
    return;
  }
  z.repath -= dt;
  if (z.repath <= 0) {
    z.path = planZombieRoute(g, z, target);
    z.repath = 1.2 + zombieSearchRandom(g, z, -1) * 0.6;
  }
  let p = z.path[0];
  if (p && distance(z, p) < 0.17) {
    z.path.shift();
    p = z.path[0];
  }
  // A waypoint is a route guide, not a point every member of a crowd must
  // occupy. Skip a nearby guide only when the next swept segment is clear.
  while (
    z.path.length > 1 &&
    distance(z, z.path[0]) < 0.7 &&
    walkSegment(f, z, z.path[1])
  )
    z.path.shift();
  p = z.path[0];
  // A visible moving survivor is a live steering target, not a cell centre
  // captured by the slower exploration planner. Sweep the full body so this
  // shortcut cannot cut corners or walk through desks/force fields. Decoys
  // retain priority and obstructed prey still use the local search route.
  if (prey && !decoy && walkSegment(f, z, prey)) p = prey;
  if (p && !clearWallSegment(f, z, p))
    p = { x: Math.floor(z.x) + 0.5, y: Math.floor(z.y) + 0.5 };
  // Grid search has no edge when both positions share a cell. Finish the
  // remaining physical distance instead of freezing just outside attack range.
  if (
    !p &&
    target &&
    !solid(f, target) &&
    canSee(f, z, target, 12) &&
    clearWallSegment(f, z, target)
  )
    p = target;
  if (p) {
    const d = distance(z, p) || 1,
      dx = (p.x - z.x) / d,
      dy = (p.y - z.y) / d;
    const probe = { x: z.x + dx * 0.55, y: z.y + dy * 0.55 },
      ob = (furnitureNear(f, probe, 0.23) ?? f.furniture).find((o) =>
        inFurniture(probe, o, 0.23),
      );
    if (ob?.door && !ob.door.latched) {
      moveZombie(g, z, p, Math.min(zombieStep, d), crowd);
      return;
    }
    if (ob) {
      const surface = surfacePoint(z, ob);
      // Objects lighter than one zombie's push (chairs, plants) are shoved
      // aside while being struck; heavier ones stop the zombie to attack.
      const shove =
        ob.speed > 0 && !ob.field && FURNITURE[ob.kind].resist < ZOMBIE_PUSH;
      if (shove && distance(z, surface) <= 0.42 && z.cooldown <= 0)
        strikeFurniture(g, z, ob, z.floor, z);
      if (shove || distance(z, surface) > 0.42) {
        moveZombie(g, z, p, Math.min(zombieStep, d), crowd);
        return;
      }
      // A contacting attacker occupies its face slot throughout its cooldown.
      // Otherwise alternating queued attackers multiply DPS between frames.
      contactFurniture(g, z, ob, contacts);
      return;
    }
    moveZombie(g, z, p, Math.min(zombieStep, d), crowd);
  }
  if (
    z.floor < CONFIG.floors &&
    distance(z, f.stairs) < (f.layout === "pursuit" ? STAIRWELL_RADIUS : 0.75)
  ) {
    z.stairUntil = g.time + CONFIG.stairSeconds;
    event(
      g,
      "horde-stairs",
      "A zombie entered the stair flight.",
      z.floor,
      z.id,
    );
  }
}
export function useItem(g: Game, a: Actor, id: string) {
  const it = a.inventory.find((i) => i.id === id);
  const issue = itemUseIssue(g, a, it);
  if (issue) {
    if (a === human(g)) g.notice = issue;
    return false;
  }
  if (!it) return false;
  const placeEffect = (
    kind: "bubble" | "flare" | "decoy",
    spec: "bubble" | "flare" | "decoy" | "battery",
  ) =>
    g.effects.push({
      kind,
      floor: a.floor,
      x: a.x,
      y: a.y,
      radius: EQUIPMENT[spec].radius,
      until: g.time + EQUIPMENT[spec].seconds,
    });
  switch (it.kind) {
    case "medkit":
      a.hp = Math.min(100, a.hp + EQUIPMENT.medkit.heal);
      break;
    case "bubble":
      placeEffect("bubble", "bubble");
      break;
    case "flare":
      placeEffect("flare", "flare");
      break;
    case "decoy":
      placeEffect("decoy", "decoy");
      break;
    case "battery":
      placeEffect("flare", "battery");
      break;
    case "repulsor":
    case "weapon":
      for (const z of itemTargets(g, a, it.kind)) {
        if (it.kind === "weapon")
          z.hp = Math.max(0, z.hp - EQUIPMENT.weapon.damage);
        else knockback(g, z, a);
      }
      break;
  }
  it.charges--;
  if (it.charges <= 0) a.inventory = a.inventory.filter((i) => i !== it);
  event(g, "item", `${a.name} used a ${it.kind}.`, a.floor, a.id);
  return true;
}
function knockback(g: Game, z: Zombie, from: Point) {
  physicsKick(g, z, from);
  z.stagger = 2.5;
  z.path = [];
}
export function takeLoot(g: Game, a: Actor, id: string, itemId: string) {
  const e = g.encounters[id],
    station = g.floors[a.floor].stations.find(
      (s) => s.encounter === id && canReachStation(g, a, s, 2),
    );
  if (
    !station ||
    !e ||
    e.state !== "consumed" ||
    e.reward !== "loot" ||
    !e.contributors.includes(a.id)
  )
    return false;
  const item = e.loot.find((i) => i.id === itemId);
  if (
    !item ||
    a.inventory.reduce((n, i) => n + i.weight, 0) + item.weight >
      CONFIG.capacity
  )
    return false;
  e.loot = e.loot.filter((i) => i !== item);
  a.inventory.push(item);
  event(g, "loot", `${a.name} collected a ${item.kind}.`, a.floor, a.id, e.id);
  return true;
}
export function step(
  g: Game,
  dt: number,
  input: Input = { x: 0, y: 0, grab: false },
) {
  // The world keeps running after the human's death/extraction; pause and
  // not-yet-started runs still freeze it.
  if (!simulationActive(g) || g.paused || !Number.isFinite(dt) || dt <= 0)
    return;
  // Historical ended saves predate endedAt. Their saved world time is the
  // best available human end time, before spectator advancement resumes.
  if (!humanActive(g)) markEnded(g);
  dt = Math.min(dt, 0.1);
  beginPhysics(g);
  beginFurnitureIndex(g.floors);
  try {
    advanceStep(g, dt, input);
    for (const object of finishPhysics(g, dt))
      for (const id of object.movers) {
        const a = g.survivors.find(
          (a) =>
            a.id === id && a.floor === object.floor && a.alive && !a.escaped,
        );
        if (a) defenseCredit(g, a, object);
      }
    recordZombieTrails(g);
  } finally {
    endFurnitureIndex();
    cancelPhysics(g);
  }
}
function advanceStep(
  g: Game,
  dt: number,
  input: Input = { x: 0, y: 0, grab: false },
) {
  if (!simulationActive(g) || g.paused) return;
  dt = Math.min(dt, 0.1);
  g.time += dt;
  g.tick = (g.tick ?? 0) + 1;
  tickSurge(g);
  for (const e of g.effects.filter((e) => e.until <= g.time))
    if (e.kind === "bubble") {
      for (const z of g.zombies.filter(
        (z) =>
          z.hp > 0 &&
          z.floor === e.floor &&
          canSee(g.floors[e.floor], e, z, e.radius + 1),
      ))
        knockback(g, z, e);
      event(
        g,
        "bubble-end",
        "The shield disperses in a concussive burst.",
        e.floor,
      );
    }
  g.effects = g.effects.filter((e) => e.until > g.time);
  const a = human(g);
  for (const f of g.floors)
    for (const o of f.furniture) {
      o.movers = [];
      if (o.turning > 0) o.turning = Math.max(0, o.turning - dt);
    }
  // Human input ends with the human's run; the world keeps advancing.
  if (humanActive(g) && a.alive && !a.escaped) {
    a.cooldown = Math.max(0, a.cooldown - dt);
    if (input.stairWalk) enterCityStairBase(g, a, input);
    if (!a.elevated || a.elevated.grounded)
      enterStairs(g, a, !!input.stairWalk || !!a.elevated, input);
    // An older saved timed flight can be resumed as a walkable flight without
    // regenerating the world or changing the player's earned stair access.
    if (
      (input.stairWalk || input.jump) &&
      a.stairTravel &&
      a.stairTravel.walked === undefined
    )
      a.stairTravel.walked = 0;
    ensureWalkingBody(g, a);
    if (input.jump && !a.vault) {
      const vaulted = g.rules !== "force-fields" && vault(g, a);
      if (!vaulted) jumpElevated(g, a);
    }
    const walking = a.stairTravel?.walked !== undefined;
    // Walking out of the staircase cancels a flight; walking inside it does not.
    const landed =
      !walking && !a.elevated && advanceStairs(g, a) && !a.stairTravel;
    if (a.elevated) {
      const magnitude = Math.hypot(input.x, input.y);
      if (magnitude) {
        a.heading = { x: input.x / magnitude, y: input.y / magnitude };
        a.noiseUntil = g.time + 0.4;
        a.noiseLevel = 4;
      }
      physicsElevated(g, (elapsed) => {
        if (!a.elevated || !a.alive || a.escaped) return;
        const result = stepElevated(g, a, input, elapsed);
        settleElevated(g, a, result.surface);
        if (result.landed) {
          const damage = fallDamage(result.landed.drop);
          if (damage > 0) {
            const fall = event(
              g,
              "fall",
              `${a.name} fell ${result.landed.drop.toFixed(1)} metres and took ${Math.round(damage)} damage.`,
              a.floor,
              a.id,
            );
            fall.position = { x: a.x, y: a.y };
            damageSurvivor(
              g,
              a,
              damage,
              a.id === "human" ? "fell to your death" : "fell to their death",
            );
          }
        }
      });
    } else if (landed) {
      /* Settle on the new floor's landing before taking input again. */
    } else if (a.vault) advanceVault(a, dt);
    else if (input.x || input.y) {
      const n = Math.hypot(input.x, input.y);
      a.heading = { x: input.x / n, y: input.y / n };
      a.noiseUntil = g.time + 0.4;
      a.noiseLevel = 4;
      if (a.grip) dragFurniture(g, a, input.x, input.y, dt);
      else if (input.grab) pushFurniture(g, a, input.x, input.y, dt);
      else {
        delete a.handling;
        if (
          !physicsMove(
            g,
            a,
            (input.x / n) * a.speed * dt,
            (input.y / n) * a.speed * dt,
          )
        )
          move(
            g.floors[a.floor],
            a,
            (input.x / n) * a.speed * dt,
            (input.y / n) * a.speed * dt,
          );
      }
    } else if (!input.grab && !a.grip) delete a.handling;
  }
  const thinkingScale = npcThinkingScale(g);
  for (const b of g.survivors.slice(1)) {
    if (!b.alive || b.escaped) continue;
    b.cooldown = Math.max(0, b.cooldown - dt);
    const previous = { activity: b.activity, intent: b.intent, floor: b.floor };
    enterStairs(g, b);
    if (advanceStairs(g, b)) {
      if (
        b.intent &&
        g.encounters[b.intent]?.state !== "consumed" &&
        npcReasoningAvailable(g.encounters[b.intent], b)
      )
        b.thought +=
          dt * 0.2 * npcThinkingRate(b, g.encounters[b.intent]) * thinkingScale;
    } else if (b.vault) {
      advanceVault(b, dt);
      if (
        b.intent &&
        g.encounters[b.intent]?.state !== "consumed" &&
        npcReasoningAvailable(g.encounters[b.intent], b)
      )
        b.thought +=
          dt * 0.2 * npcThinkingRate(b, g.encounters[b.intent]) * thinkingScale;
    } else npc(g, b, dt);
    recordNpcActivity(g, b, previous);
  }
  if ((g.floors[0].city || g.time >= spawnGrace(g)) && g.time >= g.nextSpawn) {
    const swarm = swarmPacing(g);
    g.nextSpawn =
      g.time +
      (g.rules === "force-fields" ? swarm.interval : CONFIG.spawnInterval);
    if (g.rules === "force-fields")
      g.zombies = g.zombies.filter((z) => z.hp > 0);
    const batch =
      g.rules === "force-fields"
        ? Math.min(swarm.batch, Math.max(0, swarm.cap - g.zombies.length))
        : g.spawned < CONFIG.openingHorde
          ? Math.min(CONFIG.openingBatch, CONFIG.openingHorde - g.spawned)
          : CONFIG.reinforcementBatch;
    if (g.floors[0].city) spawnCityReinforcements(g, batch);
    else
      for (let n = 0; n < batch; n++) {
        const positions = Array.from({ length: 12 }, (_, i) => ({
          x: 18.6 + ((i + g.spawned) % 12) * 0.6,
          y: 33.4,
        }));
        const position = positions.find(
          (p) =>
            !solid(g.floors[0], p) &&
            !g.zombies.some(
              (z) => z.floor === 0 && z.hp > 0 && distance(z, p) < 0.55,
            ) &&
            !g.survivors.some(
              (a) =>
                a.floor === 0 && a.alive && !a.escaped && distance(a, p) < 0.55,
            ),
        );
        if (!position) break;
        g.zombies.push({
          id: `z${g.spawned++}`,
          floor: 0,
          ...position,
          hp: 60,
          path: [],
          repath: 0,
          cooldown: 0,
          memory: 0,
          stagger: 0,
          origin: "outside",
        });
      }
  }
  const contacts = new Map<string, number>();
  const crowd = new ZombieIndex(g.zombies);
  for (const z of g.zombies) {
    zombie(g, z, dt, contacts, crowd);
    crowd.update(z);
  }
  const h = g.helicopter;
  if (g.time >= h.next) {
    h.trip++;
    h.passengers = [];
    h.until = g.time + CONFIG.boardingWindow;
    h.next = g.time + helicopterInterval(g);
    event(
      g,
      "helicopter",
      "A four-seat helicopter is boarding.",
      CONFIG.floors,
    );
  }
}
