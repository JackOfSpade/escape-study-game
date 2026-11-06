import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { InstancedMesh, Matrix4 } from "three";
import { propWorldPose, sceneSaveErrors } from "../src/authored-scene";
import { propSurfaceFace } from "../src/environment-faces";
import { fnv1a } from "../src/hash";
import type { Game, Roadmap } from "../src/model";
import { decode, encode } from "../src/persistence";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { partReach } from "../src/setting-catalog.mjs";
import { finalizeDesignedRun, previewDesignedRun } from "../src/world";
import { AuthoredScene } from "../src/view3d/authored-scene";
import { InteriorLightmap } from "../src/view3d/interior-lightmap";
import { savedRunDesign } from "./helpers/run-design";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
type Part = Record<string, unknown>;
const part = (
  shape: string,
  [x, y, z]: [number, number, number],
  [w, d, h]: [number, number, number],
  color: string,
  extra: Part = {},
): Part => ({
  shape,
  axis: "up",
  x,
  y,
  z,
  w,
  d,
  h,
  color,
  finish: "matte",
  pitch: 0,
  roll: 0,
  motion: "none",
  rate: 1,
  ...extra,
});
const LANTERN = {
  id: "lantern-jar",
  name: "Jar lantern",
  size: { w: 0.2, d: 0.2, h: 0.3 },
  parts: [
    part("box", [0, 0, 0], [0.2, 0.2, 0.02], "#4a3a2a"),
    // The largest solid, level, still box: an upright plaque.
    part("box", [0, 0, 0.02], [0.18, 0.06, 0.2], "#8a9a7a"),
    part("sphere", [0.06, 0, 0.22], [0.06, 0.06, 0.06], "#ffcc66", {
      finish: "glow",
      motion: "flicker",
      rate: 2,
    }),
    part("cylinder", [0, 0, 0.26], [0.08, 0.08, 0.04], "#aaaaaa", {
      motion: "spin",
      rate: 1,
    }),
    part("cylinder", [-0.07, 0.05, 0.2], [0.04, 0.04, 0.04], "#66ccff", {
      finish: "glass",
      motion: "bob",
      rate: 1,
    }),
    part("box", [0.07, 0.07, 0.1], [0.05, 0.02, 0.1], "#cc6644", {
      pitch: 15,
    }),
  ],
};
const FLAT = {
  id: "flat-chip",
  name: "Chip",
  size: { w: 0.1, d: 0.1, h: 0.1 },
  parts: [
    part("sphere", [0, 0, 0], [0.1, 0.1, 0.1], "#999999", {
      finish: "glow",
    }),
  ],
};
const words = (n: number) =>
  [n, n * 7 + 3, n * 13 + 5]
    .map((v) => "x" + v.toString(26).replace(/[0-9]/g, (d) => "qrstuvwxyz"[+d]))
    .join(" ");

function structure(props: unknown[] = [LANTERN]) {
  const { environment: _environment, ...d } = JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  );
  d.setting = { ...d.setting, props: structuredClone(props) };
  const phone = d.floors[0].scene.rooms[0].furniture[0].props[0];
  phone.kind = LANTERN.id;
  phone.scale = 1;
  return parseRunStructure(d);
}
function accept(s: ReturnType<typeof structure>, seed: number) {
  const token = previewDesignedRun(seed, roadmap, undefined, s),
    environment = {
      version: 1,
      surfaceFingerprint: token.surfaceFingerprint,
      surfaces: token.surfaces,
      fragments: [],
      entries: token.surfaces.map((surface, i) =>
        surface.maxTitle || surface.maxBody
          ? {
              surfaceId: surface.id,
              layout: "text",
              title: surface.maxTitle ? [{ text: words(i) }] : [],
              body: surface.maxTitle ? [] : [{ text: words(i) }],
              description: "",
              drawing: null,
            }
          : {
              surfaceId: surface.id,
              layout: "art",
              title: [],
              body: [],
              description: `Disc ${words(i)}`,
              drawing: {
                version: 1,
                background: "#e9e1cc",
                primitives: [
                  {
                    kind: "ellipse",
                    x: 0.15,
                    y: 0.15,
                    w: 0.7,
                    h: 0.7,
                    rotation: 0,
                    fill: "#1b1b1b",
                    stroke: "#20262b",
                    width: 0.012 + i / 100000,
                    opacity: 1,
                  },
                ],
              },
            },
      ),
    };
  return {
    token,
    saved: savedRunDesign(parseRunDesign({ ...s, environment })),
  };
}
const world = () => {
  const { token, saved } = accept(structure(), 3);
  return finalizeDesignedRun(token, saved);
};
const composed = (g: Game) =>
  g.floors.flatMap((f) => f.scene?.props ?? []).filter((p) => p.object);
const matrices = (mesh: InstancedMesh) =>
  Array.from({ length: mesh.count }, (_, i) => {
    const m = new Matrix4();
    mesh.getMatrixAt(i, m);
    return m.elements.slice();
  });

test("a scene prop naming a setting.props id is built from its envelope and validates", () => {
  const g = world(),
    props = composed(g);
  assert.equal(props.length, 1);
  const [p] = props;
  assert.equal(p.kind, "lantern-jar");
  assert.deepEqual(p.object, LANTERN);
  assert.ok(Math.abs(p.w - 0.2) < 1e-9 && Math.abs(p.h - 0.3) < 1e-9);
  for (const f of g.floors) assert.deepEqual(sceneSaveErrors(f), []);
  assert.ok(propWorldPose(g.floors[0], p));
  // Built-in props beside it carry no recipe.
  const others = g.floors[0].scene!.props.filter((q) => q !== p);
  assert.ok(others.length > 0 && others.every((q) => !("object" in q)));
  // Every pose of every part stays inside the envelope the prop packs with.
  for (const part of p.object!.parts) {
    const r = partReach(part as never);
    assert.ok(r.z + r.h <= p.object!.size.h + 1e-6);
  }
});

test("a composed prop's recipe is rebound from the design on load and unknown ids are rejected", () => {
  const g = world(),
    text = encode(g),
    again = (mutate: (game: Game) => void) => {
      const game = JSON.parse(
        (JSON.parse(text) as { payload: string }).payload,
      ) as Game;
      mutate(game);
      const payload = JSON.stringify(game);
      return JSON.stringify({ schema: 1, payload, checksum: fnv1a(payload) });
    };
  const clean = decode(text);
  assert.deepEqual(composed(clean)[0].object, LANTERN);
  const tampered = decode(
    again((game) => {
      const p = composed(game)[0];
      p.object!.parts = [];
      p.object!.size = { w: 3, d: 3, h: 3 };
    }),
  );
  assert.deepEqual(composed(tampered)[0].object, LANTERN);
  assert.throws(
    () =>
      decode(
        again((game) => {
          composed(game)[0].kind = "ghost-prop";
        }),
      ),
    /not in the run design/,
  );
  // A tampered footprint is caught by the scene check.
  assert.throws(() =>
    decode(
      again((game) => {
        composed(game)[0].w = 0.05;
      }),
    ),
  );
});

test("a composed prop reads on the front of its upright plaque, or the top of its envelope", () => {
  const g = world(),
    [p] = composed(g),
    face = propSurfaceFace(p);
  assert.equal(face.pitch, 0);
  assert.ok(Math.abs(face.y - 0.03) < 0.01 && face.z > 0.1 && face.z < 0.2);
  assert.ok(face.width > 0.1);
  const flat = structuredClone(p);
  flat.object = structuredClone(FLAT) as never;
  const fallback = propSurfaceFace(flat);
  assert.equal(fallback.pitch, -Math.PI / 2);
  assert.ok(fallback.z > flat.h);
  // A built-in prop keeps its own face.
  const builtin = g.floors[0].scene!.props.find((q) => !q.object)!;
  assert.ok(propSurfaceFace(builtin).width > 0);
});

test("composed props render their parts, tilted and moving, without touching game state", () => {
  const g = world(),
    floor = g.floors[0],
    snapshot = JSON.stringify(g),
    scene = new AuthoredScene(floor, new InteriorLightmap()),
    meshes = scene.group.children.filter(
      (n) => n instanceof InstancedMesh,
    ) as InstancedMesh[],
    named = (key: string) =>
      meshes.find((m) => m.name.endsWith(key)) as InstancedMesh;
  assert.ok(named("composed-box-up-matte").count >= 3);
  assert.ok(named("composed-sphere-up-glow").count === 1);
  assert.ok(named("composed-cylinder-up-glass").count === 1);
  assert.ok(named("composed-cylinder-up-matte").count === 1);
  scene.sync(0, false);
  const spin = matrices(named("composed-cylinder-up-matte")),
    bob = matrices(named("composed-cylinder-up-glass")),
    still = matrices(named("composed-box-up-matte"));
  scene.sync(0.3, false);
  assert.notDeepEqual(matrices(named("composed-cylinder-up-matte")), spin);
  assert.notDeepEqual(matrices(named("composed-cylinder-up-glass")), bob);
  assert.deepEqual(matrices(named("composed-box-up-matte")), still);
  // Bob stays within MOTION_LIMITS.bob of rest.
  for (const t of [0, 0.1, 0.25, 0.5, 0.75]) {
    scene.sync(t, false);
    const y = matrices(named("composed-cylinder-up-glass"))[0][13];
    assert.ok(y >= bob[0][13] - 0.0601 - 1e-6 && y <= bob[0][13] + 0.0601);
  }
  assert.equal(JSON.stringify(g), snapshot);
  scene.dispose();
});

test("a run without composed props builds exactly the same meshes as before", () => {
  const { environment: _environment, ...d } = JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  );
  const { token, saved } = accept(parseRunStructure(d), 3),
    g = finalizeDesignedRun(token, saved),
    scene = new AuthoredScene(g.floors[0], new InteriorLightmap());
  assert.equal(composed(g).length, 0);
  assert.ok(
    scene.group.children.every(
      (n) => !n.name.startsWith("authored-scene-composed"),
    ),
  );
  assert.equal(
    scene.group.userData.drawCallBudget,
    g.floors[0].environment ? 4 : 5,
  );
  scene.dispose();
});
