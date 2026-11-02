import { startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
// Synthetic native protocol and source rows, not real learner certification.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { finalRequirements } from "../../src/final-requirements";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../../src/roadmap-identifiers";
import { inspectMergedDocument } from "../../src/roadmap-structure";
const task =
  "| S0007-A98 | S0007 / 2026-10-16 | T01 changed-context assessment | COMPLETED; source task closed | S0007-EV98 | Synthetic task |";
const excerpt =
  "Synthetic independent changed-context reasoning covers the complete reviewed source scope without supplied reasoning.";
const correctionExcerpt =
  "Source audit found a supplied reasoning step; withdraw the closed task score without learner failure and retain all original observations.";
const correctionDecision = `| DEC0028 | 2026-10-17 / source audit | ASSESSMENT_CORRECTION | PY:S0007-A98 | ${correctionExcerpt} | Persistent source interpretation | ACTIVE |`;
const observation = `| S0007-EV98 | S0007-A98 | 2026-10-16 | T01 | D4 changed-context reasoning | TRANSFER | NONE | 3 | ${excerpt} |`;
function revision(raw: string, hash: string, n: number) {
  return raw
    .replace(/^revision: \d+$/m, `revision: ${n}`)
    .replace(/^previous_revision: \d+$/m, `previous_revision: ${n - 1}`)
    .replace(/^parent_file_sha256: .+$/m, `parent_file_sha256: ${hash}`);
}
test("closed assessment correction requires a source decision, reviews exact authority and persists invalidated proof through adoption/reload", async ({
  page,
}) => {
  const r = JSON.parse(await readFile("public/curriculum.json", "utf8"));
  let initial = revision(r.raw, r.sourceHash, 10);
  let at = initial.indexOf(
    "### 0.5.1 Attempt status register",
    initial.indexOf("<!-- BEGIN PY_PROGRESS -->"),
  );
  initial = initial.slice(0, at) + observation + "\n\n" + initial.slice(at);
  at = initial.indexOf("### 0.6 Facet gaps", at);
  initial = initial.slice(0, at) + task + "\n\n" + initial.slice(at);
  const start = initial.indexOf("<!-- BEGIN PY_PROGRESS -->"),
    end = initial.indexOf("<!-- END PY_PROGRESS -->");
  initial =
    initial.slice(0, start) +
    initial
      .slice(start, end)
      .replace("| T01 | U | — | U | — |", "| T01 | P | S0007-EV98 | U | — |") +
    initial.slice(end);
  initial = projectIdentifierCounters(
    initial,
    readIdentifierCounters(initial, false).counters,
  );
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic terminal correction fixture",
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
    const canonical = p.candidate,
      local = inspectMergedDocument(p.local).rows;
    const decisions = [...inspectMergedDocument(p.candidate).rows]
      .filter(([k, row]) => local.has(k) && local.get(k) !== row)
      .map(([key]) => ({
        key,
        choice: "incoming",
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
        attemptUpdates: [
          {
            track: "PY",
            attemptId: "S0007-A98",
            correctionDecision: { id: "DEC0028", excerpt: correctionExcerpt },
            rationale:
              "Source-recorded task invalidation; preserve observations without learner failure",
          },
        ],
        rationale:
          "Withdraw invalidated proof, preserve source observations and unrelated learning without a new learner failure.",
      },
    });
  });
  await page.goto("/");
  await startDesignedRun(page);
  const local = await page.evaluate(
    async ({ initial, excerpt, scope }) => {
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
        definitions: [
          {
            id: "PY:T01/T4",
            objectiveId: "PY:T01",
            depth: 4,
            sourceScope: scope,
            facets: [
              { id: "primary", description: "Synthetic complete source scope" },
            ],
          },
        ],
        mappings: [
          {
            scopeId: "PY:T01/T4",
            facet: "primary",
            outcome: "independent",
            evidenceIds: ["S0007-EV98"],
            sourceExcerpts: { "S0007-EV98": excerpt },
            rationale: "Synthetic reviewed full scope",
          },
        ],
        completeScopes: ["PY:T01/T4"],
        decisions: [],
        rationale: "Synthetic fixture setup",
      }));
      const job = g.study.roadmapReconciliations.at(-1);
      if (job.state !== "ready") throw Error(job.error);
      await adoptReconciledRoadmap(g, r, job.id);
      await (await import(root + "persistence.ts")).save(g);
      return g.study.roadmapExport;
    },
    {
      initial,
      excerpt,
      scope: finalRequirements(r, "PY").find((d) => d.id === "PY:T01")!.scope,
    },
  );
  let candidate = revision(local.content, local.hash, 11).replace(
    task,
    task.replace(
      "COMPLETED; source task closed",
      "INVALIDATED; supplied task withdrawn without learner failure",
    ),
  );
  const pyStart = candidate.indexOf("<!-- BEGIN PY_PROGRESS -->"),
    pyEnd = candidate.indexOf("<!-- END PY_PROGRESS -->");
  candidate =
    candidate.slice(0, pyStart) +
    candidate
      .slice(pyStart, pyEnd)
      .replace(
        "| T01 | P | S0007-EV98 | U | — |",
        "| T01 | U | S0007-EV98 | U | — |",
      ) +
    candidate.slice(pyEnd);
  const decisionAt = candidate.indexOf("### S0.4 Merged session history");
  candidate =
    candidate.slice(0, decisionAt).trimEnd() +
    "\n" +
    correctionDecision +
    "\n\n" +
    candidate.slice(decisionAt);
  candidate = projectIdentifierCounters(
    candidate,
    readIdentifierCounters(candidate, false).counters,
  );
  const before = await page.evaluate(() =>
    JSON.stringify((window as any).__deadAir.game.study.learner),
  );
  await openGameMenu(page);
  await page.locator("#curriculum-button").click();
  await page.getByText("Review an updated roadmap", { exact: true }).click();
  await page.locator("#roadmap-review-file").setInputFiles({
    name: "terminal-correction.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(candidate),
  });
  await page
    .getByRole("button", { name: "Request roadmap review", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#roadmap-adoption-controls")).toContainText(
    "Both previous and updated dispositions",
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(before);
  await expect(page.locator("#roadmap-adoption-controls")).toContainText(
    "Closed assessment correction",
  );
  await expect(page.locator("#roadmap-adoption-controls")).toContainText(
    correctionExcerpt,
  );
  await expect(page.locator("#roadmap-adoption-controls")).toContainText(
    "DEC0028",
  );
  const canonical = await page.evaluate(
    () =>
      (window as any).__deadAir.game.study.roadmapReconciliations.at(-1)
        .proposal.canonical,
  );
  expect(canonical).toContain("<!-- ATTEMPT_UPDATE ");
  expect(canonical).toContain(observation);
  const pending = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download proposed roadmap", exact: true })
    .first()
    .click();
  expect(await readFile((await (await pending).path())!, "utf8")).toBe(
    canonical,
  );
  await page.screenshot({ path: "test-results/terminal-correction.png" });
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
      status: g.study.learner.finalProgress["PY:T01"].status,
      facet:
        g.study.learner.finalProgress["PY:T01"].facets["D4:primary"].outcome,
    };
  });
  expect(result).toEqual({
    raw: canonical,
    evidence: 0,
    visits: 0,
    attempts: 0,
    status: "U",
    facet: "unknown",
  });
});
