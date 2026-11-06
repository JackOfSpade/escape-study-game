import type { Game, Roadmap } from "./model";
import {
  workspaceAssessment,
  workspaceProgressHtml,
  workspaceQuestion,
  workspaceSelectedQuestion,
} from "./study-workspace";
import {
  playProgressReveal,
  readMapSnapshot,
  type MapSnapshot,
} from "./study-progress-reveal";
import { latestTopicAssessment } from "./topic-assessment";

interface WorkspaceViewState {
  game: Game;
  starting: boolean;
  saving: boolean;
  saveError: string;
  /** Whether the question terminal is showing; a closed one can be resumed. */
  terminalOpen: boolean;
}

const topicKey = (node: HTMLElement) =>
  `${node.dataset.topicKey}/D${node.dataset.tier}`;
const writeText = (node: Element | null, value: string) => {
  if (node && node.textContent !== value) node.textContent = value;
};

/** Study-only presentation and disclosure state; learning mutations stay in the model. */
export function createStudyWorkspaceView(
  root: HTMLElement,
  roadmap: Roadmap,
  readState: () => WorkspaceViewState,
) {
  const progress = root.querySelector<HTMLElement>("#study-progress")!;
  const next = root.querySelector<HTMLButtonElement>("#study-next")!;
  const reviewRetry = root.querySelector<HTMLElement>("#study-review-retry")!;
  const saveRetry = root.querySelector<HTMLElement>("#study-save-retry")!;
  const saveStatus = root.querySelector<HTMLElement>("#study-save-status")!;
  const expanded = new Set<string>();
  let writtenHtml = "";
  let topics: HTMLElement[] = [];
  let tabStop: string | undefined;
  // Pre-question map state, kept until that question's assessment is applied.
  let baseline: { id: string; snapshot: MapSnapshot } | undefined;
  let reveal: { cancel(): void } | undefined;
  let scrolledFor: string | undefined;
  // Bumped by a reveal so a pending terminal alignment never pulls back down.
  let alignToken = 0;
  const reducedMotion = () =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Header height changes only on reflow. Measuring it on each UI tick caused
  // a read/write layout cycle for every topic even when the world was paused.
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const button = entry.target as HTMLElement;
      const node = button.closest<HTMLElement>(".study-map-topic");
      const height = entry.borderBoxSize[0]?.blockSize;
      if (node && height !== undefined)
        node.style.setProperty("--study-topic-junction", `${height / 2}px`);
    }
  });

  function updateTabStop() {
    if (!topics.some((node) => topicKey(node) === tabStop))
      tabStop = topicKey(
        topics.find((node) => node.classList.contains("is-current")) ??
          topics[0],
      );
    for (const node of topics) {
      const button = node.querySelector<HTMLButtonElement>(
        "[data-study-topic-toggle]",
      )!;
      button.tabIndex = topicKey(node) === tabStop ? 0 : -1;
    }
  }

  function renderAssessments() {
    const { game } = readState();
    const current = workspaceQuestion(game)?.problem?.contract;
    for (const node of topics) {
      const topicId = node.dataset.topicKey ?? "";
      const tier = Number(node.dataset.tier);
      const button = node.querySelector<HTMLElement>(
        "[data-study-topic-toggle]",
      )!;
      const panel = node.querySelector<HTMLElement>(
        ".study-topic-assessment-panel",
      )!;
      const open = expanded.has(topicKey(node));
      button.setAttribute("aria-expanded", String(open));
      panel.hidden = !open;
      if (!open) continue;
      const record = latestTopicAssessment(
        game.study,
        topicId,
        roadmap.sourceHash,
      );
      const date = record ? new Date(record.updatedAt).toLocaleString() : "";
      const text = (selector: string, value: string) =>
        writeText(panel.querySelector(selector), value);
      text(
        ".study-topic-assessment-meta",
        `Tier ${tier}${record && record.depth !== tier ? ` · Latest assessment after a Tier ${record.depth} question` : ""}${date ? ` · Updated ${date}` : ""}`,
      );
      const inProgress = current?.objectiveIds.some(
        (id) => id.split(".")[0] === topicId,
      );
      text(
        ".study-topic-assessment-status",
        record?.sourceHash && record.sourceHash !== roadmap.sourceHash
          ? "The roadmap has changed since this assessment was written."
          : record && inProgress
            ? "A question on this topic is in progress. This assessment updates when it finishes."
            : "",
      );
      text(
        ".study-topic-assessment-body",
        record?.text ??
          "No AI assessment saved yet. This topic’s assessment updates after you finish a question on it.",
      );
    }
  }

  progress.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    const node = event.target
      .closest("[data-study-topic-toggle]")
      ?.closest<HTMLElement>(".study-map-topic");
    if (!node) return;
    const key = topicKey(node);
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    tabStop = key;
    updateTabStop();
    renderAssessments();
  });
  // One map tab stop avoids dozens of stops between the primary study controls.
  progress.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const node = event.target
      .closest("[data-study-topic-toggle]")
      ?.closest<HTMLElement>(".study-map-topic");
    if (!node || event.altKey || event.ctrlKey || event.metaKey) return;
    const index = topics.indexOf(node);
    let target: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        target = (index + 1) % topics.length;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        target = (index + topics.length - 1) % topics.length;
        break;
      case "Home":
        target = 0;
        break;
      case "End":
        target = topics.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    tabStop = topicKey(topics[target]);
    updateTabStop();
    topics[target]
      .querySelector<HTMLElement>("[data-study-topic-toggle]")!
      .focus({ preventScroll: true });
    topics[target].scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  function render() {
    const { game, starting, saving, saveError, terminalOpen } = readState();
    if (!game.studyWorkspace?.enabled) return;
    const html = workspaceProgressHtml(game, roadmap);
    const open = workspaceQuestion(game);
    const needBaseline = !!open && baseline?.id !== open.id;
    // Take the baseline from the DOM before any rewrite, so it reflects the
    // state the learner saw when the question began.
    if (needBaseline && progress.querySelector(".study-map-topic"))
      baseline = { id: open.id, snapshot: readMapSnapshot(progress) };
    if (writtenHtml !== html) {
      // The rewritten DOM already holds the final state.
      reveal?.cancel();
      reveal = undefined;
      const previousMarker =
        progress.querySelector<HTMLElement>(".study-skill-map")?.dataset
          .currentMarker;
      const positions = new Map(
        [...progress.querySelectorAll<HTMLElement>(".study-map-scroll")].map(
          (node) => [node.dataset.tier, node.scrollTop],
        ),
      );
      const focused = document.activeElement;
      const focusedTopic =
        focused instanceof HTMLElement && progress.contains(focused)
          ? focused.closest<HTMLElement>(".study-map-topic")
          : undefined;
      const focusedKey = focusedTopic ? topicKey(focusedTopic) : undefined;
      sizes.disconnect();
      progress.innerHTML = html;
      writtenHtml = html;
      topics = [...progress.querySelectorAll<HTMLElement>(".study-map-topic")];
      if (topics.length) updateTabStop();
      renderAssessments();
      for (const node of topics) {
        sizes.observe(node.querySelector("[data-study-topic-toggle]")!);
        if (topicKey(node) === focusedKey)
          node.querySelector<HTMLElement>("[data-study-topic-toggle]")!.focus({
            preventScroll: true,
          });
      }
      for (const scroller of progress.querySelectorAll<HTMLElement>(
        ".study-map-scroll",
      ))
        scroller.scrollTop = positions.get(scroller.dataset.tier) ?? 0;
      const marker =
        progress.querySelector<HTMLElement>(".study-skill-map")?.dataset
          .currentMarker;
      const currentTopic = progress.querySelector<HTMLElement>(
        ".study-map-topic.is-current",
      );
      const scroller = currentTopic?.closest(".study-map-scroll");
      if (
        marker?.startsWith("issued:") &&
        marker !== previousMarker &&
        currentTopic &&
        scroller
      )
        scroller.scrollTop +=
          currentTopic.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          24;
    } else renderAssessments();
    if (needBaseline && baseline?.id !== open.id)
      baseline = { id: open.id, snapshot: readMapSnapshot(progress) };

    const current = workspaceQuestion(game);
    const assessment = workspaceAssessment(game);
    if (
      baseline &&
      workspaceSelectedQuestion(game)?.id === baseline.id &&
      assessment?.status === "applied"
    ) {
      const { snapshot } = baseline;
      baseline = undefined;
      alignToken++;
      reveal?.cancel();
      reveal = playProgressReveal(progress, snapshot, {
        reducedMotion: reducedMotion(),
        // Deferred so the button is already re-enabled by this render.
        onDone: () => queueMicrotask(() => next.focus({ preventScroll: true })),
      });
    }
    // Bring the question terminal to its own screen once it is ready; a
    // resumed question scrolls again.
    if (!terminalOpen) scrolledFor = undefined;
    else if (current?.problem && scrolledFor !== current.id) {
      const slot = root.querySelector<HTMLElement>("#study-terminal-slot");
      if (slot) {
        scrolledFor = current.id;
        const token = ++alignToken;
        // Status lines above the slot can change in this same tick, so align
        // after layout settles, and once more when a smooth scroll lands.
        const align = (behavior: ScrollBehavior) =>
          window.scrollTo({
            top: slot.getBoundingClientRect().top + window.scrollY,
            behavior,
          });
        requestAnimationFrame(() => {
          if (scrolledFor !== current.id || token !== alignToken) return;
          if (reducedMotion()) return align("auto");
          window.addEventListener(
            "scrollend",
            () => {
              if (
                scrolledFor === current.id &&
                token === alignToken &&
                Math.abs(slot.getBoundingClientRect().top) > 2
              )
                align("auto");
            },
            { once: true },
          );
          align("smooth");
        });
      }
    }
    // An unfinished question whose terminal was closed is resumed here, so
    // the learner can never be left without a way back to it.
    const resumable = !!current && !terminalOpen;
    next.disabled =
      starting ||
      (!!current && !resumable) ||
      saving ||
      !!saveError ||
      (assessment !== undefined && assessment.status !== "applied");
    writeText(
      next,
      starting
        ? "Preparing question…"
        : resumable
          ? "Resume question"
          : current
            ? "Question in progress"
            : "Start next question",
    );
    reviewRetry.hidden = assessment?.status !== "review-required";
    saveRetry.hidden = !saveError;
    const received = workspaceSelectedQuestion(game)?.state === "consumed";
    writeText(
      saveStatus,
      saveError ||
        (saving
          ? received
            ? "Saving learning result…"
            : "Saving study session…"
          : received
            ? `Learning result received and saved.${
                assessment?.status === "pending"
                  ? " Progress assessment is pending."
                  : assessment?.status === "review-required"
                    ? " Progress review needs attention; retry below."
                    : assessment?.status === "applied"
                      ? " Progress assessment validated and saved."
                      : ""
              }`
            : ""),
    );
    saveStatus.classList.toggle("saved", !!received && !saving && !saveError);
  }
  return { render };
}
