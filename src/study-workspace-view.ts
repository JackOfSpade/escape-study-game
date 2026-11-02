import type { Game, Roadmap } from "./model";
import {
  workspaceAssessment,
  workspaceProgressHtml,
  workspaceQuestion,
  workspaceSelectedQuestion,
} from "./study-workspace";
import { latestTopicAssessment } from "./topic-assessment";

interface WorkspaceViewState {
  game: Game;
  starting: boolean;
  saving: boolean;
  saveError: string;
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
    const { game, starting, saving, saveError } = readState();
    if (!game.studyWorkspace?.enabled) return;
    const html = workspaceProgressHtml(game, roadmap);
    if (writtenHtml !== html) {
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

    const current = workspaceQuestion(game);
    const assessment = workspaceAssessment(game);
    next.disabled =
      starting ||
      !!current ||
      saving ||
      !!saveError ||
      (assessment !== undefined && assessment.status !== "applied");
    writeText(
      next,
      starting
        ? "Preparing question…"
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
