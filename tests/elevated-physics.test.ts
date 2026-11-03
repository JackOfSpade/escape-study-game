import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ceilingAbove,
  ELEVATED_JUMP_APEX,
  jumpElevated,
  startElevated,
  stepElevated,
  surfaceBelow,
} from "../src/elevated-physics";
import {
  exteriorStructure,
  stairAccessPortals,
} from "../src/exterior-structure";
import { type Roadmap } from "../src/model";
import { step } from "../src/engine";
import {
  beginPhysics,
  cancelPhysics,
  finishPhysics,
  physicsElevated,
  physicsMove,
} from "../src/physics";
import { cityStairBase, FLOOR_HEIGHT } from "../src/stair-route";
import { createGame, createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function room() {
  const g = createGame(42, roadmap),
    a = g.survivors[0],
    f = g.floors[0];
  g.floors = [f];
  f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
  f.furniture = [];
  Object.assign(a, { x: 12, y: 12, floor: 0 });
  return { g, a, f };
}
function gallery() {
  const g = createPlayableGame(42, roadmap),
    a = g.survivors[0];
  a.access = [0, 1, 2, 3];
  return { g, a };
}

test("jump has a 1.1 m apex, cannot double jump, and lands at the same floor without damage", () => {
  const { g, a } = room();
  assert.equal(jumpElevated(g, a), true);
  assert.equal(jumpElevated(g, a), false);
  let peak = 0,
    landed;
  for (let i = 0; i < 60; i++) {
    const result = stepElevated(g, a, { x: 0, y: 0 }, 1 / 60);
    peak = Math.max(peak, a.elevated!.feet);
    landed ??= result.landed;
  }
  assert.ok(Math.abs(peak - ELEVATED_JUMP_APEX) < 0.001);
  assert.equal(a.elevated!.feet, 0);
  assert.equal(a.elevated!.grounded, true);
  assert.ok(landed && Math.abs(landed.drop - ELEVATED_JUMP_APEX) < 1e-8);
  assert.equal(ceilingAbove(g, a, a, 1.7), 2.82);
});

test("a jump onto a desk rests on its visible top; the indoor ceiling stops a second jump", () => {
  const { g, a, f } = room();
  const prop = createGame(42, roadmap).floors[0].furniture.find(
    (o) => o.kind === "desk",
  )!;
  Object.assign(prop, { x: 14, y: 12, w: 1.2, h: 2, angle: 0 });
  f.furniture = [prop];
  Object.assign(a, { x: 13, y: 12 });
  jumpElevated(g, a);
  for (let i = 0; i < 12; i++) stepElevated(g, a, { x: 0, y: 0 }, 1 / 60);
  for (let i = 0; i < 28; i++) stepElevated(g, a, { x: 1, y: 0 }, 1 / 60);
  for (let i = 0; i < 20; i++) stepElevated(g, a, { x: 0, y: 0 }, 1 / 60);
  assert.equal(a.elevated!.grounded, true);
  assert.equal(a.elevated!.feet, 0.8);
  assert.equal(surfaceBelow(g, a, a, 0.8)?.kind, "furniture");
  jumpElevated(g, a);
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    stepElevated(g, a, { x: 0, y: 0 }, 1 / 60);
    peak = Math.max(peak, a.elevated!.feet);
  }
  assert.ok(peak <= 2.82 - 1.7 + 1e-8, "head contacts the rendered ceiling");
  assert.equal(a.elevated!.feet, 0.8);
});

test("free gallery motion reaches the glass guard, while its broken bay permits a real fall", () => {
  const { g, a } = gallery(),
    structure = exteriorStructure(g),
    broken = structure.guards.find((b) => b.level === 0 && b.broken)!;
  const dx = broken.x2 - broken.x1,
    dy = broken.y2 - broken.y1,
    length = Math.hypot(dx, dy),
    normal = { x: dy / length, y: -dx / length },
    midpoint = {
      x: (broken.x1 + broken.x2) / 2,
      y: (broken.y1 + broken.y2) / 2,
    };
  // The broken gallery is on the outer east or south edge.
  if (normal.x < -0.1 || normal.y < -0.1) {
    normal.x *= -1;
    normal.y *= -1;
  }
  Object.assign(a, {
    x: midpoint.x - normal.x * 0.6,
    y: midpoint.y - normal.y * 0.6,
    floor: 1,
  });
  startElevated(g, a);
  let landed;
  for (let i = 0; i < 70; i++) {
    const result = stepElevated(g, a, normal, 1 / 60);
    landed ??= result.landed;
  }
  assert.ok(
    landed && landed.drop >= 3.6 - 1e-8,
    "the open bay has no invisible guard",
  );
  assert.equal(a.elevated!.feet, 0);
  const intact = structure.guards.find(
    (b) =>
      b.level === 0 &&
      !b.broken &&
      !b.corner &&
      Math.abs(b.base1 - 3.6) < 1e-8 &&
      Math.abs(b.base2 - 3.6) < 1e-8 &&
      Math.abs((b.x2 - b.x1) * normal.x + (b.y2 - b.y1) * normal.y) < 1e-8 &&
      ((b.x1 + b.x2) / 2 > 42 || (b.y1 + b.y2) / 2 > 30),
  )!;
  assert.ok(intact);
  const center = {
    x: (intact.x1 + intact.x2) / 2,
    y: (intact.y1 + intact.y2) / 2,
  };
  Object.assign(a, {
    x: center.x - normal.x * 0.6,
    y: center.y - normal.y * 0.6,
  });
  delete a.elevated;
  startElevated(g, a);
  for (let i = 0; i < 90; i++) stepElevated(g, a, normal, 1 / 60);
  assert.ok((a.x - center.x) * normal.x + (a.y - center.y) * normal.y < -0.25);
  assert.equal(a.elevated!.feet, FLOOR_HEIGHT);
  jumpElevated(g, a);
  for (let i = 0; i < 90; i++) stepElevated(g, a, normal, 1 / 60);
  assert.ok(
    (a.x - center.x) * normal.x + (a.y - center.y) * normal.y < -0.25,
    "jump cannot clear 1.17 m guards",
  );
  assert.equal(a.elevated!.feet, FLOOR_HEIGHT);
});

test("locked stair portals block only the outbound crossing and share visible geometry", () => {
  const { g, a } = gallery(),
    portal = stairAccessPortals(g).find((p) => p.kind === "city-base")!;
  a.access = [];
  Object.assign(a, { x: portal.x, y: portal.y - 0.6, floor: 0 });
  startElevated(g, a);
  for (let i = 0; i < 60; i++) stepElevated(g, a, { x: 0, y: 1 }, 1 / 60);
  assert.ok(a.y < portal.y - 0.25);
  Object.assign(a, { x: portal.x, y: portal.y + 0.6 });
  delete a.elevated;
  startElevated(g, a, 0.36);
  for (let i = 0; i < 60; i++) stepElevated(g, a, { x: 0, y: -1 }, 1 / 60);
  assert.ok(a.y < portal.y - 1, "the field lets descents leave to the court");
});

test("outside tiles beyond the shell are air, while the roof parapet is a one-metre support", () => {
  const { g, a } = gallery(),
    roof = g.floors[4],
    row = roof.boundary!.rows[10];
  assert.equal(
    surfaceBelow(g, a, { x: row.right + 1.8, y: 10.5 }, 14.4)?.height,
    0,
  );
  const parapet = surfaceBelow(g, a, { x: row.right + 0.5, y: 10.5 }, 15.4)!;
  assert.equal(parapet.kind, "wall");
  assert.equal(parapet.height, 15.4);
});

test("jumping onto the roof parapet and walking off produces a lethal-height fall", () => {
  const { g, a } = gallery(),
    roof = g.floors[4],
    top = roof.boundary!.top;
  Object.assign(a, {
    x: 12,
    y: top + 0.5,
    floor: 4,
    physics: { x: 0, y: -3.3, angular: 0, awake: true },
  });
  jumpElevated(g, a);
  let parapet = false,
    landed;
  for (let i = 0; i < 240; i++) {
    const result = stepElevated(g, a, { x: 0, y: -1 }, 1 / 60);
    if (
      result.surface?.kind === "wall" &&
      Math.abs(result.surface.height - 15.4) < 1e-8
    )
      parapet = true;
    if (result.landed && result.landed.drop >= 15) {
      landed = result.landed;
      break;
    }
  }
  assert.equal(
    parapet,
    true,
    "the 1.1 m jump clears the visible 1.0 m parapet",
  );
  assert.ok(
    landed && landed.drop >= 15,
    "stepping beyond it falls to the actual ground below",
  );
  assert.equal(landed.surface.kind, "ground");
  assert.equal(a.elevated!.feet, 0);
});

test("jumping never bypasses a denied field and personally allowed fields remain passable", () => {
  const { g, a, f } = room(),
    field = createGame(42, roadmap).floors[0].furniture.find(
      (o) => o.kind === "door",
    )!;
  Object.assign(field, {
    x: 14,
    y: 12,
    w: 0.1,
    h: 6,
    angle: 0,
    field: { exit: true, authorized: [], crossing: [], sides: {}, used: 0 },
  });
  f.furniture = [field];
  a.access = [];
  Object.assign(a, {
    x: 13.5,
    y: 12,
    physics: { x: 3.3, y: 0, angular: 0, awake: true },
  });
  jumpElevated(g, a);
  for (let i = 0; i < 90; i++) stepElevated(g, a, { x: 1, y: 0 }, 1 / 60);
  assert.ok(
    a.x < 13.7,
    "the full-height locked field remains solid during the jump",
  );
  field.field!.authorized.push(a.id);
  field.field!.leaf = { open: 1, side: 1, hold: 30 };
  jumpElevated(g, a);
  for (let i = 0; i < 90; i++) stepElevated(g, a, { x: 1, y: 0 }, 1 / 60);
  assert.ok(a.x > 16, "personal permission applies to the elevated body too");
});

function quotaRoom() {
  const state = room(),
    { g, a, f } = state,
    field = createGame(42, roadmap).floors[0].furniture.find(
      (o) => o.kind === "door",
    )!;
  Object.assign(field, {
    x: 14,
    y: 12,
    w: 0.1,
    h: 6,
    angle: 0,
    field: {
      exit: false,
      limit: 1,
      direction: 1,
      used: 0,
      authorized: [],
      crossing: [],
      sides: {},
      touchVersion: 1,
      leaf: { open: 1, side: 1, hold: 30 },
    },
  });
  delete field.door;
  f.furniture = [field];
  g.survivors = [a];
  g.zombies = [];
  g.status = "playing";
  g.rules = "force-fields";
  g.nextSpawn = 1e9;
  g.surge.anchor = 1e9;
  a.access = [];
  Object.assign(a, {
    x: 13.5,
    y: 12,
    physics: { x: 3.3, y: 0, angular: 0, awake: true },
  });
  return { ...state, field };
}

test("an airborne human consumes its real free field pass before landing beyond the field", () => {
  const { g, a, field } = quotaRoom();
  for (let i = 0; i < 30; i++)
    step(g, 1 / 30, { x: 1, y: 0, grab: false, jump: i === 0 });
  assert.ok(a.x > 15, "the admitted jumper crosses physically");
  assert.equal(
    field.field!.used,
    1,
    "jumping cannot avoid admission accounting",
  );
  assert.equal(g.events.filter((e) => e.type === "field-entry").length, 1);
  assert.equal(g.events.filter((e) => e.type === "field-sealed").length, 1);
});

test("jumping cannot carry an admitted human through a closed door", () => {
  const { g, a, field } = quotaRoom();
  delete field.field!.leaf;
  for (let i = 0; i < 30; i++)
    step(g, 1 / 30, { x: 1, y: 0, grab: false, jump: i === 0 });
  assert.ok(a.x < 14, "the closed leaf stops the jump at its face");
  assert.equal(field.field!.used, 0, "no pass is spent on a closed door");
});

test("airborne and native actors compete for the last pass by actual first contact in either order", () => {
  for (const winner of ["human", "npc"] as const) {
    const { g, a, field } = quotaRoom(),
      npc = structuredClone(a);
    Object.assign(npc, {
      id: "competitor",
      x: winner === "npc" ? 13.68 : 13.65,
      y: 13,
    });
    Object.assign(a, { x: winner === "human" ? 13.68 : 13.65, y: 11 });
    g.survivors.push(npc);
    jumpElevated(g, a);
    beginPhysics(g);
    try {
      physicsElevated(g, (dt) => {
        stepElevated(g, a, { x: 1, y: 0 }, dt);
      });
      physicsMove(g, npc, npc.speed / 30, 0);
      finishPhysics(g, 1 / 30);
    } finally {
      cancelPhysics(g);
    }
    assert.equal(field.field!.used, 1);
    assert.deepEqual(
      field.field!.visitors,
      [winner === "human" ? "human" : "competitor"],
      "controller order does not steal the final free pass",
    );
    const rejected = winner === "human" ? npc : a;
    assert.ok(
      rejected.x < 13.71,
      "the later contact remains on the denied side",
    );
  }
});

test("the visible city return field prevents a side-jump credential bypass while licensed entry works", () => {
  for (const licensed of [false, true]) {
    const { g, a } = gallery(),
      base = cityStairBase(g)!;
    g.survivors = [a];
    g.zombies = [];
    g.nextSpawn = 1e9;
    g.status = "playing";
    g.surge.anchor = 1e9;
    Object.assign(a, {
      x: base.start.x - 2,
      y: base.start.y + 0.5,
      floor: 0,
      access: licensed ? [0] : [],
    });
    delete a.physics;
    // Start on actual court ground, then use only ordinary input. Previously
    // this went behind the front gate and climbed with no credential at all.
    for (let i = 0; i < 24; i++)
      step(g, 1 / 30, {
        x: 1,
        y: 0,
        grab: false,
        stairWalk: true,
        jump: i === 0,
      });
    const returnField = stairAccessPortals(g).find(
      (p) => p.kind === "city-base-side",
    )!;
    assert.equal(returnField.axis, "x");
    if (licensed) assert.ok(a.x > base.start.x - 0.3);
    else
      assert.ok(
        a.x <= returnField.x - 0.25,
        "the visible west field stops the side jump",
      );
    for (let i = 0; i < 100; i++)
      step(g, 1 / 30, { x: 0, y: 1, grab: false, stairWalk: true });
    assert.equal(a.floor, licensed ? 1 : 0);
    assert.equal(a.elevated?.feet ?? 0, licensed ? FLOOR_HEIGHT : 0);
    assert.equal(a.hp, 100);
  }
});

test("the visible east corner guard also prevents a city flight side jump", () => {
  const { g, a } = gallery(),
    base = cityStairBase(g)!;
  g.survivors = [a];
  g.zombies = [];
  g.nextSpawn = 1e9;
  g.status = "playing";
  g.surge.anchor = 1e9;
  Object.assign(a, {
    x: base.start.x + 2,
    y: base.start.y + 0.5,
    floor: 0,
    access: [],
  });
  delete a.physics;
  for (let i = 0; i < 24; i++)
    step(g, 1 / 30, {
      x: -1,
      y: 0,
      grab: false,
      stairWalk: true,
      jump: i === 0,
    });
  assert.ok(
    a.x > base.start.x + 1.15,
    "the rendered east corner guard holds the jumper outside",
  );
  for (let i = 0; i < 100; i++)
    step(g, 1 / 30, { x: 0, y: 1, grab: false, stairWalk: true });
  assert.equal(a.floor, 0);
  assert.equal(a.elevated?.feet ?? 0, 0);
  assert.equal(a.hp, 100);
});
