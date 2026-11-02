import { openGameMenu } from "./helpers/game-menu";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { localHandoff } from "../helpers/local-handoff";

test("Claude CLI roadmap review survives reload with exact files and provider, then requires explicit adoption", async ({
  page,
}) => {
  const relay = await localHandoff();
  const base = relay.base;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const response = await fetch(base + url.pathname + url.search, {
      method: request.method(),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:5173",
      },
      ...(request.method() === "POST" ? { body: request.postData()! } : {}),
    });
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: await response.text(),
    });
  });
  const jobs: any[] = [];
  let outage = true;
  relay.answerWith((job) => {
    // Background question preparation is not part of this review.
    if (job.operation !== "reconcile-roadmap")
      throw Error("Not part of the roadmap review");
    jobs.push(job);
    if (outage) throw Error("Synthetic gateway outage");
    const p = job.payload;
    return {
      valid: {
        requestId: p.requestId,
        localHash: p.localHash,
        candidateHash: p.candidateHash,
        canonical: p.candidate,
        definitions: [],
        mappings: [],
        completeScopes: [],
        decisions: [],
        rationale:
          "Controlled administrative proposal; no mastery or execution claim",
      },
    };
  });
  try {
    const r = JSON.parse(await readFile("public/curriculum.json", "utf8"));
    const incoming = r.raw
      .replace(/^revision: 9$/m, "revision: 10")
      .replace(/^previous_revision: 8$/m, "previous_revision: 9")
      .replace(
        /^parent_file_sha256: .+$/m,
        `parent_file_sha256: ${r.sourceHash}`,
      )
      .replace(
        "| Learner | Mid-level",
        "| Learner | Synthetic administrative review; Mid-level",
      );
    await page.goto("/");
    // The app exposes __deadAir only after its top-level bridge/log awaits,
    // which can finish after the load event that goto waits for.
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await page.evaluate(async () => {
      const root = "/src/",
        { createGame } = await import(root + "world.ts"),
        { save } = await import(root + "persistence.ts");
      const r = await (await fetch("/curriculum.json")).json(),
        g = createGame(7, r);
      g.study.profile = "live";
      g.status = "playing";
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      for (const a of g.survivors.slice(1)) a.escaped = true;
      Object.assign((window as any).__deadAir.game, g);
      await save((window as any).__deadAir.game);
    });
    await page.reload();
    await expect(page.locator("#bridge-label")).toContainText("Claude CLI");
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: "synthetic-review.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(incoming),
    });
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "complete local working roadmap",
    );
    await page
      .getByRole("button", {
        name: "Request roadmap review",
        exact: true,
      })
      .click();
    await expect.poll(() => jobs.length).toBeGreaterThan(0);
    const job = jobs[0];
    expect(job.operation).toBe("reconcile-roadmap");
    const p = job.payload;
    expect(p.provider).toBe("claude-cli");
    expect(p.candidate).toBe(incoming);
    expect(
      await page
        .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
        .count(),
    ).toBe(0);
    await openGameMenu(page);
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    // The click resolves before the async save; reloading earlier loses it.
    await expect(page.locator("#notice")).toContainText("Run saved locally");
    await page.reload();
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    const failed = jobs.length;
    outage = false;
    await page
      .getByRole("button", { name: "Retry saved reconciliation", exact: true })
      .click();
    await expect.poll(() => jobs.length).toBeGreaterThan(failed);
    for (const again of jobs)
      expect(JSON.stringify(again)).toBe(JSON.stringify(job));
    await expect(
      page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as any).__deadAir.game.study.learner.roadmapAdoptions
            ?.length ?? 0,
      ),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__deadAir.game.study.learner.roadmapAdoptions?.at(
              -1,
            )?.provenance,
        ),
      )
      .toBe("claude-cli");
    // Adoption is applied in memory before it is persisted; wait for the save.
    await expect(page.locator("#roadmap-adoption-status")).toContainText(
      "adopted and saved",
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    const saved = await page.evaluate(() => {
      const s = (window as any).__deadAir.game.study;
      return {
        provider: s.learner.roadmapAdoptions.at(-1).provenance,
        content: s.roadmapExport.content,
        visits: s.visits.length,
      };
    });
    expect(saved).toEqual({
      provider: "claude-cli",
      content: incoming,
      visits: 0,
    });
  } finally {
    await relay.close();
  }
});
