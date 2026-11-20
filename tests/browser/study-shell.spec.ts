import { expect, test } from "@playwright/test";
import { mockClaudeStudy } from "./study-harness";

test("the app opens straight into the learning workspace with its own menu and settings", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.locator("#study-workspace")).toBeVisible();
  await expect(page.locator(".study-skill-map")).toBeVisible();
  await expect(page.locator("#study-next")).toBeVisible();
  await expect(page.locator("#save-recovery")).toBeHidden();
  // Nothing of the removed escape-game build is in the page.
  await expect(
    page.locator("canvas, .game-layout, #start-card, #hud"),
  ).toHaveCount(0);

  const menu = page.locator("#menu");
  await page.keyboard.press("Escape");
  await expect(menu).toBeVisible();
  await expect(page.locator("#menu-title")).toHaveText("Menu");
  await expect(page.locator("#agent-tools")).toBeHidden();
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator("#settings-career-focus")).toBeFocused();
  await expect(page.locator("#display-scale-label")).toHaveText("Text size");
  await page.locator("#display-scale").fill("125");
  await expect(page.locator("#display-scale-value")).toHaveText("125%");
  expect(
    await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--display-scale"),
    ),
  ).toBe("1.25");
  // Escape leaves the panel first, then the menu, and does not reopen it.
  await page.keyboard.press("Escape");
  await expect(page.locator("#settings")).toBeHidden();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.locator("#study-menu").click();
  await expect(menu).toBeVisible();
  await page.locator("#menu-close").click();
  await expect(menu).toBeHidden();
  expect(errors).toEqual([]);
});

test("a question is asked, answered and kept across a reload", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.locator("#study-next").click();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem")).toContainText(
    "Why does the leading index column matter?",
  );
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  await expect(page.locator("#workspace")).toHaveCount(0);
  await page.locator("#chat-input").fill("It decides which rows are skipped");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  await expect(page.locator("#messages .message")).toHaveCount(2);
  await expect(page.locator("#messages")).toContainText(
    "What would the planner do then?",
  );
  await expect(page.locator("#messages .message strong").last()).toHaveText(
    "Tutor",
  );

  await page.evaluate(async () => {
    window.dispatchEvent(new Event("pagehide"));
    const root = "/src/";
    const { flushSaves } = await import(
      /* @vite-ignore */ root + "persistence.ts"
    );
    await flushSaves();
  });
  await page.reload();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#messages .message")).toHaveCount(2);
  await expect(page.locator("#messages")).toContainText(
    "It decides which rows are skipped",
  );
  expect(errors).toEqual([]);
});

test("without Claude the question is locked behind the connection steps and unlocks on a recheck", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false);
  await page.goto("/");
  await page.locator("#study-next").click();
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText(
    "Connect Claude to open this question",
  );
  await expect(page.locator("#terminal-connect-steps li")).not.toHaveCount(0);
  await expect(page.locator("#terminal-body")).toBeHidden();
  relay.setAvailable(true);
  await page.locator("#terminal-connect-retry").click();
  await expect(page.locator("#terminal-body")).toBeVisible();
  await expect(page.locator("#problem")).toContainText(
    "Why does the leading index column matter?",
  );
});

test("an unreadable save shows the recovery card and a restored backup opens the workspace", async ({
  page: first,
  browser,
}, testInfo) => {
  await mockClaudeStudy(first);
  await first.goto("/");
  await expect(first.locator("#study-workspace")).toBeVisible();
  const backup = await first.evaluate(async () => {
    const root = "/src/";
    const { encode } = await import(/* @vite-ignore */ root + "persistence.ts");
    return encode((window as any).__studyApp.record);
  });
  // A browser with no durable copy and a damaged local one.
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const page = await context.newPage();
  await mockClaudeStudy(page);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("synthetic-corrupt-save-seeded")) {
      localStorage.setItem("dead-air-save-v1", "synthetic damaged checkpoint");
      sessionStorage.setItem("synthetic-corrupt-save-seeded", "1");
    }
  });
  await page.goto("/");
  await expect(page.locator("#save-recovery")).toBeVisible();
  await expect(page.locator("#save-recovery-status")).toContainText(
    "Existing checkpoints have been protected",
  );
  await expect(page.locator("#study-workspace")).toBeHidden();
  // The damaged bytes are not overwritten while the card is up.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("blur"));
    window.dispatchEvent(new Event("pagehide"));
  });
  expect(
    await page.evaluate(() => localStorage.getItem("dead-air-save-v1")),
  ).toBe("synthetic damaged checkpoint");
  await page.locator("#save-recovery-import").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{}"),
  });
  await expect(page.locator("#save-recovery-status")).toContainText(
    "Import rejected",
  );
  await page.locator("#save-recovery-import").setInputFiles({
    name: "backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(backup),
  });
  await expect(page.locator("#study-workspace")).toBeVisible();
  await expect(page.locator("#save-recovery")).toBeHidden();
  await expect(page.locator(".study-skill-map")).toBeVisible();
  await context.close();
});
