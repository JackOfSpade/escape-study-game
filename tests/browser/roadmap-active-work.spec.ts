import { openGameMenu } from "./helpers/game-menu";
// Synthetic native provider only. Real browser edits, saved work and world transactions.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { reviewRoadmap } from "../../src/roadmap-review";
import { enterLegacyBuilding } from "./helpers/legacy-world";

// The editor was removed from normal gameplay. These scoped API fixtures keep
// reconciliation's captured-work transaction covered through the actual browser
// module/transport boundary; embedded-terminal.spec.ts covers the player conversation.
async function capturedWork(
  page: import("@playwright/test").Page,
  text: string,
  id = "f0-room0",
) {
  await page.evaluate(
    async ({ text, id }) => {
      const d = (window as any).__deadAir,
        root = "/src/";
      const { ensureProblem, presentProblem, edit } = await import(
        root + "ai.ts"
      );
      const e = d.game.encounters[id];
      await ensureProblem(d.game, e, d.roadmap);
      presentProblem(d.game, e, d.roadmap);
      edit(d.game, e, text, e.revision, d.roadmap);
    },
    { text, id },
  );
}
const workspace = (page: import("@playwright/test").Page) =>
  page.evaluate(
    () => (window as any).__deadAir.game.encounters["f0-room0"].workspace,
  );

for (const scenario of ["unchanged", "stale", "new-work"])
  test(`current attempt reconciliation: ${scenario}`, async ({ page }) => {
    const stale = scenario === "stale";
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Isolated roadmap fixture" },
      }),
    );
    const r = JSON.parse(await readFile("public/curriculum.json", "utf8"));
    let release!: () => void,
      assessCalls = 0,
      completeCalls = 0;
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: "claude-cli",
          label: "Synthetic active-work fixture",
          detail: "Not genuine native certification",
          capabilities: [
            "generate",
            "tutor",
            "group",
            "complete",
            "assess",
            "reconcile-roadmap",
          ],
        },
      }),
    );
    await page.route("**/api/bridge", async (route) => {
      const { operation, payload } = route.request().postDataJSON();
      // Background preparation would race the explicit issuance below.
      if (operation === "generate" && payload.encounterId === "prepared")
        return route.fulfill({
          status: 503,
          json: { error: "Not part of this test" },
        });
      if (operation === "generate") {
        const c = payload.contract;
        await route.fulfill({
          json: {
            title: "Synthetic retained puzzle",
            prompt: `Synthetic task for ${payload.encounterId}`,
            starter: "",
            rubric: [],
            contract: c,
            scopeDefinitions: c.objectiveIds.map((id: string, i: number) => ({
              id: `${id}/D${c.depth}`,
              objectiveId: id,
              depth: c.depth,
              sourceScope: c.scopes[i],
              facets: [
                {
                  id: "scope",
                  description: "Synthetic actual same-depth scope",
                },
              ],
            })),
          },
        });
        return;
      }
      if (operation === "reconcile-roadmap") {
        const report = await reviewRoadmap(r, payload.local, payload.candidate),
          active = payload.context.activeAttempts[0];
        expect(JSON.stringify(payload)).not.toContain(
          "PRIVATE_ACTIVE_BROWSER_DRAFT",
        );
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({
          json: {
            requestId: payload.requestId,
            localHash: payload.localHash,
            candidateHash: payload.candidateHash,
            canonical: payload.candidate,
            definitions: [],
            mappings: [],
            completeScopes: [],
            attemptUpdates: [
              {
                track: "PY",
                attemptId: active.attemptId,
                rationale:
                  "Synthetic explicit external completion of the exact captured task",
                resolveCurrent: {
                  encounter: active.encounter,
                  workHash: active.workHash,
                },
              },
            ],
            decisions: report.changes
              .filter((c) => c.conflict)
              .map((c) => ({
                key: c.key,
                choice: "incoming",
                rationale: "Synthetic explicit continued source state",
              })),
            rationale:
              "Synthetic current-work resolution; the gameplay puzzle remains unfinished",
          },
        });
        return;
      }
      if (operation === "complete") {
        completeCalls++;
        await route.fulfill({
          json: {
            complete: true,
            qualified: ["human"],
            feedback: "Synthetic world completion only",
          },
        });
        return;
      }
      if (operation === "assess") {
        assessCalls++;
        if (scenario === "new-work") {
          expect(payload.packet.externalAttemptContext.instruction).toContain(
            "new human work after humanCutoff",
          );
          expect(
            payload.packet.assistanceSources.some(
              (s: any) => s.provenance === "visible-private-roadmap-review",
            ),
          ).toBe(true);
          const c = payload.packet.problem.contract,
            newest = payload.packet.history
              .filter((h: any) => h.author === "human" && h.kind === "edit")
              .at(-1);
          expect(newest.seq).toBeGreaterThan(
            payload.packet.externalAttemptContext.humanCutoff,
          );
          await route.fulfill({
            json: {
              visitOutcome: "unresolved",
              findings: [
                {
                  objectiveId: c.objectiveIds[0],
                  depth: c.depth,
                  facet: "scope",
                  outcome: "assisted",
                  completeCheckpointScope: false,
                  evidence: [newest.seq],
                  rationale:
                    "Synthetic new work retained for fresh verification",
                },
              ],
            },
          });
          return;
        }
        await route.fulfill({
          status: 503,
          json: { error: "Duplicate academic assessment must not be called" },
        });
        return;
      }
      await route.fulfill({
        status: 503,
        json: { error: "Unused fixture operation" },
      });
    });
    await enterLegacyBuilding(page);
    await page.evaluate(() => {
      const g = (window as any).__deadAir.game,
        s = g.floors[0].stations.find((s: any) => s.encounter === "f0-room0");
      g.study.profile = "live";
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      Object.assign(g.survivors[0], { x: s.x, y: s.y });
    });
    await capturedWork(page, "PRIVATE_ACTIVE_BROWSER_DRAFT");
    await expect(page.locator("#terminal")).toBeHidden();
    const source = await page.evaluate(async () => {
      const d = (window as any).__deadAir,
        g = d.game,
        r = d.roadmap,
        e = g.encounters["f0-room0"],
        root = "/src/";
      const { prepareRoadmapExport } = await import(root + "roadmap-export.ts"),
        { applyLearningAssessment, closeLearningSession } = await import(
          root + "learner.ts"
        );
      const l = g.study.learner,
        c = e.problem.contract;
      const local = await prepareRoadmapExport(r, l);
      g.study.roadmapExport = local;
      const external = structuredClone(l),
        last = e.history
          .filter((h: any) => h.author === "human" && h.kind === "edit")
          .at(-1);
      applyLearningAssessment(r, external, e, {
        id: "synthetic-external-browser",
        encounter: e.id,
        sourceVersion: external.version,
        provenance: "study-mode",
        status: "pending",
        evidenceCutoffSequence: g.seq,
        visitOutcome: "usable",
        findings: c.objectiveIds.map((id: string) => ({
          objectiveId: id,
          depth: c.depth,
          facet: "scope",
          outcome: "assisted",
          evidence: [last.seq],
          rationale: "Synthetic source assistance, not independent credit",
        })),
      });
      closeLearningSession(external);
      return {
        incoming: (await prepareRoadmapExport(r, external, local)).content,
        problem: JSON.stringify(e.problem),
        attemptId: l.attempts[0].id,
      };
    });
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: "continued.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(source.incoming),
    });
    await page
      .getByRole("button", {
        name: "Request roadmap review",
        exact: true,
      })
      .click();
    await expect.poll(() => !!release).toBe(true);
    if (stale) {
      await page.locator("#close-inspector").click();
      await page.locator("#resume-game").click();
      await capturedWork(
        page,
        "PRIVATE_ACTIVE_BROWSER_DRAFT plus newer actual typing",
      );
      await openGameMenu(page);
      await page.locator("#curriculum-button").click();
      release();
      await expect(page.locator("#roadmap-adoption-controls")).toContainText(
        "human work changed",
      );
      await expect(
        page.getByRole("button", {
          name: "Adopt reviewed roadmap",
          exact: true,
        }),
      ).toHaveCount(0);
      expect(
        await page.evaluate(
          () => (window as any).__deadAir.game.study.learner.attempts[0].status,
        ),
      ).toBe("in-progress");
      await page.locator("#close-inspector").click();
      await page.locator("#resume-game").click();
      expect(await workspace(page)).toBe(
        "PRIVATE_ACTIVE_BROWSER_DRAFT plus newer actual typing",
      );
      await expect(page.locator("#terminal")).toBeHidden();
      return;
    }
    release();
    await expect(
      page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "keeps its original puzzle and draft for gameplay",
    );
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
      .click();
    await download;
    await expect(page.locator("#roadmap-adoption-status")).toContainText(
      "adopted and saved",
    );
    await page.locator("#close-inspector").click();
    await page.locator("#resume-game").click();
    expect(await workspace(page)).toBe("PRIVATE_ACTIVE_BROWSER_DRAFT");
    expect(
      await page.evaluate(
        () => (window as any).__deadAir.game.study.learner.attempts[0].status,
      ),
    ).toBe("externally-resolved");
    await expect(page.locator("#terminal")).toBeHidden();
    expect(
      await page.evaluate(() =>
        (window as any).__deadAir.game.encounters["f0-room0"].history.some(
          (h: any) => h.kind === "source-view",
        ),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        JSON.stringify(
          (window as any).__deadAir.game.encounters["f0-room0"].problem,
        ),
      ),
    ).toBe(source.problem);
    expect(
      await page.evaluate(
        () => (window as any).__deadAir.game.encounters["f0-room0"].state,
      ),
    ).toBe("in-progress");
    const retainedDraft =
      scenario === "new-work"
        ? "PRIVATE_ACTIVE_BROWSER_DRAFT with new technical work after import"
        : "PRIVATE_ACTIVE_BROWSER_DRAFT";
    if (scenario === "new-work") await capturedWork(page, retainedDraft);
    await page.screenshot({
      path: `test-results/active-roadmap-world-task-${scenario}.png`,
    });
    await page.evaluate(async () => {
      const d = (window as any).__deadAir,
        root = "/src/";
      const { submit } = await import(root + "ai.ts");
      await submit(d.game, d.game.encounters["f0-room0"], d.roadmap);
    });
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__deadAir.game.encounters["f0-room0"].state,
        ),
      )
      .toBe("consumed");
    expect(completeCalls).toBe(1);
    await expect.poll(() => assessCalls).toBe(scenario === "new-work" ? 1 : 0);
    if (scenario === "new-work")
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (window as any).__deadAir.game.study.assessments.at(-1)?.status,
          ),
        )
        .toBe("review-required");
    expect(
      await page.evaluate(() => {
        const s = (window as any).__deadAir.game.study;
        return [
          s.learner.cycle,
          s.visits.length,
          s.learner.evidence.length,
          s.learner.attempts.length,
        ];
      }),
    ).toEqual([0, 0, 0, 1]);
    await openGameMenu(page);
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    // The click resolves before the async save; reloading earlier loses it.
    await expect(page.locator("#notice")).toContainText("Run saved locally");
    await page.locator("#resume-game").click();
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    expect(
      await page.evaluate(() => {
        const g = (window as any).__deadAir.game;
        return {
          status: g.study.learner.attempts[0].status,
          draft: g.encounters["f0-room0"].workspace,
          question: JSON.stringify(g.encounters["f0-room0"].problem),
          state: g.encounters["f0-room0"].state,
        };
      }),
    ).toEqual({
      status: "externally-resolved",
      draft: retainedDraft,
      question: source.problem,
      state: "consumed",
    });
    await page.evaluate(() => {
      const g = (window as any).__deadAir.game,
        s = g.floors[0].stations.find((s: any) => s.encounter === "f0-room3");
      Object.assign(g.survivors[0], { x: s.x, y: s.y, station: undefined });
    });
    await capturedWork(page, "Fresh next eligible question draft", "f0-room3");
    expect(
      await page.evaluate(
        () =>
          (window as any).__deadAir.game.encounters["f0-room3"].problem.prompt,
      ),
    ).toContain("Synthetic task for f0-room3");
    await expect(page.locator("#terminal")).toBeHidden();
    expect(
      await page.evaluate(() => {
        const s = (window as any).__deadAir.game.study;
        return [
          s.learner.currentSession,
          s.learner.attempts.at(-1).id,
          s.visits.length,
        ];
      }),
    ).toEqual(["S0009", "S0009-A01", 0]);
    // A declared next counter is not an issued task: use its advertised ID once.
    expect(source.incoming).toContain("next shared attempt S0009-A01");
  });
