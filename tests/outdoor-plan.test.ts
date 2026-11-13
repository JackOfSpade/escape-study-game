import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OUTDOOR_LIMITS,
  checkOutdoorGeometry,
  outdoorSolids,
  outdoorSummary,
  parseOutdoorPlan,
  regionRectangles,
  type OutdoorPlan,
  type OutdoorRegion,
  type OutdoorSite,
} from "../src/outdoor-plan.mjs";

const site: OutdoorSite = {
  building: { left: 0, right: 44, top: 2, bottom: 28 },
  entrance: { x: 22, y: 29 },
  keepClear: [{ x: 49, y: 15, w: 10, h: 30 }],
};
const plan = (regions: OutdoorRegion[] = [], over: Partial<OutdoorPlan> = {}) =>
  ({
    version: 1,
    bounds: { left: -30, right: 74, top: -20, bottom: 70 },
    ground: "rock",
    enclosure: "open-sky",
    backdrop: "sea",
    regions,
    ...over,
  }) as OutdoorPlan;
const inside = (
  x: number,
  y: number,
  rects: { x: number; y: number; w: number; h: number }[],
) =>
  rects.some(
    (r) => Math.abs(x - r.x) <= r.w / 2 && Math.abs(y - r.y) <= r.h / 2,
  );

test("a well-formed plan parses and an empty one is geometrically sound", () => {
  const p = parseOutdoorPlan(plan());
  assert.equal(p.regions.length, 0);
  assert.deepEqual(checkOutdoorGeometry(p, site), []);
});

test("shape validation names the faulty field", () => {
  assert.throws(
    () => parseOutdoorPlan(plan([], { version: 2 as 1 })),
    /version/,
  );
  assert.throws(
    () =>
      parseOutdoorPlan(
        plan([], { bounds: { left: -5, right: 74, top: -20, bottom: 70 } }),
      ),
    /bounds\.left/,
  );
  assert.throws(
    () =>
      parseOutdoorPlan(
        plan([
          {
            kind: "lava",
            shape: "rect",
            x: 0,
            y: 50,
            w: 4,
            h: 4,
            height: 1,
            color: "#ff0000",
          } as unknown as OutdoorRegion,
        ]),
      ),
    /regions\[0\]\.kind/,
  );
  assert.throws(
    () =>
      parseOutdoorPlan(
        plan([
          {
            kind: "rocks",
            shape: "rect",
            x: 0,
            y: 50,
            w: 4,
            h: 4,
            color: "#777777",
          } as OutdoorRegion,
        ]),
      ),
    /regions\[0\]\.height/,
  );
  assert.throws(
    () =>
      parseOutdoorPlan(
        plan([
          {
            kind: "path",
            shape: "ring",
            x: 22,
            y: 15,
            r: 30,
            thickness: 1,
            gaps: [],
            color: "#777777",
          } as OutdoorRegion,
        ]),
      ),
    /ring must be a solid kind/,
  );
  assert.throws(
    () =>
      parseOutdoorPlan(
        plan(
          Array.from({ length: OUTDOOR_LIMITS.regions + 1 }, () => ({
            kind: "rocks",
            shape: "rect",
            x: -20,
            y: 60,
            w: 2,
            h: 2,
            height: 1,
            color: "#777777",
          })) as OutdoorRegion[],
        ),
      ),
    /regions needs/,
  );
});

test("a disc rasterises into strips that cover its centre and stay inside its box", () => {
  const rects = regionRectangles({
    kind: "water",
    shape: "disc",
    x: 10,
    y: 50,
    r: 9,
    color: "#224466",
  });
  assert.ok(rects.length >= 9);
  assert.ok(inside(10, 50, rects), "centre covered");
  assert.ok(inside(10, 41.2, rects), "near the top covered");
  assert.ok(!inside(10, 60, rects), "outside the radius open");
  for (const r of rects) assert.ok(r.w <= 18 + 1e-9 && r.y > 40 && r.y < 60);
});

test("a ring blocks its circle except at its gaps", () => {
  const ring = {
    kind: "dome-wall",
    shape: "ring",
    x: 22,
    y: 15,
    r: 40,
    thickness: 1,
    gaps: [{ angle: 90, width: 6 }],
    height: 12,
    color: "#aaccdd",
  } as OutdoorRegion;
  const rects = regionRectangles(ring);
  assert.ok(inside(22 + 40, 15, rects), "east wall closed");
  assert.ok(inside(22, 15 - 40, rects), "north wall closed");
  assert.ok(!inside(22, 15 + 40, rects), "south gap open");
  assert.ok(!inside(22, 15, rects), "interior open");
});

test("walkable regions carve through solids regardless of order", () => {
  const solids = outdoorSolids(
    plan([
      {
        kind: "path",
        shape: "rect",
        x: 22,
        y: 50,
        w: 4,
        h: 40,
        color: "#998877",
      },
      {
        kind: "water",
        shape: "rect",
        x: 22,
        y: 50,
        w: 60,
        h: 10,
        height: 0.4,
        color: "#224466",
      },
    ]),
  );
  assert.ok(!inside(22, 50, solids), "the causeway crosses the water");
  assert.ok(
    inside(10, 50, solids) && inside(40, 50, solids),
    "water either side",
  );
  assert.ok(
    solids.every(
      (s) => s.kind === "water" && s.opaque === false && s.region === 1,
    ),
  );
});

test("geometry rejects solids over the building, the apron or the service route", () => {
  const errors = checkOutdoorGeometry(
    plan([
      {
        kind: "rocks",
        shape: "rect",
        x: 22,
        y: 15,
        w: 10,
        h: 10,
        height: 3,
        color: "#555555",
      },
      {
        kind: "fence",
        shape: "rect",
        x: 22,
        y: 31,
        w: 6,
        h: 1,
        height: 1,
        color: "#555555",
      },
      {
        kind: "trees",
        shape: "rect",
        x: 49,
        y: 10,
        w: 4,
        h: 4,
        height: 6,
        color: "#335533",
      },
    ]),
    site,
  );
  assert.equal(errors.length, 3);
  assert.match(errors[0], /regions\[0\].*overlaps the building/);
  assert.match(errors[1], /regions\[1\].*apron/);
  assert.match(errors[2], /regions\[2\].*service route/);
});

test("a sealed entrance is rejected as unreachable ground", () => {
  // Walls that touch the building close a small yard in front of the door.
  const wall = (x: number, y: number, w: number, h: number) =>
    ({
      kind: "cliff",
      shape: "rect",
      x,
      y,
      w,
      h,
      height: 8,
      color: "#555555",
    }) as OutdoorRegion;
  const errors = checkOutdoorGeometry(
    plan([wall(22, 38, 50, 2), wall(-1, 29, 2, 20), wall(45, 29, 2, 20)]),
    { ...site, keepClear: [] },
  );
  assert.ok(
    errors.some((e) => /Only \d+ m² of ground can be walked to/.test(e)),
    errors.join("\n"),
  );
  const opened = checkOutdoorGeometry(plan([wall(22, 38, 50, 2)]), {
    ...site,
    keepClear: [],
  });
  assert.deepEqual(
    opened,
    [],
    "a wall with open sides leaves the ground reachable",
  );
});

test("too many compiled rectangles is a repairable error", () => {
  const discs = Array.from({ length: 12 }, (_, i) => ({
    kind: "rocks",
    shape: "disc",
    x: -25 + (i % 6) * 18,
    y: 50 + Math.floor(i / 6) * 15,
    r: 30,
    height: 2,
    color: "#666666",
  })) as OutdoorRegion[];
  const errors = checkOutdoorGeometry(
    plan(discs, { bounds: { left: -150, right: 194, top: -20, bottom: 184 } }),
    site,
  );
  assert.ok(errors.some((e) => /collision rectangles/.test(e)));
});

test("the summary names the place without any text", () => {
  assert.deepEqual(
    outdoorSummary(
      plan([
        { kind: "water", shape: "disc", x: 0, y: 60, r: 5, color: "#224466" },
        {
          kind: "path",
          shape: "rect",
          x: 22,
          y: 50,
          w: 4,
          h: 20,
          color: "#998877",
        },
      ]),
    ),
    {
      enclosure: "open-sky",
      backdrop: "sea",
      ground: "rock",
      kinds: ["path", "water"],
    },
  );
});
