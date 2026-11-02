import { startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
// Synthetic native protocol and source rows, not real learner certification.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../../src/roadmap-identifiers";
import { inspectMergedDocument } from "../../src/roadmap-structure";
const task =
  "| S0007-A98 | S0007 / 2026-10-16 | T02.1 D1 local branch task | PENDING; no inference | — | Synthetic task |";
const observation =
  "| S0007-EV98 | S0007-A98 | 2026-10-16 | T02.1 | D1 synthetic branch observation | GUIDED | HINT | 1 | Synthetic assisted observation, not independent mastery. |";
function revision(raw: string, hash: string, n: number) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${hash}`);
}
test("source-qualified branch review exposes unresolved history, downloads exact proposal and survives explicit adoption/reload", async ({
  page,
}) => {
  const r = JSON.parse(await readFile("public/curriculum.json", "utf8"));
  let initial = revision(r.raw, r.sourceHash, 10);
  let at = initial.indexOf(
    "### 0.5.1 Attempt status register",
    initial.indexOf("<!-- BEGIN PE_PROGRESS -->"),
  );
  initial = initial.slice(0, at) + observation + "\n\n" + initial.slice(at);
  at = initial.indexOf("### 0.6 Facet gaps", at);
  initial = initial.slice(0, at) + task + "\n\n" + initial.slice(at);
  initial = projectIdentifierCounters(
    initial,
    readIdentifierCounters(initial, false).counters,
  );
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic branch fixture",
        detail: "Synthetic transport test, not actual native certification",
        capabilities: ["reconcile-roadmap"],
      },
    }),
  );
  await page.route("**/api/bridge", async (route) => {
    const { operation, payload: p } = route.request().postDataJSON();
    // Background question preparation is not part of this test.
    if (operation !== "reconcile-roadmap")
      return route.fulfill({
        status: 503,
        json: { error: "Not part of this test" },
      });
    const canonical = revision(p.local, p.localHash, 11),
      local = inspectMergedDocument(p.local).rows;
    const decisions = [...inspectMergedDocument(p.candidate).rows]
      .filter(([k, row]) => local.has(k) && local.get(k) !== row)
      .map(([key]) => ({
        key,
        choice: "local",
        rationale:
          "Preserve original local row while retaining incoming conflicting history under its source hash",
      }));
    await route.fulfill({
      json: {
        requestId: p.requestId,
        localHash: p.localHash,
        candidateHash: p.candidateHash,
        canonical,
        definitions: [],
        mappings: [],
        completeScopes: [],
        decisions,
        branchConflicts: [{ track: "PE", id: "S0007-A98" }],
        branchRationale:
          "Two actual source tasks differ. <img src=x onerror=window.branchInjected=true> Both remain unresolved.",
        rationale: "Synthetic branch preservation; no academic credit",
      },
    });
  });
  await page.goto("/");
  await startDesignedRun(page);
  const local = await page.evaluate(async (initial) => {
    const root = "/src/",
      g = (window as any).__deadAir.game,
      r = await (await fetch("/curriculum.json")).json();
    g.study.profile = "live";
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    const { reconcileRoadmap, adoptReconciledRoadmap } = await import(
      root + "roadmap-adoption.ts"
    );
    await reconcileRoadmap(g, r, initial, async (p: any) => ({
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: p.candidate,
      definitions: [],
      mappings: [],
      completeScopes: [],
      decisions: [],
      rationale: "Synthetic fixture setup",
    }));
    const job = g.study.roadmapReconciliations.at(-1);
    if (job.state !== "ready") throw Error(job.error);
    await adoptReconciledRoadmap(g, r, job.id);
    await (await import(root + "persistence.ts")).save(g);
    return g.study.roadmapExport;
  }, initial);
  const candidate = revision(local.content, local.hash, 11)
    .replace(task, task.replace("local branch task", "different incoming task"))
    .replace(
      observation,
      observation.replace(
        "Synthetic assisted observation",
        "Distinct incoming assisted observation",
      ),
    );
  const before = await page.evaluate(() =>
    JSON.stringify((window as any).__deadAir.game.study.learner),
  );
  await openGameMenu(page);
  await page.locator("#curriculum-button").click();
  await page.getByText("Review an updated roadmap", { exact: true }).click();
  await page.locator("#roadmap-review-file").setInputFiles({
    name: "branch.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(candidate),
  });
  await page
    .getByRole("button", { name: "Request roadmap review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
  ).toBeVisible();
  const summary = page.getByText(
    "1 unresolved source-qualified branch conflict(s)",
    { exact: true },
  );
  await summary.click();
  await expect(page.locator("#roadmap-adoption-controls")).toContainText(
    "No IDs are renumbered.",
  );
  await expect(page.locator("#roadmap-adoption-controls img")).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as any).branchInjected),
  ).toBeUndefined();
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(before);
  const canonical = await page.evaluate(
    () =>
      (window as any).__deadAir.game.study.roadmapReconciliations.at(-1)
        .proposal.canonical,
  );
  expect(canonical).toContain("<!-- BRANCH_RECORDS ");
  expect(canonical).toContain(task);
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download proposed roadmap", exact: true })
    .first()
    .click();
  expect(await readFile((await (await pending).path())!, "utf8")).toBe(
    canonical,
  );
  await page.screenshot({ path: "test-results/roadmap-branch-review.png" });
  const adopted = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
    .click();
  await adopted;
  await expect(page.locator("#roadmap-adoption-status")).toContainText(
    "adopted and saved",
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const result = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      raw: g.study.roadmapExport.content,
      evidence: g.study.learner.evidence.length,
      visits: g.study.visits.length,
      attempts: g.study.learner.attempts.length,
    };
  });
  expect(result).toEqual({
    raw: canonical,
    evidence: 0,
    visits: 0,
    attempts: 0,
  });
});
