import { startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
import { expect, test } from "@playwright/test";

test("importing a lower-sequence run still assesses its retained human completion", async ({
  page,
}) => {
  await page.goto("/");
  await startDesignedRun(page);
  const saved = await page.evaluate(async () => {
    const root = "/src/",
      { createGame } = await import(root + "world.ts"),
      { devProblem } = await import(root + "practice-problem.ts"),
      { encode } = await import(root + "persistence.ts"),
      { game: current, roadmap } = (window as any).__deadAir;
    current.seq = 100_000;
    current.events.push({
      seq: current.seq,
      at: 0,
      type: "breach",
      text: "Synthetic prior-run high sequence",
    });
    const next = createGame(730, roadmap),
      e = next.encounters["f0-room0"];
    next.status = "playing";
    next.survivors = [next.survivors[0]];
    next.zombies = [];
    next.nextSpawn = Number.MAX_SAFE_INTEGER;
    e.problem = devProblem(next, roadmap);
    e.state = "consumed";
    e.contributors = ["human"];
    next.seq = 1;
    next.events = [
      {
        seq: 1,
        at: 0,
        type: "completion",
        text: "Synthetic imported completion",
        encounter: e.id,
      },
    ];
    return encode(next);
  });
  await expect(page.locator("#event-feed")).toContainText(
    "Synthetic prior-run high sequence",
  );
  await openGameMenu(page);
  await page.locator("#settings-toggle").click();
  await page.locator("#import").setInputFiles({
    name: "synthetic-import.json",
    mimeType: "application/json",
    buffer: Buffer.from(saved),
  });
  await expect(page.locator("#pause-home")).toBeVisible();
  // Imported worlds remain paused until the player resumes automatic work.
  await page.locator("#resume-game").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__deadAir.game.study.assessments.length,
      ),
    )
    .toBe(1);
});

test("retrying an assessment durably captures its pending request before a reply arrives", async ({
  page,
}) => {
  let hold = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic assessment fixture",
        detail: "Synthetic transport only",
        capabilities: ["assess"],
      },
    }),
  );
  await page.route("**/api/bridge", async (route) => {
    if (hold) await gate;
    await route
      .fulfill({
        status: 503,
        json: { error: "Synthetic interrupted assessment" },
      })
      .catch(() => {});
  });
  try {
    await page.goto("/");
    await startDesignedRun(page);
    await page.evaluate(async () => {
      const root = "/src/",
        { assess } = await import(root + "ai.ts"),
        { devProblem } = await import(root + "practice-problem.ts"),
        { save } = await import(root + "persistence.ts"),
        { game: g, roadmap: r } = (window as any).__deadAir,
        e = Object.values(g.encounters)[0] as any;
      g.survivors = [g.survivors[0]];
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      g.study.profile = "live";
      e.problem = devProblem(g, r);
      e.problem.provenance = "claude-cli";
      await assess(g, e, r);
      await save(g);
    });
    // A paused world cannot autosave an otherwise unsaved retry later.
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    expect(
      await page.evaluate(() => (window as any).__deadAir.game.paused),
    ).toBe(true);
    hold = true;
    await page.locator("[data-assessment]").click();
    await expect(page.locator("[data-assessment]")).toBeDisabled();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const root = "/src/",
            { load } = await import(root + "persistence.ts");
          const g = await load();
          return g?.study.assessments[0]?.status;
        }),
      )
      .toBe("pending");
    const request = await page.evaluate(async () => {
      const root = "/src/",
        { load } = await import(root + "persistence.ts");
      return (await load())?.study.assessments[0]?.request;
    });
    expect(request?.provider).toBe("claude-cli");
    expect(JSON.parse(request!.payloadJson).packet.sourceHash).toMatch(
      /^[a-f0-9]{64}$/,
    );
    // Reload interrupts the in-flight review while retaining its exact packet.
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    const recovered = await page.evaluate(
      () => (window as any).__deadAir.game.study.assessments[0],
    );
    expect(recovered.status).toBe("review-required");
    expect(recovered.request).toEqual(request);
  } finally {
    release();
  }
});
