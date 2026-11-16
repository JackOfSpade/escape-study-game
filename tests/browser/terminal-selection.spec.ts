import { expect, test } from "@playwright/test";
import { mockClaudeStudy, openStudyQuestion } from "./study-harness";

/** The question panel re-renders on every tick; unchanged text must stay selected. */
test("question text stays selected while the workspace re-renders", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await openStudyQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#problem-title")!);
    const selection = getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  const before = await page.evaluate(() => getSelection()!.toString());
  expect(before.length).toBeGreaterThan(3);
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(before);
  await expect(page.locator("#terminal")).toBeVisible();
});
