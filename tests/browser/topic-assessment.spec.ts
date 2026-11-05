import { expect, test, type Page } from "@playwright/test";
import { mockClaudeStudy } from "./study-harness";

async function enterStudy(page: Page) {
  await page.goto("/");
  await page.locator("#study-only-toggle").click();
  await expect(page.locator("#study-workspace")).toBeVisible();
}

test("the skill map has one tab stop, arrow navigation and keyboard disclosures", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterStudy(page);
  const toggles = page.locator(".study-topic-toggle");
  const first = toggles.first();
  const last = toggles.last();
  await expect(page.locator('.study-topic-toggle[tabindex="0"]')).toHaveCount(
    1,
  );
  await page.locator("#study-only-exit").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator('.study-topic-toggle[tabindex="0"]')).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#study-next")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Home");
  await expect(first).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Space");
  await expect(first).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(toggles.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(last).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(last).toBeFocused();
  await expect(page.locator('.study-topic-toggle[tabindex="0"]')).toHaveCount(
    1,
  );
  expect(relay.calls).toHaveLength(0);

  // A real map update retains the keyboard position and disclosure state.
  await page.keyboard.press("Space");
  await expect(last).toHaveAttribute("aria-expanded", "true");
  await page.evaluate(() => {
    const d = (window as any).__deadAir;
    const o = d.roadmap.tracks.PY.objectives.find(
      (o: any) => d.game.study.learner.cells[o.id].states[0] !== "P",
    );
    d.game.study.learner.cells[o.id].states[0] = "P";
  });
  await expect(page.locator(".study-map-root")).toContainText("8 of 131");
  await expect(last).toBeFocused();
  await expect(last).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(page.locator("#study-next")).toBeFocused();
});
