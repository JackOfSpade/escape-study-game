import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  newAuthoredDesignDraft,
  type LegacyDesignDraft,
  parseDesignDraft,
  prepareDesignedRun,
  clearDesignDraft,
} from "../src/run-designer";
import {
  parseRunDesign,
  parseRunDesignRequest,
  runDesignFingerprint,
  runDesignNoveltyErrors,
  summarizeRunDesign,
} from "../src/run-design-contract.mjs";
import {
  runDesignFixture,
  sceneDesignFixture,
  savedRunDesign,
} from "./helpers/run-design";
import { createPlayableGame } from "../src/world";
import { decode, encode } from "../src/persistence";
import type { Roadmap } from "../src/model";

// These regressions retain the exact v1/v2 single-phase packets. The fresh
// two-phase flow has its own environmental designer suite.
function newDesignDraft(
  targetRunId: string,
  seed: number,
  recent: ReturnType<typeof summarizeRunDesign>[] = [],
): LegacyDesignDraft {
  const modern = newAuthoredDesignDraft(targetRunId, seed, recent, []);
  return {
    version: 1,
    targetRunId,
    request: parseRunDesignRequest({
      version: 1,
      designVersion: 2,
      requestId: modern.request.requestId,
      generationId: modern.request.generationId,
      seed,
      recent,
    }) as LegacyDesignDraft["request"],
  };
}

test("accepted AI design is correlated, fingerprinted and built before activation", async () => {
  const draft = newDesignDraft("synthetic-run", 42, []),
    captured: string[] = [];
  const design = sceneDesignFixture();
  const result = await prepareDesignedRun(draft, {
    signal: new AbortController().signal,
    capture: (d) => {
      captured.push(JSON.stringify(d));
    },
    send: async (request) => ({ requestId: request.requestId, design }),
    build: (seed, saved) => {
      assert.equal(seed, 42);
      assert.equal(saved.source, "claude-cli");
      assert.equal(saved.fingerprint, runDesignFingerprint(design));
      return "validated candidate";
    },
  });
  assert.equal(result.game, "validated candidate");
  assert.equal(captured.length, 1);
  assert.deepEqual(Object.keys(draft.request).sort(), [
    "designVersion",
    "generationId",
    "recent",
    "requestId",
    "seed",
    "version",
  ]);
});

test("retained version 1 drafts resume exactly while version 2 drafts cannot silently downgrade", async () => {
  const retained = newDesignDraft("synthetic-run", 42, []);
  delete retained.request.designVersion;
  const original = JSON.stringify(retained.request);
  const restored = parseDesignDraft(JSON.parse(JSON.stringify(retained)));
  const result = await prepareDesignedRun(restored, {
    signal: new AbortController().signal,
    capture: (draft) => assert.equal(JSON.stringify(draft.request), original),
    send: async (request) => {
      assert.equal(JSON.stringify(request), original);
      return { requestId: request.requestId, design: runDesignFixture() };
    },
    build: (_seed, saved) => saved.design.version,
  });
  assert.equal(result.game, 1);
  await assert.rejects(
    prepareDesignedRun(newDesignDraft("fresh-run", 42, []), {
      signal: new AbortController().signal,
      capture: () => {},
      send: async (request) => ({
        requestId: request.requestId,
        design: runDesignFixture(),
      }),
      build: () => assert.fail("A downgraded reply must never create a world"),
    }),
    /requested design version/,
  );
});

test("seed-only rerolls and reordered object keys do not bypass variety checks", () => {
  const original = runDesignFixture();
  const copy = structuredClone(original);
  copy.title = "A new label";
  copy.premise = "A new description with the same building.";
  copy.floors.forEach((f) => {
    f.layoutSeed += 1;
  });
  copy.footprint.inset = 4;
  copy.footprint.shoulder = 16;
  copy.footprint.mirrored = true;
  copy.footprint = Object.fromEntries(
    Object.entries(copy.footprint).reverse(),
  ) as typeof copy.footprint;
  const recent = [summarizeRunDesign(original)];
  assert.ok(
    runDesignNoveltyErrors(copy, recent).some((e) =>
      e.includes("seed/name alone"),
    ),
  );
  assert.deepEqual(
    runDesignNoveltyErrors(runDesignFixture("glass-orchard"), recent),
    [],
  );
});

test("repetitive candidate requests a bound repair before building", async () => {
  const harbor = sceneDesignFixture(),
    orchard = sceneDesignFixture("observatory-records");
  const draft = newDesignDraft("synthetic-run", 42, [
    summarizeRunDesign(harbor),
  ]);
  const ids: string[] = [];
  let builds = 0;
  const result = await prepareDesignedRun(draft, {
    signal: new AbortController().signal,
    capture: () => {},
    send: async (request) => {
      ids.push(request.requestId);
      if (request.version !== 1)
        assert.fail("Expected retained legacy request");
      if (ids.length === 2) {
        assert.deepEqual(request.repair?.candidate, harbor);
        assert.ok(
          request.repair?.errors.some((e) => e.includes("arrangement")),
        );
      }
      return {
        requestId: request.requestId,
        design: ids.length === 1 ? harbor : orchard,
      };
    },
    build: (_seed, saved) => {
      builds++;
      return saved.design.title;
    },
  });
  assert.equal(builds, 1);
  assert.equal(new Set(ids).size, 2);
  assert.equal(result.game, orchard.title);
});

test("geometry rejection repairs the candidate, with only three calls per attempt", async () => {
  const draft = newDesignDraft("synthetic-run", 42, []),
    initialId = draft.request.requestId;
  const generations: string[] = [],
    ids: string[] = [];
  await assert.rejects(
    prepareDesignedRun(draft, {
      signal: new AbortController().signal,
      capture: () => {},
      send: async (request) => {
        generations.push(request.generationId);
        ids.push(request.requestId);
        if (request.version !== 1)
          assert.fail("Expected retained legacy request");
        if (ids.length > 1)
          assert.match(request.repair!.errors[0], /no terminal route/);
        return { requestId: request.requestId, design: sceneDesignFixture() };
      },
      build: () => {
        throw Error("no terminal route");
      },
    }),
    /three attempts/,
  );
  assert.equal(ids.length, 3);
  assert.equal(new Set(generations).size, 1);
  assert.equal(ids[0], initialId);
  assert.ok(!ids.includes(draft.request.requestId));
  assert.deepEqual(parseDesignDraft(JSON.parse(JSON.stringify(draft))), draft);
});

test("a transport retry reuses the exact captured request and independent chat code", async () => {
  const draft = newDesignDraft("synthetic-run", 42, []),
    before = JSON.stringify(draft);
  let first: unknown;
  await assert.rejects(
    prepareDesignedRun(draft, {
      signal: new AbortController().signal,
      capture: () => {},
      build: () => true,
      send: async (request) => {
        first = structuredClone(request);
        throw Error("relay offline");
      },
    }),
    /relay offline/,
  );
  assert.equal(JSON.stringify(draft), before);
  const restored = parseDesignDraft(JSON.parse(before));
  await prepareDesignedRun(restored, {
    signal: new AbortController().signal,
    capture: () => {},
    build: () => true,
    send: async (request) => {
      assert.deepEqual(request, first);
      return { requestId: request.requestId, design: sceneDesignFixture() };
    },
  });
});

test("cancellation rejects late results before building and failed capture releases nothing", async () => {
  const controller = new AbortController();
  let built = false;
  await assert.rejects(
    prepareDesignedRun(newDesignDraft("synthetic-run", 42, []), {
      signal: controller.signal,
      capture: () => {},
      send: async (request) => {
        controller.abort();
        return { requestId: request.requestId, design: sceneDesignFixture() };
      },
      build: () => {
        built = true;
      },
    }),
    /abort/i,
  );
  assert.equal(built, false);
  let sent = false;
  await assert.rejects(
    prepareDesignedRun(newDesignDraft("synthetic-run", 42, []), {
      signal: new AbortController().signal,
      capture: () => {
        throw Error("storage blocked");
      },
      send: async () => {
        sent = true;
        return {};
      },
      build: () => true,
    }),
    /storage blocked/,
  );
  assert.equal(sent, false);
});

test("design contract rejects unknown fields, malformed arrays and rule-breaking choices", () => {
  assert.throws(
    () => parseRunDesign({ ...runDesignFixture(), learner: {} }),
    /unknown field/,
  );
  const bad = runDesignFixture();
  bad.floors[0].power[2] = "outage";
  assert.throws(() => parseRunDesign(bad), /free study hall lit/);
  const order = runDesignFixture();
  order.floors[0].roomOrder = [1, 1, 3];
  assert.throws(() => parseRunDesign(order), /permutation/);
  const draft = newDesignDraft("synthetic-run", 42, []);
  assert.throws(
    () => parseRunDesignRequest({ ...draft.request, curriculum: {} }),
    /unknown field/,
  );
  assert.throws(
    () =>
      parseRunDesignRequest({
        ...draft.request,
        recent: Array(6).fill(summarizeRunDesign(runDesignFixture())),
      }),
    /0–5/,
  );
});

test("saved immutable floor descriptors are rebound to the validated blueprint without rebuilding geometry", () => {
  const roadmap = JSON.parse(
    readFileSync("public/curriculum.json", "utf8"),
  ) as Roadmap;
  const game = createPlayableGame(42, roadmap, undefined, savedRunDesign());
  const originalTiles = structuredClone(game.floors[0].tiles);
  assert.ok("stories" in game.floors[0].design!);
  assert.ok("streetLabels" in game.floors[0].exteriorDesign!);
  game.floors[0].design!.stories = [];
  game.floors[0].exteriorDesign!.streetLabels = [];
  const restored = decode(encode(game));
  assert.deepEqual(restored.floors[0].tiles, originalTiles);
  assert.deepEqual(
    restored.floors[0].design,
    restored.design!.design.floors[0],
  );
  assert.ok("stories" in restored.floors[0].design!);
  assert.ok("streetLabels" in restored.floors[0].exteriorDesign!);
  assert.equal(restored.floors[0].design!.stories.length, 6);
  assert.equal(restored.floors[0].exteriorDesign!.streetLabels.length, 8);
  restored.design!.fingerprint = "tampered";
  assert.throws(() => decode(encode(restored)), /fingerprint mismatch/);
  delete game.design;
  assert.throws(() => encode(game), /missing its complete accepted run design/);
});

test("explicit cancellation can clear a corrupt design draft without touching other storage", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const stored = new Map([
    ["dead-air-run-design-draft-v1", "{bad"],
    ["dead-air-save-v1", "keep"],
  ]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => stored.get(k) ?? null,
      removeItem: (k: string) => stored.delete(k),
    },
  });
  try {
    clearDesignDraft("synthetic-run");
    assert.equal(stored.has("dead-air-run-design-draft-v1"), false);
    assert.equal(stored.get("dead-air-save-v1"), "keep");
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
