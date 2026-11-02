import { expect, test, type Page } from "@playwright/test";
import { openPlayerMenu } from "./helpers/game-menu";
import {
  enterNativeGame,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
  seedLegacyDraft,
} from "./study-harness";

async function openSettings(page: Page) {
  await openPlayerMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#volume")).toBeFocused();
}

async function setScale(page: Page, percent: number) {
  await page
    .getByRole("slider", { name: "Game and text size" })
    .fill(String(percent));
  await expect(page.locator("#display-scale-value")).toHaveText(`${percent}%`);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.settings.displayScale),
    )
    .toBe(percent / 100);
}

/** Measure physical text bounds and the actual world drawing transform. The
 * synthetic canvas has a fixed size, so responsive layout cannot mimic zoom. */
async function displayedSizes(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const title = document.querySelector("#settings-title")!,
      range = document.createRange();
    range.selectNodeContents(title);
    const textHeight = range.getBoundingClientRect().height;
    const root = "/src/",
      [{ render }, { TestRunner }] = await Promise.all([
        import(/* @vite-ignore */ root + "render.ts"),
        import(/* @vite-ignore */ root + "gametest/runner.ts"),
      ]),
      scenario = await (
        await fetch("/tests/fixtures/gametest/force-field-green.json")
      ).json();
    scenario.actions = [];
    scenario.checks = [];
    scenario.entities = scenario.entities.filter(
      (e: any) => e.kind !== "zombie",
    );
    scenario.entities.push({ id: "probe", kind: "npc", x: 11, y: 11.8 });
    const g = new TestRunner(scenario, (window as any).__deadAir.roadmap).game;
    g.settings.view = "top-down";
    g.settings.displayScale = (
      window as any
    ).__deadAir.game.settings.displayScale;
    g.survivors[1].name = "Display scale probe";
    const canvas = document.createElement("canvas");
    canvas.style.cssText =
      "width:600px;height:400px;position:fixed;left:-10000px;top:0";
    document.body.append(canvas);
    try {
      // Keep this probe at the same physical dimensions even when an ancestor
      // is zoomed, so its own layout cannot account for larger world labels.
      const rect = canvas.getBoundingClientRect();
      canvas.style.width = `${(600 * canvas.clientWidth) / rect.width}px`;
      canvas.style.height = `${(400 * canvas.clientHeight) / rect.height}px`;
      const ctx = canvas.getContext("2d")!,
        fillText = ctx.fillText.bind(ctx);
      let worldScale = 0;
      ctx.fillText = (text, x, y, ...rest) => {
        if (text === "Display scale probe") worldScale = ctx.getTransform().a;
        fillText(text, x, y, ...rest);
      };
      render(canvas, g, { floor: 0, focus: g.survivors[0], zoom: 1 });
      return { textHeight, worldScale };
    } finally {
      canvas.remove();
    }
  });
}

let relay: Awaited<ReturnType<typeof mockClaudeStudy>>;
test.beforeEach(async ({ page }) => {
  relay = await mockClaudeStudy(page);
});

test("one size slider scales text and the rendered world together and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await openSettings(page);
  const slider = page.getByRole("slider", { name: "Game and text size" });
  await expect(slider).toHaveAttribute("min", "75");
  await expect(slider).toHaveAttribute("max", "150");
  await expect(slider).toHaveAttribute("step", "5");
  await expect(slider).toHaveValue("100");
  await expect(page.locator("#display-scale-value")).toHaveText("100%");
  const normal = await displayedSizes(page);
  expect(normal.textHeight).toBeGreaterThan(0);
  expect(normal.worldScale).toBeGreaterThan(0);

  await setScale(page, 150);
  const large = await displayedSizes(page);
  expect(large.textHeight / normal.textHeight).toBeCloseTo(1.5, 1);
  expect(large.worldScale / normal.worldScale).toBeCloseTo(1.5, 5);

  await setScale(page, 75);
  const small = await displayedSizes(page);
  expect(small.textHeight / normal.textHeight).toBeCloseTo(0.75, 1);
  expect(small.worldScale / normal.worldScale).toBeCloseTo(0.75, 5);

  await setScale(page, 125);
  await page.locator("#settings-close").click();
  await page.reload();
  await openSettings(page);
  await expect(slider).toHaveValue("125");
  await expect(page.locator("#display-scale-value")).toHaveText("125%");
  expect(
    (await displayedSizes(page)).textHeight / normal.textHeight,
  ).toBeCloseTo(1.25, 1);
});

test("a saved run without the size preference opens at 100 percent", async ({
  page,
}) => {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.evaluate(async () => {
    const root = "/src/",
      { save, flushSaves } = await import(
        /* @vite-ignore */ root + "persistence.ts"
      ),
      g = (window as any).__deadAir.game;
    delete g.settings.displayScale;
    await save(g);
    await flushSaves();
  });
  await page.reload();
  await openSettings(page);
  await expect(page.locator("#display-scale")).toHaveValue("100");
  await expect(page.locator("#display-scale-value")).toHaveText("100%");
  const size = await displayedSizes(page);
  expect(size.textHeight).toBeGreaterThan(0);
  expect(size.worldScale).toBeGreaterThan(0);
});

test("maximum size keeps Settings and study controls usable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await enterNativeGame(page);
  await seedLegacyDraft(page, "Draft kept while resizing");
  const id = await openNativeQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  const asked = relay.calls.length;
  await openSettings(page);
  await setScale(page, 150);
  await expect(page.locator("#settings")).toBeInViewport({ ratio: 0.98 });
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings")).toBeHidden();
  await page.locator("#resume-game").click();
  expect(relay.calls).toHaveLength(asked);
  expect((await nativeState(page, id)).state).not.toBe("consumed");
  await expect(page.locator("#terminal")).toBeVisible();

  for (const id of ["pause-toggle"]) {
    const control = page.locator(`#${id}`);
    await control.scrollIntoViewIfNeeded();
    await expect(control).toBeInViewport();
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await expect(page.locator("#terminal")).toBeVisible();
});
