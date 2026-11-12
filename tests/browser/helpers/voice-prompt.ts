import type { Page } from "@playwright/test";

/**
 * The first run of a save without escape state, and every New game, ask whose
 * voice the player has before the run can start (src/main.ts `askGender`). The
 * dialog blocks `game.status` from leaving "ready", so every spec that starts a
 * game has to answer it.
 */

const BUTTONS = { man: "#gender-man", woman: "#gender-woman" } as const;

const handled = new WeakSet<Page>();

/**
 * Answer the voice dialog with Playwright's overlay handler: it fires whenever
 * the dialog is open before an action or an auto-waiting assertion. Registering
 * it twice for one page would click a closed dialog, so repeats are ignored.
 */
export async function answerVoicePrompt(
  page: Page,
  choice: "man" | "woman" = "woman",
) {
  if (handled.has(page)) return;
  handled.add(page);
  await page.addLocatorHandler(
    page.locator("#gender-dialog[open]"),
    async () => {
      await page.locator(BUTTONS[choice]).click({ noWaitAfter: true });
    },
    { noWaitAfter: true },
  );
}

/**
 * `expect.poll` and `page.waitForFunction` never run locator handlers, so a spec
 * that clicks Start and immediately polls game state answers the dialog here:
 * the button is clicked if the open dialog shows up within two seconds.
 *
 * The click goes through the DOM, because a locator click would first re-run a
 * registered overlay handler and then find the button it already closed.
 */
export async function chooseVoiceIfAsked(
  page: Page,
  choice: "man" | "woman" = "woman",
) {
  const opened = await page
    .locator("#gender-dialog[open]")
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return;
  await page.evaluate((selector) => {
    const dialog = document.querySelector<HTMLDialogElement>("#gender-dialog");
    if (!dialog?.open) return;
    document.querySelector<HTMLButtonElement>(selector)?.click();
  }, BUTTONS[choice]);
  await page
    .locator("#gender-dialog[open]")
    .waitFor({ state: "hidden", timeout: 2000 })
    .catch(() => {});
}
