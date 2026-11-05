import { expect, test } from "@playwright/test";
import { openPlayerMenu } from "./helpers/game-menu";
import {
  enterNativeGame,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
} from "./study-harness";

const gameTime = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as any).__deadAir.game.time as number);

test("without Claude a terminal pauses the game and lists the steps to enable it, then unlocks itself once Claude returns", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false, "cli-missing");
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await expect(page.locator("#terminal-body")).toBeHidden();
  await expect(page.locator("#problem-title")).toHaveText(
    "Connect Claude to use this terminal",
  );
  await expect(page.locator("#terminal-connect-steps li")).not.toHaveCount(0);
  await expect(page.locator("#terminal-connect-steps")).toContainText(
    "claude auth login",
  );
  expect(relay.calls.filter((c) => c.operation === "generate")).toHaveLength(0);
  expect((await nativeState(page, id)).problem).toBeUndefined();
  // The simulation is paused for as long as the terminal is locked.
  const frozen = await gameTime(page);
  await page.waitForTimeout(800);
  expect(await gameTime(page)).toBe(frozen);
  await page.locator("#chat-input").evaluate(() => {});
  await page.evaluate((id) => {
    (window as any).__deadAir.game.encounters[id].chatDraft =
      "Preserved unsent clarification";
  }, id);

  // Claude comes back: the locked terminal notices within a few seconds.
  relay.setAvailable(true);
  await expect(page.locator("#problem-title")).toHaveText(
    "Synthetic question",
    { timeout: 8000 },
  );
  await expect(page.locator("#terminal-connect")).toBeHidden();
  await expect(page.locator("#terminal-body")).toBeVisible();
  expect(relay.calls.filter((c) => c.operation === "generate")).toHaveLength(1);
  expect(relay.tutorCalls()).toHaveLength(0);
  expect((await nativeState(page, id)).keys).toBe(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Preserved unsent clarification");
});

test("the Check again button unlocks the terminal at once with exactly one generate call and names the actual cause", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false, "signed-out");
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await expect(page.locator("#terminal-connect-problem")).toContainText(
    "not signed in",
  );
  await expect(page.locator("#terminal-connect-steps")).toContainText(
    "claude auth login",
  );
  expect(relay.calls).toHaveLength(0);
  await page.evaluate((id) => {
    (window as any).__deadAir.game.encounters[id].chatDraft =
      "Unsent idea remains local";
  }, id);
  relay.setAvailable(true);
  await page.locator("#terminal-connect-retry").click();
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  await expect(page.locator("#terminal-connect")).toBeHidden();
  expect(relay.calls.filter((c) => c.operation === "generate")).toHaveLength(1);
  expect(relay.tutorCalls()).toHaveLength(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Unsent idea remains local");
  expect((await nativeState(page, id)).keys).toBe(0);
});

test("rechecking the connection from settings restores it without a tutor request or touching unsent work", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await page.evaluate((id) => {
    (window as any).__deadAir.game.encounters[id].chatDraft =
      "Unsent idea remains local";
  }, id);
  await openPlayerMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.locator("#settings")).toBeVisible();
  await page.locator("#study-connection-settings summary").click();
  relay.setAvailable(true);
  await page.locator("#reconnect").click();
  await expect(page.locator("#bridge-label")).toContainText("Claude CLI");
  await expect(page.locator("#reconnect")).toBeHidden();
  expect(relay.tutorCalls()).toHaveLength(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Unsent idea remains local");
  expect((await nativeState(page, id)).keys).toBe(0);
});
