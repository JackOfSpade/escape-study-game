/**
 * Phase 4 of the continuous world (docs/ESCAPE_REDESIGN.md section 16): near
 * places are buildings stamped into the same world, far places are regions
 * reached at the world edge, and nothing is entered through a portal.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  enterRegion,
  exitSiteReached,
  regionEdgeCrossed,
  registerArea,
  restampSites,
  setAreaDesigner,
  setAreaFactory,
  setDesignedAreaFactory,
  siteLoadingDue,
  stampReadySites,
  takeAreaSwitch,
} from "../src/areas";
import { setDirectorRequest } from "../src/escape-runtime";
import { escapeInteract } from "../src/director";
import { createEscapeState, loopReset } from "../src/escape-state";
import type { AreaStub, EscapeState } from "../src/escape-types";
import type { Game, Roadmap } from "../src/model";
import type { SavedRunDesign } from "../src/run-design-contract.mjs";
import { floorCols } from "../src/site";
import { nextSiteOrigin } from "../src/site-stamp";
import { createPlayableGame } from "../src/world";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);

/** A real playable world with the escape director attached. */
function world(seed = 5150): { g: Game; escape: EscapeState } {
  // A live fresh run builds version 5 office plans with city bounds and a
  // building footprint, which is what a stamped site needs.
  const g = createPlayableGame(seed, roadmap);
  const escape = createEscapeState(g, { gender: "male", seed });
  g.escape = escape;
  g.time = 0;
  return { g, escape };
}

/** The seed-only factory: the world generator stands in for real buildings. */
const seedFactory = (seed: number): Game => createPlayableGame(seed, roadmap);

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise((done) => setTimeout(done, 0));
};

/** Answer the next engagement with one area, then let the director commit it. */
function answerWith(area: Record<string, unknown>): Promise<void> {
  setDirectorRequest(async (operation: string) => {
    if (operation === "escape-engage")
      return { requestId: "engage-answer", area };
    if (operation === "escape-intent")
      return { requestId: "intent-answer", goals: [] };
    return { requestId: "other-answer" };
  });
  return Promise.resolve();
}

async function discover(g: Game, area: Record<string, unknown>): Promise<void> {
  await answerWith(area);
  escapeInteract(g, { kind: "read", subjectId: "lift-panel", label: "Panel" });
  await settle();
}

function onlySite(escape: EscapeState): AreaStub {
  const sites = Object.values(escape.areas.areas).filter(
    (stub) => stub.kind === "site",
  );
  assert.equal(sites.length, 1, "exactly one site stub");
  return sites[0]!;
}

const humanOf = (g: Game) => g.survivors.find((actor) => actor.id === "human")!;

test("a near area answer registers a site stub east of the start with no portal", async () => {
  setAreaDesigner(undefined);
  const { g, escape } = world();
  const eastOfStart = nextSiteOrigin(g).x;
  await discover(g, {
    name: "Deck Seven",
    brief: "A service deck.",
    transition: "lift",
  });
  const site = onlySite(escape);
  assert.equal(site.name, "Deck Seven");
  assert.equal(site.kind, "site");
  // A near place is a building next door, not a way through anything.
  assert.ok(site.origin, "the site has a plot");
  assert.equal(site.origin!.x, eastOfStart);
  assert.ok(site.origin!.x > 0, "east of the start building");
  assert.equal(escape.areas.portals.length, 0, "sites carry no portal record");
});

test("two near answers get non-overlapping plots", async () => {
  setAreaDesigner(undefined);
  const { g, escape } = world();
  await discover(g, {
    name: "Deck Seven",
    brief: "A service deck.",
    transition: "lift",
  });
  await discover(g, {
    name: "Deck Eight",
    brief: "A galley deck.",
    transition: "door",
  });
  const sites = Object.values(escape.areas.areas).filter(
    (stub) => stub.kind === "site",
  );
  assert.equal(sites.length, 2);
  const [first, second] = sites.sort((a, z) => a.origin!.x - z.origin!.x);
  // A site is assumed to need 44 x 34 tiles, so the next plot starts past it.
  assert.ok(
    second!.origin!.x >= first!.origin!.x + 44,
    `${second!.origin!.x} starts past ${first!.origin!.x} + 44`,
  );
  assert.equal(second!.origin!.y, first!.origin!.y);
});

test("stampReadySites stamps a designed site at its origin, once", async () => {
  setAreaDesigner(undefined);
  setAreaFactory(seedFactory);
  setDesignedAreaFactory(seedFactory);
  const { g, escape } = world();
  await discover(g, {
    name: "Deck Seven",
    brief: "A service deck.",
    transition: "lift",
  });
  const site = onlySite(escape);
  // A saved design is what prefetchArea stores on the stub in real play.
  site.design = { areas: [] } as unknown as SavedRunDesign;
  const before = floorCols(g.floors[0]!);
  const stamped = stampReadySites(g);
  assert.deepEqual(stamped, [site.id]);
  const shared = (g.sites ?? []).find((entry) => entry.id === site.id);
  assert.ok(shared, "the shared world gained the building");
  assert.deepEqual(shared!.origin, site.origin);
  assert.equal(site.stamped, true);
  assert.ok(
    floorCols(g.floors[0]!) > before,
    "the shared ground floor grew to hold the building",
  );
  // Stamping twice must not add the building again.
  assert.deepEqual(stampReadySites(g), []);
  assert.equal(
    (g.sites ?? []).filter((entry) => entry.id === site.id).length,
    1,
  );
});

test("siteLoadingDue needs a loading screen on an unstamped plot until it is stamped", async () => {
  setAreaDesigner(undefined);
  setAreaFactory(seedFactory);
  const { g, escape } = world();
  await discover(g, {
    name: "Deck Seven",
    brief: "A service deck.",
    transition: "lift",
  });
  const site = onlySite(escape);
  const human = humanOf(g);
  human.floor = 0;
  human.x = 0;
  human.y = 0;
  assert.equal(siteLoadingDue(g), undefined, "nobody is near the plot");
  human.x = site.origin!.x + 20;
  human.y = site.origin!.y + 10;
  assert.equal(siteLoadingDue(g)?.id, site.id);
  stampReadySites(g);
  assert.equal(siteLoadingDue(g), undefined, "the building is there now");
});

test("restampSites rebuilds the same site at the same origin after a restart", async () => {
  setAreaDesigner(undefined);
  setAreaFactory(seedFactory);
  const { g, escape } = world(5151);
  await discover(g, {
    name: "Deck Seven",
    brief: "A service deck.",
    transition: "lift",
  });
  const site = onlySite(escape);
  assert.deepEqual(stampReadySites(g), [site.id]);
  const origin = { ...site.origin! };
  // Restart: a fresh world plus loopReset keeps the stubs and their flags.
  const restarted = createPlayableGame(5151, roadmap);
  restarted.escape = loopReset(escape);
  restarted.time = 0;
  assert.equal((restarted.sites ?? []).length, 0, "the fresh world is bare");
  assert.deepEqual(restampSites(restarted), [site.id]);
  const shared = (restarted.sites ?? []).find((entry) => entry.id === site.id);
  assert.ok(shared);
  assert.deepEqual(shared!.origin, origin);
  assert.equal(restarted.escape.areas.areas[site.id]!.stamped, true);
});

test("a far area answer is a region reached at the world edge", async () => {
  setAreaDesigner(undefined);
  const { g, escape } = world();
  await discover(g, {
    name: "Frost ridge",
    brief: "Two days out across the ice.",
    transition: "vehicle",
    distance: "far",
  });
  const regions = Object.values(escape.areas.areas).filter(
    (stub) => stub.kind === "region",
  );
  assert.equal(regions.length, 1);
  const region = regions[0]!;
  assert.equal(region.origin, undefined, "a region has no plot here");
  assert.equal(escape.areas.portals.length, 1);
  const bounds = g.floors[0]!.city!.bounds;
  const human = humanOf(g);
  human.floor = 0;
  human.y = Math.round((bounds.top + bounds.bottom) / 2);
  human.x = Math.round((bounds.left + bounds.right) / 2);
  assert.equal(regionEdgeCrossed(g), undefined, "the middle of the city");
  human.x = bounds.right - 1;
  assert.equal(regionEdgeCrossed(g)?.id, region.id);
  // Travelling there enters the region at its far edge, not at the street.
  setAreaFactory(seedFactory);
  region.plan = {
    name: "Frost ridge",
    premise: "A ridge two days out.",
    rooms: [],
    people: [],
  };
  region.state = "ready";
  assert.equal(enterRegion(g, region.id), "entered");
  const dest = takeAreaSwitch(g);
  assert.ok(dest, "the region's game is ready to swap in");
  assert.equal(dest!.areaId, region.id);
  // Arriving does not count as crossing straight back out again.
  assert.equal(regionEdgeCrossed(dest!), undefined);
  assert.ok(humanOf(dest!).x < bounds.right - 2, "inside the region's edge");
});

test("an exit site counts as reached when the human enters its footprint", () => {
  const { g } = world();
  registerArea(g, {
    id: "rocket-site",
    name: "The rocket",
    brief: "The way off the rock.",
    state: "ready",
    seed: 77,
    kind: "site",
    origin: { x: 12, y: 0 },
    exit: true,
  });
  const human = humanOf(g);
  human.floor = 0;
  human.x = 0;
  human.y = 0;
  assert.equal(exitSiteReached(g), undefined, "outside the rocket");
  human.x = 12 + 10;
  human.y = 10;
  assert.equal(exitSiteReached(g)?.id, "rocket-site");
  assert.equal(exitSiteReached(g)?.exit, true);
});
