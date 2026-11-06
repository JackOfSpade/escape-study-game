import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { FURNITURE } from "../src/model";
import {
  PROP_CATALOG,
  SCENE_FURNITURE_KINDS,
  SCENE_SURFACE_KINDS,
  parseSceneDesign,
  type SceneFloorDesign,
} from "../src/scene-catalog.mjs";
import {
  parseRunDesign,
  parseRunDesignReply,
  parseRunDesignRequest,
  parseSavedRunDesign,
  runDesignFingerprint,
  runDesignNoveltyErrors,
  summarizeRunDesign,
} from "../src/run-design-contract.mjs";
import {
  runDesignFixture,
  savedRunDesign,
  sceneDesignFixture,
} from "./helpers/run-design";

test("the shared scene catalog covers physical furniture without inventing collider sizes", () => {
  assert.deepEqual(
    [...SCENE_FURNITURE_KINDS].sort(),
    Object.keys(FURNITURE)
      // gate/door are engine-owned; "custom" is placed by a design's own
      // composed object id rather than by name.
      .filter((kind) => !["gate", "door", "custom"].includes(kind))
      .sort(),
  );
  assert.equal(Object.keys(PROP_CATALOG).length, 15);
  for (const dimensions of Object.values(PROP_CATALOG)) {
    assert.deepEqual(Object.keys(dimensions).sort(), ["d", "h", "w"]);
    assert.ok(
      Object.values(dimensions).every(
        (n) => Number.isFinite(n) && n > 0 && n <= 0.32,
      ),
    );
    assert.ok(Object.isFrozen(dimensions));
  }
  assert.ok(Object.isFrozen(PROP_CATALOG));
  for (const surface of SCENE_SURFACE_KINDS)
    assert.ok(SCENE_FURNITURE_KINDS.includes(surface));
});

test("version 1 fingerprints, summaries and captured requests remain byte-stable", () => {
  const old = runDesignFixture();
  assert.equal(runDesignFingerprint(old), "78cdf1a9e497315b");
  assert.equal(
    createHash("sha256")
      .update(JSON.stringify(summarizeRunDesign(old)))
      .digest("hex"),
    "d991642a0c835bdd35f0ab5a5934f9a2b2c4c7668b5fb3e19ea55b866c2e0390",
  );
  const request = {
    version: 1 as const,
    requestId: "design-legacy",
    generationId: "design-pending",
    seed: 42,
    recent: [],
  };
  assert.deepEqual(parseRunDesignRequest(request), request);
  assert.deepEqual(
    parseRunDesignReply(
      { requestId: request.requestId, design: old },
      parseRunDesignRequest(request),
    ).design,
    old,
  );
  assert.deepEqual(
    parseSavedRunDesign(savedRunDesign(old)),
    savedRunDesign(old),
  );
  assert.throws(
    () =>
      parseRunDesign({
        ...old,
        floors: old.floors.map((f) => ({
          ...f,
          scene: sceneDesignFixture().floors[0].scene,
        })),
      }),
    /unknown field/,
  );
});

test("version 2 scene owners, object properties and independent captions are preserved as data", () => {
  for (const name of ["botanical-office", "observatory-records"] as const) {
    const design = sceneDesignFixture(name);
    assert.equal(design.version, 2);
    assert.deepEqual(parseRunDesign(design), design);
    assert.deepEqual(
      parseSavedRunDesign(savedRunDesign(design)),
      savedRunDesign(design),
    );
    const kinds = new Set(
      design.floors[0].scene!.rooms.flatMap((r) =>
        r.furniture.flatMap((o) => o.props.map((p) => p.kind)),
      ),
    );
    // The v2 fixtures predate the broadcast props.
    const broadcast = ["cassette", "headphones", "record"];
    assert.deepEqual(
      [...kinds].sort(),
      Object.keys(PROP_CATALOG)
        .filter((kind) => !broadcast.includes(kind))
        .sort(),
    );
    const room = design.floors[0].scene!.rooms[0];
    assert.ok(design.roster.some((a) => a.name === room.owner));
    assert.ok(
      room.furniture[0].props.every((p) => p.text.includes(room.owner!)),
    );
    const copy = parseRunDesign(design);
    copy.floors[0].scene!.rooms[0].furniture[0].props[0].text =
      "Changed only in the parsed copy";
    assert.notDeepEqual(copy, design);
  }
});

test("scene validation rejects unknown commands, bad ownership, unsupported surfaces and invalid poses", () => {
  const design = sceneDesignFixture(),
    base = design.floors[0].scene!;
  const owners = design.roster.map((a) => a.name);
  const cases: [string, (s: SceneFloorDesign) => void, RegExp][] = [
    [
      "script",
      (s) =>
        Object.assign(s.rooms[0].furniture[0].props[0], {
          script: "execute()",
        }),
      /unknown field/,
    ],
    [
      "asset URL",
      (s) =>
        Object.assign(s.rooms[0].furniture[0], {
          asset: "https://example.invalid/model",
        }),
      /unknown field/,
    ],
    [
      "room duplicate",
      (s) => {
        s.rooms[1].room = s.rooms[0].room;
      },
      /room must be unique/,
    ],
    [
      "ID duplicate",
      (s) => {
        s.rooms[1].furniture[0].props[0].id = s.rooms[0].furniture[0].id;
      },
      /unique within this floor/,
    ],
    [
      "owner",
      (s) => {
        s.rooms[0].furniture[0].props[0].owner = "Invented person";
      },
      /roster survivor/,
    ],
    [
      "surface",
      (s) => {
        s.rooms[0].furniture[0].kind = "chair";
      },
      /supported furniture surface/,
    ],
    [
      "furniture position",
      (s) => {
        s.rooms[0].furniture[0].at.x = 1.1;
      },
      /between 0 and 1/,
    ],
    [
      "prop position",
      (s) => {
        s.rooms[0].furniture[0].props[0].at.y = -1.1;
      },
      /between -1 and 1/,
    ],
    [
      "angle",
      (s) => {
        s.rooms[0].furniture[0].angle = Infinity;
      },
      /between -180 and 180/,
    ],
    [
      "scale",
      (s) => {
        s.rooms[0].furniture[0].props[0].scale = 0.1;
      },
      /between 0.65 and 1.25/,
    ],
    [
      "color",
      (s) => {
        s.rooms[0].palette.surface = "url(example)";
      },
      /six-digit hex/,
    ],
    [
      "condition",
      (s) => Object.assign(s.rooms[0], { condition: "toxic" }),
      /kept, worn, ransacked/,
    ],
    [
      "empty scene",
      (s) => {
        s.rooms[0].furniture[0].props = [];
      },
      /at least one authored prop/,
    ],
    [
      "control text",
      (s) => {
        s.rooms[0].description = "line\nbreak";
      },
      /printable/,
    ],
  ];
  for (const [name, change, expected] of cases) {
    const scene = structuredClone(base);
    change(scene);
    assert.throws(() => parseSceneDesign(scene, owners), expected, name);
  }
});

test("scene item budgets reject whole-floor excess even when every individual array fits", () => {
  const design = sceneDesignFixture(),
    owners = design.roster.map((a) => a.name);
  const furniture = structuredClone(design.floors[0].scene!);
  for (const room of furniture.rooms) {
    const first = room.furniture[0];
    room.furniture = Array.from({ length: 5 }, (_, i) => ({
      ...structuredClone(first),
      id: `room-${room.room}-extra-${i}`,
      props: i === 0 ? first.props : [],
    }));
  }
  assert.throws(
    () => parseSceneDesign(furniture, owners),
    /exceeds 16 furniture/,
  );
  const props = structuredClone(design.floors[0].scene!);
  for (const room of props.rooms) {
    const first = room.furniture[0];
    room.furniture = Array.from({ length: 2 }, (_, i) => ({
      ...structuredClone(first),
      id: `room-${room.room}-table-${i}`,
      props: Array.from({ length: 7 }, (_, j) => ({
        ...structuredClone(first.props[0]),
        id: `room-${room.room}-prop-${i}-${j}`,
      })),
    }));
  }
  assert.throws(() => parseSceneDesign(props, owners), /exceeds 48 props/);
});

test("retained version 2 requests require scenes while exact retained version 1 requests still accept version 1", () => {
  const request = parseRunDesignRequest({
    version: 1,
    designVersion: 2,
    requestId: "design-v2",
    generationId: "design-generation",
    seed: 42,
    recent: [],
  });
  const design = sceneDesignFixture();
  assert.deepEqual(
    parseRunDesignReply({ requestId: request.requestId, design }, request)
      .design,
    design,
  );
  assert.throws(
    () =>
      parseRunDesignReply(
        { requestId: request.requestId, design: runDesignFixture() },
        request,
      ),
    /requested design version/,
  );
  const { designVersion: _, ...old } = request;
  assert.throws(
    () => parseRunDesignReply({ requestId: old.requestId, design }, old),
    /requested design version/,
  );
  assert.throws(
    () =>
      parseRunDesignRequest({
        ...request,
        repair: { candidate: runDesignFixture(), errors: ["Fix the room"] },
      }),
    /repair candidate version/,
  );
  assert.throws(
    () => parseRunDesignRequest({ ...request, designVersion: 3 }),
    /designVersion must be 2/,
  );
  const missing = structuredClone(design);
  delete missing.floors[2].scene;
  assert.throws(() => parseRunDesign(missing), /missing a field/);
});

test("scene novelty reflects physical arrangements rather than superficial names or tabletop changes", () => {
  const original = sceneDesignFixture(),
    changed = structuredClone(original);
  changed.title = "A different title";
  changed.premise = "A different premise";
  const room = changed.floors[0].scene!.rooms[0];
  room.title = "New room label";
  room.description = "A different story";
  room.furniture[0].id = "renamed-table";
  room.furniture[0].label = "A different table label";
  room.furniture[0].color = "#eeccaa";
  room.furniture[0].at.x += 0.01;
  room.furniture[0].at.y += 0.01;
  room.furniture[0].angle += 5;
  room.furniture[0].props[0].kind = "bottle";
  room.furniture[0].props[0].at.x = 0.9;
  const recent = [summarizeRunDesign(original)];
  assert.equal(summarizeRunDesign(changed).spatial, recent[0].spatial);
  assert.ok(
    runDesignNoveltyErrors(changed, recent).some((e) =>
      e.includes("arrangement"),
    ),
  );
  room.furniture[0].at.x = 0.8;
  assert.notEqual(summarizeRunDesign(changed).spatial, recent[0].spatial);
  const reordered = structuredClone(original);
  reordered.floors.forEach((f) => {
    f.scene!.rooms.reverse();
  });
  assert.equal(summarizeRunDesign(reordered).spatial, recent[0].spatial);
  const equivalentAngle = structuredClone(original);
  equivalentAngle.floors[0].scene!.rooms[0].furniture[0].angle = -180;
  const positiveAngle = structuredClone(equivalentAngle);
  positiveAngle.floors[0].scene!.rooms[0].furniture[0].angle = 180;
  assert.equal(
    summarizeRunDesign(equivalentAngle).spatial,
    summarizeRunDesign(positiveAngle).spatial,
  );
});

test("scene summaries remain valid recent context with maximum visible room text", () => {
  const design = sceneDesignFixture();
  for (const floor of design.floors)
    for (const room of floor.scene!.rooms) {
      room.title = "界".repeat(40);
      room.description = "界".repeat(160);
    }
  parseRunDesign(design);
  const summary = summarizeRunDesign(design);
  for (const key of ["spatial", "atmosphere", "cast", "tempo"] as const)
    assert.ok(summary[key].length <= 3500);
  const request = {
    version: 1,
    designVersion: 2,
    requestId: "design-history",
    generationId: "design-history",
    seed: 42,
    recent: Array(5).fill(summary),
  };
  assert.deepEqual(parseRunDesignRequest(request), request);
});
