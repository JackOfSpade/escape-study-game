import { openGameMenu } from "./helpers/game-menu";
// Actual UI with synthetic grades, not native semantic or human achievement proof.
import { expect, test } from "@playwright/test";
import { encode } from "../../src/persistence";
import {
  laterBaselineFixture,
  laterId,
  laterScope,
} from "../helpers/later-baseline-evidence";
test("correcting an older original score retains an actually recorded later pass and review interval through UI adoption and reload", async ({
  page,
}) => {
  const { g, fixture } = await laterBaselineFixture("independent");
  const before = structuredClone(g.study.learner!);
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic later-evidence fixture",
        detail: "Controlled transport; no real native semantic certification",
        capabilities: ["reconcile-roadmap"],
      },
    }),
  );
  await page.route("**/api/bridge", async (route) => {
    const { operation, payload } = route.request().postDataJSON();
    // Background question preparation is not part of this test.
    if (operation !== "reconcile-roadmap")
      return route.fulfill({
        status: 503,
        json: { error: "Not part of this test" },
      });
    await route.fulfill({ json: fixture.proposal(payload) });
  });
  await page.goto("/");
  await page.evaluate(async (raw) => {
    const root = "/src/",
      { decode, save } = await import(root + "persistence.ts"),
      current = (window as any).__deadAir.game;
    Object.assign(current, decode(raw));
    current.status = "playing";
    current.nextSpawn = Number.MAX_SAFE_INTEGER;
    current.zombies = [];
    await save(current);
  }, encode(g));
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await openGameMenu(page);
  await page.locator("#curriculum-button").click();
  await page.getByText("Review an updated roadmap", { exact: true }).click();
  await page.locator("#roadmap-review-file").setInputFiles({
    name: "synthetic-older-score-audit.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(fixture.raw),
  });
  await page
    .getByRole("button", { name: "Request roadmap review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#roadmap-adoption-controls")).toContainText(
    "Original checkpoint review: PY:T05.2/D1",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).__deadAir.game.study.learner.reviews["PY:T05.2/D1"]
          .verifiedReviews,
    ),
  ).toBe(1);
  const downloaded = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
    .click();
  await downloaded;
  await expect(page.locator("#roadmap-adoption-status")).toContainText(
    "adopted and saved",
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const after = await page.evaluate(() => {
    const l = (window as any).__deadAir.game.study.learner;
    return {
      state: l.cells["PY:T05.2"].states[0],
      reviews: l.reviews,
      evidence: l.evidence,
      attempts: l.attempts,
      cycle: l.cycle,
    };
  });
  expect(after.state).toBe("P");
  expect(after.reviews).toEqual(JSON.parse(JSON.stringify(before.reviews)));
  expect(after.evidence).toEqual(JSON.parse(JSON.stringify(before.evidence)));
  expect(after.attempts).toEqual(JSON.parse(JSON.stringify(before.attempts)));
  expect(after.cycle).toBe(before.cycle);
  expect(after.reviews[laterScope].verifiedReviews).toBe(1);
  expect(after.reviews[laterScope].stage).toBe(1);
  expect(after.evidence.some((ev: any) => ev.objectiveId === laterId)).toBe(
    true,
  );
});
