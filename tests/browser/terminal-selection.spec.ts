import { expect, test } from "@playwright/test";
import {
  enterNativeGame,
  mockClaudeStudy,
  openNativeQuestion,
} from "./study-harness";

/** The embedded terminal re-renders every tick; unchanged text must stay selected. */
test("terminal text stays selected while the live game renders", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await enterNativeGame(page);
  await openNativeQuestion(page);
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
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await page.waitForTimeout(650);
  expect(await page.evaluate(() => getSelection()!.toString())).toBe(before);
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.time),
  ).toBeGreaterThan(time);
  await expect(page.locator("#terminal")).toBeVisible();
});
