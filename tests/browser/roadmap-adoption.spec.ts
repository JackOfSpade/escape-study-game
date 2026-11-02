import { startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
import { selectTopDown } from "./helpers/view-mode";
// Synthetic bridge responses exercise the real UI/adapter, not native semantic quality.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { finalRequirements } from "../../src/final-requirements";
import {
  projectIdentifierCounters,
  readIdentifierCounters,
} from "../../src/roadmap-identifiers";

for (const scenario of [
  "saved",
  "interrupted",
  "stale",
  "storage failure",
  "historical update",
  "manual transfer",
] as const)
  test(`roadmap adoption UI: explicit review, exact proposal and ${scenario}`, async ({
    page,
  }) => {
    await page.route("**/api/**", (route) =>
      route.fulfill({
        status: 503,
        json: { error: "Isolated synthetic roadmap-adoption fixture" },
      }),
    );
    const r = JSON.parse(await readFile("public/curriculum.json", "utf8"));
    let incoming = r.raw
      .replace(/^revision: 9$/m, "revision: 10")
      .replace(/^previous_revision: 8$/m, "previous_revision: 9")
      .replace(
        /^parent_file_sha256: .+$/m,
        `parent_file_sha256: ${r.sourceHash}`,
      )
      .replace(
        "| Learner | Mid-level",
        '| Learner | <img src=x onerror="window.adoptionInjected=true"> Mid-level',
      );
    if (scenario === "historical update") {
      const old = incoming
        .split("\n")
        .find((row: string) => row.startsWith("| S0004-A13 |"))!;
      const cells = old
        .split("|")
        .slice(1, -1)
        .map((s: string) => s.trim());
      cells[3] = "COMPLETED; assisted external continuation";
      cells[4] = "S0004-EV99";
      cells[5] = "Preserve all unresolved independent facets";
      incoming = incoming.replace(old, `| ${cells.join(" | ")} |`);
      const marker = incoming.indexOf(
        "### 0.5.1 Attempt status register",
        incoming.indexOf("<!-- BEGIN PE_PROGRESS -->"),
      );
      incoming =
        incoming.slice(0, marker) +
        "| S0004-EV99 | S0004-A13 | 2026-10-16 | T02.1 | D1 synthetic metric continuation | GUIDED | HINT | 1 | Synthetic assisted observation; not independent proof or runtime execution. |\n\n" +
        incoming.slice(marker);
    }
    const transferExcerpt =
      "Synthetic independent changed-context explanation covers the full reviewed topic scope without supplied reasoning. No actual runtime execution is claimed.";
    if (scenario === "manual transfer") {
      const begin = incoming.indexOf("<!-- BEGIN PY_PROGRESS -->"),
        end = incoming.indexOf("<!-- END PY_PROGRESS -->");
      let block = incoming.slice(begin, end);
      let at = block.indexOf("### 0.5.1 Attempt status register");
      block =
        block.slice(0, at) +
        `| S0007-EV98 | S0007-A98 | 2026-10-16 | T01 | Independent changed-context topic transfer | TRANSFER | NONE | 3 | ${transferExcerpt} |\n\n` +
        block.slice(at);
      at = block.indexOf("### 0.6 Facet gaps");
      block =
        block.slice(0, at) +
        "| S0007-A98 | S0007 / 2026-10-16 | T01 changed-context assessment | COMPLETED; source-recorded independent transfer | S0007-EV98 | Synthetic task, not a game visit |\n\n" +
        block.slice(at);
      block = block.replace(
        "| T01 | U | — | U | — |",
        "| T01 | P | S0007-EV98 | U | — |",
      );
      incoming = incoming.slice(0, begin) + block + incoming.slice(end);
      incoming = projectIdentifierCounters(
        incoming,
        readIdentifierCounters(incoming, false).counters,
      );
    }
    let release!: () => void;
    let calls = 0;
    const payloads: any[] = [];
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: "claude-cli",
          label: "Synthetic adoption fixture",
          detail: "Not actual native certification",
          capabilities: ["reconcile-roadmap"],
        },
      }),
    );
    await page.route("**/api/bridge", async (route) => {
      const { operation, payload } = route.request().postDataJSON();
      // Background question preparation is not part of this test.
      if (operation !== "reconcile-roadmap")
        return route.fulfill({
          status: 503,
          json: { error: "Not part of this test" },
        });
      payloads.push(payload);
      calls++;
      if (scenario === "saved" && calls === 1) {
        await route.fulfill({
          status: 503,
          json: { error: "Synthetic reconciliation outage" },
        });
        return;
      }
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.fulfill({
        json: {
          requestId: payload.requestId,
          localHash: payload.localHash,
          candidateHash: payload.candidateHash,
          canonical: payload.candidate,
          definitions:
            scenario === "manual transfer"
              ? [
                  {
                    id: "PY:T01/T4",
                    objectiveId: "PY:T01",
                    depth: 4,
                    sourceScope: finalRequirements(r, "PY").find(
                      (d) => d.id === "PY:T01",
                    )!.scope,
                    facets: [
                      {
                        id: "scope",
                        description:
                          "Synthetic native review of complete changed-context topic scope",
                      },
                    ],
                  },
                ]
              : [],
          mappings:
            scenario === "manual transfer"
              ? [
                  {
                    scopeId: "PY:T01/T4",
                    facet: "scope",
                    outcome: "independent",
                    evidenceIds: ["S0007-EV98"],
                    sourceExcerpts: { "S0007-EV98": transferExcerpt },
                    rationale:
                      "Synthetic semantic review, not actual human certification",
                  },
                ]
              : [],
          completeScopes: scenario === "manual transfer" ? ["PY:T01/T4"] : [],
          ...(scenario === "historical update"
            ? {
                attemptUpdates: [
                  {
                    track: "PE",
                    attemptId: "S0004-A13",
                    rationale:
                      "Synthetic exact source-backed historical disposition update",
                  },
                ],
              }
            : {}),
          decisions: [],
          rationale:
            "Synthetic metadata-only review <img src=x onerror=window.adoptionInjected=true>",
        },
      });
    });
    await page.goto("/");
    await startDesignedRun(page);
    // Roadmap menus are view-independent; headless WebGL is software-rendered.
    await selectTopDown(page);
    const before = await page.evaluate(() => {
      const g = (window as any).__deadAir.game;
      g.study.profile = "live";
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      g.encounters["f0-room0"].code = "private draft must survive adoption";
      return JSON.stringify(g.study.learner);
    });
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: "updated.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(incoming),
    });
    await page
      .getByRole("button", {
        name: "Request roadmap review",
        exact: true,
      })
      .click();
    if (scenario === "saved") {
      await expect(
        page.getByRole("button", { name: "Retry saved reconciliation" }),
      ).toBeVisible();
      expect(calls).toBe(1);
      await page.reload();
      await page.waitForFunction(() => !!(window as any).__deadAir);
      await openGameMenu(page);
      await page.locator("#curriculum-button").click();
      await page
        .getByRole("button", { name: "Retry saved reconciliation" })
        .click();
    }
    await expect.poll(() => !!release).toBe(true);
    if (scenario === "interrupted") {
      const interruptedRelease = release;
      await page.reload();
      await page.waitForFunction(() => !!(window as any).__deadAir);
      interruptedRelease();
      await openGameMenu(page);
      await page.locator("#curriculum-button").click();
      // The reload ended the in-flight request: nothing was applied, and the
      // saved reconciliation can be retried exactly.
      await expect(page.locator("#roadmap-adoption-controls")).toContainText(
        "Retry saved reconciliation",
      );
      await expect(
        page.getByRole("button", { name: "Adopt reviewed roadmap" }),
      ).toHaveCount(0);
      expect(calls).toBe(1);
      await page
        .getByRole("button", { name: "Retry saved reconciliation" })
        .click();
      await expect.poll(() => calls).toBe(2);
    }
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "pending",
    );
    await page.locator("#close-inspector").click();
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "pending",
    );
    const t = await page.evaluate(() => (window as any).__deadAir.game.time);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
      t,
    );
    expect(
      await page.evaluate(() => (window as any).__deadAir.game.paused),
    ).toBe(true);
    // The inspector pauses survival, while its captured review request stays
    // pending. Explicitly resume to check that background work never freezes
    // the playable clock, then return to the same proposal.
    await page.locator("#close-inspector").click();
    await page.locator("#resume-game").click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__deadAir.game.time))
      .toBeGreaterThan(t + 0.2);
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "pending",
    );
    release();
    await expect(
      page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
    ).toBeVisible();
    const expectedCanonical = await page.evaluate(
      () =>
        (window as any).__deadAir.game.study.roadmapReconciliations.at(-1)
          .proposal.canonical,
    );
    if (scenario === "historical update") {
      expect(expectedCanonical).toContain("<!-- ATTEMPT_UPDATE ");
      await expect(page.locator("#roadmap-adoption-controls")).toContainText(
        "Both previous and updated dispositions",
      );
    } else expect(expectedCanonical).toBe(incoming);
    if (scenario === "saved" || scenario === "interrupted")
      expect(payloads[1]).toEqual(payloads[0]);
    expect(
      await page.evaluate(() =>
        JSON.stringify((window as any).__deadAir.game.study.learner),
      ),
    ).toBe(before);
    await expect(page.locator("#roadmap-adoption-controls img")).toHaveCount(0);
    expect(
      await page.evaluate(() => (window as any).adoptionInjected),
    ).toBeUndefined();
    await page
      .getByText("Proposed progress differences", { exact: true })
      .click();
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "Complete proposed SHA-256",
    );
    if (scenario === "historical update" || scenario === "manual transfer")
      await page.screenshot({
        path:
          scenario === "manual transfer"
            ? "test-results/roadmap-manual-transfer.png"
            : "test-results/roadmap-history-adoption.png",
      });
    const proposedDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download proposed roadmap", exact: true })
      .click();
    expect(
      await readFile((await (await proposedDownload).path()) as string, "utf8"),
    ).toBe(expectedCanonical);
    if (scenario === "stale") {
      await page.evaluate(() => {
        (window as any).__deadAir.game.study.learner.version++;
      });
      const changed = await page.evaluate(() =>
        JSON.stringify((window as any).__deadAir.game.study.learner),
      );
      await page
        .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
        .click();
      await expect(page.locator("#roadmap-adoption-status")).toContainText(
        "Adoption not applied",
      );
      expect(
        await page.evaluate(() =>
          JSON.stringify((window as any).__deadAir.game.study.learner),
        ),
      ).toBe(changed);
      expect(
        await page.evaluate(
          () =>
            (window as any).__deadAir.game.study.roadmapAdoptionBackups
              ?.length ?? 0,
        ),
      ).toBe(0);
      return;
    }
    if (scenario === "storage failure")
      await page.evaluate(async () => {
        const root = "/src/";
        await (await import(root + "persistence.ts")).flushSaves();
        const set = Storage.prototype.setItem,
          transaction = IDBDatabase.prototype.transaction;
        Storage.prototype.setItem = function () {
          throw Error("Synthetic adoption storage failure");
        };
        IDBDatabase.prototype.transaction = function (...args: any[]) {
          if (args[1] === "readwrite")
            throw Error("Synthetic adoption storage failure");
          return (transaction as any).apply(this, args);
        };
        (window as any).restoreAdoptionStorage = () => {
          Storage.prototype.setItem = set;
          IDBDatabase.prototype.transaction = transaction;
        };
      });
    const adoptedDownload = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
      .click();
    expect(
      await readFile((await (await adoptedDownload).path()) as string, "utf8"),
    ).toBe(expectedCanonical);
    await expect(page.locator("#roadmap-adoption-status")).toContainText(
      scenario !== "storage failure"
        ? "adopted and saved"
        : "local save failed",
    );
    const result = await page.evaluate(() => {
      const g = (window as any).__deadAir.game;
      return {
        content: g.study.roadmapExport.content,
        backups: g.study.roadmapAdoptionBackups.length,
        visits: g.study.visits.length,
        evidence: g.study.learner.evidence.length,
        draft: g.encounters["f0-room0"].code,
      };
    });
    expect(result).toEqual({
      content: expectedCanonical,
      backups: 1,
      visits: 0,
      evidence: 0,
      draft: "private draft must survive adoption",
    });
    if (scenario === "storage failure") {
      await expect(page.locator("#roadmap-adoption-status")).toContainText(
        "full evidence/run backup",
      );
      await page.evaluate(async () => {
        (window as any).restoreAdoptionStorage();
        const root = "/src/";
        await (
          await import(root + "persistence.ts")
        ).save((window as any).__deadAir.game);
      });
    }
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    expect(
      await page.evaluate(
        () => (window as any).__deadAir.game.study.roadmapExport.content,
      ),
    ).toBe(expectedCanonical);
    if (scenario === "manual transfer")
      expect(
        await page.evaluate(
          () =>
            (window as any).__deadAir.game.study.learner.finalProgress["PY:T01"]
              .status,
        ),
      ).toBe("P");
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "1 reviewed import(s)",
    );
    await expect(
      page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
    ).toHaveCount(0);
  });
