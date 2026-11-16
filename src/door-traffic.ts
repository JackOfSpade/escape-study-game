import { rememberPlace } from "./exploration";
import { fieldAllows } from "./force-fields";
import {
  type Actor,
  type Furniture,
  type Game,
  type Point,
  distance,
} from "./model";
import { walkSegment } from "./navigation";

export interface DoorTraffic {
  door: string;
  floor: number;
  lane: number;
  offset: number;
  side: number;
  until: number;
  target: Point;
  arrival: boolean;
}
interface DoorMotion {
  point: Point;
  forwardLimit: number;
  steer: boolean;
}
const laneCount = (width: number) =>
  Math.max(1, Math.floor((width - 0.8) / 0.8) + 1);
const laneCoordinate = (
  center: number,
  offset: number,
  width: number,
  lanes: number,
  lane: number,
) =>
  center +
  offset +
  (lanes === 1 ? 0 : -width / 2 + 0.4 + (lane * (width - 0.8)) / (lanes - 1));
/** Use the width of a traversable field instead of funnelling every route into
 * its centre. Reservations are local, bounded and survive a physics checkpoint. */
export function doorwayMotion(
  g: Game,
  a: Actor,
  target: Point,
): DoorMotion | undefined {
  const f = g.floors[a.floor];
  let state = a.doorTraffic;
  let door = state && f.furniture.find((o) => o.id === state!.door);
  if (
    state &&
    (!door ||
      !door.field ||
      !fieldAllows(door, a) ||
      state.floor !== a.floor ||
      g.time > state.until ||
      distance(state.target, target) > 0.75)
  ) {
    delete a.doorTraffic;
    state = undefined;
    door = undefined;
  }
  const axes = (o: Furniture) =>
    o.w >= o.h
      ? { normal: "y" as const, along: "x" as const, width: o.w, depth: o.h }
      : { normal: "x" as const, along: "y" as const, width: o.h, depth: o.w };
  if (!state) {
    for (const o of f.furniture) {
      if (!o.field || !fieldAllows(o, a) || distance(o, a) > 5) continue;
      const { normal, along, width, depth } = axes(o);
      if (width < 1.6) continue;
      const side = Math.sign(a[normal] - o[normal]);
      if (!side || Math.abs(a[along] - o[along]) > width / 2 + 4) continue;
      // A spawn-hall arrival is an area, not a mandatory point under the human.
      const spawnEntry =
        o.field.publicEntry &&
        distance(target, f.entry) < 0.1 &&
        (f.entry[normal] - o[normal]) * side > 0 &&
        distance(f.entry, o) < 2;
      let crosses = false,
        from: Point = a;
      for (const p of a.path.slice(0, 8)) {
        if (p.action) break;
        const delta = p[normal] - from[normal];
        if ((p[normal] - o[normal]) * side < -0.05 && delta) {
          const t = (o[normal] - from[normal]) / delta;
          const at = from[along] + t * (p[along] - from[along]);
          if (t >= 0 && t <= 1 && Math.abs(at - o[along]) < width / 2)
            crosses = true;
          break;
        }
        from = p;
      }
      if (!crosses && !spawnEntry) continue;
      const lanes = laneCount(width);
      // A small stable personal offset avoids identical tracks without random
      // changes of direction on each frame or changing the world's RNG.
      let hash = 0;
      for (const char of a.id + o.id)
        hash = (Math.imul(hash, 31) + char.charCodeAt(0)) | 0;
      const offset = (((hash >>> 0) % 13) - 6) / 100;
      let best: { lane: number; score: number } | undefined;
      for (let lane = 0; lane < lanes; lane++) {
        const coordinate = laneCoordinate(o[along], offset, width, lanes, lane);
        const approach = {
          ...a,
          [along]: coordinate,
          [normal]: o[normal] + side * (depth / 2 + 0.7),
        };
        const exit = {
          ...approach,
          [normal]: o[normal] - side * (depth / 2 + 0.9),
        };
        if (!walkSegment(f, a, approach) || !walkSegment(f, approach, exit))
          continue;
        let score = Math.abs(a[along] - coordinate) * 0.3;
        for (const b of g.survivors) {
          if (b === a || !b.alive || b.escaped || b.floor !== a.floor) continue;
          const reservation = b.doorTraffic;
          if (
            reservation?.door === o.id &&
            reservation.until > g.time &&
            reservation.lane === lane
          )
            score += reservation.side === side ? 1.5 : 4;
          // Idle players/students cannot be commanded to move out of our lane.
          if (
            (!b.path.length ||
              b.id === "human" ||
              (b.activity === "studying" &&
                b.station &&
                f.stations.some(
                  (s) => s.id === b.station && distance(b, s) < 1.3,
                ))) &&
            Math.abs(b[along] - coordinate) < 0.6 &&
            Math.abs(b[normal] - o[normal]) < 2
          )
            score += 20;
        }
        if (!best || score < best.score) best = { lane, score };
      }
      if (!best) continue;
      state = a.doorTraffic = {
        door: o.id,
        floor: a.floor,
        lane: best.lane,
        offset,
        side,
        until: g.time + 2,
        target: { ...target },
        arrival: !!spawnEntry || a.exploringDoor?.id === o.id,
      };
      door = o;
      break;
    }
  }
  if (!state || !door) return;
  const activeState = state,
    activeDoor = door;
  const { normal, along, width, depth } = axes(door);
  const position = (a[normal] - door[normal]) * state.side;
  if (position < -depth / 2 - 0.9) {
    delete a.doorTraffic;
    rememberPlace(a, `entered-door-${door.id}`);
    if (
      a.activity === "exploring" &&
      a.target &&
      (state.arrival || distance(a.target, door) < 2.5)
    ) {
      // Completing the crossing satisfies the local exploration goal even
      // when our clear gap is beside its old, occupied centre point.
      a.target = { x: a.x, y: a.y };
      delete a.exploringDoor;
    }
    a.path = [];
    a.repath = 0;
    return;
  }
  state.until = g.time + 2;
  const lanes = laneCount(width);
  // Opposing streams keep right through a wide opening. Reassign only before
  // reaching its threshold; changing lanes inside the field causes cross traffic.
  const opposed = g.survivors.some(
    (b) =>
      b !== a &&
      b.alive &&
      !b.escaped &&
      b.floor === a.floor &&
      distance(b, activeDoor) < 5 &&
      (b[normal] - activeDoor[normal]) * activeState.side < -depth / 2 &&
      ((b.doorTraffic?.door === activeDoor.id &&
        b.doorTraffic.side !== activeState.side) ||
        (b.navTarget &&
          (b.navTarget[normal] - activeDoor[normal]) * activeState.side > 0)),
  );
  if (opposed && position > depth / 2 + 0.4)
    state.lane =
      (normal === "y" ? state.side : -state.side) > 0 ? lanes - 1 : 0;
  const coordinateAt = (lane: number) =>
    laneCoordinate(activeDoor[along], activeState.offset, width, lanes, lane);
  const staticBlock = (lane: number) =>
    g.survivors.some(
      (b) =>
        b !== a &&
        b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        Math.abs(b[along] - coordinateAt(lane)) < 0.6 &&
        Math.abs(b[normal] - activeDoor[normal]) < 2 &&
        (a[normal] - b[normal]) * activeState.side > -0.2 &&
        (b.id === "human" ||
          (b.station &&
            b.activity === "studying" &&
            f.stations.some(
              (s) => s.id === b.station && distance(b, s) < 1.3,
            ))),
    );
  // A person stopping just beyond the threshold must not pin its follower in
  // place. Use another clear gap rather than repeatedly pushing that person.
  if (staticBlock(state.lane)) {
    const alternatives = Array.from({ length: lanes }, (_, lane) => lane)
      .filter((lane) => !staticBlock(lane))
      .sort(
        (b, c) =>
          Math.abs(a[along] - coordinateAt(b)) -
          Math.abs(a[along] - coordinateAt(c)),
      );
    for (const lane of alternatives) {
      const exit = {
        x: a.x,
        y: a.y,
        [along]: coordinateAt(lane),
        [normal]: door[normal] - state.side * (depth / 2 + 1.1),
      };
      if (walkSegment(f, a, exit)) {
        state.lane = lane;
        break;
      }
    }
  }
  const coordinate = coordinateAt(state.lane);
  const aligned = Math.abs(a[along] - coordinate) < 0.25;
  const point: Point = {
    x: door.x,
    y: door.y,
    [along]: coordinate,
    [normal]:
      door[normal] +
      state.side *
        (aligned || position < depth / 2 + 0.6
          ? -depth / 2 - 1.1
          : depth / 2 + 0.7),
  };
  if (!walkSegment(f, a, point)) {
    delete a.doorTraffic;
    return;
  }
  let forwardLimit = Infinity;
  for (const b of g.survivors) {
    if (
      b === a ||
      !b.alive ||
      b.escaped ||
      b.floor !== a.floor ||
      Math.abs(b[along] - coordinate) > 0.6
    )
      continue;
    const gap = (a[normal] - b[normal]) * state.side;
    if (gap > 0 && Math.abs(b[normal] - door[normal]) < 4)
      forwardLimit = Math.min(forwardLimit, Math.max(0, gap - 0.68));
  }
  return {
    point,
    forwardLimit: aligned ? forwardLimit : Infinity,
    steer: !aligned && position > depth / 2 + 0.6,
  };
}
