import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { Mesh, Object3D } from "three";
import { compileOutdoorPlan } from "../src/city-layout";
import type { Floor, Roadmap } from "../src/model";
import type { OutdoorPlan } from "../src/outdoor-plan.mjs";
import type { RunSetting, RunSurroundings } from "../src/setting-catalog.mjs";
import { ExteriorDressing } from "../src/view3d/exterior";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const radio = () =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  ).setting as RunSetting;

function withCanvas<T>(work: () => T): T {
  const noop = () => undefined,
    context: object = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === "measureText"
            ? () => ({ width: 8 })
            : key === "createRadialGradient" || key === "createLinearGradient"
              ? () => ({ addColorStop: noop })
              : noop,
        set: () => true,
      },
    ),
    globals = globalThis as any,
    previous = globals.document;
  globals.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => context }),
  };
  try {
    return work();
  } finally {
    if (previous === undefined) delete globals.document;
    else globals.document = previous;
  }
}

const base = {
  version: 1,
  bounds: { left: -40, right: 84, top: -30, bottom: 90 },
} as const;
const island: OutdoorPlan = {
  ...base,
  ground: "rock",
  enclosure: "open-sky",
  backdrop: "sea",
  regions: [
    {
      kind: "water",
      shape: "rect",
      x: 22,
      y: 60,
      w: 120,
      h: 12,
      height: 0.4,
      color: "#1f3f5a",
    },
    {
      kind: "path",
      shape: "rect",
      x: 22,
      y: 55,
      w: 4,
      h: 40,
      color: "#8a8f8a",
    },
    {
      kind: "rocks",
      shape: "disc",
      x: -25,
      y: 20,
      r: 8,
      height: 5,
      color: "#3d4650",
    },
    {
      kind: "fence",
      shape: "rect",
      x: 60,
      y: 45,
      w: 12,
      h: 0.3,
      height: 1.2,
      color: "#6b5a44",
    },
  ],
};
const dome: OutdoorPlan = {
  ...base,
  ground: "regolith",
  enclosure: "dome",
  backdrop: "dunes",
  regions: [
    {
      kind: "dome-wall",
      shape: "ring",
      x: 22,
      y: 30,
      r: 55,
      thickness: 1,
      gaps: [{ angle: 90, width: 6 }],
      height: 14,
      color: "#bcd6e0",
    },
    {
      kind: "building",
      shape: "rect",
      x: 70,
      y: 60,
      w: 10,
      h: 8,
      height: 6,
      color: "#8a8f9a",
    },
  ],
};

function dressed(plan: OutdoorPlan) {
  const floor: Floor = createPlayableGame(7, roadmap).floors[0],
    setting = structuredClone(radio());
  setting.surroundings = {
    ...setting.surroundings,
    neighbors: "buildings",
    scenery: [],
    weather: "none",
  } as RunSurroundings;
  setting.outdoors = plan;
  floor.setting = setting;
  floor.city = compileOutdoorPlan(floor, plan, 7);
  const dressing = new ExteriorDressing();
  withCanvas(() => dressing.build(floor, [floor]));
  const names: string[] = [];
  dressing.group.traverse((o: Object3D) => {
    if ((o as Mesh).isMesh) names.push(o.name);
  });
  return { dressing, names };
}

test("an island draws water, its fence and no enclosure", () => {
  const { dressing, names } = dressed(island);
  assert.ok(names.includes("authored-water"), names.join(", "));
  assert.ok(names.includes("themed-paths"), "the causeway is drawn");
  assert.ok(!names.some((n) => n.startsWith("outdoor-enclosure")));
  dressing.dispose();
});

test("a dome draws its shell over the bounds", () => {
  const { dressing, names } = dressed(dome);
  assert.ok(names.includes("outdoor-enclosure-dome"), names.join(", "));
  assert.ok(!names.includes("authored-water"), "no water in a dry dome");
  dressing.dispose();
});

test("the city skyline backdrop is only drawn when the design asks for it", () => {
  const vertices = (plan: OutdoorPlan) => {
    const { dressing } = dressed(plan);
    let count = 0;
    dressing.group.traverse((o: Object3D) => {
      const mesh = o as Mesh;
      if (mesh.isMesh && mesh.name === "merged-street-facade-props")
        count = mesh.geometry.getAttribute("position").count;
    });
    dressing.dispose();
    return count;
  };
  const none = vertices({ ...island, backdrop: "none" }),
    skyline = vertices({ ...island, backdrop: "skyline" });
  assert.ok(skyline > none + 1000, `skyline ${skyline} vs none ${none}`);
});
