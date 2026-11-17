// Practical environment observations through the curriculum inspector, with
// isolated synthetic bridge responses.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openAgentMenu, openApp } from "./helpers/agent-menu";
import { flushStudySave } from "./study-harness";

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

test("practical observations: unreviewed output is inert, persists without changing ENV or academic status, and fits a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/");
  await openApp(page);
  const before = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return JSON.stringify(g.study.learner);
  });
  await openAgentMenu(page);
  await page.locator("#curriculum-button").click();
  await page.locator("#environment-observations summary").click();
  await expect(page.locator("#environment-item option")).toHaveCount(6);
  await page.locator("#environment-item").selectOption("PE:ENV02");
  await page
    .locator("#environment-statement")
    .fill(
      "I supplied a profiling log <script>window.badENV=true</script>; no metric is verified yet.",
    );
  const output =
    "Unreviewed browser metric output\n<script>window.badENV=true</script>\n";
  await page.locator("#environment-output").setInputFiles({
    name: "metrics.log",
    mimeType: "text/plain",
    buffer: Buffer.from(output),
  });
  await page
    .getByRole("button", { name: "Save observation for review", exact: true })
    .click();
  await expect(page.locator("#environment-status")).toContainText(
    "No ENV pass",
  );
  await expect(page.locator("#environment-observation-list")).toContainText(
    "learner-supplied output",
  );
  await expect(page.locator("#environment-observation-list")).toContainText(
    "<script>",
  );
  expect(await page.evaluate(() => (window as any).badENV)).toBeUndefined();
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(before);
  expect(
    await page.evaluate(() => {
      const node = document.querySelector<HTMLElement>(
        "#environment-observations",
      )!;
      return node.scrollWidth <= node.clientWidth + 1;
    }),
  ).toBe(true);
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download observation packet", exact: true })
    .click();
  const file = await (await downloadPromise).path(),
    packet = JSON.parse(await readFile(file!, "utf8"));
  expect(packet.suppliedOutput.text).toBe(output);
  expect(packet.status).toBe("pending-review");
  expect(packet.execution).toBeUndefined();
  await page.locator("#environment-observations").scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/environment-observations.png" });
  await page.locator("#close-inspector").click();
  await flushStudySave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await openAgentMenu(page);
  await page.locator("#curriculum-button").click();
  await page.locator("#environment-observations summary").click();
  await expect(page.locator("#environment-observation-list")).toContainText(
    "1 saved observation packet",
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(before);
});

test("environment packet survives an actual browser-storage write failure and can be downloaded or retried without duplication", async ({
  page,
}) => {
  await page.goto("/");
  await openApp(page);
  await page.evaluate(async () => {
    const root = "/src/",
      p = await import(root + "persistence.ts");
    await p.flushSaves();
    const storage = Storage.prototype.setItem,
      transaction = IDBDatabase.prototype.transaction;
    Storage.prototype.setItem = function () {
      throw new DOMException(
        "Synthetic storage quota failure",
        "QuotaExceededError",
      );
    };
    IDBDatabase.prototype.transaction = function (...args: any[]) {
      if (args[1] === "readwrite")
        throw new DOMException("Synthetic write failure", "UnknownError");
      return (transaction as any).apply(this, args);
    };
    (window as any).restoreEnvironmentStorage = () => {
      Storage.prototype.setItem = storage;
      IDBDatabase.prototype.transaction = transaction;
    };
  });
  await openAgentMenu(page);
  await page.locator("#curriculum-button").click();
  await page.locator("#environment-observations summary").click();
  await page
    .locator("#environment-statement")
    .fill("Reported keyboard check; no verified runtime claim.");
  await page
    .getByRole("button", { name: "Save observation for review", exact: true })
    .click();
  await expect(page.locator("#environment-status")).toContainText(
    "retained in this run, but local save failed",
  );
  await expect(page.locator("#environment-observation-list")).toContainText(
    "1 saved observation packet",
  );
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download observation packet", exact: true })
    .click();
  const file = await (await downloadPromise).path(),
    packet = JSON.parse(await readFile(file!, "utf8"));
  expect(packet.learnerStatement).toBe(
    "Reported keyboard check; no verified runtime claim.",
  );
  await page.evaluate(() => (window as any).restoreEnvironmentStorage());
  await page
    .getByRole("button", { name: "Save observation for review", exact: true })
    .click();
  await expect(page.locator("#environment-status")).toContainText(
    "saved locally for review",
  );
  await expect(page.locator("#environment-observation-list")).toContainText(
    "1 saved observation packet",
  );
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.study.environmentObservations[0].id,
    ),
  ).toBe(packet.id);
});

for (const { storageFailure, provider } of [
  { storageFailure: false, provider: "claude-cli" },
  { storageFailure: true, provider: "claude-cli" },
])
  test(`practical ${provider} review: explicit outage retry, separate ENV pass, inert judgment, complete export and reload${storageFailure ? " with save outage" : ""}`, async ({
    page,
  }) => {
    // Isolated live-mode ledger exercises the actual export guard. The reviewer and
    // learner work below are synthetic and never certify real human progress.
    let releaseReview: (() => void) | undefined;
    let calls = 0,
      first: any;
    const reviewReply = (p: any) => ({
      requestId: p.requestId,
      sourceHash: p.sourceHash,
      observationId: p.observation.id,
      observationFingerprint: p.observation.fingerprint,
      envId: p.definition.id,
      classification: "observed",
      learnerWork: true,
      learnerWorkQuote: "I wrote and executed the tests",
      reviewedOutputs: [
        { kind: "supplied-output", excerpt: "one browser test passed" },
      ],
      covered: ["Synthetic complete test scope"],
      remaining: [],
      completeScope: true,
      rationale: "Synthetic only <script>window.badReview=true</script>",
    });
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: provider,
          label: "Synthetic ENV reviewer",
          detail: "Not live-model verification",
          capabilities: ["review-environment"],
        },
      }),
    );
    await page.route("**/api/bridge", async (route) => {
      const { operation, payload: p } = route.request().postDataJSON();
      // Background question preparation is not part of this test.
      if (operation !== "review-environment")
        return route.fulfill({
          status: 503,
          json: { error: "Not part of this test" },
        });
      expect(p.provider).toBe(provider);
      calls++;
      if (calls === 1) {
        first = p;
        await route.fulfill({
          status: 503,
          json: { error: "Synthetic review outage" },
        });
        return;
      }
      expect(p).toEqual(first);
      await new Promise<void>((resolve) => {
        releaseReview = resolve;
      });
      await route.fulfill({ json: reviewReply(p) });
    });
    await page.goto("/");
    // This review never needs the first-person city. Software WebGL makes
    // each of its frames cost seconds and starves every later UI step.
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await page.evaluate(() => {});
    await openApp(page);
    const before = await page.evaluate(async () => {
      const g = (window as any).__deadAir.game,
        root = "/src/",
        { checkBridge } = await import(root + "ai.ts");
      await checkBridge();
      g.study.profile = "live";
      return JSON.stringify({
        cells: g.study.learner.cells,
        attempts: g.study.learner.attempts,
        sessions: g.study.learner.sessions,
        cycle: g.study.learner.cycle,
      });
    });
    await openAgentMenu(page);
    await page.locator("#curriculum-button").click();
    await page.locator("#environment-observations summary").click();
    await page.locator("#environment-item").selectOption("PE:ENV06");
    await page
      .locator("#environment-statement")
      .fill("I wrote and executed the tests in my own repository.");
    await page.locator("#environment-output").setInputFiles({
      name: "synthetic.log",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "PRIVATE_OUTPUT_NOT_FOR_ROADMAP: one browser test passed",
      ),
    });
    await page
      .getByRole("button", { name: "Save observation for review", exact: true })
      .click();
    await expect(page.locator("#environment-status")).toContainText(
      "No ENV pass",
    );
    await page
      .getByRole("button", { name: "Review observation", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Retry review", exact: true }),
    ).toBeVisible();
    await expect(page.locator("#environment-status")).toContainText("retry");
    await page.waitForTimeout(400);
    expect(calls).toBe(1);
    if (storageFailure)
      await page.evaluate(async () => {
        const root = "/src/",
          { flushSaves } = await import(root + "persistence.ts");
        await flushSaves();
        const set = Storage.prototype.setItem,
          transaction = IDBDatabase.prototype.transaction;
        Storage.prototype.setItem = function () {
          throw Error("Synthetic review storage failure");
        };
        IDBDatabase.prototype.transaction = function (...args: any[]) {
          if (args[1] === "readwrite")
            throw Error("Synthetic review storage failure");
          return (transaction as any).apply(this, args);
        };
        (window as any).restoreReviewStorage = () => {
          Storage.prototype.setItem = set;
          IDBDatabase.prototype.transaction = transaction;
        };
      });
    await page
      .getByRole("button", { name: "Retry review", exact: true })
      .click();
    await expect.poll(() => !!releaseReview).toBe(true);
    await page.locator("#close-inspector").click();
    await openAgentMenu(page);
    await page.locator("#curriculum-button").click();
    await page.locator("#environment-observations summary").click();
    releaseReview!();
    await expect(page.locator("#environment-status")).toContainText(
      storageFailure ? "Review/save unavailable" : "Practical review saved",
    );
    await expect(page.locator("#environment-observation-list")).toContainText(
      "PE:ENV06 · P · applied",
    );
    await expect(page.locator("#environment-observation-list")).toContainText(
      "<script>",
    );
    expect(
      await page.evaluate(() => (window as any).badReview),
    ).toBeUndefined();
    expect(
      await page.evaluate(() => {
        const g = (window as any).__deadAir.game;
        return JSON.stringify({
          cells: g.study.learner.cells,
          attempts: g.study.learner.attempts,
          sessions: g.study.learner.sessions,
          cycle: g.study.learner.cycle,
        });
      }),
    ).toBe(before);
    await expect(page.locator('[data-readiness="PE"]')).toContainText(
      "Observed environment skills 1/6",
    );
    if (storageFailure) {
      const recovery = page.waitForEvent("download");
      await page.locator("#evidence-export").click();
      const backup = JSON.parse(
        await readFile((await (await recovery).path())!, "utf8"),
      );
      expect(backup.study.environmentReviews[0].state).toBe("applied");
      expect(backup.study.learner.environmentEvidence).toHaveLength(1);
      await page.evaluate(() => (window as any).restoreReviewStorage());
    }
    const download = page.waitForEvent("download");
    await page.locator("#progress-export").click();
    const text = await readFile((await (await download).path())!, "utf8");
    expect(text).toMatch(/\| ENV06 \|[^\n]+\| P \|/);
    expect(text).not.toContain("PRIVATE_OUTPUT_NOT_FOR_ROADMAP");
    expect(text).not.toContain("window.badReview");
    expect(text).toContain("revision: 10");
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await openAgentMenu(page);
    await page.locator("#curriculum-button").click();
    await page.locator("#environment-observations summary").click();
    await expect(page.locator("#environment-observation-list")).toContainText(
      "PE:ENV06 · P · applied",
    );
    await expect(page.locator("#environment-observation-list")).toContainText(
      "Reviewed through Claude CLI",
    );
    expect(
      await page.evaluate(
        () =>
          (window as any).__deadAir.game.study.learner.environmentEvidence[0]
            .provenance,
      ),
    ).toBe(provider);
    expect(calls).toBe(2);
    expect(
      await page.evaluate(() => ({
        ev: (window as any).__deadAir.game.study.learner.evidence.length,
        visits: (window as any).__deadAir.game.study.visits.length,
      })),
    ).toEqual({ ev: 0, visits: 0 });
    const again = page.waitForEvent("download");
    await page.locator("#progress-export").click();
    expect(await readFile((await (await again).path())!, "utf8")).toBe(text);
  });
