import { EQUIPMENT } from "../equipment";
import { SWARM } from "../force-fields";
import { soundConnected } from "../acoustics";
import { buildingLayoutErrors } from "../building-layout";
import { assertDesignedEnvironment } from "../environment-save";
import { step, toggleDoor, toggleGrip, vault } from "../engine";
import { distance, type Game, type Roadmap, type Point } from "../model";
import { applyStudyPacing } from "../study-pacing";
import {
  beginPhysics,
  checkpointPhysics,
  finishPhysics,
  physicsMove,
} from "../physics";
import {
  parseScenario,
  type Action,
  type Check,
  type Scenario,
} from "./schema";
import { createTestWorld, entity, spawn } from "./world";
import { populateCity } from "../world";
import { FLOOR_HEIGHT, sampleStairRoute } from "../stair-route";
export const TEST_DT = 1 / 30;
export interface CheckResult {
  name: string;
  status: "pending" | "passed" | "failed";
  tick: number;
  actual?: number | boolean;
  expected: number | boolean;
  message: string;
}
export interface TestResult {
  id: string;
  name: string;
  seed: number;
  status: TestRunner["status"];
  tick: number;
  time: number;
  checks: CheckResult[];
  error?: string;
  actions: { tick: number; type: string; ok: boolean }[];
  positions: { id: string; x: number; y: number; floor: number; hp: number }[];
}
function read(
  g: Game,
  c: Check,
  endedTravel: { npcTravel: number; zombieTravel: number },
): number | boolean {
  const q = c.query;
  if (q.type === "worldTime") return g.time;
  if (q.type === "humanEnded")
    return g.status === "dead" || g.status === "escaped";
  if (q.type === "sinceEnd")
    return g.endedAt === undefined
      ? -1
      : q.metric === "time"
        ? g.time - g.endedAt
        : endedTravel[q.metric];
  if (q.type === "property") {
    const e = entity(g, q.id);
    if (!e) throw Error(`Missing entity ${q.id}`);
    if (q.field === "latched") {
      if (!("door" in e) || !e.door)
        throw Error(`${q.id} is not a hinged door`);
      return e.door.latched;
    }
    if (q.field === "doorOpen") {
      if (!("field" in e) || !e.field)
        throw Error(`${q.id} is not an access door`);
      return e.field.leaf?.open ?? 0;
    }
    if (q.field === "maxHp") {
      if (!("maxHp" in e))
        throw Error(`${q.id} has no furniture maximum health`);
      return e.maxHp;
    }
    if (q.field === "absAngle") {
      if (!("kind" in e)) throw Error(`${q.id} has no furniture angle`);
      return Math.abs(e.angle ?? 0);
    }
    if (q.field === "elevation")
      return "alive" in e
        ? (e.elevated?.feet ??
            (e.stairTravel?.walked !== undefined
              ? sampleStairRoute(g, e.stairTravel).y
              : e.floor * FLOOR_HEIGHT))
        : e.floor * FLOOR_HEIGHT;
    if (q.field === "falling")
      return (
        "alive" in e &&
        !!e.elevated &&
        !e.elevated.grounded &&
        e.elevated.vz < 0
      );
    if (q.field === "alive") return "alive" in e ? e.alive : e.hp > 0;
    return e[q.field];
  }
  if (q.type === "separation") {
    const points = q.ids.map((id) => {
      const e = entity(g, id);
      if (!e) throw Error(`Missing entity ${id}`);
      return e;
    });
    let min = 100000;
    for (let i = 0; i < points.length; i++)
      for (let j = i + 1; j < points.length; j++)
        if (points[i].floor === points[j].floor)
          min = Math.min(min, distance(points[i], points[j]));
    return min;
  }
  if (q.type === "event")
    return g.events.filter((e) => e.type === q.event).length;
  if (q.type === "soundConnected")
    return soundConnected(g.floors[q.floor], q.a, q.b);
  if (q.type === "buildingLayoutErrors") return buildingLayoutErrors(g).length;
  if (q.type === "furnitureCount")
    return g.floors
      .filter((f) => q.floor === undefined || f.index === q.floor)
      .flatMap((f) => f.furniture)
      .filter((o) => o.kind === q.kind && !o.destroyed).length;
  if (q.type === "environmentErrors") {
    try {
      assertDesignedEnvironment(g);
      return 0;
    } catch {
      return 1;
    }
  }
  if (q.type === "atStation") {
    const a = g.survivors.find((e) => e.id === q.id);
    return (
      !!a &&
      a.alive &&
      !a.escaped &&
      !!g.floors[a.floor]?.stations.some(
        (s) => Math.hypot(s.x - a.x, s.y - a.y) <= 0.7,
      )
    );
  }
  const values =
    q.kind === "zombie"
      ? g.zombies.filter((z) => z.hp > 0)
      : g.survivors.filter((a) => a.id !== "human" && a.alive && !a.escaped);
  return q.type === "count"
    ? values.length
    : values.filter(
        (e) =>
          e.floor === q.floor &&
          e.x >= q.x1 &&
          e.x <= q.x2 &&
          e.y >= q.y1 &&
          e.y <= q.y2,
      ).length;
}
function matches(value: number | boolean, c: Check) {
  return c.op === "eq"
    ? value === c.expected
    : typeof value === "number" &&
        typeof c.expected === "number" &&
        (c.op === "gte" ? value >= c.expected : value <= c.expected);
}
export class TestRunner {
  readonly scenario: Scenario;
  game: Game;
  tick = 0;
  status: "ready" | "running" | "passed" | "failed" | "unverified" = "ready";
  error?: string;
  readonly results: CheckResult[];
  readonly actionResults: { tick: number; type: string; ok: boolean }[] = [];
  private moves = new Map<string, Point & { stairWalk?: boolean }>();
  private walkTargets = new Map<string, Point & { stairWalk?: boolean }>();
  private jumpPending = false;
  private endedTravel = { npcTravel: 0, zombieTravel: 0 };
  constructor(s: Scenario, roadmap: Roadmap) {
    this.scenario = parseScenario(s);
    this.game = createTestWorld(this.scenario, roadmap);
    if (this.scenario.pacing === "study") {
      applyStudyPacing(this.game);
      if (!this.scenario.naturalSpawns)
        this.game.nextSpawn = Number.MAX_SAFE_INTEGER;
    }
    if (this.scenario.city && this.scenario.design?.version !== 3) {
      populateCity(this.game, this.scenario.naturalSpawns);
      if (!this.scenario.naturalSpawns)
        this.game.nextSpawn = Number.MAX_SAFE_INTEGER;
    }
    this.results = this.scenario.checks.map((c) => ({
      name: c.name,
      status: "pending",
      tick: 0,
      expected: c.expected,
      message: "Waiting",
    }));
  }
  private action(a: Action) {
    if (a.type === "decoy") {
      this.game.effects.push({
        kind: "decoy",
        floor: a.floor,
        x: a.x,
        y: a.y,
        radius: EQUIPMENT.decoy.radius,
        until: this.game.time + EQUIPMENT.decoy.seconds,
      });
      return true;
    }
    if (a.type === "pause") {
      this.game.paused = a.paused;
      return true;
    }
    if (a.type === "checkpoint") {
      checkpointPhysics(this.game);
      this.game = JSON.parse(JSON.stringify(this.game)) as Game;
      return true;
    }
    if (a.type === "spawn") {
      spawn(this.game, a.entity);
      return true;
    }
    const e = entity(this.game, a.id);
    if (!e || !("alive" in e || "origin" in e))
      throw Error(`Missing character ${a.id}`);
    if (a.type === "jump") {
      this.jumpPending = true;
      return true;
    }
    if (a.type === "walkTo") {
      this.moves.delete(a.id);
      this.walkTargets.set(a.id, { x: a.x, y: a.y, stairWalk: a.stairWalk });
      return true;
    }
    if (a.type === "move") {
      this.walkTargets.delete(a.id);
      this.moves.set(a.id, {
        x: a.x,
        y: a.y,
        ...(a.stairWalk === undefined ? {} : { stairWalk: a.stairWalk }),
      });
      if ("heading" in e && Math.hypot(a.x, a.y) > 0)
        e.heading = {
          x: a.x / Math.hypot(a.x, a.y),
          y: a.y / Math.hypot(a.x, a.y),
        };
      return true;
    }
    if (!("alive" in e))
      throw Error("Only survivors can use handles or vault.");
    if (a.type === "door") return toggleDoor(this.game, e, a.target);
    if (a.type === "grip") return toggleGrip(this.game, e, a.target);
    return vault(this.game, e, a.target === "auto" ? undefined : a.target);
  }
  advance(count = 1, manual?: Point) {
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > this.scenario.maxTicks
    )
      throw Error("Invalid tick count.");
    for (
      let i = 0;
      i < count && ["ready", "running"].includes(this.status);
      i++
    ) {
      this.status = "running";
      this.tick++;
      try {
        for (const a of this.scenario.actions.filter(
          (a) => a.tick === this.tick,
        )) {
          const ok = this.action(a);
          this.actionResults.push({ tick: this.tick, type: a.type, ok });
          if (!ok)
            throw Error(
              `Tick ${this.tick}: ${a.type} action could not reach its target.`,
            );
        }
        if (this.scenario.simulation === "game") {
          const before =
            this.game.endedAt === undefined
              ? undefined
              : new Map(
                  [...this.game.survivors, ...this.game.zombies].map((e) => [
                    e.id,
                    { x: e.x, y: e.y, floor: e.floor },
                  ]),
                );
          const target = this.walkTargets.get("human"),
            human = this.game.survivors[0],
            dx = target ? target.x - human.x : 0,
            dy = target ? target.y - human.y : 0,
            remaining = Math.hypot(dx, dy),
            steering = target
              ? {
                  x: remaining > human.speed * TEST_DT ? dx / remaining : 0,
                  y: remaining > human.speed * TEST_DT ? dy / remaining : 0,
                  stairWalk: target.stairWalk,
                }
              : undefined,
            input = manual ??
              steering ??
              this.moves.get("human") ?? { x: 0, y: 0 };
          step(this.game, TEST_DT, {
            ...input,
            grab: false,
            jump: this.jumpPending,
          });
          this.jumpPending = false;
          if (before)
            for (const [kind, entities] of [
              [
                "npcTravel",
                this.game.survivors.filter(
                  (a) => a.id !== "human" && a.alive && !a.escaped,
                ),
              ],
              ["zombieTravel", this.game.zombies.filter((z) => z.hp > 0)],
            ] as const)
              for (const e of entities) {
                const p = before.get(e.id);
                if (p?.floor === e.floor)
                  this.endedTravel[kind] += distance(e, p);
              }
        } else {
          this.game.time += TEST_DT;
          this.game.tick = (this.game.tick ?? 0) + 1;
          beginPhysics(this.game);
          // Set intended headings for the whole crowd before evaluating avoidance.
          for (const [id, v] of this.moves) {
            const e = entity(this.game, id);
            if (e && "heading" in e && Math.hypot(v.x, v.y) > 0) {
              e.heading = {
                x: v.x / Math.hypot(v.x, v.y),
                y: v.y / Math.hypot(v.x, v.y),
              };
              if (id !== "human" && "alive" in e) e.activity = "exploring";
            }
          }
          for (const [id, v] of this.moves) {
            const e = entity(this.game, id);
            if (!e || !("alive" in e || "origin" in e))
              throw Error(`Missing motor character ${id}`);
            const speed =
                "speed" in e
                  ? e.speed
                  : this.game.rules
                    ? 3.3 * SWARM.speedRatio
                    : 2.05,
              n = Math.max(1, Math.hypot(v.x, v.y));
            physicsMove(
              this.game,
              e,
              (v.x / n) * speed * TEST_DT,
              (v.y / n) * speed * TEST_DT,
              id !== "human",
            );
          }
          finishPhysics(this.game, TEST_DT);
        }
        this.scenario.checks.forEach((c, index) => {
          const result = this.results[index];
          if (
            result.status === "failed" ||
            (c.mode !== "always" && result.status === "passed") ||
            this.tick < (c.fromTick ?? 1) ||
            (c.mode === "at" && c.tick !== this.tick)
          )
            return;
          const value = read(this.game, c, this.endedTravel),
            ok = matches(value, c);
          result.actual = value;
          result.tick = this.tick;
          result.status = ok
            ? "passed"
            : c.mode === "eventually" && this.tick < this.scenario.maxTicks
              ? "pending"
              : "failed";
          result.message = `${c.name}: expected ${c.op} ${c.expected}, got ${value} at tick ${this.tick}`;
        });
        if (this.results.some((r) => r.status === "failed"))
          this.status = "failed";
        else if (this.tick === this.scenario.maxTicks) {
          for (const r of this.results)
            if (r.status === "pending") {
              r.status = "failed";
              r.message = `Timed out: ${r.name}`;
              r.tick = this.tick;
            }
          this.status = this.results.some((r) => r.status === "failed")
            ? "failed"
            : this.results.length
              ? "passed"
              : "unverified";
        }
      } catch (error) {
        this.error = String(error);
        this.status = "failed";
      }
    }
    return this.report();
  }
  run() {
    return this.advance(this.scenario.maxTicks);
  }
  report(): TestResult {
    return {
      id: this.scenario.id,
      name: this.scenario.name,
      seed: this.scenario.seed,
      status: this.status,
      tick: this.tick,
      time: this.game.time,
      checks: structuredClone(this.results),
      error: this.error,
      actions: structuredClone(this.actionResults),
      positions: [
        ...this.game.survivors,
        ...this.game.zombies,
        ...this.game.floors.flatMap((f) => f.furniture),
      ].map((e) => ({ id: e.id, x: e.x, y: e.y, floor: e.floor, hp: e.hp })),
    };
  }
}
