import {
  type Actor,
  type Game,
  type Point,
  CONFIG,
  devPass,
  distance,
  event,
} from "./model";
import { walkSegment } from "./navigation";
import { line, solid } from "./spatial";
import { STAIRWELL_RADIUS, inStairwell, stairwell } from "./stairwell";
import {
  cityStairBase,
  buildStairRoute,
  FLOOR_HEIGHT,
  sampleStairRoute,
  STAIR_ROUTE_WIDTH,
  travelSite,
} from "./stair-route";
import {
  START_SITE,
  roofFloorOf,
  stairMarkers,
  type StairMarker,
} from "./site";
import {
  insideFootprint,
  startElevated,
  stepElevated,
  surfaceBelow,
  type ElevatedSurface,
} from "./elevated-physics";

/** On a carved well, walking this close to the marker completes the flight. */
export const STAIRWELL_DEEP = STAIRWELL_RADIUS / 2;

export interface StairTravel {
  fromFloor: number;
  toFloor: number;
  /** Site whose markers this flight connects; omitted for the start building. */
  site?: string;
  origin: Point;
  destination: Point;
  until: number;
  /** Saved metres along the physical exterior flight. Omitted for legacy/AI flights. */
  walked?: number;
  /** A licensed walker joined the ground flight from its actual city position. */
  cityBase?: boolean;
  /** A physical walker has left the building, and later entered a floor plate. */
  left?: boolean;
  arrived?: boolean;
}
const refusedCityBase = new WeakSet<Actor>();

function refuseStairs(g: Game, a: Actor) {
  if (a.id !== "human") return;
  g.notice =
    "This staircase is locked for you. Solve a solo terminal on this floor for personal stair access.";
  event(
    g,
    "stairs-locked",
    "The staircase refused a survivor without personal access.",
    a.floor,
    a.id,
  );
}

/** The court can meet the bottom of the visible flight directly. Join its
 * continuous motor before touching the first riser, preserving the actual
 * departure position and requiring exactly the same personal credential. */
export function enterCityStairBase(g: Game, a: Actor, input: Point) {
  // Open ground has no stair base to join: the marker is the pickup pad.
  if (g.floors[0]?.open) return false;
  const base = cityStairBase(g);
  if (
    !base ||
    a.id !== "human" ||
    a.floor !== 0 ||
    !a.alive ||
    a.escaped ||
    a.vault ||
    a.stairTravel
  )
    return false;
  const forward = base.start.y - a.y,
    lateral = Math.abs(a.x - base.start.x),
    near =
      forward > 0 &&
      forward <= 0.95 &&
      lateral <= STAIR_ROUTE_WIDTH / 2 - 0.25 &&
      Math.hypot(forward, lateral) <= 1;
  if (!near) {
    refusedCityBase.delete(a);
    return false;
  }
  const magnitude = Math.hypot(input.x, input.y);
  if (!magnitude || input.y / magnitude < 0.5) return false;
  // Only this credentialed entry may ignore the flat footprint of the rise;
  // real furniture and all other city/office geometry remain blocking.
  const floor = g.floors[0],
    approach = {
      ...floor,
      city: {
        ...floor.city!,
        obstacles: floor.city!.obstacles.filter((o) => o.kind !== "stair-base"),
      },
    };
  if (!walkSegment(approach, a, base.start)) return false;
  if (!a.access.includes(0) && !devPass(a)) {
    if (!refusedCityBase.has(a)) refuseStairs(g, a);
    refusedCityBase.add(a);
    return false;
  }
  refusedCityBase.delete(a);
  return startStairTravel(
    g,
    a,
    {
      fromFloor: 0,
      toFloor: 1,
      origin: { x: a.x, y: a.y },
      destination: { ...g.floors[1].entry },
      until: g.time + CONFIG.stairSeconds,
      walked: 0,
      cityBase: true,
    },
    false,
    true,
  );
}
/** The nearest stair marker of any site on this floor that the actor stands
 * in; on an exact tie the start building's own marker wins, as before. */
function stairMarkerAt(
  g: Game,
  a: Actor,
  direction?: "up" | "down",
): StairMarker | undefined {
  let best: StairMarker | undefined,
    bestDistance = Infinity;
  for (const marker of stairMarkers(g, a.floor)) {
    if (direction && marker.direction !== direction) continue;
    if (!inStairwell(a, marker.at)) continue;
    const d = distance(a, marker.at);
    if (d < bestDistance) {
      best = marker;
      bestDistance = d;
    }
  }
  return best;
}
/** Which staircase on its floor the survivor is standing in, if any. */
export function stairwellAt(g: Game, a: Actor): "up" | "down" | undefined {
  if (!g.floors[a.floor]) return undefined;
  return stairMarkerAt(g, a)?.direction;
}
/** Walking into a staircase starts its flight. Standing in one, or arriving
 * in one from another floor, does not start another; the survivor must step
 * out and back in. A locked staircase refuses the entry and says why. */
export function enterStairs(g: Game, a: Actor, walking = false, input?: Point) {
  const marker = a.alive && !a.escaped ? stairMarkerAt(g, a) : undefined,
    well = marker?.direction;
  if (well === a.stairwell) {
    // A newly unlocked visible portal must work without requiring an unseen
    // step-out/reset. Outbound input also distinguishes this from an arrival.
    const outbound = well && input && input.y * (well === "up" ? -1 : 1) > 0;
    // Only the start building's climb is gated by personal credentials.
    if (
      !walking ||
      !outbound ||
      (well === "up" &&
        marker?.site.id === START_SITE &&
        !a.access.includes(a.floor) &&
        !devPass(a))
    )
      return false;
  }
  if (well) a.stairwell = well;
  else delete a.stairwell;
  if (!well || a.stairTravel || a.vault) return false;
  return beginStairs(g, a, well === "down", walking);
}
export function cancelStairs(g: Game, a: Actor) {
  if (!a.stairTravel) return;
  delete a.stairTravel;
  a.activity = "exploring";
  if (a.id === "human")
    g.notice = "You left the staircase. You are still on this floor.";
}
export function beginStairs(g: Game, a: Actor, down = false, walking = false) {
  // An open site is ground level: its stair marker is the extraction pad, so
  // no flight ever starts and nobody leaves floor 0.
  if (g.floors[a.floor]?.open) return false;
  if (!a.alive || a.escaped || a.vault || a.stairTravel) return false;
  const source = g.floors[a.floor],
    marker = stairMarkerAt(g, a, down ? "down" : "up");
  if (!source || !marker || !walkSegment(source, a, marker.at)) return false;
  const site = marker.site,
    toFloor = a.floor + (down ? -1 : 1),
    f = g.floors[toFloor],
    // Layers share x/y, so a flight stays on this site's own column: its
    // landing on the floor above, its stair head on the floor below.
    at = down ? site.stairs[toFloor] : site.entry[toFloor],
    destination = at && (down ? { x: at.x, y: at.y + 1 } : { ...at });
  if (
    !f ||
    !destination ||
    (down && a.floor <= (site.floors[0] ?? 0)) ||
    (!down && a.floor >= roofFloorOf(site))
  )
    return false;
  // Only the start building gates climbing on a personal floor credential.
  if (
    !down &&
    site.id === START_SITE &&
    !a.access.includes(a.floor) &&
    !devPass(a)
  ) {
    refuseStairs(g, a);
    return false;
  }
  return startStairTravel(
    g,
    a,
    {
      fromFloor: a.floor,
      toFloor,
      site: site.id,
      origin: { x: a.x, y: a.y },
      destination,
      until: g.time + CONFIG.stairSeconds,
      ...(walking ? { walked: 0 } : {}),
    },
    down,
    walking,
  );
}

function startStairTravel(
  g: Game,
  a: Actor,
  travel: StairTravel,
  down: boolean,
  walking: boolean,
) {
  a.stairTravel = travel;
  if (walking) startElevated(g, a);
  delete a.station;
  delete a.handling;
  delete a.grip;
  delete a.defensePlan;
  delete a.exploringDoor;
  delete a.fleeTarget;
  delete a.fleeFloor;
  a.fleeUntil = 0;
  a.path = [];
  delete a.target;
  delete a.navTarget;
  a.repath = 0;
  a.activity = "climbing";
  event(
    g,
    "survivor-stairs",
    `${a.name} entered the ${down ? "descending" : "ascending"} stair flight.`,
    a.floor,
    a.id,
  );
  if (a.id === "human")
    g.notice = walking
      ? "Emergency stairs. Walk along the flight and gallery; turn at the landings."
      : down
        ? "Taking the stairs down. Step back out to stay on this floor."
        : "Climbing the stairs. Step back out to stay on this floor.";
  return true;
}
/** The survivor stays exposed inside the staircase until a clear connected
 * landing is available. Leaving the well, or being pushed out, cancels. */
export function advanceStairs(g: Game, a: Actor) {
  const travel = a.stairTravel;
  if (!travel) return false;
  const source = g.floors[travel.fromFloor],
    site = travelSite(g, travel),
    marker =
      travel.toFloor > travel.fromFloor
        ? site.stairs[travel.fromFloor]
        : site.entry[travel.fromFloor];
  // A flight saved from before an open site reloaded must never land above it.
  if (source?.open) {
    cancelStairs(g, a);
    return false;
  }
  if (
    !source ||
    !a.alive ||
    a.escaped ||
    (travel.walked === undefined && a.floor !== travel.fromFloor) ||
    !marker ||
    (travel.walked === undefined && !inStairwell(a, marker))
  ) {
    cancelStairs(g, a);
    return false;
  }
  if (travel.walked !== undefined) {
    if (!travel.arrived) return true;
  } else {
    const deep =
      source.layout === "pursuit" && distance(a, marker) <= STAIRWELL_DEEP;
    if (!deep && g.time + 1e-8 < travel.until) return true;
  }
  const f = g.floors[travel.toFloor];
  if (!f) return true;
  // Only the start building has a carved well to fall back into.
  const well =
    site.id === START_SITE
      ? stairwell(f, travel.toFloor > travel.fromFloor ? "down" : "up")
      : undefined;
  const points: Point[] = [
    { x: 0, y: 0 },
    { x: 0, y: 0.7 },
    { x: 0.7, y: 0 },
    { x: -0.7, y: 0 },
    { x: 0, y: -0.7 },
  ].map((p) => ({
    x: travel.destination.x + p.x,
    y: travel.destination.y + p.y,
  }));
  if (well) {
    points.push({ ...well.mouth });
    for (const depth of [0.5, 1, 1.5, 2, 2.5])
      for (const lateral of [0, 0.5, -0.5])
        points.push({
          x: well.mouth.x + lateral,
          y: well.mouth.y + well.open * depth,
        });
  }
  const destinationBlocked = solid(
    f,
    travel.destination,
    0.25,
    undefined,
    true,
  );
  const candidates = points
    .map((p, i) => ({ p, i, d: distance(p, travel.destination) }))
    .sort((u, v) => u.d - v.d || u.i - v.i)
    .map((c) => c.p)
    .filter(
      (p) =>
        !solid(f, p) &&
        (walkSegment(f, travel.destination, p) ||
          // Furniture on the destination itself: the landing only needs a
          // wall-free line from the staircase, never a spot inside furniture.
          (destinationBlocked && line(f, travel.destination, p))),
    );
  const free = (p: Point) =>
    !g.survivors.some(
      (b) =>
        b !== a &&
        b.alive &&
        !b.escaped &&
        b.floor === travel.toFloor &&
        distance(b, p) < 0.55,
    ) &&
    !g.zombies.some(
      (z) => z.hp > 0 && z.floor === travel.toFloor && distance(z, p) < 0.55,
    );
  // A crowded landing never blocks a flight forever: physics separates bodies.
  // The physical walker has already reached a clear floor plate. Preserve
  // that exact position; only timed AI flights need a landing search.
  const landing = travel.arrived
    ? travel.destination
    : (candidates.find(free) ?? candidates[0]);
  if (!landing) {
    if (a.id === "human")
      g.notice = "Stair landing blocked. Step back out to stay on this floor.";
    return true;
  }
  a.floor = travel.toFloor;
  Object.assign(a, landing);
  if (travel.walked !== undefined) {
    delete a.physics;
    delete a.elevated;
  }
  delete a.stairTravel;
  a.path = [];
  delete a.target;
  delete a.navTarget;
  a.repath = 0;
  a.activity = "exploring";
  // Arriving inside the other well must not immediately start the return flight.
  const arrivedIn = stairwellAt(g, a);
  if (arrivedIn) a.stairwell = arrivedIn;
  else delete a.stairwell;
  const text = `${a.name} reached ${a.floor === CONFIG.floors ? "the rooftop" : `Floor ${a.floor + 1}`}.`;
  event(g, "climb", text, a.floor, a.id);
  if (a.id === "human") g.notice = text;
  return true;
}

/** Upgrade a saved centreline pose once, then retain free physical movement. */
export function ensureWalkingBody(g: Game, a: Actor) {
  const travel = a.stairTravel;
  if (!travel || travel.walked === undefined || a.elevated) return;
  const pose = sampleStairRoute(g, travel);
  a.x = pose.x;
  a.y = pose.z;
  // Old centreline saves used a smooth ramp, while the visible flight has
  // discrete 18 cm treads. Settle within the ordinary step/snap tolerance.
  const surface = surfaceBelow(g, a, a, pose.y + 0.3);
  startElevated(
    g,
    a,
    surface && Math.abs(surface.height - pose.y) <= 0.3
      ? surface.height
      : pose.y,
  );
}

/** Keep the historical route distance as a projection, never a constraint. */
function projectWalkingProgress(g: Game, a: Actor) {
  const travel = a.stairTravel!;
  const route = buildStairRoute(g, travel);
  let along = 0,
    best = Infinity,
    walked = 0;
  for (let i = 1; i < route.points.length; i++) {
    const p = route.points[i - 1],
      q = route.points[i];
    const dx = q.x - p.x,
      dy = q.y - p.y,
      dz = q.z - p.z;
    const length = Math.hypot(dx, dy, dz);
    const t = length
      ? Math.max(
          0,
          Math.min(
            1,
            ((a.x - p.x) * dx +
              (a.elevated!.feet - p.y) * dy +
              (a.y - p.z) * dz) /
              (length * length),
          ),
        )
      : 0;
    const distance = Math.hypot(
      a.x - p.x - dx * t,
      a.elevated!.feet - p.y - dy * t,
      a.y - p.z - dz * t,
    );
    if (distance < best) {
      best = distance;
      walked = along + length * t;
    }
    along += length;
  }
  travel.walked = walked;
}

/** Transfer to flat physics only on a real floor plate or city ground. */
export function settleElevated(g: Game, a: Actor, surface?: ElevatedSurface) {
  const body = a.elevated;
  if (!body) return;
  const travel = a.stairTravel;
  a.floor = Math.max(
    0,
    Math.min(CONFIG.floors, Math.floor((body.feet + 0.05) / FLOOR_HEIGHT)),
  );
  if (travel?.walked !== undefined) {
    projectWalkingProgress(g, a);
    if (!insideFootprint(g.floors[travel.fromFloor], a)) travel.left = true;
    if (!body.grounded || !surface) return;
    if (surface.kind === "ground") {
      cancelStairs(g, a);
      a.floor = 0;
      if (g.floors[0].city) delete a.elevated;
      delete a.physics;
    } else if (surface.kind === "plate" && surface.inside) {
      a.floor = surface.floor;
      if (
        (!travel.left && !inStairwell(a, travel.origin)) ||
        (travel.left && surface.floor === travel.fromFloor)
      ) {
        cancelStairs(g, a);
        delete a.elevated;
        delete a.physics;
        a.stairwell = stairwellAt(g, a);
      } else if (travel.left) {
        travel.toFloor = surface.floor;
        travel.destination = { x: a.x, y: a.y };
        travel.arrived = true;
        advanceStairs(g, a);
      }
    }
  } else if (
    body.grounded &&
    surface &&
    (surface.kind === "plate" || surface.kind === "ground")
  ) {
    a.floor = surface.floor;
    // Historical fixtures have no city physics outside the tile grid. Keep
    // their flat outdoor body until a real plate, without an invisible edge.
    if (surface.kind === "plate" || g.floors[0].city) delete a.elevated;
    delete a.physics;
  }
}

/** Walk freely in two dimensions; only visible geometry blocks the body. */
export function walkStairs(g: Game, a: Actor, input: Point, dt: number) {
  if (a.stairTravel?.walked === undefined) return false;
  ensureWalkingBody(g, a);
  const result = stepElevated(g, a, input, dt);
  settleElevated(g, a, result.surface);
  return result;
}
