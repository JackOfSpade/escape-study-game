import { openGameMenu } from "./helpers/game-menu";
// Controlled local queue only; no external ChatGPT or real learner transmission.
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
// @ts-expect-error Local relay integration.
import { createHandoffQueue } from "../../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Local relay integration.
import { createHandoffRoutes } from "../../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Local relay integration.
import { createStudyBridgeServer } from "../../scripts/study-bridge-server.mjs";

test("ChatGPT roadmap review survives reload with exact files and provider, then requires explicit adoption", async ({
  page,
}) => {
  const q = createHandoffQueue();
  q.enable(true);
  const server: Server = createStudyBridgeServer({
    handoff: createHandoffRoutes(q, { token: "isolated-test-token" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing relay");
  const base = `http://127.0.0.1:${address.port}`;
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const response = await fetch(base + url.pathname + url.search, {
      method: request.method(),
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:5173",
      },
      ...(request.method() === "POST" ? { body: request.postData()! } : {}),
    });
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: await response.text(),
    });
  });
  try {
    const r = JSON.parse(await readFile("public/curriculum.json", "utf8"));
    const incoming = r.raw
      .replace(/^revision: 9$/m, "revision: 10")
      .replace(/^previous_revision: 8$/m, "previous_revision: 9")
      .replace(
        /^parent_file_sha256: .+$/m,
        `parent_file_sha256: ${r.sourceHash}`,
      )
      .replace(
        "| Learner | Mid-level",
        "| Learner | Synthetic administrative review; Mid-level",
      );
    await page.goto("/");
    // The app exposes __deadAir only after its top-level bridge/log awaits,
    // which can finish after the load event that goto waits for.
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await page.evaluate(async () => {
      const root = "/src/",
        { createGame } = await import(root + "world.ts"),
        { save } = await import(root + "persistence.ts");
      const r = await (await fetch("/curriculum.json")).json(),
        g = createGame(7, r);
      g.study.profile = "live";
      g.status = "playing";
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      for (const a of g.survivors.slice(1)) a.escaped = true;
      Object.assign((window as any).__deadAir.game, g);
      await save((window as any).__deadAir.game);
    });
    await page.reload();
    await expect(page.locator("#bridge-label")).toContainText(
      "ChatGPT handoff",
    );
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page.getByText("Review an updated roadmap", { exact: true }).click();
    await page.locator("#roadmap-review-file").setInputFiles({
      name: "synthetic-review.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(incoming),
    });
    await expect(page.locator("#roadmap-adoption-controls")).toContainText(
      "complete local working roadmap",
    );
    await page
      .getByRole("button", {
        name: "Request ChatGPT roadmap review",
        exact: true,
      })
      .click();
    await expect.poll(() => q.snapshot().queued).toBe(1);
    const worker = "isolated-roadmap-worker",
      job = q.get(worker);
    expect(job.operation).toBe("reconcile-roadmap");
    let p = job.payload;
    if (job.payloadManifest) {
      const parts = [];
      for (let i = 0; i < job.payloadManifest.parts; i++)
        parts.push(q.part(worker, job.jobId, job.claim, i).text);
      p = JSON.parse(parts.join(""));
    }
    expect(p.provider).toBe("chatgpt-handoff");
    expect(p.candidate).toBe(incoming);
    expect(
      await page
        .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
        .count(),
    ).toBe(0);
    await openGameMenu(page);
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    // The click resolves before the async save; reloading earlier loses it.
    await expect(page.locator("#notice")).toContainText("Run saved locally");
    await page.reload();
    await openGameMenu(page);
    await page.locator("#curriculum-button").click();
    await page
      .getByRole("button", { name: "Retry saved reconciliation", exact: true })
      .click();
    await expect.poll(() => q.snapshot().queued).toBe(0);
    expect(q.get(worker).jobId).toBe(job.jobId);
    expect(q.get(worker).requestHash).toBe(job.requestHash);
    q.submit(worker, job.jobId, job.claim, {
      requestId: p.requestId,
      localHash: p.localHash,
      candidateHash: p.candidateHash,
      canonical: p.candidate,
      definitions: [],
      mappings: [],
      completeScopes: [],
      decisions: [],
      rationale:
        "Controlled administrative proposal; no mastery or execution claim",
    });
    await expect(
      page.getByRole("button", { name: "Adopt reviewed roadmap", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (window as any).__deadAir.game.study.learner.roadmapAdoptions
            ?.length ?? 0,
      ),
    ).toBe(0);
    await page
      .getByRole("button", { name: "Adopt reviewed roadmap", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).__deadAir.game.study.learner.roadmapAdoptions?.at(
              -1,
            )?.provenance,
        ),
      )
      .toBe("chatgpt-handoff");
    // Adoption is applied in memory before it is persisted; wait for the save.
    await expect(page.locator("#roadmap-adoption-status")).toContainText(
      "adopted and saved",
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    const saved = await page.evaluate(() => {
      const s = (window as any).__deadAir.game.study;
      return {
        provider: s.learner.roadmapAdoptions.at(-1).provenance,
        content: s.roadmapExport.content,
        visits: s.visits.length,
      };
    });
    expect(saved).toEqual({
      provider: "chatgpt-handoff",
      content: incoming,
      visits: 0,
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
