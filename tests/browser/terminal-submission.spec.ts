import { expect, test } from "@playwright/test";
import {
  flushStudySave,
  mockClaudeStudy,
  openStudyQuestion,
  studyState,
} from "./study-harness";

test("a reply that cannot be accepted keeps the exact request and its retry completes once", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const id = await openStudyQuestion(page);
  await expect(page.locator("#workspace")).toBeHidden();
  relay.reply(() => ({
    text: "Solved.",
    complete: true,
    knowledge: { facets: "not-a-report" },
  }));
  await page.locator("#chat-input").fill("My complete reasoning");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  const retry = page.locator("button[data-question-retry]");
  await expect(retry).toBeVisible();
  const interrupted = await studyState(page, id);
  expect(interrupted.submissions).toBe(0);
  relay.solve();
  await retry.click();
  await expect.poll(() => relay.tutorCalls().length).toBe(2);
  expect(relay.tutorCalls()[1].payload).toEqual(relay.tutorCalls()[0].payload);
  const completed = await studyState(page, id);
  expect(completed.submissions).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect((await studyState(page, id)).submissions).toBe(1);
  expect(relay.tutorCalls()).toHaveLength(2);
  expect(errors).toEqual([]);
});
