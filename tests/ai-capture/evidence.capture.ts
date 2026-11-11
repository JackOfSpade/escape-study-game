/**
 * Manual capture: real review-environment and reconcile-roadmap calls against
 * the real relay, fed with realistic learner-written evidence. Nothing under
 * /api is mocked.
 */
import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { startDesignedRun } from "../browser/helpers/designed-run";
import { openGameMenu } from "../browser/helpers/game-menu";
import { selectTopDown } from "../browser/helpers/view-mode";
import { countBridgeCalls, waitForBridgeIdle } from "./support";

const VARIANTS = Math.max(1, Number(process.env.CAPTURE_EVIDENCE ?? "3"));

/** A live run where the reviewer/roadmap capabilities are real, solo player. */
async function enterStudyRun(page: Page) {
  await page.goto("/");
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await selectTopDown(page);
  await startDesignedRun(page);
  await page.evaluate(async () => {
    const root = "/src/",
      g = (window as any).__deadAir.game,
      { checkBridge } = await import(/* @vite-ignore */ root + "ai.ts");
    await checkBridge();
    g.study.profile = "live";
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = 10000;
    for (const actor of g.survivors.slice(1)) actor.escaped = true;
  });
}

/** Environment observations written the way a learner would file them. */
const STATEMENTS = [
  "I rewrote the failing cache test in my own repo, ran the suite until it passed, and pasted the tail of that run. The fix was to assert on the loader's freshness token instead of the cached bytes.",
  "On a scratch copy of the project I ran the migration twice to check it is idempotent, compared the row counts by hand, and deleted the copy afterwards. Output log is from the second run.",
  "I paired the retry logic with a fault injection I wrote myself: the fake client throws on the first two calls, then succeeds. The attached log is the third attempt, which is the one that has to pass.",
];

const OUTPUTS = [
  "cache.test.ts ... 12 passed (12)\nDuration 1.9s\nRan locally against my own checkout.",
  "migration run 2/2\nrows before 1043\nrows after 1043\nschema_migrations unchanged",
  "attempt 1: ETIMEDOUT (injected)\nattempt 2: ETIMEDOUT (injected)\nattempt 3: succeeded after 812ms, 0 retries left",
];

/** Derive a plausible learner-side roadmap revision with genuine conflicts. */
async function deriveRoadmap(variant: number): Promise<string> {
  const roadmap = JSON.parse(await readFile("public/curriculum.json", "utf8"));
  let text: string = roadmap.raw
    .replace(/^revision: 9$/m, `revision: ${10 + variant}`)
    .replace(/^previous_revision: 8$/m, "previous_revision: 9")
    .replace(
      /^parent_file_sha256: .+$/m,
      `parent_file_sha256: ${roadmap.sourceHash}`,
    );
  const rows = text.split("\n").filter((row) => /^\| S\d{4}-A\d+ \|/.test(row));
  const row = rows[variant % rows.length];
  const cells = row
    .split("|")
    .slice(1, -1)
    .map((cell) => cell.trim());
  cells[3] =
    variant % 2 === 0
      ? "COMPLETED; redid it independently in my own repository"
      : "IN_PROGRESS; only the first half reviewed so far";
  cells[5] = "Reviewed with a scratched copy; local evidence still partial";
  text = text.replace(row, `| ${cells.join(" | ")} |`);
  return text.replace(
    "| Learner | Mid-level",
    `| Learner | Mid-level (self-report in revision ${10 + variant}: ${
      cells[0]
    } is done)`,
  );
}

test("review-environment: realistic learner observations reach the relay", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const counter = countBridgeCalls(page);
  await enterStudyRun(page);
  for (let variant = 0; variant < VARIANTS; variant++) {
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.locator("#environment-observations summary").click();
    const values = await page
      .locator("#environment-item option")
      .evaluateAll((options) =>
        options.map((option) => (option as HTMLOptionElement).value),
      );
    await page
      .locator("#environment-item")
      .selectOption(values[variant % values.length]);
    await page
      .locator("#environment-statement")
      .fill(STATEMENTS[variant % STATEMENTS.length]);
    await page.locator("#environment-output").setInputFiles({
      name: `capture-${variant + 1}.log`,
      mimeType: "text/plain",
      buffer: Buffer.from(OUTPUTS[variant % OUTPUTS.length], "utf8"),
    });
    await page
      .getByRole("button", { name: "Save observation for review", exact: true })
      .click();
    const before = counter.counts()["review-environment"] ?? 0;
    await page
      .getByRole("button", { name: "Review observation", exact: true })
      .click();
    await waitForBridgeIdle(page, counter, 10 * 60_000);
    await expect
      .poll(() => counter.counts()["review-environment"] ?? 0, {
        timeout: 10 * 60_000,
      })
      .toBeGreaterThan(before);
    const status = await page.locator("#environment-status").innerText();
    console.log(
      `[evidence] review-environment ${variant + 1}/${VARIANTS} status=${status.replace(/\s+/g, " ").slice(0, 120)}`,
    );
    await page.locator("#close-inspector").click();
    await page.waitForTimeout(1_000);
  }
  const counts = counter.counts();
  counter.stop();
  console.log(`[evidence] bridge calls ${JSON.stringify(counts)}`);
  expect(pageErrors).toEqual([]);
});

test("reconcile-roadmap: learner roadmap revisions reach the relay", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const counter = countBridgeCalls(page);
  await enterStudyRun(page);
  for (let variant = 0; variant < VARIANTS; variant++) {
    const incoming = await deriveRoadmap(variant);
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: `updated-${variant + 1}.md`,
      mimeType: "text/markdown",
      buffer: Buffer.from(incoming, "utf8"),
    });
    const before = counter.counts()["reconcile-roadmap"] ?? 0;
    await page
      .getByRole("button", { name: "Request roadmap review", exact: true })
      .click();
    await waitForBridgeIdle(page, counter, 35 * 60_000);
    await expect
      .poll(() => counter.counts()["reconcile-roadmap"] ?? 0, {
        timeout: 35 * 60_000,
      })
      .toBeGreaterThan(before);
    const controls = await page
      .locator("#roadmap-adoption-controls")
      .innerText();
    console.log(
      `[evidence] reconcile-roadmap ${variant + 1}/${VARIANTS} status=${controls.replace(/\s+/g, " ").slice(0, 160)}`,
    );
    await page.locator("#close-inspector").click();
    await page.waitForTimeout(1_000);
  }
  const counts = counter.counts();
  counter.stop();
  console.log(`[evidence] bridge calls ${JSON.stringify(counts)}`);
  expect(pageErrors).toEqual([]);
});
