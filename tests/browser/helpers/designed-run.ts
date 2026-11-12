import { expect, test, type Page } from "@playwright/test";
import { environmentDesignFixture } from "../../helpers/environment-design";
import { qualityFixtureReply } from "../../helpers/quality-design";
import { answerVoicePrompt, chooseVoiceIfAsked } from "./voice-prompt";

/** A New game asks for the voice before it requests the design, sometimes after
 * an epilogue request has settled, so give that prompt the full allowance. */
async function settleVoice(page: Page) {
  await answerVoicePrompt(page);
  await chooseVoiceIfAsked(page);
}

/** Click Start. A run without escape state asks for the voice immediately, and
 * the status waits that follow never run locator handlers, so answer it here.
 * A preparing run opens the design dialog first and asks only on the Start
 * after it, so it is never prompted. */
async function clickStart(page: Page) {
  await page.locator("#start").click();
  const prompted = await page.evaluate(() => {
    const game = (window as any).__deadAir?.game;
    return !!game && !game.preparingRun && !game.escape;
  });
  if (prompted) await chooseVoiceIfAsked(page);
}

const design = environmentDesignFixture();
interface SyntheticDesigner {
  active: boolean;
  restoring: boolean;
  previousStatus?: unknown;
  previousRunId?: string;
  previousView?: string;
  preparationStarted?: number;
  previousTimeout?: number;
}
const designers = new WeakMap<Page, SyntheticDesigner>();

async function syntheticDesigner(page: Page, activate = true) {
  let designer = designers.get(page);
  if (!designer) {
    designer = { active: false, restoring: false };
    designers.set(page, designer);
    const state = designer;
    // The captured environmental fixture uses seed 42. Only the run-seed
    // request is fixed; IDs and every other source of randomness stay intact.
    const fixedRunSeed = () => {
      const random = crypto.getRandomValues.bind(crypto);
      Object.defineProperty(crypto, "getRandomValues", {
        configurable: true,
        value(array: any) {
          if (array instanceof Uint32Array && array.length === 1) {
            array[0] = 42;
            return array;
          }
          return random(array);
        },
      });
    };
    await page.addInitScript(fixedRunSeed);
    await page.evaluate(fixedRunSeed);
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/api/status" && (state.active || state.restoring))
        return route.fulfill({
          json: state.restoring
            ? state.previousStatus
            : {
                mode: "claude-cli",
                label: "Synthetic run designer",
                detail: "Offline fixture; no external model",
                capabilities: ["design-run"],
              },
        });
      if (
        path === "/api/bridge" &&
        request.method() === "POST" &&
        request.postDataJSON()?.operation === "design-run"
      ) {
        const body = request.postDataJSON();
        if (!state.active)
          return route.fulfill({
            status: 503,
            json: { error: "Synthetic run designer has not been enabled." },
          });
        // Restore the real requested view before the player presses Start, so
        // first-person entry still performs its ordinary mouse-capture action.
        if (body.payload.phase === "content-review")
          await page.evaluate((view) => {
            (window as any).__deadAir.game.settings.view = view;
          }, state.previousView);
        return route.fulfill({
          json: qualityFixtureReply(body.payload, design, [design]),
        });
      }
      if (path === "/api/bridge" && request.method() === "POST") {
        const operation = request.postDataJSON()?.operation;
        // Escape narration has no synthetic answer: fail fast so the game falls
        // back offline instead of leaving the request in flight.
        if (typeof operation === "string" && operation.startsWith("escape-"))
          return route.fulfill({
            status: 503,
            json: {
              error: `No synthetic ${operation} in the browser fixture.`,
            },
          });
      }
      return route.fallback();
    });
  }
  if (activate && !designer.active) {
    // The former instant fixture is now thirty real generation stages. Give
    // preparation its own bounded allowance, then charge only its actual time;
    // the original gameplay/assertion budget stays unchanged.
    designer.previousTimeout = test.info().timeout;
    designer.preparationStarted = performance.now();
    if (designer.previousTimeout > 0)
      test.setTimeout(designer.previousTimeout + 30_000);
    const previous = await page.evaluate(async () => {
      const { status } = await import("/src/bridge-client.ts" as string);
      const game = (window as any).__deadAir.game;
      const previous = {
        status: status(),
        id: game.id as string,
        view: game.settings.view as string,
      };
      // Preparing thirty synthetic stages does not need expensive software
      // WebGL frames. Restore the test's requested view immediately afterward.
      game.settings.view = "top-down";
      return previous;
    });
    designer.previousStatus = previous.status;
    designer.previousRunId = previous.id;
    designer.previousView = previous.view;
    designer.active = true;
  }
  return designer;
}

async function finishSyntheticDesign(page: Page, state: SyntheticDesigner) {
  // These gameplay fixtures reuse one authored world. Novelty/history has its
  // own dedicated designer coverage; keep it out of unrelated restart tests.
  await page.evaluate((view) => {
    localStorage.removeItem("dead-air-run-design-history-v1");
    localStorage.removeItem("dead-air-environment-history-v1");
    (window as any).__deadAir.game.settings.view = view;
  }, state.previousView);
  state.active = false;
  state.restoring = true;
  try {
    await page.evaluate(async () => {
      const { checkBridge } = await import("/src/bridge-client.ts" as string);
      await checkBridge();
    });
  } finally {
    state.restoring = false;
  }
}

/** A restart replays the saved level: no design dialog, only Start. */
export async function startRestartedRun(page: Page) {
  await page.waitForFunction(() => {
    const game = (window as any).__deadAir.game;
    return game.status === "ready" && !game.preparingRun && !game.paused;
  });
  await answerVoicePrompt(page);
  await expect(page.locator("#run-design-dialog")).toHaveCount(0);
  await clickStart(page);
  await page.waitForFunction(() => {
    const game = (window as any).__deadAir.game;
    return game.status === "playing" && !game.paused;
  });
}

/** Complete every new run through the real quality pipeline using local replies. */
export async function chooseDesignedRun(page: Page) {
  const designer = await syntheticDesigner(page);
  // A New game asks for the voice before it requests the design.
  await settleVoice(page);
  const dialog = page.locator("#run-design-dialog");
  const previousId = designer.previousRunId!;
  // A restart may have checked the study mock's capabilities before this helper
  // enabled its designer. Retry that captured request through the same UI.
  const outcome = await page.waitForFunction((previous) => {
    const game = (window as any).__deadAir.game;
    if (game.id !== previous && game.status === "ready" && !game.preparingRun)
      return "complete";
    const retry =
      document.querySelector<HTMLButtonElement>("#run-design-retry");
    return retry && !retry.disabled ? "retry" : false;
  }, previousId);
  if ((await outcome.jsonValue()) === "retry")
    await dialog.locator("#run-design-retry").click();
  await page.waitForFunction((previous) => {
    const game = (window as any).__deadAir?.game;
    return (
      game &&
      game.id !== previous &&
      game.status === "ready" &&
      !game.preparingRun &&
      !game.paused &&
      game.design?.design.version === 3
    );
  }, previousId);
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#start-card")).toBeVisible();
  await finishSyntheticDesign(page, designer);
  await clickStart(page);
  await page.waitForFunction(() => {
    const game = (window as any).__deadAir.game;
    return game.status === "playing" && !game.paused;
  });
  // Starting a run records its design as recent, after the clearing above, and a
  // repeated fixture would then fail the real novelty check on the next restart.
  await page.evaluate(() => {
    localStorage.removeItem("dead-air-run-design-history-v1");
    localStorage.removeItem("dead-air-environment-history-v1");
  });
  await expect(page.locator("#start-card")).toBeHidden();
  // Keep the setup allowance through Start and first-person initialization,
  // matching the prior helper's preparation budget before gameplay assertions.
  if (designer.previousTimeout! > 0)
    test.setTimeout(
      designer.previousTimeout! +
        Math.ceil(performance.now() - designer.preparationStarted!),
    );
}

/** Ready runs start on click; fresh runs require design and a second Start click. */
export async function startDesignedRun(page: Page) {
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const preparing = await page.evaluate(
    () => !!(window as any).__deadAir.game.preparingRun,
  );
  await syntheticDesigner(page, preparing);
  await clickStart(page);
  if (preparing) await chooseDesignedRun(page);
  else {
    await page.waitForFunction(() => {
      const game = (window as any).__deadAir.game;
      return game.status === "playing" && !game.paused;
    });
    await expect(page.locator("#start-card")).toBeHidden();
  }
}
