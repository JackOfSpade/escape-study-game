import { providerLabel } from "./provider-label";
import { escapeHtml as escape } from "./html";
import {
  environmentExecutions,
  recordEnvironmentObservation,
} from "./environment-observations";
import {
  finalRequirements,
  finalRequirementStatus,
} from "./final-requirements";
import type { Game, Roadmap } from "./model";
import { download } from "./persistence";
const refreshers = new WeakMap<HTMLElement, () => void>();
export function renderEnvironmentObservations(
  host: HTMLElement,
  g: Game,
  r: Roadmap,
  persist: () => unknown,
  review?: (id: string, retry: boolean) => Promise<void> | undefined,
  updated?: () => void,
) {
  const definitions = finalRequirements(r, "PE").filter(
      (d) => d.kind === "environment",
    ),
    runs = environmentExecutions(g).slice(-30);
  const section = document.createElement("details");
  section.id = "environment-observations";
  section.innerHTML = `<summary>Practical environment observations</summary><p>Save your own practical work for review. A description is reported exposure; supplied output and runner receipts still need review. Saving never marks an ENV item passed, awards academic evidence or changes a tier gate. ${review ? "The connected reviewer can review a saved observation when you request it. Review is separate from academic mastery." : "ENV review is unavailable. Download packets and the full game backup for external review."}</p><form id="environment-form"><label>Environment skill <select id="environment-item">${definitions.map((d) => `<option value="${escape(d.id)}">${escape(d.id)} · ${escape(d.scope)}</option>`).join("")}</select></label><p id="environment-scope" class="muted"></p><label for="environment-statement">Your actions, environment, what ran and what you observed</label><textarea id="environment-statement" rows="5" maxlength="8000" required></textarea><label>Saved code run (optional) <select id="environment-run"><option value="">No saved runner receipt</option>${runs.map((v) => `<option value="${escape(v.key)}">${escape(v.job.language)} v${v.job.revision} · ${escape(v.e.id)} · ${escape(v.job.id.slice(0, 8))}</option>`).join("")}</select></label><label>Supporting output or shared text file (optional, 256 KiB) <input id="environment-output" type="file" accept=".txt,.log,.json,.md,.py,.ts,.tsx,.js,text/plain,application/json,text/markdown"></label><button type="submit">Save observation for review</button><p id="environment-status" role="status"></p></form><div id="environment-observation-list"></div>`;
  host.append(section);
  const item = section.querySelector<HTMLSelectElement>("#environment-item")!;
  const showScope = () => {
    section.querySelector<HTMLElement>("#environment-scope")!.textContent =
      definitions.find((d) => d.id === item.value)?.scope ?? "";
  };
  item.onchange = showScope;
  showScope();
  const list = () => {
    const items = g.study.environmentObservations ?? [],
      box = section.querySelector<HTMLElement>(
        "#environment-observation-list",
      )!;
    box.innerHTML = `<p>${items.length} saved observation packet${items.length === 1 ? "" : "s"} · ${g.study.environmentReviews?.filter((j) => j.state === "applied").length ?? 0} reviewed. ENV completion remains separate.</p>${[
      ...items,
    ]
      .reverse()
      .slice(0, 30)
      .map(
        (o) =>
          `<article><strong>${escape(o.envId)} · ${escape(
            g.study.learner
              ? finalRequirementStatus(
                  r,
                  g.study.learner,
                  definitions.find((d) => d.id === o.envId)!,
                )
              : "U",
          )} · ${escape(g.study.environmentReviews?.find((j) => j.observationId === o.id)?.state ?? "pending review")}</strong><p>${escape(o.capturedAt)} · ${escape(o.profile)} profile · ${o.execution ? "runner receipt attached" : o.suppliedOutput ? "learner-supplied output" : "reported exposure only"} · independence unassessed</p><pre>${escape(o.learnerStatement.slice(0, 500))}</pre><button type="button" data-environment-download="${escape(o.id)}" class="quiet">Download observation packet</button>${review && !g.study.environmentReviews?.some((j) => j.observationId === o.id && j.state === "applied") ? `<button type="button" data-environment-review="${escape(o.id)}" ${g.study.environmentReviews?.some((j) => j.state === "pending") ? "disabled" : ""}>${g.study.environmentReviews?.some((j) => j.observationId === o.id) ? "Retry review" : "Review observation"}</button>` : ""}<p>${escape(g.study.environmentReviews?.find((j) => j.observationId === o.id)?.error ?? g.study.learner?.environmentEvidence?.find((v) => v.payload.observation.id === o.id)?.judgment.rationale ?? "Relevant output and ownership remain unreviewed.")}</p></article>`,
      )
      .join("")}`;
    for (const entry of g.study.learner?.environmentEvidence ?? []) {
      const button = [
        ...box.querySelectorAll<HTMLButtonElement>(
          "[data-environment-download]",
        ),
      ].find(
        (b) => b.dataset.environmentDownload === entry.payload.observation.id,
      );
      if (button) {
        const detail = document.createElement("p");
        detail.textContent = `Reviewed through ${providerLabel(entry.provenance)}. This packet: ${entry.judgment.classification}. Covered: ${entry.judgment.covered.join("; ") || "none observed"}. Remaining: ${entry.judgment.remaining.join("; ") || "none in reviewed scope"}. ENV status is separate from independent academic proof.`;
        button.closest("article")?.append(detail);
      }
    }
    updated?.();
    for (const button of box.querySelectorAll<HTMLButtonElement>(
      "[data-environment-download]",
    ))
      button.onclick = () => {
        const o = items.find(
          (o) => o.id === button.dataset.environmentDownload,
        );
        if (o)
          download(
            `${o.envId.replace(":", "-")}-${o.id}.json`,
            JSON.stringify(o, null, 2),
          );
      };
    for (const button of box.querySelectorAll<HTMLButtonElement>(
      "[data-environment-review]",
    ))
      button.onclick = async () => {
        const id = button.dataset.environmentReview!;
        let status = section.querySelector<HTMLElement>("#environment-status")!;
        try {
          const pending = review?.(
            id,
            !!g.study.environmentReviews?.some((j) => j.observationId === id),
          );
          list();
          try {
            await persist();
          } catch {
            /* Preserve the running review and report any final save failure below. */
          }
          await pending;
          refresh();
          await persist();
          status =
            host.querySelector<HTMLElement>("#environment-status") ?? status;
          const job = g.study.environmentReviews?.find(
            (j) => j.observationId === id,
          );
          status.textContent =
            job?.state === "applied"
              ? "Practical review saved. Academic checkpoints, visits and tier gates are unchanged."
              : `Review retained for retry: ${job?.error ?? "unavailable"}`;
        } catch (error) {
          refresh();
          status =
            host.querySelector<HTMLElement>("#environment-status") ?? status;
          status.textContent = `Review/save unavailable; evidence retained for download. ${String(error)}`;
        }
      };
  };
  refreshers.set(host, list);
  const refresh = () => (refreshers.get(host) ?? list)();
  list();
  section.querySelector<HTMLFormElement>("#environment-form")!.onsubmit =
    async (event) => {
      event.preventDefault();
      const button = section.querySelector<HTMLButtonElement>(
          'button[type="submit"]',
        )!,
        status = section.querySelector<HTMLElement>("#environment-status")!,
        file = section.querySelector<HTMLInputElement>("#environment-output")!
          .files?.[0];
      button.disabled = true;
      let recorded = false;
      try {
        if (file && file.size > 262144)
          throw Error("Supporting text output must be at most 256 KiB");
        const statement = section.querySelector<HTMLTextAreaElement>(
            "#environment-statement",
          )!.value,
          envId =
            section.querySelector<HTMLSelectElement>(
              "#environment-item",
            )!.value,
          executionKey =
            section.querySelector<HTMLSelectElement>("#environment-run")!.value;
        await recordEnvironmentObservation(g, r, {
          envId,
          statement,
          ...(executionKey ? { executionKey } : {}),
          ...(file
            ? { suppliedOutput: { name: file.name, text: await file.text() } }
            : {}),
        });
        recorded = true;
        list();
        await persist();
        status.textContent =
          "Observation packet saved locally for review. No ENV pass or academic credit awarded.";
      } catch (error) {
        status.textContent = recorded
          ? `Observation retained in this run, but local save failed. Download its packet or a full game backup. ${String(error)}`
          : `Observation not saved: ${String(error)}`;
      } finally {
        button.disabled = false;
      }
    };
}
