import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseRunStructure } from "../src/run-design-contract.mjs";
import { designReplySchema } from "../src/run-design-schema.mjs";
import { TERMINAL_STYLES, surfaceTop } from "../src/setting-catalog.mjs";
import { schemaErrors } from "./helpers/json-schema";

const radio = JSON.parse(
  readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
);
const { environment, ...structure } = radio;
/** Give every composed part the neutral pose and motion the contract requires. */
const neutralParts = (objects: { parts: object[] }[]) => {
  for (const o of objects)
    o.parts = o.parts.map((p) => ({
      ...p,
      pitch: 0,
      roll: 0,
      motion: "none",
      rate: 1,
    }));
};
const request = (phase: string) => ({
  version: 3,
  phase,
  requestId: "req-1",
});

test("every quality stage has a structured-output schema; legacy requests keep free JSON", () => {
  for (const phase of [
    "concepts",
    "selection",
    "structure",
    "structure-review",
    "content-plan",
    "content-batch",
    "content-review",
    "content-revision",
  ]) {
    const schema = designReplySchema(request(phase));
    assert.equal(schema?.type, "object", phase);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.requestId, { const: "req-1" });
  }
  assert.equal(designReplySchema({ version: 1, requestId: "x" }), undefined);
  assert.equal(
    designReplySchema({ version: 2, phase: "structure" }),
    undefined,
  );
});

test("a valid broadcast structure and its writing fit the stage schemas", () => {
  assert.deepEqual(
    schemaErrors(designReplySchema(request("structure")), {
      requestId: "req-1",
      structure,
    }),
    [],
  );
  assert.deepEqual(
    schemaErrors(designReplySchema(request("content-batch")), {
      requestId: "req-1",
      entries: environment.entries.slice(0, 24),
    }),
    [],
  );
});

test("composed objects in a structure fit the schema and the validator", () => {
  const s = structuredClone(structure);
  s.setting.venue = "custom";
  s.setting.objects = [
    {
      id: "cryo-pod",
      name: "Cryo pod",
      role: "bed",
      weight: "heavy",
      size: { w: 0.9, d: 0.9, h: 2 },
      surface: false,
      parts: [
        {
          shape: "box",
          axis: "up",
          x: 0,
          y: 0,
          z: 0,
          w: 0.9,
          d: 0.9,
          h: 0.2,
          color: "#3a4048",
          finish: "metal",
        },
        {
          shape: "cylinder",
          axis: "up",
          x: 0,
          y: 0,
          z: 0.2,
          w: 0.8,
          d: 0.8,
          h: 1.6,
          color: "#9fd8ff",
          finish: "glass",
        },
        {
          shape: "sphere",
          axis: "up",
          x: 0,
          y: 0,
          z: 1.6,
          w: 0.8,
          d: 0.8,
          h: 0.4,
          color: "#3a4048",
          finish: "metal",
        },
        {
          shape: "box",
          axis: "up",
          x: 0,
          y: 0.42,
          z: 0.6,
          w: 0.3,
          d: 0.05,
          h: 0.12,
          color: "#56f0c8",
          finish: "glow",
        },
      ],
    },
  ];
  neutralParts(s.setting.objects);
  s.setting.filler = {
    reception: ["cryo-pod", "reception"],
    break: ["sofa"],
    cubicles: ["desk"],
    meeting: ["table"],
    storage: ["shelf"],
    manager: ["desk"],
  };
  s.floors[0].scene.rooms[0].furniture.push({
    id: "pod-a",
    kind: "cryo-pod",
    at: { x: 0.8, y: 0.8 },
    angle: 0,
    color: "#3a4048",
    condition: "intact",
    owner: null,
    props: [],
  });
  assert.deepEqual(
    schemaErrors(designReplySchema(request("structure")), {
      requestId: "req-1",
      structure: s,
    }),
    [],
  );
  assert.doesNotThrow(() => parseRunStructure(s));
  // Shape mistakes are caught by the schema before any repair round.
  const bad = structuredClone(s);
  bad.setting.objects[0].parts[0].finish = "chrome";
  delete bad.setting.objects[0].weight;
  const errors = schemaErrors(designReplySchema(request("structure")), {
    requestId: "req-1",
    structure: bad,
  });
  assert.ok(errors.some((e) => /finish not in enum/.test(e)));
  assert.ok(errors.some((e) => /weight is required/.test(e)));
});

test("the validator rejects floating, oversized or unsupported composed objects", () => {
  const base = () => {
    const s = structuredClone(structure);
    s.setting.objects = [
      {
        id: "lamp-post",
        name: "Lamp post",
        role: "light",
        weight: "light",
        size: { w: 0.4, d: 0.4, h: 2 },
        surface: false,
        parts: [
          {
            shape: "cylinder",
            axis: "up",
            x: 0,
            y: 0,
            z: 0,
            w: 0.4,
            d: 0.4,
            h: 0.1,
            color: "#333333",
            finish: "metal",
          },
          {
            shape: "cylinder",
            axis: "up",
            x: 0,
            y: 0,
            z: 0.1,
            w: 0.06,
            d: 0.06,
            h: 1.7,
            color: "#333333",
            finish: "metal",
          },
          {
            shape: "sphere",
            axis: "up",
            x: 0,
            y: 0,
            z: 1.8,
            w: 0.2,
            d: 0.2,
            h: 0.2,
            color: "#ffe9a8",
            finish: "glow",
          },
        ],
      },
    ];
    neutralParts(s.setting.objects);
    return s;
  };
  assert.doesNotThrow(() => parseRunStructure(base()));
  const floating = base();
  floating.setting.objects[0].parts[2].z = 1.9;
  floating.setting.objects[0].parts[2].h = 0.1;
  // A hanging or levitating part is allowed; it is visual only.
  assert.doesNotThrow(() => parseRunStructure(floating));
  const airborne = base();
  airborne.setting.objects[0].parts[0].z = 0.05;
  assert.throws(
    () => parseRunStructure(airborne),
    /at least one part standing on the floor/,
  );
  const outside = base();
  outside.setting.objects[0].parts[0].w = 0.6;
  assert.throws(
    () => parseRunStructure(outside),
    /outside the object's size envelope/,
  );
  const fakeSurface = base();
  fakeSurface.setting.objects[0].surface = true;
  assert.throws(
    () => parseRunStructure(fakeSurface),
    /surface needs a flat-topped/,
  );
  const builtIn = base();
  builtIn.setting.objects[0].id = "desk";
  assert.throws(() => parseRunStructure(builtIn), /built-in furniture name/);
  const props = base();
  props.floors[0].scene.rooms[0].furniture.push({
    id: "lamp-a",
    kind: "lamp-post",
    at: { x: 0.8, y: 0.8 },
    angle: 0,
    color: "#333333",
    condition: "intact",
    owner: null,
    props: [
      {
        id: "lamp-mug",
        kind: "mug",
        at: { x: 0, y: 0 },
        angle: 0,
        scale: 1,
        color: "#ffffff",
        accent: "#000000",
        condition: "intact",
        owner: null,
      },
    ],
  });
  assert.throws(() => parseRunStructure(props), /supported furniture surface/);
  const filler = base();
  filler.setting.venue = "custom";
  filler.setting.filler = {
    reception: ["teleporter"],
    break: ["sofa"],
    cubicles: ["desk"],
    meeting: ["table"],
    storage: ["shelf"],
    manager: ["desk"],
  };
  assert.throws(() => parseRunStructure(filler), /filler.reception\[0\]/);
});

test("object roles, wedge and torus parts, larger sizes and roof objects validate", () => {
  const base = () => {
    const s = structuredClone(structure);
    s.setting.objects = [
      {
        id: "ramp-hall",
        name: "Ramp hall",
        role: "decor",
        weight: "heavy",
        size: { w: 4, d: 3, h: 3.2 },
        surface: false,
        parts: [
          {
            shape: "box",
            axis: "up",
            x: 0,
            y: 0,
            z: 0,
            w: 4,
            d: 3,
            h: 0.2,
            color: "#555555",
            finish: "matte",
          },
          {
            shape: "wedge",
            axis: "across",
            x: -1,
            y: 0,
            z: 0.2,
            w: 2,
            d: 3,
            h: 1,
            color: "#886644",
            finish: "matte",
          },
          {
            shape: "torus",
            axis: "along",
            x: 1,
            y: 0,
            z: 0.2,
            w: 2,
            d: 0.4,
            h: 3,
            color: "#6644aa",
            finish: "glow",
          },
        ],
      },
    ];
    neutralParts(s.setting.objects);
    s.setting.exterior.roofFeatures = [{ kind: "ramp-hall", x: 0.5, y: 0.5 }];
    return s;
  };
  const check = (s: unknown) =>
    schemaErrors(designReplySchema(request("structure")), {
      requestId: "req-1",
      structure: s,
    });
  assert.deepEqual(check(base()), []);
  assert.doesNotThrow(() => parseRunStructure(base()));
  const noRole = base();
  delete noRole.setting.objects[0].role;
  assert.ok(check(noRole).some((e) => /role is required/.test(e)));
  assert.throws(() => parseRunStructure(noRole), /missing a field/);
  const badRole = base();
  badRole.setting.objects[0].role = "throne";
  assert.throws(() => parseRunStructure(badRole), /role must be one of/);
  const unknownRoof = base();
  unknownRoof.setting.exterior.roofFeatures[0].kind = "statue";
  assert.throws(
    () => parseRunStructure(unknownRoof),
    /roofFeatures\[0\]\.kind/,
  );
  const shadow = base();
  shadow.setting.objects[0].id = "mast";
  shadow.setting.exterior.roofFeatures = [];
  assert.throws(() => parseRunStructure(shadow), /roof feature name/);
  const tooBig = base();
  tooBig.setting.objects[0].size.w = 4.5;
  assert.throws(() => parseRunStructure(tooBig), /size\.w/);
});

test("wedges and tori never count as a prop surface", () => {
  const part = (shape: string, axis = "up") => ({
    shape,
    axis,
    x: 0,
    y: 0,
    z: 0,
    w: 1,
    d: 1,
    h: 0.5,
    color: "#808080",
    finish: "matte",
    pitch: 0,
    roll: 0,
    motion: "none",
    rate: 1,
  });
  for (const shape of ["wedge", "torus"])
    assert.equal(
      surfaceTop({
        size: { w: 1, d: 1, h: 0.5 },
        parts: [part(shape)],
      } as never),
      null,
      shape,
    );
  assert.equal(
    surfaceTop({
      size: { w: 1, d: 1, h: 0.5 },
      parts: [part("box")],
    } as never),
    0.5,
  );
});

test("the structure schema requires the terminal and accepts every style only", () => {
  const schema = designReplySchema(request("structure"));
  for (const style of TERMINAL_STYLES) {
    const s = structuredClone(structure);
    s.setting.terminal.style = style;
    assert.deepEqual(
      schemaErrors(schema, { requestId: "req-1", structure: s }),
      [],
      style,
    );
  }
  const unknown = structuredClone(structure);
  unknown.setting.terminal.style = "throne";
  assert.notDeepEqual(
    schemaErrors(schema, { requestId: "req-1", structure: unknown }),
    [],
  );
  const missing = structuredClone(structure);
  delete missing.setting.terminal;
  assert.notDeepEqual(
    schemaErrors(schema, { requestId: "req-1", structure: missing }),
    [],
  );
});
