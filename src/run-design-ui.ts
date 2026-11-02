import { checkBridge } from "./bridge-client";
import type { Game, Roadmap } from "./model";
import {
  createPlayableGame,
  previewDesignedRun,
  finalizeDesignedRun,
} from "./world";
import {
  clearDesignDraft,
  newDesignDraft,
  prepareDesignedRun,
  readDesignDraft,
  saveDesignDraft,
  retryDesignDraft,
  type DesignDraft,
} from "./run-designer";
import type { SavedRunDesign } from "./run-design-contract.mjs";
import type { RunDesignActivity } from "./run-design-progress";

export type RunChoice = { seed: number; saved: SavedRunDesign };
let choosing = false;
/** Only a completed design can replace the active run; cancellation leaves it intact. */
export async function chooseRunDesign(
  game: Game,
  roadmap: Roadmap,
): Promise<RunChoice | undefined> {
  if (choosing) return;
  choosing = true;
  const dialog = document.createElement("dialog");
  dialog.id = "run-design-dialog";
  dialog.className = "run-design-dialog";
  dialog.setAttribute("aria-labelledby", "run-design-title");
  dialog.setAttribute("aria-describedby", "run-design-status");
  dialog.dataset.state = "working";
  dialog.innerHTML = `
    <span class="eyebrow">NEW ESCAPE</span>
    <h2 id="run-design-title">Preparing your escape</h2>
    <div class="run-design-state">
      <span id="run-design-loading" role="progressbar" aria-label="Preparing your escape"><span class="run-design-spinner" aria-hidden="true"></span></span>
      <p id="run-design-status" role="status" aria-atomic="true">Starting your escape design…</p>
    </div>
    <ol id="run-design-steps" aria-label="Setup steps">
      <li data-step="design" data-state="active" aria-current="step"><span class="run-design-step-marker" aria-hidden="true">1</span><span>Design</span></li>
      <li data-step="details" data-state="pending"><span class="run-design-step-marker" aria-hidden="true">2</span><span>Details</span></li>
      <li data-step="review" data-state="pending"><span class="run-design-step-marker" aria-hidden="true">3</span><span>Review</span></li>
    </ol>
    <div class="run-design-actions">
      <button id="run-design-retry" hidden>Retry design</button>
      <button id="run-design-cancel" class="quiet">Cancel</button>
    </div>`;
  document.body.append(dialog);
  const title = dialog.querySelector<HTMLElement>("#run-design-title")!;
  const message = dialog.querySelector<HTMLElement>("#run-design-status")!;
  const loading = dialog.querySelector<HTMLElement>("#run-design-loading")!;
  const retry = dialog.querySelector<HTMLButtonElement>("#run-design-retry")!;
  const steps = [
    ...dialog.querySelectorAll<HTMLElement>("#run-design-steps li"),
  ];
  const previousPause = game.paused;
  if (game.status === "playing") game.paused = true;
  dialog.showModal();
  let draft: DesignDraft | undefined;
  let active: AbortController | undefined;
  let closed = false;
  let activity: RunDesignActivity | undefined;
  const showActivity = () => {
    if (closed) return;
    const state = activity?.state ?? "working";
    dialog.dataset.state = state;
    title.textContent = "Preparing your escape";
    message.textContent = activity?.detail ?? "Starting your escape design…";
    loading.hidden = false;
    loading.setAttribute("aria-valuetext", message.textContent);
    retry.hidden = true;
    const current = Math.max(
      0,
      steps.findIndex((step) => step.dataset.step === activity?.stage),
    );
    steps.forEach((step, index) => {
      step.dataset.state =
        index < current ? "complete" : index === current ? "active" : "pending";
      if (index === current) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
  };
  let settle: (choice: RunChoice | undefined) => void = () => {};
  const done = new Promise<RunChoice | undefined>((resolve) => {
    settle = resolve;
  });
  const finish = (choice: RunChoice | undefined) => {
    if (closed) return;
    closed = true;
    active?.abort();
    if (!choice) {
      try {
        clearDesignDraft(game.id);
      } catch {
        /* A blocked store is reported when next used. */
      }
    }
    dialog.close();
    dialog.remove();
    game.paused = previousPause;
    choosing = false;
    settle(choice);
  };
  const attempt = async () => {
    if (active || closed) return;
    active = new AbortController();
    const controller = active;
    retry.disabled = true;
    if (activity) activity = { ...activity, state: "working" };
    showActivity();
    try {
      draft ??=
        readDesignDraft(game.id) ??
        newDesignDraft(game.id, crypto.getRandomValues(new Uint32Array(1))[0]);
      saveDesignDraft(draft);
      await checkBridge();
      controller.signal.throwIfAborted();
      const result = await prepareDesignedRun(draft, {
        signal: controller.signal,
        capture: saveDesignDraft,
        activity: (next) => {
          activity = next;
          showActivity();
        },
        build: (seed, saved) =>
          createPlayableGame(seed, roadmap, structuredClone(game.study), saved),
        preview: (seed, structure) =>
          previewDesignedRun(
            seed,
            roadmap,
            structuredClone(game.study),
            structure,
          ),
        finalize: finalizeDesignedRun,
      });
      finish({ seed: result.seed, saved: result.saved });
    } catch (error) {
      if (!closed) {
        dialog.dataset.state = "error";
        title.textContent = "Setup paused";
        loading.hidden = true;
        loading.removeAttribute("aria-valuetext");
        retry.hidden = false;
        message.textContent =
          error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (active === controller) active = undefined;
      retry.disabled = false;
    }
  };
  retry.onclick = () => {
    if (draft) retryDesignDraft(draft);
    void attempt();
  };
  dialog.querySelector<HTMLButtonElement>("#run-design-cancel")!.onclick = () =>
    finish(undefined);
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(undefined);
  });
  void attempt();
  return done;
}
