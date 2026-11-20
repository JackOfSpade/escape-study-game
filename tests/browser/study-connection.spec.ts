import { expect, test } from "@playwright/test";
import {
  mockClaudeStudy,
  openStudyQuestion,
  studyState,
} from "./study-harness";

test("without Claude a question lists the steps to enable it, then unlocks itself once Claude returns", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false, "cli-missing");
  const id = await openStudyQuestion(page);
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await expect(page.locator("#terminal-body")).toBeHidden();
  await expect(page.locator("#problem-title")).toHaveText(
    "Connect Claude to open this question",
  );
  await expect(page.locator("#terminal-connect-steps li")).not.toHaveCount(0);
  await expect(page.locator("#terminal-connect-steps")).toContainText(
    "claude auth login",
  );
  expect(relay.calls.filter((c) => c.operation === "generate")).toHaveLength(0);
  expect((await studyState(page, id)).problem).toBeUndefined();
  await page.locator("#chat-input").evaluate(() => {});
  await page.evaluate((id) => {
    (window as any).__studyApp.record.encounters[id].chatDraft =
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
  expect(
    await page.evaluate(
      (id) => (window as any).__studyApp.record.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Preserved unsent clarification");
});

test("the Check again button unlocks the question at once with exactly one generate call and names the actual cause", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false, "signed-out");
  const id = await openStudyQuestion(page);
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await expect(page.locator("#terminal-connect-problem")).toContainText(
    "not signed in",
  );
  await expect(page.locator("#terminal-connect-steps")).toContainText(
    "claude auth login",
  );
  expect(relay.calls).toHaveLength(0);
  await page.evaluate((id) => {
    (window as any).__studyApp.record.encounters[id].chatDraft =
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
      (id) => (window as any).__studyApp.record.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Unsent idea remains local");
});

test("rechecking the connection from settings restores it without a tutor request or touching unsent work", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page, false);
  const id = await openStudyQuestion(page);
  await expect(page.locator("#terminal-connect")).toBeVisible();
  await page.evaluate((id) => {
    (window as any).__studyApp.record.encounters[id].chatDraft =
      "Unsent idea remains local";
  }, id);
  await page.keyboard.press("Escape");
  await page.locator("#settings-toggle").click();
  await expect(page.locator("#settings")).toBeVisible();
  await page.locator("#study-connection-settings summary").click();
  relay.setAvailable(true);
  await page.locator("#reconnect").click();
  await expect(page.locator("#terminal-connect")).toBeHidden();
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  expect(relay.tutorCalls()).toHaveLength(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__studyApp.record.encounters[id].chatDraft,
      id,
    ),
  ).toBe("Unsent idea remains local");
});
