import assert from "node:assert/strict";
import test from "node:test";
import { fallbackCatastrophe } from "../src/catastrophe";
import {
  createEscapeState,
  isEscapeState,
  loopReset,
} from "../src/escape-state";
import type { EscapeState } from "../src/escape-types";
import type { Game } from "../src/model";
import { drawVoiceIdentity } from "../src/voice-identity";

/** Only the fields escape-state reads, so the tests stay about this module. */
function fakeGame(overrides: Record<string, unknown> = {}): Game {
  return {
    seed: 1234,
    survivors: [{ name: "Ada Reyes", role: "flight engineer" }],
    design: {
      design: {
        title: "Kestrel Station",
        premise: "A mining station is going quiet.",
        opening: "You arrive on the last supply run.",
      },
    },
    ...overrides,
  } as unknown as Game;
}

test("createEscapeState fills every default from the human and the design", () => {
  const game = fakeGame();
  const escape = createEscapeState(game, { gender: "female", seed: 77 });

  assert.equal(escape.version, 1);
  assert.deepEqual(escape.persona, {
    name: "Ada Reyes",
    role: "flight engineer",
    backstory:
      "You arrive on the last supply run. A mining station is going quiet.",
  });
  assert.deepEqual(escape.catastrophe, fallbackCatastrophe(77, "start"));
  assert.deepEqual(escape.ledger, { facts: [], journal: [], seq: 0 });
  assert.deepEqual(escape.tasks, []);
  assert.deepEqual(escape.areas, {
    start: "start",
    current: "start",
    areas: {
      start: {
        id: "start",
        name: "Kestrel Station",
        brief: "A mining station is going quiet.",
        state: "ready",
        seed: 77,
      },
    },
    portals: [],
  });
  assert.deepEqual(escape.voices, drawVoiceIdentity("female", 77));
  assert.equal(escape.voices.playerGender, "female");
  assert.deepEqual(escape.announcements, []);
  assert.equal(escape.loop, 0);
  assert.deepEqual(escape.log, []);
  assert.deepEqual(escape.prompts, []);
  assert.deepEqual(escape.areaStore, {});
  assert.deepEqual(escape.roomPower, {});
  assert.equal(escape.epilogue, undefined);
});

test("createEscapeState falls back to a generic persona and area without a design", () => {
  const game = fakeGame({ design: undefined });
  const escape = createEscapeState(game, { gender: "male", seed: 3 });
  assert.equal(escape.persona.name, "Ada Reyes");
  assert.equal(escape.persona.role, "flight engineer");
  assert.ok(escape.persona.backstory.length > 20);
  assert.equal(escape.areas.areas.start.name, "the building");
  assert.equal(escape.areas.areas.start.seed, 3);
  assert.equal(escape.voices.playerGender, "male");
});

test("loopReset keeps the plan, the knowledge, the voices and the epilogue", () => {
  const game = fakeGame();
  const first = createEscapeState(game, { gender: "female", seed: 9 });
  first.loop = 0;
  first.ledger.facts.push({
    id: "f1",
    text: "The hatch needs a flight-crew badge.",
    subject: { kind: "object", id: "hatch" },
    source: "director",
    visibility: ["public"],
    at: 12,
  });
  first.ledger.journal.push({
    factId: "f1",
    line: "Hatch: flight-crew badge",
    learnedAt: 12,
    via: "attempt",
  });
  first.tasks.push({
    id: "t1",
    title: "Loosen the hatch bolts",
    unit: "bolts",
    steps: 4,
    done: 3,
    objectId: "hatch",
    areaId: "start",
    fromFacts: ["f1"],
    state: "in-progress",
  });
  first.tasks.push({
    id: "t2",
    title: "Restore the radio",
    unit: "wires",
    steps: 2,
    done: 0,
    objectId: "radio",
    areaId: "start",
    fromFacts: [],
    state: "abandoned",
  });
  first.areas.current = "start";
  first.areas.areas.start.plan = {
    name: "Kestrel",
    premise: "mined out",
    rooms: [],
    people: [],
  };
  first.areas.areas.annex = {
    id: "annex",
    name: "Annex",
    brief: "a side room",
    state: "ready",
    seed: 5,
  };
  first.areas.portals.push({
    id: "p1",
    from: "start",
    to: "annex",
    transition: "door",
    at: { floor: 0, x: 2, y: 2 },
    label: "annex door",
  });
  first.areas.current = "annex";
  first.announcements.push({
    id: "a1",
    at: 3,
    kind: "routine",
    text: "Weather is fine.",
    areaId: "start",
  });
  first.log.push({ at: 4, kind: "phase", areaId: "start", text: "It begins." });
  first.prompts.push({ npcId: "npc-1", reason: "greet", at: 5 });
  first.roomPower["0:control"] = "outage";
  first.areaStore.annex = {
    game: {} as never,
    parkedAt: 6,
  };
  first.epilogue = { loop: 0, text: "The station fell.", writtenAt: 7 };

  const second = loopReset(first);

  assert.equal(second.loop, 1);
  assert.deepEqual(second.persona, first.persona);
  assert.deepEqual(second.catastrophe, first.catastrophe);
  assert.deepEqual(second.ledger, first.ledger);
  assert.deepEqual(second.voices, first.voices);
  assert.notEqual(second.voices, first.voices);
  assert.deepEqual(second.epilogue, {
    loop: 0,
    text: "The station fell.",
    writtenAt: 7,
  });
  assert.deepEqual(second.areas.areas, first.areas.areas);
  assert.deepEqual(second.areas.portals, first.areas.portals);
  assert.equal(second.areas.start, "start");
  assert.equal(second.areas.current, "start");
  assert.deepEqual(
    second.tasks.map((t) => [t.id, t.done, t.state]),
    [
      ["t1", 0, "available"],
      ["t2", 0, "abandoned"],
    ],
  );
  assert.deepEqual(second.log, []);
  assert.deepEqual(second.announcements, []);
  assert.deepEqual(second.prompts, []);
  assert.deepEqual(second.roomPower, {});
  assert.deepEqual(second.areaStore, {});
  // The previous state is left as it was.
  assert.equal(first.areas.current, "annex");
  assert.equal(first.log.length, 1);
  assert.equal(first.tasks[0]!.done, 3);
  assert.equal(first.tasks[0]!.state, "in-progress");
  assert.equal(first.roomPower["0:control"], "outage");
});

test("isEscapeState accepts a created state and rejects broken shapes", () => {
  const escape = createEscapeState(fakeGame(), { gender: "male", seed: 21 });
  assert.equal(isEscapeState(escape), true);
  assert.equal(isEscapeState(null), false);
  assert.equal(isEscapeState(undefined), false);
  assert.equal(isEscapeState("escape"), false);
  assert.equal(isEscapeState([]), false);
  assert.equal(isEscapeState({}), false);
  assert.equal(isEscapeState({ ...escape, version: 2 }), false);
  const without = (key: keyof EscapeState) => {
    const copy: Record<string, unknown> = {
      ...(escape as unknown as Record<string, unknown>),
    };
    delete copy[key];
    return copy;
  };
  assert.equal(isEscapeState(without("tasks")), false);
  assert.equal(isEscapeState(without("voices")), false);
  assert.equal(isEscapeState(without("areas")), false);
  assert.equal(
    isEscapeState({ ...escape, ledger: { facts: [], journal: [] } }),
    false,
  );
});
