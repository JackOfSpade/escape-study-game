import { type Actor, type Game, type Point } from "./model";
import { walkSegment } from "./navigation";

interface TrafficBody extends Point {
  id: string;
  velocity: Point;
}
const HORIZON = 0.65;
const CLEARANCE = 0.58;
/** Small local velocity search, not another global path search. Intended routes
 * remain owned by navigation; the native solver still owns all contacts. */
export function trafficVelocity(
  g: Game,
  a: Actor,
  preferred: Point,
  bodies: TrafficBody[],
): Point {
  const speed = Math.hypot(preferred.x, preferred.y);
  if (speed < 1e-6 || !bodies.length) return preferred;
  if (
    a.trafficPass &&
    (a.trafficPass.floor !== a.floor || g.time >= a.trafficPass.until)
  )
    delete a.trafficPass;
  const nearby = bodies
    .filter((b) => b.id !== a.id && Math.hypot(b.x - a.x, b.y - a.y) < 2.4)
    .sort(
      (b, c) =>
        Math.hypot(b.x - a.x, b.y - a.y) - Math.hypot(c.x - a.x, c.y - a.y) ||
        b.id.localeCompare(c.id),
    )
    .slice(0, 8);
  const collision = (v: Point) => {
    let penalty = 0;
    for (const b of nearby) {
      const px = b.x - a.x,
        py = b.y - a.y;
      const vx = b.velocity.x - v.x,
        vy = b.velocity.y - v.y;
      const t = Math.max(
        0,
        Math.min(HORIZON, -(px * vx + py * vy) / (vx * vx + vy * vy || 1)),
      );
      // Contact at t=0 is already owned by physics. A separating or tangent
      // velocity must be allowed to escape that contact: charging its current
      // distance against every candidate makes stopping a permanent minimum.
      if (Math.hypot(px, py) <= CLEARANCE && px * vx + py * vy >= -1e-6)
        continue;
      const gap = Math.hypot(px + vx * t, py + vy * t);
      if (gap < CLEARANCE) penalty += (CLEARANCE - gap) * 80 * (1.5 - t);
    }
    return penalty;
  };
  if (collision(preferred) < 0.01) return preferred;
  const nx = preferred.x / speed,
    ny = preferred.y / speed;
  const previous = a.physics;
  let best = { x: 0, y: 0 },
    score = collision(best) + 2.2,
    chosenSide = 0;
  for (const degrees of [
    0, 22, -22, 45, -45, 70, -70, 90, -90, 115, -115, 150, -150, 180,
  ]) {
    const angle = (degrees * Math.PI) / 180,
      cos = Math.cos(angle),
      sin = Math.sin(angle);
    for (const scale of [1, 0.5]) {
      const v = {
        x: (nx * cos - ny * sin) * speed * scale,
        y: (ny * cos + nx * sin) * speed * scale,
      };
      const continuity = previous
        ? Math.hypot(v.x - previous.x, v.y - previous.y) / speed
        : 0;
      const value =
        collision(v) +
        (1 - cos) * 0.8 +
        (1 - scale) * 0.65 +
        continuity * 0.12 +
        (degrees < 0 ? 0.04 : 0) +
        (a.trafficPass && degrees * a.trafficPass.side < 0 ? 0.2 : 0);
      if (value >= score) continue;
      // Check a swept body route with this actor's personal field permissions.
      const look = Math.min(0.8, speed * HORIZON * scale);
      const end = {
        x: a.x + (v.x / (speed * scale)) * look,
        y: a.y + (v.y / (speed * scale)) * look,
      };
      if (!walkSegment(g.floors[a.floor], a, end)) continue;
      score = value;
      best = v;
      chosenSide = Math.sign(degrees);
    }
  }
  if (chosenSide && !a.trafficPass)
    a.trafficPass = {
      side: chosenSide as -1 | 1,
      until: g.time + 0.8,
      floor: a.floor,
    };
  return best;
}
