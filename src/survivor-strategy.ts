import { distance, rand, type Actor, type Game, type Point } from "./model";
import { extractionPoints } from "./site";
import { survivorPath, walkSegment, type NavStep } from "./navigation";
import { solid } from "./spatial";

/** Smallest distance from `p` to the polyline `origin -> ...route`. */
function closestApproach(origin: Point, route: Point[], p: Point) {
  let closest = Infinity,
    from = origin;
  for (const to of route) {
    const dx = to.x - from.x,
      dy = to.y - from.y,
      length = dx * dx + dy * dy;
    const t = length
      ? Math.max(
          0,
          Math.min(1, ((p.x - from.x) * dx + (p.y - from.y) * dy) / length),
        )
      : 0;
    closest = Math.min(
      closest,
      distance(p, { x: from.x + dx * t, y: from.y + dy * t }),
    );
    from = to;
  }
  return closest;
}
/** Score added per enemy the route passes too close to. */
export const CONTACT_PENALTY = 1000;
/** Visible enemies near any part of the route, not just its destination. */
export function routeExposure(origin: Point, route: Point[], enemies: Point[]) {
  let exposure = 0;
  for (const enemy of enemies) {
    const closest = closestApproach(origin, route, enemy);
    exposure += Math.max(0, 1.25 - closest) ** 2;
  }
  return exposure;
}
export function chooseRetreat(
  g: Game,
  a: Actor,
  enemies: Point[],
  pickup: boolean,
) {
  const f = g.floors[a.floor],
    // The pickup of the run: a building's roof helipad or an open site's
    // ground pad. Retreating toward it only helps on its own floor.
    pad = extractionPoints(g)[0],
    options: { point: Point; score: number }[] = [];
  const add = (point: Point, route: Point[], vaults = 0) => {
    if (solid(f, point)) return;
    const clearance = enemies.reduce(
      (min, z) => Math.min(min, distance(z, point)),
      20,
    );
    let exits = 0;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ])
      if (!solid(f, { x: point.x + dx, y: point.y + dy })) exits++;
    const danger =
      routeExposure(a, route, enemies) *
      (2 + (1 - a.risk) * 2) *
      (a.hp < 40 ? 1.4 : 1);
    options.push({
      point,
      score:
        clearance +
        exits * 0.7 -
        danger -
        routeContacts(a, route, enemies) * CONTACT_PENALTY -
        vaults * 0.5 +
        (pickup && a.floor === pad.floor
          ? -Math.max(0, distance(point, pad) - pad.radius) * (1 + a.risk * 0.4)
          : 0) +
        (a.access.includes(a.floor) ? -distance(point, f.stairs) * 0.15 : 0) +
        rand(g) * 0.4,
    });
  };
  for (let i = 0; i < 16; i++) {
    const angle = (i / 16) * Math.PI * 2;
    for (const radius of [1.5, 3, 6]) {
      const point = {
        x: a.x + Math.cos(angle) * radius,
        y: a.y + Math.sin(angle) * radius,
      };
      if (walkSegment(f, a, point)) add(point, [point]);
    }
  }
  // Consider actual complete vault routes over nearby cover. The normal
  // follower still performs the approach, vulnerability interval and landing.
  const nearby = f.furniture
    .filter(
      (o) =>
        !o.destroyed &&
        o.kind !== "door" &&
        o.kind !== "gate" &&
        distance(a, o) < 3,
    )
    .sort((b, c) => distance(a, b) - distance(a, c))
    .slice(0, 4);
  for (const o of nearby)
    for (const sign of [-1, 1]) {
      const horizontal = o.w <= o.h;
      const point = horizontal
        ? {
            x: o.x + sign * (o.w / 2 + 0.55),
            y: Math.max(
              o.y - o.h / 2 + 0.3,
              Math.min(a.y, o.y + o.h / 2 - 0.3),
            ),
          }
        : {
            x: Math.max(
              o.x - o.w / 2 + 0.3,
              Math.min(a.x, o.x + o.w / 2 - 0.3),
            ),
            y: o.y + sign * (o.h / 2 + 0.55),
          };
      if (solid(f, point)) continue;
      const route: NavStep[] = survivorPath(f, a, point);
      const landings = route.filter((step) => step.action === "vault");
      if (
        landings.some(
          (p) =>
            g.survivors.some(
              (b) =>
                b.id !== a.id &&
                b.alive &&
                !b.escaped &&
                b.floor === a.floor &&
                distance(b, p) < 0.55,
            ) ||
            g.zombies.some(
              (z) => z.hp > 0 && z.floor === a.floor && distance(z, p) < 0.55,
            ),
        )
      )
        continue;
      if (
        route.some((step) => step.action === "vault" && step.obstacle === o.id)
      )
        add(
          point,
          route,
          route.filter((step) => step.action === "vault").length,
        );
    }
  return options.sort((b, c) => c.score - b.score)[0]?.point;
}

/** Count routes that enter a perceived enemy's contact space. Initial close
 * contact does not forbid escape: a route moving away from it remains usable. */
export function routeContacts(origin: Point, route: Point[], enemies: Point[]) {
  let contacts = 0;
  for (const enemy of enemies) {
    const closest = closestApproach(origin, route, enemy);
    if (closest < Math.min(1.1, distance(origin, enemy) - 0.03)) contacts++;
  }
  return contacts;
}
export function unsafeReturn(g: Game, a: Actor, enemies: Point[]) {
  const f = g.floors[a.floor],
    e = a.intent ? g.encounters[a.intent] : undefined,
    // The run's pickup replaces the roof assumption: an open site's ground pad
    // is reached from its own floor, a building's helipad only from the roof.
    pad = extractionPoints(g)[0];
  const target =
    a.floor === pad.floor
      ? pad
      : a.access.includes(a.floor)
        ? f.stairs
        : e && e.floor === a.floor && e.state !== "consumed"
          ? f.stations
              .filter((s) => s.encounter === e.id && a.seen.includes(s.id))
              .sort(
                (b, c) =>
                  Number(c.id === a.taskSearch?.station) -
                    Number(b.id === a.taskSearch?.station) ||
                  distance(a, b) - distance(a, c),
              )[0]
          : a.target;
  if (!target) return false;
  const route = survivorPath(f, a, target);
  return route.length > 0 && routeContacts(a, route, enemies) > 0;
}
