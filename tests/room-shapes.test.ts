import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inFurniture } from "../src/spatial";
import { carvedCells, cornerCells, cornerProfile } from "../src/room-shapes";
import { furnishingErrors } from "../src/office-layout";
import { pursuitLayoutErrors } from "../src/pursuit-layout";
import { type Floor, type Game, type Roadmap, H, W } from "../src/model";
import { decode, encode } from "../src/persistence";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { cornerWallGeometry } from "../src/view3d/corner-walls";
import { finalizeDesignedRun, previewDesignedRun } from "../src/world";
import { savedRunDesign } from "./helpers/run-design";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
type Shape = "rect" | "chamfered" | "rounded" | "octagon";
const STRUCTURES = ["radio-broadcast", "mars-habitat"] as const;

/** Distinct letters-only phrases (the contract rejects similar writing). */
const words = (n: number) =>
  [n, n * 7 + 3, n * 13 + 5]
    .map((v) => "x" + v.toString(26).replace(/[0-9]/g, (d) => "qrstuvwxyz"[+d]))
    .join(" ");
/** A fixture structure with the given shapes on every floor, fully accepted
 * with plain environment entries so it can be finalised for any seed. */
function build(
  name: (typeof STRUCTURES)[number],
  seed: number,
  shapes?: Shape[],
) {
  const { environment: _environment, ...json } = JSON.parse(
    readFileSync(`tests/fixtures/run-designs/${name}.json`, "utf8"),
  );
  for (const floor of json.floors) {
    delete floor.roomShapes;
    if (shapes) floor.roomShapes = shapes;
  }
  const structure = parseRunStructure(json),
    token = previewDesignedRun(seed, roadmap, undefined, structure),
    environment = {
      version: 1,
      surfaceFingerprint: token.surfaceFingerprint,
      surfaces: token.surfaces,
      fragments: [],
      entries: token.surfaces.map((s, i) =>
        s.maxTitle || s.maxBody
          ? {
              surfaceId: s.id,
              layout: "text",
              title: s.maxTitle ? [{ text: words(i) }] : [],
              body: s.maxTitle ? [] : [{ text: words(i) }],
              description: "",
              drawing: null,
            }
          : {
              surfaceId: s.id,
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
  return finalizeDesignedRun(
    token,
    savedRunDesign(parseRunDesign({ ...structure, environment })),
  );
}
const study = (g: Game) => g.floors.slice(0, 4);
const carved = (f: Floor) => f.generation?.corners ?? [];

function reachableCells(f: Floor, from: { x: number; y: number }) {
  const seen = new Set<number>(),
    queue = [{ x: Math.floor(from.x), y: Math.floor(from.y) }];
  for (let i = 0; i < queue.length; i++) {
    const { x, y } = queue[i],
      k = y * W + x;
    if (x < 0 || y < 0 || x >= W || y >= H || seen.has(k) || f.tiles[y][x])
      continue;
    seen.add(k);
    queue.push(
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 },
    );
  }
  return seen;
}

test("corner geometry: staircases, profiles and cells agree", () => {
  const chamfer = {
    x: 5,
    y: 7,
    sx: 1 as const,
    sy: -1 as const,
    style: "chamfered" as const,
    size: 2,
    room: 0,
  };
  assert.deepEqual(
    cornerCells(chamfer).map((c) => `${c.x},${c.y}`),
    ["5,7", "6,7", "5,6"],
  );
  const profile = cornerProfile(chamfer);
  assert.equal(profile.length, 3);
  assert.deepEqual(profile[0], { x: 5, y: 8 });
  assert.deepEqual(profile[1], { x: 7.5, y: 8 });
  assert.deepEqual(profile[2], { x: 5, y: 5.5 });
  const round = cornerCells({ ...chamfer, style: "rounded", size: 5 });
  assert.equal(round.length, 5);
  assert.ok(
    cornerProfile({ ...chamfer, style: "rounded", size: 5 }).length > 8,
  );
  assert.equal(
    cornerCells({ ...chamfer, style: "rounded", size: 1 }).length,
    0,
  );
});

test("absent roomShapes carves nothing and leaves tiles identical", () => {
  for (const name of STRUCTURES) {
    for (const seed of [3, 11]) {
      const plain = build(name, seed),
        rect = build(name, seed, ["rect", "rect", "rect", "rect"]);
      for (const f of study(plain)) assert.equal(carved(f).length, 0);
      for (const f of study(rect)) assert.equal(carved(f).length, 0);
      assert.deepEqual(
        rect.floors.map((f) => f.tiles),
        plain.floors.map((f) => f.tiles),
      );
    }
  }
});

for (const shape of ["chamfered", "rounded", "octagon"] as const) {
  test(`${shape} rooms carve corners, stay valid and reachable (radio and mars, several seeds)`, () => {
    let total = 0;
    for (const name of STRUCTURES)
      for (const seed of [2, 7, 19]) {
        const plain = build(name, seed),
          g = build(name, seed, [shape, shape, shape, shape]);
        for (const f of study(g)) {
          assert.deepEqual(
            pursuitLayoutErrors(g, f),
            [],
            `${name}/${seed}/${f.index}`,
          );
          assert.deepEqual(furnishingErrors(f), []);
          const before = plain.floors[f.index].tiles;
          let changed = 0;
          for (let y = 0; y < H; y++)
            for (let x = 0; x < W; x++)
              if (f.tiles[y][x] !== before[y][x]) changed++;
          // Same planned floor, only extra solid cells where corners are recorded.
          const cells = carvedCells(f);
          total += cells.length;
          for (const c of cells) assert.equal(f.tiles[c.y][c.x], 1);
          for (const corner of carved(f)) assert.equal(corner.style, shape);
          // Every terminal and the stairs stay reachable from the entry.
          const seen = reachableCells(f, f.entry);
          for (const s of f.stations)
            assert.ok(seen.has(Math.floor(s.y) * W + Math.floor(s.x)), s.id);
          assert.ok(
            seen.has(Math.floor(f.stairs.y) * W + Math.floor(f.stairs.x)),
          );
          // No furniture stands on a carved cell.
          for (const c of cells)
            for (const o of f.furniture)
              if (!o.field && o.kind !== "door")
                assert.ok(!inFurniture({ x: c.x + 0.5, y: c.y + 0.5 }, o));
        }
      }
    assert.ok(total > 0, `${shape} carved nothing`);
  });
}

test("mixed shapes follow their study room and survive a save", () => {
  const g = build("radio-broadcast", 5, [
    "rect",
    "chamfered",
    "rounded",
    "octagon",
  ]);
  for (const f of study(g)) {
    for (const c of carved(f)) assert.ok(c.room !== 0);
    const styles = new Set(carved(f).map((c) => `${c.room}:${c.style}`));
    for (const s of styles)
      assert.ok(["1:chamfered", "2:rounded", "3:octagon"].includes(s), s);
  }
  const copy = decode(encode(g));
  for (const f of study(copy))
    assert.deepEqual(f.generation?.corners, carved(g.floors[f.index]));
});

test("corner wall geometry faces the room and caps upward", () => {
  for (const style of ["chamfered", "rounded", "octagon"] as const)
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as const) {
      const corner = {
        x: 10,
        y: 10,
        sx,
        sy,
        style,
        size: style === "rounded" ? 4 : 2,
        room: 1,
      };
      const g = cornerWallGeometry(corner),
        pos = g.getAttribute("position"),
        nor = g.getAttribute("normal"),
        index = g.getIndex()!;
      assert.ok(index.count > 0 && index.count % 3 === 0);
      for (let t = 0; t < index.count; t += 3) {
        const [a, b, c] = [0, 1, 2].map((k) => index.getX(t + k));
        const p = [a, b, c].map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
        const e1 = p[1].map((v, k) => v - p[0][k]),
          e2 = p[2].map((v, k) => v - p[0][k]);
        const n = [
          e1[1] * e2[2] - e1[2] * e2[1],
          e1[2] * e2[0] - e1[0] * e2[2],
          e1[0] * e2[1] - e1[1] * e2[0],
        ];
        const stored = [nor.getX(a), nor.getY(a), nor.getZ(a)];
        assert.ok(
          n[0] * stored[0] + n[1] * stored[1] + n[2] * stored[2] > 0,
          `${style} ${sx},${sy} triangle ${t / 3} winds against its normal`,
        );
        // Side faces look into the room.
        if (stored[1] === 0)
          assert.ok(stored[0] * sx + stored[2] * sy > 0, "side faces the room");
      }
    }
});
