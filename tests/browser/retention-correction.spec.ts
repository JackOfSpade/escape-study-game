import { openGameMenu } from "./helpers/game-menu";
// Controlled source review only; no live model or real learner grades.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { encode } from "../../src/persistence";
import {
  laterScope,
  retentionCorrection,
  retentionFixture,
} from "../helpers/retention-correction";
for (const removed of [0, 1])
  test(`explicit retention correction of review ${removed} preserves history through preview, adoption and reload`, async ({
    page,
  }) => {
    const { g, events } = retentionFixture();
    g.status = "playing";
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    for (const actor of g.survivors.slice(1)) actor.escaped = true;
    const expected =
      removed === 1
        ? events[0].after
        : {
            ...events[1].after,
            stage: 1,
            verifiedReviews: 1,
            due: "2026-11-02",
          };
    const fixture = await retentionCorrection(
      g,
      [events[removed].attemptId],
      expected,
    );
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: "claude-cli",
          label: "Controlled Claude gateway",
          detail: "Local fixture only",
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
      expect(payload.provider).toBe("claude-cli");
      expect(
        payload.context.retentionHistory.filter(
          (e: any) => e.scopeId === laterScope,
        ),
      ).toHaveLength(2);
      await route.fulfill({ json: fixture.proposal(payload) });
    });
    await page.goto("/");
    await page.evaluate(async (saved) => {
      const root = "/src/",
        { decode, save } = await import(root + "persistence.ts");
      const current = (window as any).__deadAir.game;
      Object.assign(current, decode(saved));
      current.status = "playing";
      await save(current);
    }, encode(g));
    await page.reload();
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: "synthetic-retention-review.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(fixture.raw),
    });
    await page
      .getByRole("button", {
        name: "Request roadmap review",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "Dates and verification counts are recomputed",
    );
    expect(
      await page.evaluate(
        (scope) =>
          (window as any).__deadAir.game.study.learner.reviews[scope]
            .verifiedReviews,
        laterScope,
      ),
    ).toBe(2);
    const proposed = await page.evaluate(
      () =>
        (window as any).__deadAir.game.study.roadmapReconciliations.at(-1)
          .proposal.canonical,
    );
    const downloaded = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download proposed roadmap", exact: true })
      .click();
    expect(await readFile((await (await downloaded).path())!, "utf8")).toBe(
      proposed,
    );
    await page
      .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          (scope) =>
            (window as any).__deadAir.game.study.learner.reviews[scope]
              .verifiedReviews,
          laterScope,
        ),
      )
      .toBe(1);
    await expect(page.locator("#roadmap-adoption-status")).toContainText(
      "adopted and saved",
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    const saved = await page.evaluate((scope) => {
      const s = (window as any).__deadAir.game.study;
      return {
        review: s.learner.reviews[scope],
        history: s.learner.retentionHistory.filter(
          (e: any) => e.scopeId === scope,
        ),
        cycle: s.learner.cycle,
        provider: s.learner.roadmapAdoptions.at(-1).provenance,
      };
    }, laterScope);
    expect(saved.review).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(saved.history).toEqual(JSON.parse(JSON.stringify(events)));
    expect(saved.cycle).toBe(g.study.learner!.cycle);
    expect(saved.provider).toBe("claude-cli");
  });
