// Retired: the ChatGPT handoff enable control and its status polling.
// Not built here; see ../../RE-ENABLE.md.
import { chooseDesignedRun, startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
import { test, expect } from "@playwright/test";

test("an older handoff status response cannot undo a newer local disable result", async ({
  page,
}) => {
  let release!: () => void,
    hold = false,
    controlled = false,
    held = 0;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/handoff/status", async (route) => {
    // Startup also checks relay metadata. Only hold settings requests, and
    // distinguish control completion from independent periodic status polls.
    const old = hold && !controlled;
    if (old) {
      held++;
      await gate;
    }
    await route.fulfill({
      json: {
        enabled: old,
        autonomousWork: false,
        queued: 0,
        working: 0,
        done: old ? 99 : 0,
        public: { configured: false },
      },
    });
  });
  // This fixture never forwards a control mutation to the actual bridge.
  await page.route("**/api/handoff/control", (route) => {
    controlled = true;
    return route.fulfill({ json: { enabled: false } });
  });
  await page.goto("/");
  await openGameMenu(page);
  hold = true;
  await page.locator("#settings-toggle").click();
  await expect.poll(() => held).toBeGreaterThanOrEqual(1);
  await page.locator("#handoff-enable").evaluate((input: HTMLInputElement) => {
    input.checked = false;
    input.dispatchEvent(new Event("change"));
  });
  await expect.poll(() => controlled).toBe(true);
  await expect(page.locator("#handoff-status")).toContainText("Disabled");
  const late = page.waitForResponse(
    async (response) =>
      response.url().endsWith("/api/handoff/status") &&
      (await response.json()).done === 99,
  );
  release();
  await (await late).finished();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator("#handoff-enable")).not.toBeChecked();
  await expect(page.locator("#handoff-status")).not.toContainText(
    "99 answered",
  );
});
