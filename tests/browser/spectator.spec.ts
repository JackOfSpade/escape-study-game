import { startDesignedRun, startRestartedRun } from "./helpers/designed-run";
import { expect, test } from "@playwright/test";
import {
  flushNativeSave,
  killHumanInStep,
  mockClaudeStudy,
} from "./study-harness";
const state = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const d = (window as any).__deadAir,
      g = d.game;
    return {
      view: d.view,
      time: g.time,
      seq: g.seq,
      x: g.survivors[0].x,
      floorName: g.floors[1].name,
      paused: !!g.paused,
      npcs: g.survivors.slice(1).map((a: any) => `${a.floor}/${a.x}/${a.y}`),
      zombies: g.zombies.map((z: any) => `${z.floor}/${z.x}/${z.y}`),
    };
  });
test("after combat death the live building can be watched, paused and reloaded with a free camera", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await startDesignedRun(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.zombies = [];
    g.nextSpawn = 999999;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
  });
  await killHumanInStep(page);
  await expect(
    page.getByRole("button", { name: "Begin another run" }),
  ).toBeVisible();
  await expect(page.locator("#spectator")).toBeHidden();
  const before = await state(page);
  await page.getByRole("button", { name: "Watch the building" }).click();
  await expect(page.locator("#start-card")).toBeHidden();
  await expect(page.locator("#spectator")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/spectating/);
  await expect(page.locator("#hud")).toBeHidden();
  const floors = page.locator("#spectator-floors button");
  await expect(floors).toHaveText(["1", "2", "3", "4", "ROOF"]);
  await expect(floors.nth(0)).toHaveAttribute("aria-pressed", "true");
  const opened = await state(page);
  expect(opened.view.floor).toBe(0);
  expect(opened.view.zoom).toBe(1);
  expect(opened.view.focus.x).toBeCloseTo(before.x, 6);
  await floors.filter({ hasText: "ROOF" }).click();
  await expect(page.locator("#floor-label")).toHaveText("ROOFTOP / EXTRACTION");
  await expect(floors.nth(4)).toHaveAttribute("aria-pressed", "true");
  await expect(floors.nth(0)).toHaveAttribute("aria-pressed", "false");
  expect((await state(page)).view.floor).toBe(4);
  await floors.nth(1).click();
  await expect(page.locator("#floor-label")).toHaveText("FLOOR 02 / 4");
  await expect(page.locator("#floor-name")).toHaveText(before.floorName);
  // Keys pan the camera on the viewed floor.
  await page.locator("#world").focus();
  const start = (await state(page)).view.focus.x;
  await page.keyboard.down("d");
  await page.waitForTimeout(300);
  await page.keyboard.up("d");
  const panned = await state(page);
  expect(panned.view.floor).toBe(1);
  expect(panned.view.focus.x).toBeGreaterThan(start + 1);
  // The wheel zooms, within bounds.
  const box = (await page.locator("#world").boundingBox())!;
  const cx = box.x + box.width / 2,
    cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -100);
  await expect
    .poll(async () => (await state(page)).view.zoom)
    .toBeGreaterThan(1);
  expect((await state(page)).view.zoom).toBeLessThanOrEqual(2.5);
  await page.mouse.wheel(0, 100);
  await page.mouse.wheel(0, 100);
  await expect
    .poll(async () => (await state(page)).view.zoom)
    .toBeLessThanOrEqual(1);
  // Dragging the world right moves the focus left.
  const beforeDrag = (await state(page)).view.focus.x;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 60, cy, { steps: 4 });
  await page.mouse.move(cx + 120, cy, { steps: 4 });
  await page.mouse.up();
  const dragged = (await state(page)).view.focus.x;
  expect(dragged).toBeLessThan(beforeDrag - 1);
  expect(dragged).toBeGreaterThanOrEqual(0);
  // The summary comes back on demand and Esc toggles it.
  await page.getByRole("button", { name: "Run summary" }).click();
  await expect(
    page.getByRole("button", { name: "Begin another run" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#start-card")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.locator("#start-card")).toBeVisible();
  // Camera controls never move the dead human; the rest of the world lives.
  const after = await state(page);
  expect(after.time).toBeGreaterThan(before.time);
  expect(after.x).toBe(before.x);
  expect(after.npcs).not.toEqual(before.npcs);
  expect(after.zombies).not.toEqual(before.zombies);
  await page.locator("#pause-toggle").click();
  await expect.poll(async () => (await state(page)).paused).toBe(true);
  const paused = await state(page);
  await page.waitForTimeout(300);
  const still = await state(page);
  expect(still.time).toBe(paused.time);
  expect(still.npcs).toEqual(paused.npcs);
  expect(still.zombies).toEqual(paused.zombies);
  await page.locator("#resume-game").click();
  await expect
    .poll(async () => (await state(page)).time)
    .toBeGreaterThan(paused.time);
  // The ended save still offers spectating after a reload.
  await flushNativeSave(page);
  await page.reload();
  await page.getByRole("button", { name: "Watch the building" }).click();
  await expect(page.locator("#spectator")).toBeVisible();
  await expect(page.locator("#floor-label")).toHaveText("FLOOR 01 / 4");
  // A new run leaves spectator mode.
  await page.getByRole("button", { name: "Run summary" }).click();
  await page.getByRole("button", { name: "Begin another run" }).click();
  await startRestartedRun(page);
  await expect(page.locator("body")).not.toHaveClass(/spectating/);
  await expect(page.locator("#spectator")).toBeHidden();
  await expect(page.locator("#start-card")).toBeHidden();
  await expect(page.locator("#hud")).toBeVisible();
  expect((await state(page)).view).toBeUndefined();
});
