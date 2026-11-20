import type { Page } from "@playwright/test";

/** Agent diagnostics stay available to synthetic browser fixtures without
 * adding developer controls to the normal learner menu. */
export async function openAgentMenu(page: Page) {
  await page.waitForFunction(
    () => typeof (window as any).__studyApp?.openAgentMenu === "function",
  );
  await page.evaluate(() => (window as any).__studyApp.openAgentMenu());
}

/** The app is the study workspace: open it and wait for its saved record. */
export async function openApp(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__studyApp?.record);
}

/** Give the open record the four unasked questions that fixtures name
 * (`question-0` to `question-3`), as `tests/helpers/record.ts` does for units. */
export async function seedQuestions(page: Page) {
  await page.evaluate(async () => {
    const { question } = await import(
      /* @vite-ignore */ "/tests/helpers/" + "record.ts"
    );
    const g = (window as any).__studyApp.record;
    for (let i = 0; i < 4; i++)
      g.encounters[`question-${i}`] ??= question(g, `question-${i}`);
  });
}
