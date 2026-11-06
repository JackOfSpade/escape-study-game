import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Roadmap } from "../src/model";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { previewDesignedRun } from "../src/world";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
const structure = (): any => {
  const { environment: _environment, ...rest } = parseRunDesign(
    JSON.parse(
      readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
    ),
  ) as any;
  return structuredClone(rest);
};

/** Pile identical pieces on one spot in room 0 so the authored scene cannot be
 * realized; every other room keeps a single prop-hosting piece so the floor
 * stays within the contract's furniture limit. */
function overcrowd(s: any, floor: number) {
  const rooms = s.floors[floor].scene.rooms;
  for (const room of rooms)
    room.furniture = [room.furniture.find((o: any) => o.props.length)];
  const room = rooms[0],
    first = room.furniture[0];
  room.furniture = Array.from({ length: 6 }, (_, i) => ({
    ...structuredClone(first),
    id: i ? `crowd-${floor}-${i}` : first.id,
    at: { x: 0.5, y: 0.5 },
    props: i ? [] : first.props,
  }));
  return room.room as number;
}

test("an unmodified designed structure previews without throwing", () => {
  const token = previewDesignedRun(
    42,
    roadmap,
    undefined,
    parseRunStructure(structure()),
  );
  assert.ok(token.surfaces.length > 0);
});

test("problems on two floors are reported together in one error", () => {
  const s = structure();
  const roomA = overcrowd(s, 0),
    roomB = overcrowd(s, 3);
  let message = "";
  assert.throws(
    () => previewDesignedRun(42, roadmap, undefined, parseRunStructure(s)),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      message = error.message;
      return true;
    },
  );
  assert.match(
    message,
    new RegExp(`Authored scene floor 0, room ${roomA}, item`),
  );
  assert.match(
    message,
    new RegExp(`Authored scene floor 3, room ${roomB}, item`),
  );
});
