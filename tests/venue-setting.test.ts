import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createBuildingFootprint } from "../src/building-layout";
import { fnv1a } from "../src/hash";
import { HELIPAD, HELIPAD_RADIUS, type Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import {
  FOOTPRINT_SHAPES,
  RUN_DESIGN_GUIDANCE,
  parseRunDesign,
  parseRunStructure,
  summarizeRunDesign,
} from "../src/run-design-contract.mjs";
import { PROP_CATALOG, SCENE_FURNITURE_KINDS } from "../src/scene-catalog.mjs";
import {
  ROOF_FEATURE_KINDS,
  SETTING_GUIDANCE,
  TERMINAL_STYLES,
  VENUES,
  parseSetting,
} from "../src/setting-catalog.mjs";
import { resolveRoofFeatures, settingErrors } from "../src/venue";
import { createPlayableGame, previewDesignedRun } from "../src/world";
import { environmentStructureFixture } from "./helpers/environment-design";
import { runDesignFixture, savedRunDesign } from "./helpers/run-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const radio = () =>
  parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
    ),
  );
const setting = () => structuredClone((radio() as any).setting);

test("the setting contract validates every choice and stays optional", () => {
  assert.deepEqual(parseSetting(setting()), setting());
  for (const [mutate, message] of [
    [(s: any) => (s.venue = "castle"), /venue must be one of/],
    [(s: any) => (s.interior.roomFloor = "lava"), /roomFloor/],
    [(s: any) => (s.interior.wall = "red"), /six-digit hex/],
    [(s: any) => (s.exterior.facade = "marble"), /facade/],
    [(s: any) => (s.exterior.extra = 1), /unknown field/],
    [(s: any) => delete s.exterior.canopy, /missing a field/],
    [(s: any) => (s.exterior.roofFeatures[0].x = 1.2), /between 0 and 1/],
    [(s: any) => (s.exterior.roofFeatures[0].kind = "statue"), /kind/],
    [
      (s: any) =>
        (s.exterior.roofFeatures = Array.from({ length: 7 }, () => ({
          kind: "vent",
          x: 0,
          y: 0,
        }))),
      /0–6 entries/,
    ],
  ] as const) {
    const s = setting();
    mutate(s);
    assert.throws(() => parseSetting(s), message);
  }
  // Older v3 structures without a setting still parse; v1/v2 cannot carry one.
  assert.equal("setting" in environmentStructureFixture(), false);
  const legacy: any = structuredClone(runDesignFixture());
  legacy.setting = setting();
  assert.throws(() => parseRunDesign(legacy), /unknown field/);
});

test("the designer is told to build the premise's venue from the full catalog", () => {
  assert.doesNotMatch(RUN_DESIGN_GUIDANCE, /zombie-escape office building/);
  for (const word of [
    ...VENUES,
    ...ROOF_FEATURE_KINDS,
    ...FOOTPRINT_SHAPES,
    ...SCENE_FURNITURE_KINDS,
    ...Object.keys(PROP_CATALOG),
  ])
    assert.ok(RUN_DESIGN_GUIDANCE.includes(word), word);
  assert.match(RUN_DESIGN_GUIDANCE, /meeting=live studio/);
});

test("venue and exterior choices count toward novelty without changing older summaries", () => {
  const design: any = radio();
  const office = structuredClone(design);
  office.setting.venue = "office";
  assert.notEqual(
    summarizeRunDesign(design).atmosphere,
    summarizeRunDesign(office).atmosphere,
  );
  const moved = structuredClone(design);
  moved.setting.exterior.roofFeatures[0].x = 0.9;
  assert.notEqual(
    summarizeRunDesign(design).spatial,
    summarizeRunDesign(moved).spatial,
  );
  const bare = structuredClone(design);
  delete bare.setting;
  assert.doesNotMatch(summarizeRunDesign(bare).atmosphere, /venue/);
});

test("the radio fixture builds a furnished broadcast station that survives save and reload", () => {
  const design = radio();
  const game = createPlayableGame(
    42,
    roadmap,
    undefined,
    savedRunDesign(design),
  );
  for (const floor of game.floors)
    assert.equal(floor.setting?.venue, "broadcast", `floor ${floor.index}`);
  const kinds = new Set(
    game.floors.flatMap((f) => f.furniture.map((o) => o.kind)),
  );
  for (const kind of [
    "mixingConsole",
    "micStand",
    "recordShelf",
    "onAirLight",
    "soundPanel",
    "equipmentRack",
  ] as const)
    assert.ok(kinds.has(kind), kind);
  for (const kind of ["printer", "vending", "partition"] as const)
    assert.equal(kinds.has(kind), false, kind);
  const payload = JSON.parse(JSON.parse(encode(game)).payload);
  // A tampered floor setting is rebound from the fingerprinted blueprint.
  payload.floors[2].setting.venue = "office";
  const text = JSON.stringify(payload);
  const loaded = decode(
    JSON.stringify({ schema: 1, payload: text, checksum: fnv1a(text) }),
  );
  assert.deepEqual(loaded.floors[2].setting, (design as any).setting);
});

test("roof features stand on the free roof edge, away from the helipad, stairs and barrier", () => {
  for (const shape of FOOTPRINT_SHAPES) {
    const boundary = createBuildingFootprint(7, {
      shape,
      width: 38,
      top: 3,
      inset: 3,
      mirrored: true,
      shoulder: 14,
    });
    const features = ROOF_FEATURE_KINDS.slice(0, 6).map((kind, i) => ({
      kind,
      x: [0, 1, 0, 1, 0.5, 0.5][i],
      y: [0, 0, 1, 1, 0, 1][i],
    }));
    const resolved = resolveRoofFeatures(boundary, features);
    assert.equal(resolved.filter(Boolean).length, 6, shape);
    for (const f of resolved) {
      assert.ok(f);
      const row = boundary.rows[Math.floor(f.y)];
      assert.ok(f.x > row.left && f.x < row.right, `${shape} inside roof`);
      assert.ok(
        Math.hypot(f.x - HELIPAD.x, f.y - HELIPAD.y) >= HELIPAD_RADIUS + 1.2,
      );
      assert.ok(f.x < 19 || f.x > 26, "clear of the stair columns");
      assert.ok(f.y < 21 || f.y > 24, "clear of the cover barrier");
      assert.equal(Math.hypot(f.outward.x, f.outward.y).toFixed(6), "1.000000");
    }
    for (let i = 0; i < resolved.length; i++)
      for (let j = i + 1; j < resolved.length; j++)
        assert.ok(
          Math.hypot(
            resolved[i]!.x - resolved[j]!.x,
            resolved[i]!.y - resolved[j]!.y,
          ) >= 2.5,
        );
    assert.deepEqual(resolveRoofFeatures(boundary, features), resolved);
  }
});

test("a roof too crowded for its features is rejected for repair, never silently trimmed", () => {
  const boundary = createBuildingFootprint(7, {
    shape: "notched",
    width: 36,
    top: 4,
    inset: 4,
    mirrored: false,
    shoulder: 12,
  });
  const crowded = Array.from({ length: 200 }, () => ({
    kind: "vent" as const,
    x: 0.1,
    y: 0.1,
  }));
  const s = setting();
  s.exterior.roofFeatures = crowded;
  assert.ok(
    settingErrors(s, boundary).some((e) => /no free roof edge/.test(e)),
  );
  assert.deepEqual(settingErrors(setting(), boundary), []);
  assert.deepEqual(settingErrors(undefined, boundary), []);
});

test("new silhouettes keep the shared stair and entrance columns and a usable width", () => {
  for (const shape of ["tapered", "notched", "tee"] as const)
    for (const width of [36, 38, 40] as const)
      for (const inset of [2, 3, 4]) {
        const top = 3,
          b = createBuildingFootprint(1, {
            shape,
            width,
            top,
            inset,
            mirrored: false,
            shoulder: top + 10,
          });
        for (let y = b.top; y < b.bottom; y++) {
          const { left, right } = b.rows[y];
          assert.equal(left + right, 44, `${shape} row ${y} is symmetric`);
          assert.ok(left <= 20 && right >= 24, `${shape} keeps the columns`);
          assert.ok(right - left >= width - 2 * inset);
        }
        assert.deepEqual(b.rows[b.bottom - 1], {
          left: 22 - width / 2 + (shape === "tapered" ? 0 : inset),
          right: 22 + width / 2 - (shape === "tapered" ? 0 : inset),
        });
      }
  // Seed-only runs keep their historical four shapes.
  const seen = new Set(
    Array.from({ length: 64 }, (_, i) => createBuildingFootprint(i).shape),
  );
  assert.deepEqual([...seen].sort(), [
    "chamfered",
    "rectangle",
    "stepped",
    "waisted",
  ]);
});

test("a broadcast structure previews through the real builder for every silhouette", () => {
  const { environment: _e, ...structure } = radio() as any;
  for (const shape of FOOTPRINT_SHAPES) {
    const s = structuredClone(structure);
    s.footprint.shape = shape;
    // One small prop-hosting anchor per room: a full authored scene is fitted
    // to its own silhouette, and the repair loop handles one that no longer fits.
    for (const floor of s.floors)
      for (const room of floor.scene.rooms) {
        const anchor = room.furniture.find((o: any) => o.props.length);
        room.furniture = [
          { ...anchor, kind: "cafeTable", at: { x: 0.5, y: 0.5 } },
        ];
      }
    const token = previewDesignedRun(
      42,
      roadmap,
      undefined,
      parseRunStructure(s),
    );
    assert.ok(token.surfaces.length > 200, shape);
  }
});

test("a roof feature may name a composed object and keeps the placement rules", () => {
  const s: any = setting();
  s.venue = "custom";
  s.filler = {
    reception: ["desk"],
    break: ["table"],
    cubicles: ["desk"],
    meeting: ["table"],
    storage: ["shelf"],
    manager: ["desk"],
  };
  s.objects = [
    {
      id: "weather-vane",
      name: "Weather vane",
      role: "decor",
      weight: "light",
      size: { w: 0.6, d: 0.6, h: 2 },
      surface: false,
      parts: [
        {
          shape: "cylinder",
          axis: "up",
          x: 0,
          y: 0,
          z: 0,
          w: 0.1,
          d: 0.1,
          h: 1.8,
          color: "#444444",
          finish: "metal",
          pitch: 0,
          roll: 0,
          motion: "none",
          rate: 1,
        },
        {
          shape: "wedge",
          axis: "across",
          x: 0,
          y: 0,
          z: 1.7,
          w: 0.6,
          d: 0.1,
          h: 0.3,
          color: "#aa8844",
          finish: "metal",
          pitch: 0,
          roll: 0,
          motion: "none",
          rate: 1,
        },
      ],
    },
  ];
  s.exterior.roofFeatures = [
    { kind: "weather-vane", x: 0.5, y: 0.1 },
    { kind: "mast", x: 0.5, y: 0.1 },
  ];
  assert.doesNotThrow(() => parseSetting(s));
  const footprint = createBuildingFootprint({
      shape: "rectangle",
      width: 38,
      top: 3,
    } as any),
    placed = resolveRoofFeatures(footprint, s.exterior.roofFeatures);
  assert.deepEqual(
    placed.map((p) => p?.kind),
    ["weather-vane", "mast"],
  );
  assert.ok(
    Math.hypot(placed[0]!.x - placed[1]!.x, placed[0]!.y - placed[1]!.y) >= 2.5,
    "composed and built-in features keep the same spacing",
  );
  s.exterior.roofFeatures[0].kind = "weather-wane";
  assert.throws(() => parseSetting(s), /roofFeatures\[0\]\.kind/);
});

test("the terminal setting is required and accepts every style but no others", () => {
  assert.deepEqual(
    [...TERMINAL_STYLES],
    ["desk", "console", "lectern", "pedestal", "kiosk", "altar", "cabinet"],
  );
  for (const style of TERMINAL_STYLES) {
    const s = setting();
    s.terminal.style = style;
    assert.equal(parseSetting(s).terminal.style, style);
  }
  for (const [mutate, message] of [
    [
      (s: any) => (s.terminal.style = "throne"),
      /terminal.style must be one of/,
    ],
    [(s: any) => (s.terminal.body = "grey"), /terminal.body needs a six-digit/],
    [(s: any) => (s.terminal.accent = "#12"), /terminal.accent/],
    [(s: any) => (s.terminal.screen = 5), /terminal.screen/],
    [(s: any) => delete s.terminal, /missing a field/],
    [(s: any) => delete s.terminal.screen, /missing a field/],
    [(s: any) => (s.terminal.glow = "#ffffff"), /unknown field/],
  ] as const) {
    const s = setting();
    mutate(s);
    assert.throws(() => parseSetting(s), message);
  }
  assert.match(SETTING_GUIDANCE, /terminal:\{style:desk\|console/);
  assert.match(SETTING_GUIDANCE, /lectern/);
});
