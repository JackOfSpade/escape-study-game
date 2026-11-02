import { openGameMenu } from "./helpers/game-menu";
// Controlled source reviews through actual UI. No real learner results.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { decode, encode, recover } from "../../src/persistence";
import { inspectMergedDocument } from "../../src/roadmap-structure";
import { setup, withdraw } from "../helpers/observation-withdrawal";
for (const outcome of ["assisted", "contradicted"] as const) {
  test(`reviewed ${outcome} observation retraction preserves audit and unknown status through explicit adoption and reload`, async ({
    page,
  }) => {
    const g = await setup(false, false, outcome);
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    const fixture = recover(decode(encode(g)));
    const prepared = await withdraw(fixture, "U");
    expect(prepared.state, prepared.error).toBe("ready");
    const candidate = prepared.payload.candidate;
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: "claude-cli",
          label: "Synthetic correction fixture",
          detail: "Controlled transport only; no native semantic certification",
          capabilities: ["reconcile-roadmap"],
        },
      }),
    );
    await page.route("**/api/bridge", async (route) => {
      const { operation, payload: p } = route.request().postDataJSON();
      // Background question preparation is not part of this test.
      if (operation !== "reconcile-roadmap")
        return route.fulfill({
          status: 503,
          json: { error: "Not part of this test" },
        });
      const local = inspectMergedDocument(p.local).rows;
      await route.fulfill({
        json: {
          requestId: p.requestId,
          localHash: p.localHash,
          candidateHash: p.candidateHash,
          canonical: p.candidate,
          definitions: [],
          mappings: [],
          completeScopes: [],
          decisions: [...inspectMergedDocument(p.candidate).rows]
            .filter(([key, row]) => local.has(key) && local.get(key) !== row)
            .map(([key]) => ({
              key,
              choice: "incoming",
              rationale:
                "Explicit source-backed withdrawal; preserve immutable observations",
            })),
          attemptUpdates: [
            {
              track: "PY",
              attemptId: "S0007-A98",
              rationale:
                "Exact source task invalidation, not a learner failure",
            },
          ],
          rationale:
            "Synthetic review withdraws sole invalidated support while preserving all historical facts.",
        },
      });
    });
    await page.goto("/");
    await page.evaluate(async (saved) => {
      const root = "/src/",
        { save, decode } = await import(root + "persistence.ts");
      const current = (window as any).__deadAir.game;
      Object.assign(current, decode(saved));
      current.status = "playing";
      await save(current);
    }, encode(g));
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    const before = await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    );
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: `synthetic-${outcome}-correction.md`,
      mimeType: "text/markdown",
      buffer: Buffer.from(candidate),
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
      "judgments supported only by it",
    );
    expect(
      await page.evaluate(() =>
        JSON.stringify((window as any).__deadAir.game.study.learner),
      ),
    ).toBe(before);
    const canonical = await page.evaluate(
      () =>
        (window as any).__deadAir.game.study.roadmapReconciliations.at(-1)
          .proposal.canonical,
    );
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download proposed roadmap", exact: true })
      .first()
      .click();
    expect(await readFile((await (await download).path())!, "utf8")).toBe(
      canonical,
    );
    await page.screenshot({
      path: `.artifacts/observation-retraction-${outcome}.png`,
    });
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
        status: l.finalProgress["PY:T01"].status,
        facet: l.finalProgress["PY:T01"].facets["D4:primary"],
        raw: g.study.roadmapExport.content,
        evidence: l.evidence.length,
        visits: g.study.visits.length,
      };
    });
    expect(result.status).toBe("U");
    expect(result.facet.outcome).toBe("unknown");
    expect(result.facet.evidenceIds).toEqual(["S0007-EV98"]);
    expect(result.raw).toBe(canonical);
    expect(result.raw).toContain("<!-- ATTEMPT_UPDATE ");
    expect(result.evidence).toBe(0);
    expect(result.visits).toBe(0);
  });
}
