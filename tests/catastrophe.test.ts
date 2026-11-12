import assert from "node:assert/strict";
import test from "node:test";
import type { CatastropheSpec } from "../src/escape-types";
import {
  CATASTROPHE_LIMITS,
  catastropheState,
  fallbackCatastrophe,
  omensDue,
  onsetAt,
  validateCatastrophe,
} from "../src/catastrophe";

const AREAS = ["hangar", "corridor", "plant"] as const;

function validSpec(): CatastropheSpec {
  return {
    id: "the-excavation-device",
    title: "The excavation device",
    premise:
      "A mining laser left running in the hangar is cutting toward the fuel spine.",
    origin: { areaId: "hangar", roomHint: "Bay 3" },
    behaviours: [
      {
        kind: "hunter",
        body: { color: "#5b4a3f", scale: 1.05, silhouette: "quadruped" },
        count: 6,
        speed: 1.1,
        sightRange: 9,
        hearingWeight: 0.8,
        doors: "break",
        damage: 18,
        spawn: "waves",
      },
      {
        kind: "hazard",
        medium: "smoke",
        spreadRate: 0.35,
        damagePerSecond: 6,
        blockedByClosedDoors: true,
        obscures: 0.7,
      },
      { kind: "collapse", targets: ["power", "doors"], cadence: 90 },
    ],
    timeline: {
      graceSeconds: 300,
      phases: [
        { name: "omens", at: 30, behaviours: [], intensity: 0.1 },
        { name: "onset", at: 300, behaviours: [0], intensity: 0.4 },
        { name: "spread", at: 480, behaviours: [1, 2], intensity: 0.7 },
        { name: "peak", at: 600, behaviours: [0], intensity: 1 },
      ],
    },
    omens: [
      {
        id: "omen-1",
        text: "A bulb over Bay 3 stutters.",
        at: 20,
        areaId: "hangar",
      },
      {
        id: "omen-2",
        text: "A vent ticks twice and stops.",
        at: 60,
        areaId: "corridor",
      },
      {
        id: "omen-3",
        text: "A badge reader refuses a clean swipe.",
        at: 100,
        areaId: "hangar",
      },
      {
        id: "omen-4",
        text: "Someone reports a metallic taste.",
        at: 150,
        areaId: "plant",
      },
      {
        id: "omen-5",
        text: "The lights dim for one second.",
        at: 200,
        areaId: "corridor",
      },
      {
        id: "omen-6",
        text: "A door latch clicks on its own.",
        at: 250,
        areaId: "hangar",
      },
    ],
    publicStory:
      "A scheduled drill is in progress. Please continue your shift.",
  };
}

type Loose = Record<string, any>;

const clone = (): Loose => structuredClone(validSpec()) as unknown as Loose;

const paths = (spec: unknown): string[] =>
  validateCatastrophe(spec, AREAS).map((problem) => problem.split(": ")[0]!);

function perception(overrides: Loose = {}): Loose {
  return {
    kind: "perception-rule",
    trigger: "sees-own-reflection",
    effect: "damage",
    damagePerSecond: 12,
    warning: "flicker",
    ...overrides,
  };
}

interface RejectionCase {
  name: string;
  path: string;
  /** False when the mutation legitimately trips more than one rule. */
  exact?: boolean;
  mutate: (spec: Loose) => void;
}

const rejections: RejectionCase[] = [
  {
    name: "blank id",
    path: "id",
    mutate: (spec) => {
      spec.id = "  ";
    },
  },
  {
    name: "title over 80 characters",
    path: "title",
    mutate: (spec) => {
      spec.title = "t".repeat(81);
    },
  },
  {
    name: "blank premise",
    path: "premise",
    mutate: (spec) => {
      spec.premise = "  ";
    },
  },
  {
    name: "public story over 400 characters",
    path: "publicStory",
    mutate: (spec) => {
      spec.publicStory = "s".repeat(401);
    },
  },
  {
    name: "origin area not in the area graph",
    path: "origin.areaId",
    mutate: (spec) => {
      spec.origin.areaId = "moon";
    },
  },
  {
    name: "origin room hint over 80 characters",
    path: "origin.roomHint",
    mutate: (spec) => {
      spec.origin.roomHint = "r".repeat(81);
    },
  },
  {
    name: "no behaviours",
    path: "behaviours",
    mutate: (spec) => {
      spec.behaviours = [];
    },
  },
  {
    name: "four behaviours",
    path: "behaviours",
    exact: false,
    mutate: (spec) => {
      spec.behaviours.push(structuredClone(spec.behaviours[0]));
    },
  },
  {
    name: "unknown behaviour field",
    path: "behaviours[0].sneak",
    mutate: (spec) => {
      spec.behaviours[0].sneak = true;
    },
  },
  {
    name: "hunter colour is not a hex colour",
    path: "behaviours[0].body.color",
    mutate: (spec) => {
      spec.behaviours[0].body.color = "red";
    },
  },
  {
    name: "hunter scale below the bound",
    path: "behaviours[0].body.scale",
    mutate: (spec) => {
      spec.behaviours[0].body.scale = 0.5;
    },
  },
  {
    name: "hunter silhouette outside the union",
    path: "behaviours[0].body.silhouette",
    mutate: (spec) => {
      spec.behaviours[0].body.silhouette = "blob";
    },
  },
  {
    name: "hunter count not an integer in range",
    path: "behaviours[0].count",
    mutate: (spec) => {
      spec.behaviours[0].count = 41;
    },
  },
  {
    name: "hunter speed above the bound",
    path: "behaviours[0].speed",
    mutate: (spec) => {
      spec.behaviours[0].speed = 1.7;
    },
  },
  {
    name: "hunter speed not finite",
    path: "behaviours[0].speed",
    mutate: (spec) => {
      spec.behaviours[0].speed = Number.NaN;
    },
  },
  {
    name: "hunter sight range above the bound",
    path: "behaviours[0].sightRange",
    mutate: (spec) => {
      spec.behaviours[0].sightRange = 15;
    },
  },
  {
    name: "hearing weight above the bound",
    path: "behaviours[0].hearingWeight",
    mutate: (spec) => {
      spec.behaviours[0].hearingWeight = 1.2;
    },
  },
  {
    name: "hunter doors outside the union",
    path: "behaviours[0].doors",
    mutate: (spec) => {
      spec.behaviours[0].doors = "slam";
    },
  },
  {
    name: "hunter damage above the bound",
    path: "behaviours[0].damage",
    mutate: (spec) => {
      spec.behaviours[0].damage = 61;
    },
  },
  {
    name: "hunter spawn outside the union",
    path: "behaviours[0].spawn",
    mutate: (spec) => {
      spec.behaviours[0].spawn = "twice";
    },
  },
  {
    name: "hazard medium outside the union",
    path: "behaviours[1].medium",
    mutate: (spec) => {
      spec.behaviours[1].medium = "lava";
    },
  },
  {
    name: "hazard spread rate below the bound",
    path: "behaviours[1].spreadRate",
    mutate: (spec) => {
      spec.behaviours[1].spreadRate = 0;
    },
  },
  {
    name: "hazard damage per second below the bound",
    path: "behaviours[1].damagePerSecond",
    mutate: (spec) => {
      spec.behaviours[1].damagePerSecond = 0;
    },
  },
  {
    name: "hazard closed-door flag is not a boolean",
    path: "behaviours[1].blockedByClosedDoors",
    mutate: (spec) => {
      spec.behaviours[1].blockedByClosedDoors = "yes";
    },
  },
  {
    name: "hazard obscures above the bound",
    path: "behaviours[1].obscures",
    mutate: (spec) => {
      spec.behaviours[1].obscures = 1.5;
    },
  },
  {
    name: "perception trigger outside the union",
    path: "behaviours[2].trigger",
    mutate: (spec) => {
      spec.behaviours[2] = perception({ trigger: "hears-name" });
    },
  },
  {
    name: "perception effect outside the union",
    path: "behaviours[2].effect",
    mutate: (spec) => {
      spec.behaviours[2] = perception({ effect: "flee" });
    },
  },
  {
    name: "damage effect without a damage rate",
    path: "behaviours[2].damagePerSecond",
    mutate: (spec) => {
      const behaviour = perception();
      delete behaviour.damagePerSecond;
      spec.behaviours[2] = behaviour;
    },
  },
  {
    name: "makes-sound without a threshold",
    path: "behaviours[2].threshold",
    mutate: (spec) => {
      spec.behaviours[2] = perception({ trigger: "makes-sound" });
    },
  },
  {
    name: "threshold above the bound",
    path: "behaviours[2].threshold",
    mutate: (spec) => {
      spec.behaviours[2] = perception({
        trigger: "makes-sound",
        threshold: 11,
      });
    },
  },
  {
    name: "warning outside the union",
    path: "behaviours[2].warning",
    mutate: (spec) => {
      spec.behaviours[2] = perception({ warning: "bell" });
    },
  },
  {
    name: "collapse with no targets",
    path: "behaviours[2].targets",
    mutate: (spec) => {
      spec.behaviours[2] = { kind: "collapse", targets: [], cadence: 90 };
    },
  },
  {
    name: "collapse with duplicate targets",
    path: "behaviours[2].targets",
    mutate: (spec) => {
      spec.behaviours[2] = {
        kind: "collapse",
        targets: ["power", "power"],
        cadence: 90,
      };
    },
  },
  {
    name: "collapse target outside the union",
    path: "behaviours[2].targets[0]",
    mutate: (spec) => {
      spec.behaviours[2] = {
        kind: "collapse",
        targets: ["elevators"],
        cadence: 90,
      };
    },
  },
  {
    name: "collapse cadence below the bound",
    path: "behaviours[2].cadence",
    mutate: (spec) => {
      spec.behaviours[2].cadence = 9;
    },
  },
  {
    name: "grace period below the bound",
    path: "timeline.graceSeconds",
    mutate: (spec) => {
      spec.timeline.graceSeconds = 120;
    },
  },
  {
    name: "grace period not finite",
    path: "timeline.graceSeconds",
    mutate: (spec) => {
      spec.timeline.graceSeconds = Number.NaN;
    },
  },
  {
    name: "only one phase",
    path: "timeline.phases",
    exact: false,
    mutate: (spec) => {
      spec.timeline.phases = [spec.timeline.phases[0]];
    },
  },
  {
    name: "first phase is not omens",
    path: "timeline.phases[0].name",
    exact: false,
    mutate: (spec) => {
      spec.timeline.phases[0].name = "peak";
    },
  },
  {
    name: "omens phase at or after the grace period",
    path: "timeline.phases[0].at",
    mutate: (spec) => {
      spec.timeline.graceSeconds = 240;
      spec.timeline.phases[0].at = 260;
    },
  },
  {
    name: "phase times not strictly increasing",
    path: "timeline.phases[2].at",
    mutate: (spec) => {
      spec.timeline.phases[2].at = 300;
    },
  },
  {
    name: "duplicate phase name",
    path: "timeline.phases[2].name",
    mutate: (spec) => {
      spec.timeline.phases[2].name = "onset";
    },
  },
  {
    name: "no onset phase",
    path: "timeline.phases",
    exact: false,
    mutate: (spec) => {
      spec.timeline.phases[1].name = "spread";
    },
  },
  {
    name: "onset before the grace period",
    path: "timeline.phases[1].at",
    mutate: (spec) => {
      spec.timeline.phases[1].at = 250;
    },
  },
  {
    name: "phase behaviour index out of range",
    path: "timeline.phases[1].behaviours[0]",
    mutate: (spec) => {
      spec.timeline.phases[1].behaviours = [7];
    },
  },
  {
    name: "duplicate behaviour index in a phase",
    path: "timeline.phases[2].behaviours",
    mutate: (spec) => {
      spec.timeline.phases[2].behaviours = [1, 1, 2];
    },
  },
  {
    name: "phase intensity above the bound",
    path: "timeline.phases[3].intensity",
    mutate: (spec) => {
      spec.timeline.phases[3].intensity = 1.2;
    },
  },
  {
    name: "behaviour never active after onset",
    path: "timeline.phases",
    mutate: (spec) => {
      spec.timeline.phases[2].behaviours = [2];
    },
  },
  {
    name: "only four omens",
    path: "omens",
    mutate: (spec) => {
      spec.omens = spec.omens.slice(0, 4);
    },
  },
  {
    name: "eleven omens",
    path: "omens",
    mutate: (spec) => {
      for (let index = 0; index < 5; index += 1) {
        spec.omens.push({
          id: `omen-extra-${index}`,
          text: "Another vent ticks.",
          at: 260 + index,
          areaId: "plant",
        });
      }
    },
  },
  {
    name: "duplicate omen id",
    path: "omens[1].id",
    mutate: (spec) => {
      spec.omens[1].id = "omen-1";
    },
  },
  {
    name: "blank omen text",
    path: "omens[0].text",
    mutate: (spec) => {
      spec.omens[0].text = "  ";
    },
  },
  {
    name: "omen text over 280 characters",
    path: "omens[0].text",
    mutate: (spec) => {
      spec.omens[0].text = "o".repeat(281);
    },
  },
  {
    name: "omen before zero",
    path: "omens[0].at",
    mutate: (spec) => {
      spec.omens[0].at = -1;
    },
  },
  {
    name: "omen at the last phase",
    path: "omens[5].at",
    mutate: (spec) => {
      spec.omens[5].at = 600;
    },
  },
  {
    name: "omen in an unknown area",
    path: "omens[0].areaId",
    mutate: (spec) => {
      spec.omens[0].areaId = "moon";
    },
  },
  {
    name: "omen effect outside the union",
    path: "omens[0].effect",
    mutate: (spec) => {
      spec.omens[0].effect = "siren";
    },
  },
];

test("a valid spec has no problems", () => {
  assert.deepEqual(validateCatastrophe(validSpec(), AREAS), []);
  assert.deepEqual(
    validateCatastrophe(validSpec(), ["hangar", "corridor", "plant", "moon"]),
    [],
  );
});

test("unknown fields are rejected by name", () => {
  const spec: Loose = clone();
  spec.mascot = "the reactor";
  assert.deepEqual(validateCatastrophe(spec, AREAS), ["mascot: unknown field"]);
  assert.deepEqual(paths(spec), ["mascot"]);
});

test("every bound and structural rule rejects a concrete bad value at its own path", () => {
  const distinct = new Set<string>();
  for (const item of rejections) {
    const spec = clone();
    item.mutate(spec);
    const found = paths(spec);
    distinct.add(item.path);
    if (item.exact === false) {
      assert.ok(
        found.includes(item.path),
        `${item.name}: expected ${item.path} in ${JSON.stringify(found)}`,
      );
    } else {
      assert.deepEqual(found, [item.path], item.name);
    }
  }
  assert.ok(
    distinct.size >= 12,
    `only ${distinct.size} distinct paths covered`,
  );
});

test("catastropheState is calm before the first phase", () => {
  const spec = validSpec();
  assert.deepEqual(catastropheState(spec, 0), {
    phase: "calm",
    intensity: 0,
    behaviours: [],
    onset: false,
  });
  assert.deepEqual(catastropheState(spec, 29.9), {
    phase: "calm",
    intensity: 0,
    behaviours: [],
    onset: false,
  });
});

test("omens phases contribute no behaviours and are never the onset", () => {
  const spec = validSpec();
  assert.equal(onsetAt(spec), 300);
  assert.deepEqual(catastropheState(spec, 30), {
    phase: "omens",
    intensity: 0.1,
    behaviours: [],
    onset: false,
  });
  assert.deepEqual(catastropheState(spec, 299.9), {
    phase: "omens",
    intensity: 0.1,
    behaviours: [],
    onset: false,
  });
});

test("the onset phase starts exactly at its time", () => {
  const spec = validSpec();
  assert.deepEqual(catastropheState(spec, 300), {
    phase: "onset",
    intensity: 0.4,
    behaviours: [spec.behaviours[0]],
    onset: true,
  });
});

test("after spread the behaviours are the union in index order", () => {
  const spec = validSpec();
  assert.deepEqual(catastropheState(spec, 480), {
    phase: "spread",
    intensity: 0.7,
    behaviours: [spec.behaviours[0], spec.behaviours[1], spec.behaviours[2]],
    onset: true,
  });
  assert.deepEqual(catastropheState(spec, 600), {
    phase: "peak",
    intensity: 1,
    behaviours: [spec.behaviours[0], spec.behaviours[1], spec.behaviours[2]],
    onset: true,
  });
});

test("omensDue is a half-open window sorted by time then id", () => {
  const spec = validSpec();
  assert.deepEqual(
    omensDue(spec, 0, 20).map((omen) => omen.id),
    ["omen-1"],
  );
  assert.deepEqual(
    omensDue(spec, 20, 100).map((omen) => omen.id),
    ["omen-2", "omen-3"],
  );
  assert.deepEqual(omensDue(spec, 19, 19), []);
  assert.deepEqual(omensDue(spec, 100, 100), []);

  const tied = validSpec();
  tied.omens[0] = {
    id: "z-omen",
    text: "A bulb over Bay 3 stutters.",
    at: 120,
    areaId: "hangar",
  };
  tied.omens[1] = {
    id: "a-omen",
    text: "A vent ticks twice and stops.",
    at: 120,
    areaId: "corridor",
  };
  const due = omensDue(tied, 0, 200);
  assert.deepEqual(
    due.map((omen) => omen.id),
    ["omen-3", "a-omen", "z-omen", "omen-4", "omen-5"],
  );
  assert.deepEqual(
    due.map((omen) => omen.at),
    [100, 120, 120, 150, 200],
  );
});

test("CATASTROPHE_LIMITS is frozen and carries the documented bounds", () => {
  assert.ok(Object.isFrozen(CATASTROPHE_LIMITS));
  assert.deepEqual(
    {
      graceSecondsMin: CATASTROPHE_LIMITS.graceSecondsMin,
      graceSecondsMax: CATASTROPHE_LIMITS.graceSecondsMax,
      behaviourMin: CATASTROPHE_LIMITS.behaviourMin,
      behaviourMax: CATASTROPHE_LIMITS.behaviourMax,
      phaseMin: CATASTROPHE_LIMITS.phaseMin,
      phaseMax: CATASTROPHE_LIMITS.phaseMax,
      omenMin: CATASTROPHE_LIMITS.omenMin,
      omenMax: CATASTROPHE_LIMITS.omenMax,
      intensityMin: CATASTROPHE_LIMITS.intensityMin,
      intensityMax: CATASTROPHE_LIMITS.intensityMax,
    },
    {
      graceSecondsMin: 240,
      graceSecondsMax: 900,
      behaviourMin: 1,
      behaviourMax: 3,
      phaseMin: 2,
      phaseMax: 6,
      omenMin: 5,
      omenMax: 10,
      intensityMin: 0,
      intensityMax: 1,
    },
  );
});

test("fallbackCatastrophe is deterministic for a seed", () => {
  for (const seed of [0, 1, 23, -7, 1000]) {
    assert.deepEqual(
      fallbackCatastrophe(seed, "hangar"),
      fallbackCatastrophe(seed, "hangar"),
      `seed ${seed}`,
    );
  }
  const spec = fallbackCatastrophe(4, "plant");
  assert.deepEqual(spec.origin.areaId, "plant");
  assert.deepEqual(
    spec.omens.every((omen) => omen.areaId === "plant"),
    true,
  );
});

test("every fallback template validates and all of them are used", () => {
  const signatures = new Set<string>();
  for (let seed = 0; seed <= 40; seed += 1) {
    const spec = fallbackCatastrophe(seed, "hangar");
    assert.deepEqual(validateCatastrophe(spec, ["hangar"]), [], `seed ${seed}`);
    signatures.add(
      spec.behaviours.map((behaviour) => behaviour.kind).join("+"),
    );
  }
  assert.deepEqual([...signatures].sort(), [
    "collapse",
    "hazard+collapse",
    "hunter",
    "perception-rule",
  ]);
});
