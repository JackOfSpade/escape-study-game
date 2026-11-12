import { openGameMenu, openPlayerMenu } from "./helpers/game-menu";
import { expect, test, type Page } from "./helpers/offline-test";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import {
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
  seedLegacyDraft,
} from "./study-harness";
import { answerVoicePrompt } from "./helpers/voice-prompt";

// A legacy save has no escape state: its first Start asks for the voice.
test.beforeEach(async ({ page }) => {
  await answerVoicePrompt(page);
});

async function safeRun(page: Page) {
  await mockClaudeStudy(page);
  await enterLegacyBuilding(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    g.survivors = [a];
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
    f.furniture = [];
    Object.assign(a, { x: 10, y: 10, hp: 60 });
    a.inventory = [
      { id: "keyboard-medkit", kind: "medkit", weight: 1, charges: 1 },
    ];
    f.stations = [{ ...f.stations[0], x: 10.8, y: 10 }];
  });
}
async function survivor(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0];
    return { x: a.x, y: a.y, hp: a.hp, inventory: a.inventory, time: g.time };
  });
}

test("curriculum dropdown owns navigation and shortcuts while survival stays paused", async ({
  page,
}) => {
  await safeRun(page);
  await openGameMenu(page);
  await page.getByRole("button", { name: "Inspect ↗" }).click();
  await page
    .getByText("Practical environment observations", { exact: true })
    .click();
  const select = page.locator("#environment-item");
  await select.focus();
  await page.evaluate(() => {
    (window as any).keyboardDefaults = [];
    window.addEventListener("keydown", (event) => {
      (window as any).keyboardDefaults.push({
        code: event.code,
        prevented: event.defaultPrevented,
      });
    });
  });
  const before = await survivor(page);
  await page.keyboard.down("ArrowDown");
  await page.waitForTimeout(400);
  await page.keyboard.up("ArrowDown");
  await page.keyboard.press("1");
  await page.keyboard.press("e");
  const after = await survivor(page);
  expect({ ...after, time: before.time }).toEqual(before);
  expect(after.time).toBe(before.time);
  expect(await page.evaluate(() => (window as any).__deadAir.game.paused)).toBe(
    true,
  );
  await expect(page.locator("#terminal")).toBeHidden();
  expect(await page.evaluate(() => (window as any).keyboardDefaults)).toEqual([
    { code: "ArrowDown", prevented: false },
    { code: "Digit1", prevented: false },
    { code: "KeyE", prevented: false },
  ]);
});

test("settings has keyboard focus and explicit close preserves the open Claude question", async ({
  page,
}) => {
  await safeRun(page);
  await seedLegacyDraft(page, "preserved while changing settings");
  const id = await openNativeQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  const captured = await nativeState(page, id);
  await openPlayerMenu(page);
  const toggle = page.getByRole("button", { name: "Settings", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("dialog", { name: "Transmission settings" }),
  ).toBeVisible();
  await expect(page.locator("#volume")).toBeFocused();
  const before = await survivor(page);
  await page.keyboard.press("ArrowLeft");
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#pause-home")).toBeVisible();
  await expect(toggle).toBeFocused();
  expect((await nativeState(page, id)).problem).toBe(captured.problem);
  expect(captured.workspace).toBe("preserved while changing settings");
  expect((await nativeState(page, id)).workspace).toBe(captured.workspace);
  const after = await survivor(page);
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  expect(after.time).toBe(before.time);
  await page.locator("#resume-game").click();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#pause-toggle")).toBeFocused();
  await page.locator("#world").focus();
  await expect(page.locator("#world")).toBeFocused();
  await page.keyboard.down("w");
  await page.waitForTimeout(200);
  await page.keyboard.up("w");
  expect((await survivor(page)).y).toBeLessThan(before.y);
});

test("opening panels clears held movement and close restores the invoking control", async ({
  page,
}) => {
  await safeRun(page);
  await page.locator("#world").focus();
  await page.keyboard.down("d");
  await page.waitForTimeout(100);
  await openPlayerMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const before = await survivor(page);
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.waitForTimeout(200);
  const after = await survivor(page);
  expect([after.x, after.y]).toEqual([before.x, before.y]);
  expect(after.time).toBe(before.time);
  await page.keyboard.up("d");
  await expect(page.locator("#settings-toggle")).toBeFocused();
  const inspect = page.locator("#curriculum-button");
  await openGameMenu(page);
  await inspect.click();
  await expect(
    page.getByRole("dialog", { name: "Learning continuity", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#inspector-title")).toBeFocused();
  await page.locator("#close-inspector").click();
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(inspect).toBeFocused();
  await expect(page.locator("#pause-home")).toBeVisible();
});

for (const view of ["top-down", "first-person"] as const) {
  test.describe(view, () => {
    // GPU-less CI renders WebGL on the CPU, so every 3D pixel costs frame time.
    // This flow checks menus and focus, not rendering detail.
    if (view === "first-person")
      test.use({ viewport: { width: 960, height: 640 } });
    test(`pause submenus return home before Esc resumes the world (${view})`, async ({
      page,
    }) => {
      await safeRun(page);
      await page.evaluate((v) => {
        (window as any).__deadAir.game.settings.view = v;
      }, view);
      const canvas = page.locator(
        view === "first-person" ? "#view3d" : "#world",
      );
      await expect(canvas).toBeVisible();
      await canvas.focus();
      const inspect = page.locator("#curriculum-button"),
        settings = page.locator("#settings-toggle");
      await openGameMenu(page);
      await inspect.click();
      await expect(inspect).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#pause-home")).toBeHidden();
      await expect(page.locator("#settings")).toBeHidden();
      await expect(page.locator("#pause-back")).toBeVisible();
      const before = await survivor(page);
      await page.keyboard.press("Escape");
      await expect(page.locator("#inspector")).toBeHidden();
      await expect(page.locator("#pause-home")).toBeVisible();
      await expect(inspect).toBeFocused();
      await expect(inspect).toHaveAttribute("aria-expanded", "false");

      await settings.click();
      await expect(settings).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator("#pause-home")).toBeHidden();
      await expect(page.locator("#inspector")).toBeHidden();
      await page.getByRole("button", { name: "Back to pause menu" }).click();
      await expect(page.locator("#settings")).toBeHidden();
      await expect(settings).toBeFocused();
      await expect(settings).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#pause-home")).toBeVisible();
      expect((await survivor(page)).time).toBe(before.time);
      expect(
        await page.evaluate(() => (window as any).__deadAir.game.paused),
      ).toBe(true);

      await page.keyboard.press("Escape");
      await expect(page.locator("#pause-menu")).toBeHidden();
      await expect(canvas).toBeFocused();
      const yaw =
        view === "first-person"
          ? await page.evaluate(
              () => (window as any).__deadAir.look().yaw as number,
            )
          : -Math.PI / 2;
      const facing = { x: Math.cos(yaw), y: Math.sin(yaw) };
      await page.keyboard.down("w");
      await page.waitForTimeout(200);
      await page.keyboard.up("w");
      const after = await survivor(page);
      const forward =
        (after.x - before.x) * facing.x + (after.y - before.y) * facing.y;
      const lateral =
        (after.x - before.x) * -facing.y + (after.y - before.y) * facing.x;
      expect(forward).toBeGreaterThan(0.3);
      expect(Math.abs(lateral)).toBeLessThan(0.05);
      if (view === "top-down") expect(after.y).toBeLessThan(before.y);
    });
  });
}
