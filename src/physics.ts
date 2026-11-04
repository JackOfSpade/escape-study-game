import { trafficVelocity } from "./local-traffic";
import { fieldPassable, updateDoorLeaves, updateFields } from "./force-fields";
import {
  Box,
  Circle,
  FrictionJoint,
  RevoluteJoint,
  RopeJoint,
  Vec2,
  World,
  type Body,
  type Contact,
  type Joint,
} from "planck";
import { DOOR_SWING, doorPose, ensureDoor, latchDoor } from "./doors";
import {
  FURNITURE,
  H,
  W,
  distance,
  type Actor,
  type Floor,
  type Furniture,
  type Game,
  type Point,
  type Zombie,
} from "./model";
import { move, solid, STATION_BODY, stationSignature } from "./spatial";
import { solidDesks } from "./station-clearance";
import { cityCollisionBoxes, cityWall } from "./city-layout";

export const BODY_RADIUS = 0.26;
/** Largest force one zombie applies while pressing furniture or a crowd that
 * touches it. Free zombies keep direct velocity control. */
export const ZOMBIE_PUSH = 30;
/** Largest force a walking survivor applies to furniture it walks into. Light
 * office pieces (chairs, plants, boxes, an armchair) slide aside on contact;
 * a desk, sofa or fridge holds until it is deliberately gripped. */
export const SURVIVOR_PUSH = 100;
/** Static floor friction of an unheld object. Unknown kinds keep the old mass rule. */
const floorResist = (o: Furniture) =>
  FURNITURE[o.kind]?.resist ?? (20 / Math.max(0.05, o.speed)) * 6;
/** Friction spread over the footprint resists turning in proportion to its size,
 * so a long desk cannot be swung open by one zombie at its end. */
const floorTorque = (o: Furniture) =>
  (floorResist(o) * Math.hypot(o.w, o.h)) / 3;
type Entity = Actor | Zombie | Furniture;
const furniture = (e: Entity): e is Furniture => "kind" in e;
const actor = (e: Entity): e is Actor => "alive" in e;
const active = (e: Entity) =>
  furniture(e)
    ? !e.destroyed &&
      (!e.open || !!e.door) &&
      !(e.kind === "gate" && e.turning < 0)
    : actor(e)
      ? e.alive &&
        !e.escaped &&
        !e.elevated &&
        e.stairTravel?.walked === undefined
      : e.hp > 0;
interface RecordBody {
  entity: Entity;
  body: Body;
  shape: string;
  radius?: number;
  floor: number;
  hinge?: RevoluteJoint;
  friction?: FrictionJoint;
  published: { x: number; y: number; angle: number };
  start: {
    x: number;
    y: number;
    angle: number;
    moved: number;
    blocked: number;
    vault?: Actor["vault"];
  };
  drive?: Point;
  /** Desired velocity of a zombie pressing furniture, applied as a bounded force. */
  motor?: Point;
  /** Contact impulse received from moving bodies during the current solver step. */
  push?: number;
  /** Solver substep in which the body last left its static rest. */
  slidAt?: number;
}
interface FloorPhysics {
  world: World;
  ground: Body;
  walls: Body;
  /** Fixed terminal desks. Their positions are `stationKey`. */
  desks: Body;
  stationKey?: string;
  /** Copy of the tile grid the wall fixtures were built from. */
  tiles: number[][];
  city?: Game["floors"][number]["city"];
}
/** Element-wise compare; exits on the first difference and builds no string. */
function sameTiles(a: number[][], b: number[][]) {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++) {
    const ra = a[y],
      rb = b[y];
    if (ra.length !== rb.length) return false;
    for (let x = 0; x < ra.length; x++) if (ra[x] !== rb[x]) return false;
  }
  return true;
}
const layers = new WeakMap<Game, PhysicsLayer>();
export function physicsActive(g: Game) {
  return layers.get(g)?.running ?? false;
}
export function beginPhysics(g: Game) {
  let layer = layers.get(g);
  if (!layer) {
    layer = new PhysicsLayer(g);
    layers.set(g, layer);
  }
  layer.begin();
}
export function finishPhysics(g: Game, dt: number) {
  return layers.get(g)!.finish(dt);
}
/** Run the human's vertical motor on the native contact clock, so a jump
 * competes for force-field admission at the same swept time as floor bodies. */
export function physicsElevated(g: Game, advance: (dt: number) => void) {
  const layer = layers.get(g);
  if (!layer?.running) return false;
  layer.elevated = advance;
  return true;
}
export function physicsKick(g: Game, z: Zombie, from: Point) {
  let layer = layers.get(g);
  if (!layer) {
    layer = new PhysicsLayer(g);
    layers.set(g, layer);
  }
  layer.kick(z, from);
}
/** Snapshot boundaries discard solver caches so live and restored branches start identically. */
export function checkpointPhysics(g: Game) {
  if (!layers.get(g)?.running) layers.delete(g);
}
export function cancelPhysics(g: Game) {
  const layer = layers.get(g);
  if (layer) layer.running = false;
}
/** During a frame, controllers state their desired motion; the solver owns actual contact movement. */
export function physicsMove(
  g: Game,
  e: Actor | Zombie,
  dx: number,
  dy: number,
  steer = false,
) {
  const layer = layers.get(g);
  if (!layer?.running) return false;
  layer.drive(e, dx, dy, steer);
  return true;
}
/** Furniture-less view of a floor, cached per physics step. */
export function physicsFloor(g: Game, floor: number) {
  const layer = layers.get(g);
  return layer
    ? layer.view(floor)
    : { ...g.floors[floor], furniture: [] as Furniture[] };
}

class PhysicsLayer {
  running = false;
  elevated?: (dt: number) => void;
  private floors: FloorPhysics[] = [];
  private views: Floor[] = [];
  private records = new Map<Entity, RecordBody>();
  private grips = new Map<
    Actor,
    { object: Furniture; joint: Joint; state: NonNullable<Actor["grip"]> }
  >();
  private movedBy = new Map<Furniture, Set<string>>();
  /** Furniture ids held by a living survivor (grip or handling), per frame. */
  private held = new Set<string>();
  /** Running solver substep count, for the rest hysteresis in stickOrSlip. */
  private substep = 0;
  constructor(private g: Game) {}
  private hinge(
    p: FloorPhysics,
    body: Body,
    d: NonNullable<Furniture["door"]>,
    lower: number,
    upper: number,
  ) {
    return p.world.createJoint(
      new RevoluteJoint({
        bodyA: p.ground,
        bodyB: body,
        localAnchorA: d.hinge,
        localAnchorB: { x: d.hinge.x - d.frame.x, y: d.hinge.y - d.frame.y },
        referenceAngle: 0,
        enableLimit: true,
        lowerAngle: lower,
        upperAngle: upper,
      }),
    )!;
  }
  private preSolvePair(contact: Contact, person: Entity, object: Entity) {
    if (!actor(person) || !furniture(object)) return;
    if (object.field && fieldPassable(object, person))
      contact.setEnabled(false);
    const vault = person.vault ?? this.records.get(person)?.start.vault;
    if (vault?.obstacle === object.id || vault?.obstacles?.includes(object.id))
      contact.setEnabled(false);
  }
  private addPush(e: Entity, total: number) {
    const r = this.records.get(e);
    if (r && furniture(e)) r.push = (r.push ?? 0) + total;
  }
  private postSolvePair(person: Entity, object: Entity) {
    if (!actor(person) || !furniture(object) || !(object.speed > 0)) return;
    const r = this.records.get(person),
      v = r?.drive;
    if (
      person.grip?.object === object.id ||
      (v && v.x * (object.x - person.x) + v.y * (object.y - person.y) > 0)
    ) {
      let movers = this.movedBy.get(object);
      if (!movers) this.movedBy.set(object, (movers = new Set()));
      movers.add(person.id);
    }
  }
  private floor(index: number, refresh = false) {
    const f = this.g.floors[index];
    let p = this.floors[index];
    // Walls can change between ticks (including imported/debug worlds), but
    // synchronizing each body must not rescan the same floor's tiles.
    if (p && !refresh) return p;
    if (!p) {
      const world = new World(Vec2(0, 0));
      world.setWarmStarting(false);
      world.setContinuousPhysics(true);
      const ground = world.createBody();
      p = {
        world,
        ground,
        walls: world.createBody(),
        desks: world.createBody(),
        tiles: [],
      };
      this.floors[index] = p;
      world.on("pre-solve", (contact) => {
        const bodyA = contact.getFixtureA().getBody(),
          bodyB = contact.getFixtureB().getBody(),
          a = bodyA.getUserData() as Entity | undefined,
          b = bodyB.getUserData() as Entity | undefined;
        // Desks stop the player. Everyone else routes around them, but a crowd
        // shoved against one must slip past rather than jam a study row.
        const other = bodyA === p!.desks ? b : bodyB === p!.desks ? a : undefined;
        if (other && other !== this.g.survivors[0]) contact.setEnabled(false);
        if (!a || !b) return;
        this.preSolvePair(contact, a, b);
        this.preSolvePair(contact, b, a);
      });
      world.on("post-solve", (contact, impulse) => {
        const a = contact.getFixtureA().getBody().getUserData() as
            Entity | undefined,
          b = contact.getFixtureB().getBody().getUserData() as
            Entity | undefined;
        if (!a || !b) return;
        let total = 0;
        for (const n of impulse.normalImpulses) total += n;
        this.addPush(a, total);
        this.addPush(b, total);
        this.postSolvePair(a, b);
        this.postSolvePair(b, a);
      });
    }
    if (!sameTiles(p.tiles, f.tiles) || p.city !== f.city) {
      p.world.destroyBody(p.walls);
      p.walls = p.world.createBody();
      p.tiles = f.tiles.map((row) => row.slice());
      p.city = f.city;
      // The city supplies actual urban obstacle footprints. Retain authored
      // office masonry, while removing the old square grid's outdoor walls.
      const authoredWall = (x: number, y: number) =>
        cityWall(f, x + 0.5, y + 0.5) === undefined && f.tiles[y]?.[x] !== 0;
      // Merge horizontal runs: fewer fixtures without changing the authored wall silhouette.
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W;) {
          if (!authoredWall(x, y)) {
            x++;
            continue;
          }
          const start = x;
          while (x < W && authoredWall(x, y)) x++;
          p.walls.createFixture(
            new Box(
              (x - start) / 2 - 0.01,
              0.49,
              Vec2((start + x) / 2, y + 0.5),
            ),
            { friction: 0.1 },
          );
        }
      const boundaryBoxes = f.city
        ? cityCollisionBoxes(f.city)
        : [
            { x: -0.5, y: H / 2, w: 1, h: H + 2 },
            { x: W + 0.5, y: H / 2, w: 1, h: H + 2 },
            { x: W / 2, y: -0.5, w: W + 2, h: 1 },
            { x: W / 2, y: H + 0.5, w: W + 2, h: 1 },
          ];
      for (const box of boundaryBoxes)
        p.walls.createFixture(
          new Box(box.w / 2 - 0.01, box.h / 2 - 0.01, Vec2(box.x, box.y)),
          { friction: 0.1 },
        );
    }
    const stationKey = stationSignature(f);
    if (p.stationKey !== stationKey) {
      p.world.destroyBody(p.desks);
      p.desks = p.world.createBody();
      p.stationKey = stationKey;
      for (const s of solidDesks(f))
        p.desks.createFixture(
          new Box(STATION_BODY.w / 2, STATION_BODY.h / 2, Vec2(s.x, s.y)),
          { friction: 0.1 },
        );
    }
    return p;
  }
  private remove(e: Entity) {
    const r = this.records.get(e);
    if (!r) return;
    for (const [a, grip] of this.grips)
      if (a === e || grip.object === e) {
        this.floors[r.floor].world.destroyJoint(grip.joint);
        this.grips.delete(a);
      }
    this.floors[r.floor].world.destroyBody(r.body);
    this.records.delete(e);
  }
  private sync(e: Entity) {
    if (furniture(e)) ensureDoor(e, this.g.floors[e.floor]);
    if (!active(e)) {
      this.remove(e);
      return;
    }
    const p = this.floor(e.floor),
      angle = furniture(e) ? (e.angle ?? 0) : 0,
      shape = furniture(e) ? `${e.kind}/${e.w}/${e.h}` : "character";
    let r = this.records.get(e);
    if (r && (r.floor !== e.floor || r.shape !== shape)) {
      this.remove(e);
      r = undefined;
    }
    if (!r) {
      const radius = furniture(e)
        ? undefined
        : (e.physics?.radius ??
          Math.max(
            0.06,
            Math.min(
              BODY_RADIUS,
              ...[...this.g.survivors, ...this.g.zombies]
                .filter(
                  (other) =>
                    other !== e && active(other) && other.floor === e.floor,
                )
                .map((other) => distance(e, other) / 2 - 0.002),
            ),
          ));
      const dynamic = !furniture(e) || !!e.door || e.speed > 0,
        body = p.world.createBody({
          type: dynamic ? "dynamic" : "static",
          position: Vec2(e.x, e.y),
          angle,
          // Zombie impacts on furniture must go through the main solver, where
          // floor friction applies; planck's TOI sub-steps ignore joints.
          bullet: furniture(e) || actor(e),
          fixedRotation: !furniture(e),
          linearDamping: furniture(e) ? 4 : actor(e) ? 0 : 4,
          angularDamping: 5,
          userData: e,
        });
      body.createFixture(
        furniture(e)
          ? new Box(
              Math.max(0.005, e.w / 2 - 0.01),
              Math.max(0.005, e.h / 2 - 0.01),
            )
          : new Circle(radius!),
        {
          density: furniture(e) ? (e.door ? 4 / (e.w * e.h) : 1) : 8,
          friction: furniture(e) ? 0.35 : 0,
          restitution: 0,
        },
      );
      if (furniture(e) && e.speed > 0) this.setFurnitureMass(body, e);
      r = {
        entity: e,
        body,
        floor: e.floor,
        shape,
        radius,
        published: { x: e.x, y: e.y, angle },
        start: {
          x: e.x,
          y: e.y,
          angle,
          moved: furniture(e) ? e.moved : 0,
          blocked: actor(e) ? (e.blockedTime ?? 0) : 0,
        },
      };
      this.records.set(e, r);
      if (furniture(e) && e.door) {
        const d = e.door;
        r.hinge = this.hinge(
          p,
          body,
          d,
          d.latched ? 0 : -DOOR_SWING,
          d.latched ? 0 : DOOR_SWING,
        );
      } else if (furniture(e) && e.speed > 0) {
        r.friction = p.world.createJoint(
          new FrictionJoint(
            { maxForce: floorResist(e), maxTorque: floorTorque(e) },
            p.ground,
            body,
            body.getPosition(),
          ),
        )!;
      }
      if (e.physics) {
        body.setLinearVelocity(e.physics);
        body.setAngularVelocity(e.physics.angular);
        body.setAwake(e.physics.awake);
      }
    } else if (
      Math.abs(e.x - r.published.x) +
        Math.abs(e.y - r.published.y) +
        Math.abs(angle - r.published.angle) >
      1e-7
    ) {
      r.body.setTransform(Vec2(e.x, e.y), angle);
      r.body.setLinearVelocity(e.physics ?? Vec2(0, 0));
      r.body.setAngularVelocity(e.physics?.angular ?? 0);
      r.body.setAwake(true);
    }
    return r;
  }
  view(index: number): Floor {
    const f = this.g.floors[index];
    let v = this.views[index];
    // Rebuilt every begin(); also when tiles or the city were reassigned.
    if (!v || v.tiles !== f.tiles || v.city !== f.city)
      v = this.views[index] = { ...f, furniture: [] };
    return v;
  }
  begin() {
    this.running = true;
    this.elevated = undefined;
    this.views.length = 0;
    this.movedBy.clear();
    for (let i = 0; i < this.g.floors.length; i++) this.floor(i, true);
    const entities: Entity[] = [
        ...this.g.floors.flatMap((f) => f.furniture),
        ...this.g.survivors,
        ...this.g.zombies,
      ],
      present = new Set(entities);
    for (const e of this.records.keys())
      if (!present.has(e) || !active(e)) this.remove(e);
    for (const e of entities) {
      const r = this.sync(e);
      if (!r) continue;
      r.start = {
        x: e.x,
        y: e.y,
        angle: furniture(e) ? (e.angle ?? 0) : 0,
        moved: furniture(e) ? e.moved : 0,
        blocked: actor(e) ? (e.blockedTime ?? 0) : 0,
        vault: actor(e) && e.vault ? { ...e.vault } : undefined,
      };
      r.drive = undefined;
    }
  }
  drive(e: Actor | Zombie, dx: number, dy: number, steer: boolean) {
    const r = this.records.get(e);
    if (!r) return;
    if (actor(e) && e.bodyTrailFloor !== e.floor) {
      delete e.bodyTrail;
      delete e.bodyYield;
      e.bodyTrailFloor = e.floor;
    }
    if (steer && actor(e) && Math.hypot(dx, dy) > 1e-8) {
      const requested = Math.hypot(dx, dy);
      let length = requested;
      const nx = dx / length,
        ny = dy / length,
        f = this.g.floors[e.floor];
      const people = this.g.survivors.filter(
        (other) =>
          other !== e &&
          other.alive &&
          !other.escaped &&
          other.floor === e.floor &&
          distance(other, e) < 2.4,
      );
      const threats = this.g.zombies.filter(
        (z) => z.hp > 0 && z.floor === e.floor && distance(z, e) < 2.4,
      );
      const inLane = (other: Point) => {
        const x = other.x - e.x,
          y = other.y - e.y;
        return x * nx + y * ny > 0 && Math.abs(x * ny - y * nx) < 0.52;
      };
      // Follow traffic travelling in the same direction instead of orbiting
      // every nearby body. Only crossing/oncoming traffic needs a sidestep.
      const following = people.filter(
        (other) =>
          inLane(other) &&
          other.heading.x * nx + other.heading.y * ny > 0.65 &&
          (other.activity === "exploring" ||
            other.activity === "climbing" ||
            other.activity === "fleeing" ||
            (other.physics?.x ?? 0) * nx + (other.physics?.y ?? 0) * ny >
              0.25) &&
          other.activity !== "studying" &&
          other.activity !== "waiting" &&
          other.activity !== "defending",
      );
      for (const other of following) {
        const gap = (other.x - e.x) * nx + (other.y - e.y) * ny;
        length = Math.min(
          length,
          requested * Math.min(1, Math.max(0.15, (gap - 0.48) / 0.27)),
        );
      }
      if (length < requested) {
        dx = nx * length;
        dy = ny * length;
      }
      const ahead = [
        ...people.filter(
          (other) => !following.includes(other) && inLane(other),
        ),
        // Attackers remain dangerous outside the friendly walking lane.
        ...threats.filter((z) => (z.x - e.x) * nx + (z.y - e.y) * ny > 0),
      ];
      const sides = [1, -1]
        .map((side) => {
          const x = nx - ny * side * 0.9,
            y = ny + nx * side * 0.9,
            n = Math.hypot(x, y);
          return { x: x / n, y: y / n };
        })
        .filter(
          (v) => !solid(f, { x: e.x + v.x * 0.65, y: e.y + v.y * 0.65 }, 0.26),
        );
      if (
        e.bodyYield &&
        (this.g.time >= e.bodyYield.until || (ahead.length && sides.length))
      )
        delete e.bodyYield;
      // Predict relative motion for attackers as well as friendly traffic.
      // The old fixed sidestep at bite range flipped direction each frame.
      if ((people.length || threats.length) && sides.length && !e.bodyYield) {
        const desired = {
          x: (dx / requested) * e.speed,
          y: (dy / requested) * e.speed,
        };
        const v = trafficVelocity(
          this.g,
          e,
          desired,
          [
            ...people.filter((other) => !following.includes(other)),
            ...threats,
          ].map((other) => {
            const record = this.records.get(other);
            return {
              id: other.id,
              x: record?.start.x ?? other.x,
              y: record?.start.y ?? other.y,
              velocity: {
                x: other.physics?.x ?? 0,
                y: other.physics?.y ?? 0,
              },
            };
          }),
        );
        dx = (v.x / e.speed) * requested;
        dy = (v.y / e.speed) * requested;
      } else if (ahead.length && !sides.length && !e.bodyYield) {
        const opposing = people.find(
          (other) =>
            (other.x - e.x) * nx + (other.y - e.y) * ny > 0 &&
            other.heading.x * nx + other.heading.y * ny < -0.4,
        );
        if (opposing && e.id > opposing.id) {
          const points = (e.bodyTrail ?? [])
            .slice()
            .reverse()
            .filter((p) => distance(p, e) > 0.25);
          if (points.length) e.bodyYield = { points, until: this.g.time + 6 };
        }
      }
      if (e.bodyYield) {
        while (
          e.bodyYield.points[0] &&
          distance(e, e.bodyYield.points[0]) < 0.12
        )
          e.bodyYield.points.shift();
        const p = e.bodyYield.points[0];
        if (p) {
          const n = distance(e, p) || 1;
          dx = ((p.x - e.x) / n) * Math.min(n, length);
          dy = ((p.y - e.y) / n) * Math.min(n, length);
        } else delete e.bodyYield;
      }
    }
    r.drive = { x: (r.drive?.x ?? 0) + dx, y: (r.drive?.y ?? 0) + dy };
    move(physicsFloor(this.g, e.floor), e, dx, dy);
  }
  kick(z: Zombie, from: Point) {
    const r = this.sync(z);
    if (!r) return;
    const d = distance(z, from) || 1;
    r.body.applyLinearImpulse(
      Vec2(
        ((z.x - from.x) / d) * r.body.getMass() * 8,
        ((z.y - from.y) / d) * r.body.getMass() * 8,
      ),
      r.body.getPosition(),
      true,
    );
    const v = r.body.getLinearVelocity();
    z.physics = {
      ...z.physics,
      x: v.x,
      y: v.y,
      angular: 0,
      awake: true,
      radius: r.radius,
    };
  }
  private syncGrips() {
    for (const [a, grip] of this.grips)
      if (
        !a.alive ||
        a.escaped ||
        a.grip !== grip.state ||
        a.grip?.object !== grip.object.id ||
        a.floor !== grip.object.floor ||
        !this.records.has(grip.object)
      ) {
        this.floors[grip.object.floor].world.destroyJoint(grip.joint);
        this.grips.delete(a);
      }
    for (const a of this.g.survivors)
      if (a.grip && !this.grips.has(a)) {
        const object = this.g.floors[a.floor].furniture.find(
            (o) => o.id === a.grip!.object,
          ),
          ra = this.records.get(a),
          rb = object && this.records.get(object);
        if (!object || !ra || !rb) continue;
        const joint = this.floors[a.floor].world.createJoint(
          object.door
            ? new RopeJoint({
                bodyA: ra.body,
                bodyB: rb.body,
                localAnchorA: Vec2(0, 0),
                localAnchorB: a.grip.local,
                maxLength: a.grip.length ?? 0.45,
                collideConnected: true,
              })
            : new RevoluteJoint({
                bodyA: ra.body,
                bodyB: rb.body,
                localAnchorA: Vec2(0, 0),
                localAnchorB: a.grip.local,
                referenceAngle: 0,
                collideConnected: true,
              }),
        )!;
        this.grips.set(a, { object, joint, state: a.grip });
      }
  }
  /** Static floor friction. An unheld object rests as a static body, so crowd
   * compression and solver error cannot creep it, and becomes dynamic only
   * when the contact push it receives exceeds its floor resistance. Positions
   * are never written; only the body type and its velocity change. */
  private stickOrSlip(h: number, movable: readonly RecordBody[]) {
    for (const r of movable) {
      const o = r.entity as Furniture;
      const held = this.held.has(o.id),
        pushed = (r.push ?? 0) / h > floorResist(o);
      if (r.body.isStatic()) {
        if (held || pushed) this.slide(r, o);
      } else if (
        !held &&
        !pushed &&
        // Changing the body type drops its contacts until the next solve has
        // run, so a freshly slipped object keeps moving for a few substeps
        // rather than snapping back to rest before the push can reach it.
        this.substep - (r.slidAt ?? -Infinity) > 3 &&
        r.body.getLinearVelocity().length() < 0.03 &&
        Math.abs(r.body.getAngularVelocity()) < 0.03
      )
        r.body.setType("static");
    }
  }
  /** Let a resting object move again under its own mass. */
  private slide(r: RecordBody, o: Furniture) {
    if (!r.body.isStatic() || o.speed <= 0) return;
    r.body.setType("dynamic");
    r.slidAt = this.substep;
    this.setFurnitureMass(r.body, o);
    r.body.setAwake(true);
  }
  private setFurnitureMass(body: Body, e: Furniture) {
    const mass = 20 / e.speed;
    body.setMassData({
      mass,
      center: Vec2(0, 0),
      I: (mass * (e.w * e.w + e.h * e.h)) / 12,
    });
  }
  /** Bodies pressing movable furniture: zombies touching (or about to touch)
   * it directly or through other zombies, and survivors walking into it.
   * Survivors press only by direct contact and only while not carrying,
   * vaulting or bracing, which keep their own velocity control. */
  private pressing() {
    const found = new Set<RecordBody>(),
      queue: RecordBody[] = [];
    const visit = (body: Body, direct: boolean) => {
      // Broad-phase contacts include bodies about to touch, so a zombie at the
      // back of a crowd cannot flicker in and out and re-inject its momentum.
      for (let edge = body.getContactList(); edge; edge = edge.next) {
        const other = edge.other?.getUserData() as Entity | undefined,
          r = other && this.records.get(other);
        if (!r || !other || furniture(other) || found.has(r)) continue;
        if (actor(other)) {
          if (
            direct &&
            !other.grip &&
            !other.handling &&
            !other.vault &&
            !r.start.vault
          )
            found.add(r);
          continue;
        }
        found.add(r);
        queue.push(r);
      }
    };
    for (const r of this.records.values())
      if (furniture(r.entity) && r.entity.speed > 0 && !r.entity.door)
        visit(r.body, true);
    for (let i = 0; i < queue.length; i++) visit(queue[i].body, false);
    return found;
  }
  finish(dt: number): Furniture[] {
    // Arrivals, deaths, stairs and broken props can change membership during AI decisions.
    const entities: Entity[] = [
      ...this.g.floors.flatMap((f) => f.furniture),
      ...this.g.survivors,
      ...this.g.zombies,
    ];
    const pressing = this.pressing(),
      braces = new Set<string>(),
      carriers = new Map<string, number>();
    this.held.clear();
    for (const a of this.g.survivors)
      for (const id of new Set([a.grip?.object, a.handling])) {
        if (!id) continue;
        // Any holder lifts the carry speed limit; only the living hold it.
        carriers.set(id, Math.max(carriers.get(id) ?? 3, a.speed * 2.5));
        if (!a.alive || a.escaped) continue;
        this.held.add(id);
        if (id === a.handling && !a.grip) braces.add(id);
      }
    for (const e of entities) {
      const old = this.records.get(e);
      if (!active(e)) {
        this.remove(e);
        continue;
      }
      if (!old || old.floor !== e.floor) {
        this.sync(e);
        continue;
      }
      const r = old,
        angle = furniture(e) ? (e.angle ?? 0) : 0,
        delta = { x: e.x - r.start.x, y: e.y - r.start.y };
      // Models are controller proposals until contacts are solved. Never teleport a dynamic body to that proposal.
      if (!furniture(e)) {
        if (!actor(e))
          // City arrival timing is physical distance / walking speed. Damping
          // is retained for knockback and pushing, rather than slowing every
          // free approach by a different amount at each simulation timestep.
          r.body.setLinearDamping(
            e.cityApproach && e.stagger <= 0 && !pressing.has(r) ? 0 : 4,
          );
        let v = r.drive
          ? { x: r.drive.x / dt, y: r.drive.y / dt }
          : { x: delta.x / dt, y: delta.y / dt };
        const max = actor(e)
          ? Math.max(
              e.speed,
              r.start.vault
                ? distance(r.start.vault.from, r.start.vault.to) /
                    r.start.vault.duration
                : 0,
            )
          : 4;
        const speed = Math.hypot(v.x, v.y);
        if (speed > max) {
          v = { x: (v.x * max) / speed, y: (v.y * max) / speed };
        }
        r.motor = undefined;
        if (pressing.has(r)) {
          if (actor(e) || e.stagger <= 0) r.motor = v;
        } else if (actor(e) || e.stagger <= 0) r.body.setLinearVelocity(v);
        if (Math.hypot(v.x, v.y) > 0) r.body.setAwake(true);
      } else if (
        !e.door &&
        (distance(e, r.start) > 1e-8 || Math.abs(angle - r.start.angle) > 1e-8)
      ) {
        this.slide(r, e);
        r.body.setLinearVelocity({ x: delta.x / dt, y: delta.y / dt });
        r.body.setAngularVelocity((angle - r.start.angle) / dt);
        r.body.setAwake(true);
      }
      if (furniture(e)) {
        const held = this.held.has(e.id);
        if (held && !e.door) this.slide(r, e);
        r.friction?.setMaxForce(held ? 0 : floorResist(e));
        r.body.setLinearDamping(held && !e.door ? 0 : 4);
        r.body.setAngularDamping(held && !e.door ? 0 : 5);
        const braced = braces.has(e.id);
        // A deliberate balanced carry resists torque; an end grip stays free to pivot.
        r.friction?.setMaxTorque(
          braced ? r.body.getMass() * 100 : held ? 0 : floorTorque(e),
        );
        if (e.door && r.hinge) {
          const d = e.door;
          if (!d.latched && r.body.isStatic()) {
            const world = this.floors[e.floor];
            world.world.destroyJoint(r.hinge);
            r.body.setType("dynamic");
            r.body.setTransform(Vec2(r.start.x, r.start.y), r.start.angle);
            r.body.setLinearVelocity(Vec2(0, 0));
            r.body.setAngularVelocity(0);
            r.hinge = this.hinge(world, r.body, d, -DOOR_SWING, DOOR_SWING);
          } else r.body.setType(d.latched ? "static" : "dynamic");
          r.hinge.setLimits(
            d.latched ? 0 : d.side > 0 ? 0 : -DOOR_SWING,
            d.latched ? 0 : d.side < 0 ? 0 : DOOR_SWING,
          );
        }
      }
      e.x = r.start.x;
      e.y = r.start.y;
      if (furniture(e)) e.angle = r.start.angle;
    }
    this.syncGrips();
    // Old saves can contain tightly packed soft bodies. Expand their solid
    // fixtures gradually rather than ejecting the whole queue in one frame.
    for (const r of this.records.values())
      if (r.radius !== undefined && r.radius < BODY_RADIUS) {
        r.radius = Math.min(BODY_RADIUS, r.radius + 0.025 * dt);
        r.body.destroyFixture(r.body.getFixtureList()!);
        r.body.createFixture(new Circle(r.radius), {
          density: 8,
          friction: 0,
          restitution: 0,
        });
      }
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    // Membership is settled above, so partition the bodies once per frame
    // rather than filtering every record in each loop of every substep.
    const motors: RecordBody[] = [],
      furnitureBodies: RecordBody[] = [],
      movable: RecordBody[] = [],
      doors: RecordBody[] = [];
    for (const r of this.records.values()) {
      if (r.motor) motors.push(r);
      const o = r.entity;
      if (!furniture(o)) continue;
      furnitureBodies.push(r);
      if (o.door) doors.push(r);
      else if (o.speed > 0) movable.push(r);
    }
    const fieldPeople = this.g.floors.some((f) =>
      f.furniture.some((o) => o.field && !o.destroyed),
    )
      ? this.g.survivors.filter(
          (a) => a.alive && !a.escaped && (this.records.has(a) || !!a.elevated),
        )
      : [];
    for (let i = 0; i < steps; i++) {
      this.substep++;
      // Resetting a pressing body's velocity every frame would inject m·v of
      // momentum per frame: an unbounded, frame-rate dependent shove. A bounded
      // motor gives the same free-space walk and a fixed push per zombie or
      // walking survivor, so an object slides only when that push beats its
      // floor friction.
      for (const r of motors)
        if (r.motor) {
          const v = r.body.getLinearVelocity(),
            m = r.body.getMass(),
            limit =
              ((actor(r.entity) ? SURVIVOR_PUSH : ZOMBIE_PUSH) * dt) / steps;
          let jx = m * (r.motor.x - v.x),
            jy = m * (r.motor.y - v.y);
          const n = Math.hypot(jx, jy);
          if (n > limit) {
            jx *= limit / n;
            jy *= limit / n;
          }
          r.body.applyLinearImpulse(Vec2(jx, jy), r.body.getPosition(), true);
        }
      for (const r of furnitureBodies)
        if (!r.body.isStatic()) {
          const o = r.entity as Furniture,
            v = r.body.getLinearVelocity(),
            speed = v.length(),
            limit = carriers.get(o.id) ?? 3;
          if (o.speed > 0 && speed > limit)
            r.body.setLinearVelocity(
              Vec2((v.x * limit) / speed, (v.y * limit) / speed),
            );
          r.body.setAngularVelocity(
            Math.max(-2.5, Math.min(2.5, r.body.getAngularVelocity())),
          );
        }
      // Supply the held object's translation as well as the player's drive.
      // Weight still matters for impacts, but cannot tax walking speed in free
      // space. An off-center hand keeps the natural pivot; contacts remain
      // authoritative because these are velocities, never teleported poses.
      for (const [a, grip] of this.grips) {
        if (grip.object.door) continue;
        const person = this.records.get(a),
          object = this.records.get(grip.object);
        if (!person || !object) continue;
        const drive = person.drive ?? { x: 0, y: 0 },
          v = { x: drive.x / dt, y: drive.y / dt },
          hand = object.body.getWorldVector(grip.state.local),
          o = grip.object,
          inertia = (o.w * o.w + o.h * o.h) / 12,
          turn = Math.max(
            -2.5,
            Math.min(
              2.5,
              (hand.x * v.y - hand.y * v.x) /
                (inertia + hand.x * hand.x + hand.y * hand.y),
            ),
          );
        person.body.setLinearVelocity(v);
        object.body.setAngularVelocity(turn);
        object.body.setLinearVelocity(
          Vec2(v.x + turn * hand.y, v.y - turn * hand.x),
        );
      }
      for (const [a, grip] of this.grips)
        if (grip.object.door && !grip.object.door.latched) {
          const person = this.records.get(a),
            object = this.records.get(grip.object),
            drive = person?.drive;
          if (!person || !object || !drive) continue;
          const n = Math.hypot(drive.x, drive.y);
          if (n < 1e-8) continue;
          const hand = object.body.getWorldPoint(a.grip!.local);
          if (distance(hand, person.body.getPosition()) > 1.15) continue;
          const force = Vec2((drive.x / n) * 12, (drive.y / n) * 12);
          object.body.applyForce(force, hand, true);
          person.body.applyForce(
            Vec2(-force.x, -force.y),
            person.body.getPosition(),
            true,
          );
        }
      const beforeFields = new Map(
        fieldPeople.map((a) => [
          a.id,
          {
            ...(this.records.get(a)?.body.getPosition() ?? { x: a.x, y: a.y }),
          },
        ]),
      );
      this.elevated?.(dt / steps);
      // Kinetic floor friction. planck 1.5.1's FrictionJoint never applies its
      // linear impulse (its clamp aliases the accumulated impulse), so the
      // joint only resists turning and sliding friction is applied here.
      for (const r of movable) {
        if (r.body.isStatic()) continue;
        const limit = r.friction?.getMaxForce() ?? 0,
          v = r.body.getLinearVelocity(),
          speed = v.length();
        if (!limit || speed < 1e-9) continue;
        const j = Math.min(r.body.getMass() * speed, (limit * dt) / steps);
        r.body.applyLinearImpulse(
          Vec2((-v.x / speed) * j, (-v.y / speed) * j),
          r.body.getWorldCenter(),
          true,
        );
      }
      for (const r of this.records.values()) r.push = 0;
      for (const f of this.floors) f.world.step(dt / steps, 12, 20);
      this.stickOrSlip(dt / steps, movable);
      if (fieldPeople.length) {
        for (const a of fieldPeople) {
          const body = this.records.get(a)?.body;
          if (body) Object.assign(a, body.getPosition());
        }
        updateFields(this.g, beforeFields);
        for (const a of fieldPeople) {
          const body = this.records.get(a)?.body;
          if (!body) continue;
          if (distance(a, body.getPosition()) > 1e-8) {
            body.setTransform(Vec2(a.x, a.y), 0);
            body.setLinearVelocity(Vec2(0, 0));
            body.setAwake(true);
          }
        }
      }
      for (const r of doors) {
        const d = (r.entity as Furniture).door!,
          angle = r.body.getAngle();
        // Choose a swing side only beyond the solver’s angular contact slop.
        // Tiny contact corrections at release must not lock the wrong side.
        if (!d.latched && !d.side && Math.abs(angle) > 0.06) {
          d.side = angle > 0 ? 1 : -1;
          r.hinge!.setLimits(
            d.side > 0 ? 0 : -DOOR_SWING,
            d.side > 0 ? DOOR_SWING : 0,
          );
        }
        if (Math.abs(angle) > 0.06) d.swung = true;
      }
    }
    updateDoorLeaves(this.g, dt);
    const moved: Furniture[] = [];
    for (const r of this.records.values()) {
      const e = r.entity,
        p = r.body.getPosition();
      e.x = p.x;
      e.y = p.y;
      const velocity = r.body.getLinearVelocity();
      e.physics = {
        x: velocity.x,
        y: velocity.y,
        angular: r.body.getAngularVelocity(),
        awake: r.body.isAwake(),
        ...(r.radius !== undefined ? { radius: r.radius } : {}),
      };
      if (furniture(e)) {
        e.angle = r.body.getAngle();
        if (e.door && Math.abs(e.angle) < 0.045 && latchDoor(this.g, e)) {
          const pose = doorPose(e, 0);
          r.body.setTransform(pose, 0);
          r.body.setLinearVelocity(Vec2(0, 0));
          r.body.setAngularVelocity(0);
          r.hinge!.setLimits(0, 0);
          r.body.setType("static");
        }
        const amount =
          distance(e, r.start) +
          (Math.abs(e.angle - r.start.angle) * Math.hypot(e.w, e.h)) / 2;
        e.moved = r.start.moved + amount;
        if (amount > 1e-5 && e.speed > 0) {
          e.initial ??= {
            x: r.start.x,
            y: r.start.y,
            w: e.w,
            h: e.h,
            angle: r.start.angle,
          };
          e.lastMoveTick = this.g.tick;
          for (const id of this.movedBy.get(e) ?? [])
            if (!e.movers.includes(id)) e.movers.push(id);
          if (e.movers.length) e.lastBy = e.movers[0];
          moved.push(e);
        }
      } else if (actor(e)) {
        if (e.bodyTrailFloor !== e.floor) {
          delete e.bodyTrail;
          delete e.bodyYield;
          e.bodyTrailFloor = e.floor;
        }
        if (
          !e.bodyYield &&
          !r.start.vault &&
          (!e.bodyTrail?.length || distance(e, e.bodyTrail.at(-1)!) > 0.3)
        ) {
          e.bodyTrail ??= [];
          e.bodyTrail.push({ x: e.x, y: e.y });
          if (e.bodyTrail.length > 18) e.bodyTrail.shift();
        }
        if (distance(e, r.start) > 0.001) {
          e.blockedTime = 0;
          e.exploreStall = 0;
        } else if (r.drive) e.blockedTime = r.start.blocked + dt;
        const vault = e.vault ?? r.start.vault;
        if (vault && distance(e, vault.to) > 0.04) {
          const dx = vault.to.x - vault.from.x,
            dy = vault.to.y - vault.from.y,
            n = dx * dx + dy * dy,
            progress = Math.max(
              0,
              Math.min(
                1,
                ((e.x - vault.from.x) * dx + (e.y - vault.from.y) * dy) /
                  (n || 1),
              ),
            );
          e.vault = {
            ...vault,
            left: Math.max(dt, vault.duration * (1 - progress)),
          };
          e.cooldown = 0;
        }
      }
      r.published = {
        x: e.x,
        y: e.y,
        angle: furniture(e) ? (e.angle ?? 0) : 0,
      };
    }
    this.running = false;
    return moved;
  }
}
