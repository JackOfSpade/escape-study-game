import { startDesignedRun } from "./helpers/designed-run";
import { expect, test } from "@playwright/test";
test("last-run seed: E releases the physical first entrance and keyboard input physically enters", async ({
  page,
}) => {
  await page.goto("/");
  await startDesignedRun(page);
  await page.evaluate(async () => {
    const { createGame } = await import("/src/world.ts" as string),
      { step } = await import("/src/engine.ts" as string);
    const g = (window as any).__deadAir.game,
      fresh = createGame(1137190675, (window as any).__deadAir.roadmap);
    fresh.settings.view = "top-down";
    for (const key of Object.keys(g))
      if (!Object.hasOwn(fresh, key)) delete g[key];
    Object.assign(g, fresh);
    g.status = "playing";
    g.survivors = [g.survivors[0]];
    g.zombies = [];
    g.nextSpawn = 1e9;
    g.surge.anchor = 1e9;
    for (let i = 0; i < 96; i++) step(g, 1 / 30);
    Object.assign(g.survivors[0], {
      x: 22.1197889474316,
      y: 29.144842656013676,
    });
  });
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).__deadAir.game.floors[0].furniture.find(
            (o: any) => o.id === "main-gate",
          ).door?.latched,
      ),
    )
    .toBe(false);
  await expect(page.locator("#notice")).toContainText("Latch released");
  await page.keyboard.down("w");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.survivors[0].y),
    )
    .toBeLessThan(27.8);
  await page.keyboard.up("w");
  const angle = await page.evaluate(() =>
    Math.abs(
      (window as any).__deadAir.game.floors[0].furniture.find(
        (o: any) => o.id === "main-gate",
      ).angle,
    ),
  );
  expect(angle).toBeGreaterThan(0.1);
  await page.screenshot({ path: "test-results/reopened-entrance.png" });
});

test("opening countdown prevents all zombie spawns until ten simulation seconds", async ({
  page,
}) => {
  await page.goto("/");
  await startDesignedRun(page);
  // Fresh runs use the force-field swarm wording; legacy worlds say zombies.
  await expect(page.locator("#next-description")).not.toContainText(
    /(Swarm begins|Zombies spawn) in/,
  );
  const result = await page.evaluate(async () => {
    const { createGame } = await import("/src/world.ts" as string),
      { step } = await import("/src/engine.ts" as string);
    const g = createGame(7, (window as any).__deadAir.roadmap);
    g.status = "playing";
    g.survivors = [g.survivors[0]];
    for (let i = 0; i < 299; i++) step(g, 1 / 30);
    const before = g.zombies.length;
    g.time = 10;
    step(g, 1 / 30);
    return { before, after: g.zombies.length, hp: g.survivors[0].hp };
  });
  expect(result).toEqual({ before: 0, after: 3, hp: 100 });
});
