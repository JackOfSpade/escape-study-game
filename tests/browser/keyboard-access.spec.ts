import { openAgentMenu } from "./helpers/agent-menu";
import { expect, test } from "./helpers/offline-test";
import {
  mockClaudeStudy,
  openStudyQuestion,
  studyState,
} from "./study-harness";

test("curriculum dropdown owns its keys while it has focus", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__studyApp?.record);
  await openAgentMenu(page);
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
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("1");
  await page.keyboard.press("e");
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
  await mockClaudeStudy(page);
  const id = await openStudyQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  await page.evaluate((id) => {
    (window as any).__studyApp.record.encounters[id].workspace =
      "preserved while changing settings";
  }, id);
  const captured = await studyState(page, id);
  await page.keyboard.press("Escape");
  const toggle = page.locator("#settings-toggle");
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator("#settings-career-focus")).toBeFocused();
  await page.locator("#settings-close").click();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#menu-home")).toBeVisible();
  await expect(toggle).toBeFocused();
  expect((await studyState(page, id)).problem).toBe(captured.problem);
  expect((await studyState(page, id)).workspace).toBe(captured.workspace);
  await page.locator("#menu-close").click();
  await expect(page.locator("#terminal")).toBeVisible();
});

test("closing a panel restores the invoking control", async ({ page }) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__studyApp?.record);
  await page.keyboard.press("Escape");
  await page.locator("#settings-toggle").click();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.locator("#settings-toggle")).toBeFocused();
  const inspect = page.locator("#curriculum-button");
  await openAgentMenu(page);
  await inspect.click();
  await expect(
    page.getByRole("dialog", { name: "Learning continuity", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#inspector-title")).toBeFocused();
  await page.locator("#close-inspector").click();
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(inspect).toBeFocused();
  await expect(page.locator("#menu-home")).toBeVisible();
});

test("menu submenus return home before Esc closes the menu", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__studyApp?.record);
  const inspect = page.locator("#curriculum-button"),
    settings = page.locator("#settings-toggle");
  await openAgentMenu(page);
  await inspect.click();
  await expect(inspect).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#menu-home")).toBeHidden();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(page.locator("#menu-back")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#inspector")).toBeHidden();
  await expect(page.locator("#menu-home")).toBeVisible();
  await expect(inspect).toBeFocused();
  await expect(inspect).toHaveAttribute("aria-expanded", "false");

  await settings.click();
  await expect(settings).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#menu-home")).toBeHidden();
  await expect(page.locator("#inspector")).toBeHidden();
  await page.getByRole("button", { name: "Back to menu" }).click();
  await expect(page.locator("#settings")).toBeHidden();
  await expect(settings).toBeFocused();
  await expect(settings).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#menu-home")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator("#menu")).toBeHidden();
});
