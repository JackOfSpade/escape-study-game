import { expect, test } from "@playwright/test";
import { openPlayerMenu } from "./helpers/game-menu";
import {
  enterNativeGame,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
} from "./study-harness";

test("retrying an unavailable study connection asks Claude once and keeps the learner's unsent work", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#completion-connection")).toContainText(
    "study connection is unavailable",
  );
  await expect(page.locator("#completion-connection")).toContainText(
    "Claude CLI",
  );
  await expect(page.locator("#retry-connection")).toBeVisible();
  expect(relay.calls).toHaveLength(0);
  expect((await nativeState(page, id)).problem).toBeUndefined();
  await page.locator("#chat-input").fill("Preserved unsent clarification");
  await page.evaluate((id) => {
    (window as any).__deadAir.game.encounters[id].chatDraft =
      "Preserved unsent clarification";
  }, id);

  relay.setAvailable(true);
  await page.locator("#retry-connection").click();
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  await expect(page.locator("#retry-connection")).toBeHidden();
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

test("rechecking the connection from settings restores it without a tutor request or touching unsent work", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#retry-connection")).toBeVisible();
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
  await expect(page.locator("#live-profile")).toBeVisible();
  expect(relay.tutorCalls()).toHaveLength(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Unsent idea remains local");
  expect((await nativeState(page, id)).keys).toBe(0);
});
