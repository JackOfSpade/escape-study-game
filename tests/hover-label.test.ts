import assert from "node:assert/strict";
import { test } from "node:test";
import { HOVER_LABEL_MS, HoverLabel } from "../src/hover-label";
import { human } from "../src/engine";
import { readFileSync } from "node:fs";
import { TestRunner } from "../src/gametest/runner";
import { emptyScenario } from "../src/gametest/schema";
import type { Game, Roadmap } from "../src/model";
import { interactionPrompt } from "../src/view3d/hud";
import { lookTarget } from "../src/view3d/targeting";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
function fixture() {
  const scenario = emptyScenario();
  scenario.entities = [
    { id: "human", kind: "player", x: 12, y: 12 },
    { id: "near-chair", kind: "chair", x: 12, y: 12.7 },
    { id: "aimed-desk", kind: "desk", x: 13.5, y: 12 },
  ];
  return new TestRunner(scenario, roadmap).game;
}

test("HoverLabel shows for 2 s, stays hidden while hovering, returns after leaving", () => {
  const h = new HoverLabel();
  assert.equal(h.update(undefined, 0), false);
  assert.equal(h.update("a", 100), true);
  assert.equal(h.update("a", 100 + HOVER_LABEL_MS - 1), true);
  assert.equal(h.update("a", 100 + HOVER_LABEL_MS), false);
  assert.equal(h.update("a", 9000), false);
  assert.equal(h.update(undefined, 9100), false);
  assert.equal(h.update("a", 9200), true);
});

test("HoverLabel restarts on a new target even when the old one expired", () => {
  const h = new HoverLabel();
  h.update("a", 0);
  assert.equal(h.update("a", 3000), false);
  assert.equal(h.update("b", 3100), true);
  assert.equal(h.update("a", 3200), true);
});

test("first-person prompt names furniture only via the crosshair, and only for 2 s", () => {
  const game = fixture(),
    h = new HoverLabel();
  assert.equal(lookTarget(game, 0)?.kind, "grip");
  assert.equal(interactionPrompt(game, undefined, h, 0), "");
  assert.equal(interactionPrompt(game, Math.PI, h, 0), "");
  assert.equal(interactionPrompt(game, 0, h, 1000), "E · Grip desk");
  assert.equal(interactionPrompt(game, 0, h, 2999), "E · Grip desk");
  assert.equal(interactionPrompt(game, 0, h, 3000), "");
  assert.equal(interactionPrompt(game, 0, h, 9000), "");
  // Looking away and back brings the label back.
  interactionPrompt(game, Math.PI / 2, h, 9100);
  assert.equal(interactionPrompt(game, 0, h, 9200), "E · Grip desk");
});

test("release-grip prompt is not timed", () => {
  const game = fixture(),
    h = new HoverLabel();
  game.floors[0].furniture.find((o) => o.id === "aimed-desk");
  human(game).grip = {
    object: "aimed-desk",
  } as never;
  assert.equal(interactionPrompt(game, 0, h, 0), "E · Release grip");
  assert.equal(interactionPrompt(game, 0, h, 99999), "E · Release grip");
});

test("terminal prompts under the crosshair are never timed out", () => {
  const scenario = emptyScenario();
  scenario.entities = [{ id: "human", kind: "player", x: 12, y: 12 }];
  const game = new TestRunner(scenario, roadmap).game,
    h = new HoverLabel();
  game.floors[0].stations.push({
    id: "t1",
    x: 13.2,
    y: 12,
    encounter: "enc-t1",
  });
  game.encounters["enc-t1"] = {
    id: "enc-t1",
    state: "open",
    mode: "group",
    contributors: [],
    loot: [],
  } as unknown as Game["encounters"][string];
  assert.equal(lookTarget(game, 0)?.kind, "station");
  for (const now of [0, 2500, 60_000])
    assert.equal(interactionPrompt(game, 0, h, now), "E · Open terminal");
});
