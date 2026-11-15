import { startDesignedRun } from "./helpers/designed-run";
import { expect, test, type Page } from "@playwright/test";

async function walkIntoWell(page: Page) {
  await page.keyboard.down("w");
  const observed = await page.waitForFunction(
    () => {
      const g = (window as any).__deadAir.game,
        a = g.survivors[0];
      if (!a.stairTravel) return false;
      // Stop inside the browser on the observing frame; an RPC round trip
      // must not keep the movement key held while the flight is inspected.
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyW" }));
      return {
        floor: a.floor,
        until: a.stairTravel.until,
        time: g.time,
        start: g.events
          .filter(
            (e: any) => e.type === "survivor-stairs" && e.actor === "human",
          )
          .at(-1).at,
      };
    },
    undefined,
    { polling: "raf" },
  );
  await page.keyboard.up("w");
  const snapshot = await observed.jsonValue();
  if (!snapshot) throw Error("Stair flight was not captured");
  return snapshot;
}

test("walking into the personal staircase starts a saved flight; leaving the well cancels it", async ({
  page,
}) => {
  await page.goto("/");
  await startDesignedRun(page);
  const baseline = await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      a = g.survivors[0],
      root = "/src/",
      { complete } = await import(root + "engine.ts");
    g.survivors = [a];
    g.settings.view = "top-down";
    g.zombies = [];
    g.nextSpawn = 999999;
    g.surge.anchor = 999999;
    complete(
      g,
      "f0-room0",
      "synthetic-stair-credential",
      ["human"],
      "World reward fixture; no learning claim",
    );
    // The pursuit well's center intentionally completes a flight immediately.
    // Enter its outer edge to exercise the saved two-second deadline instead.
    Object.assign(a, {
      x: g.floors[0].stairs.x + 0.75,
      y: g.floors[0].stairs.y + 3,
    });
    return {
      study: JSON.stringify(g.study),
      stairs: g.floors[0].stairs,
      boundary: g.floors[0].boundary,
    };
  });
  expect(baseline.stairs).toEqual({ x: 22, y: baseline.boundary.top - 1 });
  await page.locator("#world").focus();
  // No E: walking north into the well starts the flight by itself.
  const started = await walkIntoWell(page);
  expect(started.floor).toBe(0);
  expect(started.until).toBeGreaterThan(started.time);
  // Walking back out of the well cancels; the survivor stays on this floor.
  await page.keyboard.down("s");
  await page.waitForFunction(
    () => {
      if ((window as any).__deadAir.game.survivors[0].stairTravel) return false;
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyS" }));
      return true;
    },
    undefined,
    { polling: "raf" },
  );
  await page.keyboard.up("s");
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.survivors[0].floor,
    ),
  ).toBe(0);
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.notice),
  ).toMatch(/left the staircase/);
  // Walk back in: a new flight with its own saved deadline.
  const saved = await walkIntoWell(page);
  await page.reload();
  await expect(page.locator("#world")).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.survivors[0].stairTravel?.until,
    ),
  ).toBe(saved.until);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.survivors[0].floor),
    )
    .toBe(1);
  const arrived = await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0];
    return {
      event: g.events
        .filter((e: any) => e.type === "climb" && e.actor === "human")
        .at(-1),
      study: JSON.stringify(g.study),
      access: a.access,
      x: a.x,
      y: a.y,
      entry: g.floors[1].entry,
      stairwell: a.stairwell,
    };
  });
  expect(arrived.event.at - saved.start).toBeGreaterThanOrEqual(2 - 1e-8);
  expect(arrived.study).toBe(baseline.study);
  expect(arrived.access).toEqual([0, 1, 2, 3, 4]);
  expect(
    Math.hypot(arrived.x - arrived.entry.x, arrived.y - arrived.entry.y),
  ).toBeLessThan(0.1);
  // Arriving inside the descending well must not start the return flight.
  expect(arrived.stairwell).toBe("down");
  await page.waitForTimeout(300);
  expect(
    await page.evaluate(() => {
      const a = (window as any).__deadAir.game.survivors[0];
      return { floor: a.floor, travel: a.stairTravel };
    }),
  ).toEqual({ floor: 1, travel: undefined });
});
