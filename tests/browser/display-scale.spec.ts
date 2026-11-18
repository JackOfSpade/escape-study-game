import { expect, test, type Page } from "@playwright/test";
import {
  mockClaudeStudy,
  openStudyQuestion,
  studyState,
} from "./study-harness";

async function openSettings(page: Page) {
  // Escape is handled only once the saved record has loaded.
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.keyboard.press("Escape");
  await expect(page.locator("#pause-menu")).toBeVisible();
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#settings-career-focus")).toBeFocused();
}

async function setScale(page: Page, percent: number) {
  await page.getByRole("slider", { name: "Text size" }).fill(String(percent));
  await expect(page.locator("#display-scale-value")).toHaveText(`${percent}%`);
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.settings.displayScale),
    )
    .toBe(percent / 100);
}

/** The rendered height of the settings title, in physical pixels. */
async function textHeight(page: Page) {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#settings-title")!);
    return range.getBoundingClientRect().height;
  });
}

let relay: Awaited<ReturnType<typeof mockClaudeStudy>>;
test.beforeEach(async ({ page }) => {
  relay = await mockClaudeStudy(page);
});

test("one size slider scales text and survives reload", async ({ page }) => {
  await page.goto("/");
  await openSettings(page);
  const slider = page.getByRole("slider", { name: "Text size" });
  await expect(slider).toHaveAttribute("min", "75");
  await expect(slider).toHaveAttribute("max", "150");
  await expect(slider).toHaveAttribute("step", "5");
  await expect(slider).toHaveValue("100");
  await expect(page.locator("#display-scale-value")).toHaveText("100%");
  const normal = await textHeight(page);
  expect(normal).toBeGreaterThan(0);

  await setScale(page, 150);
  expect((await textHeight(page)) / normal).toBeCloseTo(1.5, 1);
  await setScale(page, 75);
  expect((await textHeight(page)) / normal).toBeCloseTo(0.75, 1);

  await setScale(page, 125);
  await page.locator("#settings-close").click();
  await page.reload();
  await openSettings(page);
  await expect(slider).toHaveValue("125");
  await expect(page.locator("#display-scale-value")).toHaveText("125%");
  expect((await textHeight(page)) / normal).toBeCloseTo(1.25, 1);
});

test("a saved record without the size preference opens at 100 percent", async ({
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
  expect(await textHeight(page)).toBeGreaterThan(0);
});

test("maximum size keeps Settings and study controls usable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const id = await openStudyQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  const asked = relay.calls.length;
  await openSettings(page);
  await setScale(page, 150);
  await expect(page.locator("#settings")).toBeInViewport({ ratio: 0.98 });
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings")).toBeHidden();
  await page.locator("#menu-close").click();
  expect(relay.calls).toHaveLength(asked);
  expect((await studyState(page, id)).state).not.toBe("consumed");
  await expect(page.locator("#terminal")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});
