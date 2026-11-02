import { startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
// Actual UI, controlled source judgment; no real learner data is corrected.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createGame } from "../../src/world";
import { baselineFixture, roadmap as r } from "../helpers/baseline-correction";

test("original checkpoint correction exposes complete historical review before adoption and survives reload", async ({
  page,
}) => {
  const synthetic = createGame(7, r);
  synthetic.study.profile = "live";
  const fixture = await baselineFixture(synthetic);
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic original checkpoint review",
        detail:
          "Controlled transport fixture, not real native semantic certification",
        capabilities: ["reconcile-roadmap"],
      },
    }),
  );
  let requests = 0;
  await page.route("**/api/bridge", async (route) => {
    const { operation, payload } = route.request().postDataJSON();
    // Background question preparation is not part of this test.
    if (operation !== "reconcile-roadmap")
      return route.fulfill({
        status: 503,
        json: { error: "Not part of this test" },
      });
    const reply = fixture.proposal(payload);
    await route.fulfill({
      json: {
        ...reply,
        definitions: ++requests === 1 ? null : reply.definitions,
      },
    });
  });
  await page.goto("/");
  await startDesignedRun(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.study.profile = "live";
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.zombies = [];
  });
  const before = await page.evaluate(() =>
    JSON.stringify((window as any).__deadAir.game.study.learner),
  );
  await openGameMenu(page);
  await page.locator("#curriculum-button").click();
  await page.getByText("Review an updated roadmap", { exact: true }).click();
  await page.locator("#roadmap-review-file").setInputFiles({
    name: "synthetic-baseline-correction.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(fixture.raw),
  });
  await page
    .getByRole("button", { name: "Request roadmap review", exact: true })
    .click();
  const controls = page.locator("#roadmap-adoption-controls");
  await expect(controls).toContainText(
    "Invalid roadmap reconciliation identity or shape",
  );
  await expect(
    page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(before);
  await page
    .getByRole("button", { name: "Retry saved reconciliation", exact: true })
    .click();

  await expect(
    page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
  ).toBeVisible();
  await expect(controls).toContainText(
    "Original checkpoint review: PY:T05.2/D1",
  );
  await expect(controls).toContainText(
    "Every historical observation is reviewed",
  );
  await expect(controls).toContainText(fixture.decisionId);
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(before);
  expect(requests).toBe(2);
  const canonical = await page.evaluate(
    () =>
      (window as any).__deadAir.game.study.roadmapReconciliations.at(-1)
        .proposal.canonical,
  );
  expect(canonical).toContain(fixture.history.evidenceRows[0]);
  expect(canonical).toContain(fixture.decision);
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download proposed roadmap", exact: true })
    .click();
  expect(await readFile((await (await downloading).path())!, "utf8")).toBe(
    canonical,
  );
  await page.screenshot({ path: "test-results/baseline-correction.png" });
  const adopted = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
    .click();
  await adopted;
  await expect(page.locator("#roadmap-adoption-status")).toContainText(
    "adopted and saved",
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const result = await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      l = g.study.learner;
    return {
      state: l.cells["PY:T05.2"].states[0],
      facet: l.cells["PY:T05.2"].facets["D1:source-0"].outcome,
      evidence: l.evidence.length,
      attempts: l.attempts.length,
      visits: g.study.visits.length,
      cycle: l.cycle,
      source: l.sourceHash,
    };
  });
  expect(result).toEqual({
    state: "U",
    facet: "unknown",
    evidence: 0,
    attempts: 0,
    visits: 0,
    cycle: 0,
    source: r.sourceHash,
  });
});
