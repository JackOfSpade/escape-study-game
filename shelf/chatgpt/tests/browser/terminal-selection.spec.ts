import { expect, test } from "@playwright/test";
import {
  enterNativeGame,
  mockNativeStudy,
  openNativeQuestion,
} from "./native-study-harness";

/** The game only displays a small status card; questions live in native chat. */
test("native status text stays selected while the live game renders", async ({
  page,
}) => {
  await mockNativeStudy(page);
  await enterNativeGame(page);
  await openNativeQuestion(page);
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector("#native-study-title")!);
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
  await expect(page.locator("#terminal")).toBeHidden();
});

test("copying the native request creates no answer or substitute composer", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "clipboard permission is Chromium-only",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const relay = await mockNativeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await page.locator("#native-study-copy").click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("get_current_study_question");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "finish_study_question",
  );
  expect(relay.calls).toHaveLength(1);
  const state = await page.evaluate((id) => {
    const e = (window as any).__deadAir.game.encounters[id];
    return {
      humans: e.tutor.filter((m: any) => m.kind === "human").length,
      submissions: e.submissions.length,
    };
  }, id);
  expect(state).toEqual({ humans: 0, submissions: 0 });
  await expect(page.locator("#chat-input")).toBeHidden();
  await expect(page.locator("#workspace")).toBeHidden();
});
