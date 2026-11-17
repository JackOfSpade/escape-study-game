// Real request flow and learning transaction through the study workspace's
// modules, with isolated synthetic bridge responses.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { tier4RoadmapFixture } from "../fixtures/tier4-roadmap";
import { openAgentMenu, openApp, seedQuestions } from "./helpers/agent-menu";

// No browser case may accidentally release real model/bridge work.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status")
      return route.fulfill({
        json: {
          mode: "development",
          label: "Isolated fixture",
          detail: "No real study requests",
          capabilities: [],
        },
      });
    return route.fulfill({
      status: 503,
      json: { error: "Browser study/runner network is isolated" },
    });
  });
});

for (const fixtureKind of ["checkpoint", "transfer", "historical"] as const) {
  const finalRequirement = fixtureKind === "transfer",
    historical = fixtureKind === "historical";
  test(`controlled bridge fixture: ${finalRequirement ? "Tier 4 transfer" : historical ? "historical partial proof" : "ordinary checkpoint"}, real request flow and independent learning transaction`, async ({
    page,
  }) => {
    // This exercises the adapter with isolated synthetic responses. It does not
    // establish that any genuine Claude CLI connection is working.
    if (finalRequirement) {
      const source = tier4RoadmapFixture(
        JSON.parse(await readFile("public/curriculum.json", "utf8")),
      );
      await page.route("**/curriculum.json", (route) =>
        route.fulfill({ json: source }),
      );
    }
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: "claude-cli",
          label: "Test bridge fixture",
          detail: "Synthetic transport fixture only",
          capabilities: ["generate", "tutor", "complete", "assess"],
        },
      }),
    );
    await page.route("**/api/bridge", async (route) => {
      const { operation, payload } = route.request().postDataJSON();
      if (operation === "generate") {
        const c = payload.contract;
        await route.fulfill({
          json: {
            title: "Isolated bridge workflow",
            prompt: "A synthetic task for browser integration verification.",
            starter: "",
            rubric: ["scope"],
            contract: c,
            scopeDefinitions: [
              {
                id: `${c.objectiveIds[0]}/${c.kind === "transfer" || c.kind === "integration" ? "T4" : `D${c.depth}`}`,
                objectiveId: c.objectiveIds[0],
                depth: c.depth,
                sourceScope: c.scopes[0],
                facets: historical
                  ? [
                      {
                        id: "historical",
                        description:
                          "Preserve next-node access before changing a linked reference",
                      },
                      {
                        id: "scope",
                        description:
                          "Explain the remaining end-of-chain boundary",
                      },
                    ]
                  : [
                      {
                        id: "scope",
                        description:
                          "Synthetic complete scope for this test fixture",
                      },
                    ],
              },
            ],
          },
        });
        return;
      }
      if (operation === "complete") {
        await route.fulfill({
          json: {
            complete: true,
            feedback: "Fixture completion response.",
            qualified: ["human"],
          },
        });
        return;
      }
      if (operation === "assess") {
        const packet = payload.packet,
          c = packet.problem.contract,
          artifact = packet.history.find(
            (h: any) => h.author === "human" && h.kind === "edit",
          );
        if (historical)
          expect(packet.historicalSourceContext).toContain("| S0006-EV16 |");
        await route.fulfill({
          json: {
            historicalMappings: historical
              ? [
                  {
                    scopeId: packet.problem.scopeDefinitions[0].id,
                    facet: "historical",
                    sourceHash: packet.sourceHash,
                    evidenceIds: ["S0006-EV16"],
                    outcome: "independent",
                    rationale:
                      "Synthetic explicit narrow source-to-facet equivalence review",
                  },
                ]
              : undefined,
            findings: [
              {
                objectiveId: c.objectiveIds[0],
                facet: "scope",
                depth: c.depth,
                outcome: "independent",
                evidence: [artifact.seq],
                completeCheckpointScope: true,
                execution: "not-run",
                rationale: "Explicitly synthetic browser-test finding.",
              },
            ],
            visitOutcome: "usable",
            scopeReviews: [
              {
                id: packet.problem.scopeDefinitions[0].id,
                completeCoverage: true,
                rationale: "Synthetic scope review.",
              },
            ],
            helpAttributions: (packet.assistanceSources ?? []).map(
              (m: any) => ({
                messageId: m.id,
                facets: [],
                rationale:
                  "Fixture prompt contains a question only and supplies no answer.",
              }),
            ),
          },
        });
        return;
      }
      await route.fulfill({ json: { text: "Fixture guidance" } });
    });
    await openApp(page);
    await seedQuestions(page);
    await page.waitForFunction(
      () => (window as any).__deadAir.game.study.profile === "live",
    );
    await page.evaluate(
      (flags) => {
        const g = (window as any).__deadAir.game;
        if (flags.finalRequirement) {
          g.study.learner.reviews = {};
          g.study.learner.tracks.PY.cleared = 3;
          g.study.learner.tracks.PE.cleared = 3;
        }
        if (flags.historical) {
          g.study.learner.reviews = {};
          g.study.learner.tracks.PY.queue = ["T07"];
        }
      },
      { finalRequirement, historical },
    );
    await page.evaluate(async () => {
      const d = (window as any).__deadAir,
        root = "/src/";
      const { ensureProblem, presentProblem, edit, submit } = await import(
        root + "ai.ts"
      );
      const e = d.game.encounters["question-0"];
      await ensureProblem(d.game, e, d.roadmap);
      presentProblem(d.game, e, d.roadmap);
      edit(
        d.game,
        e,
        "Human-authored integration fixture reasoning, covering the defined scope without any asserted runtime execution.",
        e.revision,
        d.roadmap,
      );
      await submit(d.game, e, d.roadmap);
    });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = (window as any).__deadAir.game;
          return {
            evidence: g.study.learner.evidence.length,
            reviews: g.study.assessments
              .filter((a: any) => a.status === "review-required")
              .map((a: any) => a.error ?? a.rationale ?? a),
          };
        }),
      )
      .toEqual({ evidence: 1, reviews: [] });
    const result = await page.evaluate(() => {
      const g = (window as any).__deadAir.game;
      return {
        profile: g.study.profile,
        attempt: g.study.learner.attempts[0].id,
        outcome: g.study.assessments[0].status,
        cycle: g.study.learner.cycle,
        sourcePasses: g.study.learner.cells["PY:T05.2"].states[0],
      };
    });
    expect(result).toEqual({
      profile: "live",
      attempt: "S0008-A01",
      outcome: "applied",
      cycle: 1,
      sourcePasses: "P",
    });
    if (finalRequirement) {
      expect(
        await page.evaluate(() => {
          const l = (window as any).__deadAir.game.study.learner;
          return {
            status: l.finalProgress["PY:T01"].status,
            ordinaryCells: Object.keys(l.cells).length,
            fakeCell: l.cells["PY:T01"],
          };
        }),
      ).toEqual({ status: "P", ordinaryCells: 192, fakeCell: undefined });
    }
    if (historical)
      expect(
        await page.evaluate(() => {
          const l = (window as any).__deadAir.game.study.learner;
          return {
            status: l.cells["PY:T07.1"].states[0],
            oldRefs: l.cells["PY:T07.1"].facets["D1:historical"].evidenceIds,
            newObservations: l.evidence.length,
            reconciliations: l.historicalReviews.length,
          };
        }),
      ).toEqual({
        status: "P",
        oldRefs: ["S0006-EV16"],
        newObservations: 1,
        reconciliations: 1,
      });
    await openAgentMenu(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.locator("#inspector-content")).toContainText(
      "Recorded academic visits: 1",
    );
    if (historical) {
      await page
        .getByText("Historical facet reconciliations (1)", { exact: true })
        .click();
      await expect(page.locator("#inspector-content")).toContainText(
        "S0006-EV16 observed 2026-09-18",
      );
      await expect(page.locator("#inspector-content")).toContainText(
        "Reconciliation dates record review activity, not new human demonstrations",
      );
    }
    const firstDownload = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: "Download updated merged roadmap",
        exact: true,
      })
      .click();
    const first = await firstDownload;
    const exported = await readFile((await first.path())!, "utf8");
    expect(exported).toContain("revision: 10\nprevious_revision: 9");
    expect(exported).toContain("S0008-EV01");
    if (historical) {
      expect(exported).toContain(
        "Historical facet reconciliation (no new observation IDs)",
      );
      expect([...exported.matchAll(/^\| S0006-EV16 \|/gm)]).toHaveLength(1);
    }
    if (finalRequirement) {
      expect(exported).toMatch(/\| T01 \| P \|[^\n]*S0008-EV01/);
      expect(exported).toContain("PY:T01/T4");
    }
    expect(exported).not.toContain(
      "Human-authored integration fixture reasoning",
    );
    await expect(page.locator("#progress-export-status")).toContainText(
      "revision 10",
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await openAgentMenu(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    const secondDownload = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: "Download updated merged roadmap",
        exact: true,
      })
      .click();
    const second = await secondDownload;
    expect(await readFile((await second.path())!, "utf8")).toBe(exported);
  });
}
