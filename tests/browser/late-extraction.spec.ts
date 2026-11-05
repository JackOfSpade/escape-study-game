import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";

test("earned shields and real keyboard controls extract from a crowded rooftop after the saved long-study ascent", async ({
  page,
}) => {
  const captured = JSON.parse(
    await readFile(
      "docs/evidence/late-extraction-range-0-floor4-world.json",
      "utf8",
    ),
  );
  expect(captured.survivors[0].alive).toBe(true);
  expect(captured.survivors[0].floor).toBe(4);
  expect(
    captured.survivors[0].inventory.filter((i: any) => i.kind === "bubble"),
  ).toHaveLength(3);
  const baseline = {
    created: captured.spawned,
    evidence: JSON.stringify(captured.study.learner.evidence),
    visits: captured.study.visits.length,
    attempts: JSON.stringify(captured.study.learner.attempts),
    trip: captured.helicopter.trip,
  };
  await page.goto("/");
  await page.evaluate(async (captured) => {
    const root = "/src/",
      { save } = await import(root + "persistence.ts");
    const current = (window as any).__deadAir.game;
    // The captured ascent is a legacy world; a fresh run's force-field rules
    // must not leak into it through the save.
    delete current.rules;
    Object.assign(current, captured);
    current.settings.view = "top-down";
    await save(current);
  }, captured);
  await page.reload();
  await page.waitForFunction(
    () => (window as any).__deadAir?.game.survivors[0].floor === 4,
  );
  await expect(page.locator("#next-title")).toHaveText("Hold for extraction.");
  await page.locator("#world").focus();
  let held = new Set<string>();
  const release = async () => {
    for (const key of held) await page.keyboard.up(key);
    held = new Set();
  };
  for (let i = 0; i < 220; i++) {
    const s = await page.evaluate(async () => {
      const g = (window as any).__deadAir.game,
        a = g.survivors[0],
        f = g.floors[4],
        root = "/src/",
        { survivorPath } = await import(root + "navigation.ts"),
        { canSee, sightRadius } = await import(root + "visibility.ts"),
        { distance } = await import(root + "model.ts");
      const route = survivorPath(f, a, { x: 21.5, y: 13.0 }),
        next = route.find((p: any) => distance(a, p) > 0.16);
      const shielded = g.effects.some(
        (e: any) =>
          e.kind === "bubble" &&
          e.floor === 4 &&
          e.until > g.time + 0.2 &&
          canSee(f, e, a, e.radius - 0.1),
      );
      const threat = g.zombies.some(
        (z: any) =>
          z.hp > 0 &&
          z.floor === 4 &&
          // Deploy for an approaching contact, not every distant visible zombie.
          // Three stationary shields must cover the actual approach to boarding.
          distance(a, z) < 2 &&
          canSee(f, a, z, sightRadius(f)),
      );
      return {
        status: g.status,
        alive: a.alive,
        hp: a.hp,
        range: Math.hypot(a.x - 21.5, a.y - 10.5),
        boarding: g.time < g.helicopter.until,
        bubble: a.inventory.findIndex((i: any) => i.kind === "bubble"),
        needShield: threat && !shielded,
        next,
        dx: next ? next.x - a.x : 0,
        dy: next ? next.y - a.y : 0,
        vault: !!a.vault,
      };
    });
    if (s.status === "escaped") break;
    if (!s.alive)
      await writeFile(
        "test-results/rigid-roof-failed-world.json",
        await page.evaluate(() =>
          JSON.stringify((window as any).__deadAir.game),
        ),
      );
    expect(s.alive, JSON.stringify(s)).toBe(true);
    if (s.boarding && s.range < 2.75) {
      await release();
      await page.keyboard.press("e");
      await page.waitForTimeout(40);
      continue;
    }
    if (s.needShield && s.bubble >= 0) {
      await release();
      await page
        .getByRole("button", { name: /Protective bubble/ })
        .first()
        .click();
      await page.locator("#world").focus();
      continue;
    }
    const desired = new Set<string>();
    if (!s.vault && s.next) {
      if (s.next.action === "vault") {
        await release();
        await page.keyboard.press("Space");
      } else {
        if (s.dx < -0.08) desired.add("a");
        if (s.dx > 0.08) desired.add("d");
        if (s.dy < -0.08) desired.add("w");
        if (s.dy > 0.08) desired.add("s");
      }
    }
    for (const key of held) if (!desired.has(key)) await page.keyboard.up(key);
    for (const key of desired)
      if (!held.has(key)) await page.keyboard.down(key);
    held = desired;
    await page.waitForTimeout(45);
  }
  await release();
  await expect(
    page.getByRole("heading", { name: "You made it." }),
  ).toBeVisible();
  await expect(page.locator("#next-title")).toHaveText("Extraction confirmed.");
  await expect(page.locator("#pickup")).toContainText("EXTRACTED");
  await expect(page.locator("#start-card")).toHaveClass(/finished/);
  const after = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      status: g.status,
      hp: g.survivors[0].hp,
      passengers: g.helicopter.passengers,
      trip: g.helicopter.trip,
      bubbles: g.survivors[0].inventory.filter((i: any) => i.kind === "bubble")
        .length,
      created: g.spawned,
      evidence: JSON.stringify(g.study.learner.evidence),
      visits: g.study.visits.length,
      profile: g.study.profile,
      attempts: JSON.stringify(g.study.learner.attempts),
      used: g.events.filter(
        (e: any) =>
          e.type === "item" && e.actor === "human" && e.text.includes("bubble"),
      ).length,
    };
  });
  expect(after.status).toBe("escaped");
  expect(after.hp).toBeGreaterThan(0);
  expect(after.passengers).toContain("human");
  expect(after.trip).toBe(baseline.trip);
  expect(after.used).toBeGreaterThan(0);
  expect(after.used).toBeLessThanOrEqual(3);
  expect(after.bubbles).toBe(3 - after.used);
  expect(after.created).toBeGreaterThanOrEqual(baseline.created);
  expect(after.evidence).toBe(baseline.evidence);
  // The captured run is a development run; loading moves it to the live
  // profile, which resets the development curriculum visits but keeps the
  // learner ledger (evidence above), so the visits are not preserved.
  expect(after.profile).toBe("live");
  expect(after.visits).toBe(0);
  expect(after.attempts).toBe(baseline.attempts);
  await writeFile(
    "test-results/late-extraction-ui-state.json",
    JSON.stringify({ baseline, after }, null, 2),
  );
  await page.screenshot({ path: "test-results/late-extraction-ui.png" });
});
