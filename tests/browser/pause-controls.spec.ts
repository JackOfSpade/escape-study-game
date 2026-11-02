import { chooseDesignedRun } from "./helpers/designed-run";
import { expect, test, type Page } from "./helpers/offline-test";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import { environmentDesignFixture } from "../helpers/environment-design";
import {
  flushNativeSave,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
  seedLegacyDraft,
} from "./study-harness";
async function setup(page: Page) {
  await mockClaudeStudy(page);
  await enterLegacyBuilding(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    g.survivors = [a];
    g.zombies = [];
    g.nextSpawn = 1e9;
    g.surge.anchor = 1e9;
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
    f.furniture = [];
    Object.assign(a, { x: 10, y: 10 });
    f.stairs = { x: 30, y: 30 };
    f.stations = [{ ...f.stations[0], x: 10.8, y: 10 }];
  });
}
test("player controls live in the pause dialog and developer tools stay hidden", async ({
  page,
}) => {
  await setup(page);
  await expect(page.locator("#settings-toggle")).toBeHidden();
  await expect(page.locator("#curriculum-button")).toBeHidden();
  await expect(page.locator("#save-button")).toBeHidden();
  await expect(page.locator("#game-menu-toggle")).toHaveCount(0);

  await page.locator("#world").focus();
  await page.keyboard.down("d");
  await page.waitForTimeout(100);
  await page.keyboard.press("Escape");
  await page.keyboard.up("d");
  const menu = page.getByRole("dialog", { name: "Game paused", exact: true });
  await expect(menu).toBeVisible();
  for (const id of [
    "resume-game",
    "settings-toggle",
    "restart-game",
    "save-quit",
  ])
    await expect(menu.locator(`#${id}`)).toBeVisible();
  await expect(page.locator("#curriculum-button")).toBeHidden();
  await expect(page.locator("#save-button")).toBeHidden();
  await expect(page.getByRole("link", { name: /Test Lab/i })).toHaveCount(0);
  const before = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return { time: g.time, x: g.survivors[0].x, y: g.survivors[0].y };
  });
  await menu.locator("#settings-toggle").click();
  await expect(
    page.getByRole("dialog", { name: "Transmission settings", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#pause-home")).toBeHidden();
  await expect(page.locator("#volume")).toBeFocused();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    before.time,
  );
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#settings-toggle")).toBeFocused();
  expect(await page.evaluate(() => (window as any).__deadAir.game.paused)).toBe(
    true,
  );

  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toBeHidden();
  await expect(page.locator("#world")).toBeFocused();
  await page.waitForTimeout(200);
  const resumed = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return { time: g.time, x: g.survivors[0].x, y: g.survivors[0].y };
  });
  expect(resumed.time).toBeGreaterThan(before.time);
  expect([resumed.x, resumed.y]).toEqual([before.x, before.y]);
});
test("Esc freezes survival during a Claude question, preserves the captured legacy draft and survives reload without catch-up", async ({
  page,
}) => {
  await setup(page);
  await seedLegacyDraft(page, "saved learner draft");
  const id = await openNativeQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  const captured = await nativeState(page, id);
  await page.locator("#world").focus();
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toBeVisible();
  const world = () =>
    page.evaluate(() => {
      const g = (window as any).__deadAir.game;
      return JSON.stringify({
        time: g.time,
        survivors: g.survivors,
        zombies: g.zombies,
        floors: g.floors,
      });
    });
  const before = await world();
  await page.keyboard.press("w");
  await page.keyboard.press("e");
  await page.waitForTimeout(700);
  expect(await world()).toBe(before);
  await expect(page.locator("#pause-save-status")).toContainText("saved");
  await flushNativeSave(page);
  await page.reload();
  await expect(page.locator("#pause-menu")).toBeVisible();
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    time,
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).not.toBeVisible();
  await page.locator("#world").focus();
  expect((await nativeState(page, id)).problem).toBe(captured.problem);
  expect((await nativeState(page, id)).workspace).toBe("saved learner draft");
  // A reload never reopens the terminal on its own.
  await expect(page.locator("#terminal")).toBeHidden();
  await page.waitForTimeout(250);
  const elapsed =
    (await page.evaluate(() => (window as any).__deadAir.game.time)) - time;
  expect(elapsed).toBeGreaterThan(0.15);
  expect(elapsed).toBeLessThan(1);
});
test("pause restart retains original progress and archives unfinished human work", async ({
  page,
}) => {
  await setup(page);
  await seedLegacyDraft(page, "unfinished human reasoning survives restart");
  const id = await openNativeQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  const captured = await nativeState(page, id);
  const before = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      id: g.id,
      progress: {
        cells: g.study.learner?.cells,
        evidence: g.study.learner?.evidence,
      },
      source: g.study.learner?.sourceHash,
      encounters: Object.keys(g.encounters),
    };
  });
  await page.keyboard.press("Escape");
  await page.locator("#restart-game").click();
  await chooseDesignedRun(page);
  await expect(page.locator("#pause-menu")).not.toBeVisible();
  const after = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game;
    return {
      id: g.id,
      progress: {
        cells: g.study.learner?.cells,
        evidence: g.study.learner?.evidence,
      },
      source: g.study.learner?.sourceHash,
      archives: g.study.archives.map((e: any) => e.workspace),
      archivedProblem: JSON.stringify(
        g.study.archives.find((e: any) => e.id === id)?.problem,
      ),
      paused: g.paused,
    };
  }, id);
  expect(after.id).not.toBe(before.id);
  expect(after.progress).toEqual(before.progress);
  expect(after.source).toEqual(before.source);
  expect(after.archives).toContain(
    "unfinished human reasoning survives restart",
  );
  expect(after.archivedProblem).toBe(captured.problem);
  expect(after.paused).toBe(false);
});
test("E toggles a pivoting grip; old G/R/digit shortcuts do not act; Space vaults", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    f.stations = [];
    f.furniture = [
      {
        id: "test-sofa",
        kind: "sofa",
        floor: 0,
        x: 12,
        y: 12,
        w: 3.8,
        h: 1.2,
        hp: 100,
        maxHp: 100,
        speed: 1,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    Object.assign(a, {
      x: 9.55,
      y: 12,
      hp: 50,
      inventory: [{ id: "medkit", kind: "medkit", weight: 1, charges: 1 }],
    });
    f.furniture.push({
      ...f.furniture[0],
      id: "closer-center-chair",
      kind: "chair",
      x: 9.55,
      y: 10.8,
      w: 0.6,
      h: 0.6,
    });
    f.stairs = { x: a.x, y: a.y + 2 }; // Nearby but out of reach: must not swallow E on the long sofa end.
  });
  await page.keyboard.press("r");
  await page.keyboard.press("1");
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.survivors[0].hp),
  ).toBe(50);
  await page.keyboard.press("e");
  await page.keyboard.down("w");
  await page.waitForTimeout(500);
  await page.keyboard.up("w");
  const pose = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return { grip: g.survivors[0].grip, angle: g.floors[0].furniture[0].angle };
  });
  expect(pose.grip.object).toBe("test-sofa");
  expect(Math.abs(pose.angle)).toBeGreaterThan(0.05);
  await page.keyboard.press("e");
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.survivors[0].grip),
  ).toBeUndefined();
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      o = g.floors[0].furniture[0],
      a = g.survivors[0];
    Object.assign(o, { angle: 0, x: 12, y: 12 });
    Object.assign(a, { x: 12, y: 10.85, heading: { x: 0, y: 1 } });
  });
  await page.keyboard.press("Space");
  expect(
    await page.evaluate(
      () => !!(window as any).__deadAir.game.survivors[0].vault,
    ),
  ).toBe(true);
  await page.waitForTimeout(1400);
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.survivors[0].y),
  ).toBeGreaterThan(12.6);
});
test("diagnostics retain only newest three runs, including pause/restart and no drafts, with no download button", async ({
  page,
}) => {
  await setup(page);
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Escape");
    await page.locator("#restart-game").click();
    await chooseDesignedRun(page);
    await expect(page.locator("#pause-menu")).not.toBeVisible();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByText(/download last 3 game logs/i)).toHaveCount(0);
  const log = JSON.parse(
    await page.evaluate(() => (window as any).__deadAir.logs()),
  );
  expect(log.runs).toHaveLength(3);
  expect(log.runs.at(-1).entries.some((e: any) => e.type === "pause")).toBe(
    true,
  );
  expect(log.runs.at(-2).entries.some((e: any) => e.type === "restart")).toBe(
    true,
  );
  expect(log.runs.at(-2).summary.outcome).toBe("restarted");
  expect(JSON.stringify(log)).not.toContain('"study":');
  await page.screenshot({
    path: "test-results/pause-menu.png",
    fullPage: true,
  });
});
test("restart saves learning before the new run; save and quit shows the saved run behind the main menu", async ({
  page,
}) => {
  await setup(page);
  const first = await page.evaluate(() => (window as any).__deadAir.game.id);
  await page.keyboard.press("Escape");
  await page.locator("#restart-game").click();
  await chooseDesignedRun(page);
  await expect(page.locator("#pause-menu")).not.toBeVisible();
  const restarted = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return { id: g.id, notice: g.notice, opening: g.design?.design.opening };
  });
  expect(restarted.id).not.toBe(first);
  expect(restarted.opening).toBe(environmentDesignFixture().opening);
  expect(restarted.notice).toBe(
    `${restarted.opening} Zombies are already approaching. The entrance is behind you; they will reach it in about three minutes. Learning progress saved. New run ready.`,
  );

  await page.keyboard.press("Escape");
  await page.locator("#save-quit").click();
  await expect(page.locator("#pause-menu")).not.toBeVisible();
  await expect(page.locator("#start-card")).toBeVisible();
  await expect(page.locator("#quit-save")).toHaveText(
    "✓ Run and learning progress saved.",
  );
  await page.screenshot({ path: "test-results/save-and-quit.png" });
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    time,
  );
  // The saved run is the one the menu continues.
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect(await page.evaluate(() => (window as any).__deadAir.game.id)).toBe(
    restarted.id,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await page.locator("#save-quit").click();
  await expect(page.locator("#start-card")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#start-card")).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.paused))
    .toBe(false);
});

test("Space uses the current movement direction and vaults the faced long barricade, not a nearer chair behind", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    f.stations = [];
    Object.assign(a, { x: 14.7, y: 10.95, heading: { x: 0, y: -1 } });
    const o = {
      id: "long-barricade",
      kind: "shelf",
      floor: 0,
      x: 12,
      y: 12,
      w: 6,
      h: 1,
      hp: 100,
      maxHp: 100,
      speed: 0.32,
      rotation: 0,
      destroyed: false,
      movers: [],
      moved: 0,
      credited: [],
      turning: 0,
    };
    f.furniture = [
      o,
      {
        ...o,
        id: "chair-behind",
        kind: "chair",
        x: a.x,
        y: 9.5,
        w: 0.8,
        h: 0.8,
      },
    ];
  });
  await page.locator("#world").focus();
  // Same input frame: Space must not use the previous heading.
  await page.keyboard.down("s");
  await page.keyboard.press("Space");
  await page.keyboard.up("s");
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.survivors[0].vault?.obstacle,
    ),
  ).toBe("long-barricade");
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.survivors[0].y),
    )
    .toBeGreaterThan(12.7);
});
