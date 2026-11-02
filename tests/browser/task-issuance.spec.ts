import { chooseDesignedRun } from "./helpers/designed-run";
// Real issuance/persistence lifecycle with a synthetic Claude gateway.
import { expect, test } from "@playwright/test";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import { openGameMenu } from "./helpers/game-menu";
import { killHumanInStep } from "./study-harness";

test("restart saves the unfinished task and immediately allows a new question, including after reload", async ({
  page,
}) => {
  let generations = 0,
    questions = 0;
  const assessmentCalls: any[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (url.pathname === "/api/status")
      return json({
        mode: "claude-cli",
        label: "Synthetic Claude gateway",
        detail: "Synthetic fixture; no real AI",
        capabilities: ["generate", "assess", "tutor"],
      });
    if (url.pathname !== "/api/bridge")
      return json({ error: "Unused synthetic route" }, 404);
    const { operation, payload } = request.postDataJSON();
    // Background preparation would pick the next question before this test does.
    if (operation === "generate" && payload.encounterId === "prepared")
      return json({ error: "Not part of this test" }, 503);
    if (operation === "generate") {
      generations++;
      questions++;
      const c = payload.contract;
      return json({
        title: "Synthetic unanswered task",
        prompt: `Read-only question ${questions}`,
        starter: "",
        rubric: ["Synthetic scope"],
        contract: c,
        scopeDefinitions: c.objectiveIds.map((id: string, i: number) => ({
          id: `${id}/D${c.depth}`,
          objectiveId: id,
          depth: c.depth,
          sourceScope: c.scopes[i],
          facets: [{ id: "scope", description: "Synthetic scope" }],
        })),
      });
    }
    if (operation === "assess") {
      assessmentCalls.push(payload);
      return json({ visitOutcome: "unresolved", findings: [] });
    }
    return json({ error: "Unused synthetic operation" }, 503);
  });
  await enterLegacyBuilding(page);
  const position = () =>
    page.evaluate(() => {
      const g = (window as any).__deadAir.game,
        a = g.survivors[0],
        s = g.floors[0].stations[0];
      g.survivors = [a];
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      g.surge.anchor = Number.MAX_SAFE_INTEGER;
      Object.assign(a, { floor: 0, x: s.x, y: s.y });
      return s.encounter as string;
    });
  const baseline = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.study.profile = "live";
    return {
      cycle: g.study.learner.cycle,
      tracks: JSON.stringify(g.study.learner.tracks),
    };
  });
  const id = await position();
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText(
    "Synthetic unanswered task",
  );
  const issued = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game,
      l = g.study.learner,
      e = g.encounters[id];
    return {
      id: l.attempts[0]?.id,
      attempts: l.attempts.length,
      cycle: l.cycle,
      evidence: l.evidence.length,
      tracks: JSON.stringify(l.tracks),
      run: g.id,
      problem: e.problem,
    };
  }, id);
  expect(issued.id).toBeTruthy();
  expect(issued.attempts).toBe(1);
  expect(issued.cycle).toBe(baseline.cycle);
  expect(issued.tracks).toBe(baseline.tracks);
  expect(issued.evidence).toBe(0);
  const asked = generations;
  // Walking away closes only physical station use. The immutable question
  // stays available.
  await page.evaluate(() => {
    const h = (window as any).__deadAir.game.survivors[0];
    h.x = 21.5;
    h.y = 31.5;
  });
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.survivors[0].station),
    )
    .toBeUndefined();
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally");
  await page.locator("#resume-game").click();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const resumed = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game;
    return {
      ids: g.study.learner.attempts.map((a: any) => a.id),
      problem: g.encounters[id].problem,
    };
  }, id);
  expect(resumed.ids).toEqual([issued.id]);
  expect(resumed.problem).toEqual(issued.problem);
  expect(generations).toBe(asked);
  await killHumanInStep(page);
  // No question is open after the reload, so the end card is shown at once.
  await expect(page.locator("#start-card")).toContainText("Your work survives");
  await page.getByRole("button", { name: "Begin another run" }).click();
  await chooseDesignedRun(page);
  await expect(page.locator("#start-card")).toBeHidden();
  const nextId = await position();
  const after = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      run: g.id,
      archives: g.study.archives,
      attempts: g.study.learner.attempts,
      cycle: g.study.learner.cycle,
      evidence: g.study.learner.evidence,
      keys: g.survivors[0].keys ?? 0,
    };
  });
  expect(after.run).not.toBe(issued.run);
  expect(after.attempts[0].status).toBe("interrupted");
  const archive = after.archives.find(
    (e: any) => e.id === id && e.runId === issued.run,
  );
  expect(archive.problem).toEqual(issued.problem);
  expect(archive.workspace).toBe("");
  expect(after.cycle).toBe(baseline.cycle);
  expect(after.evidence).toEqual([]);
  expect(after.keys).toBe(0);
  // Variety practice is never the scheduled visit; clear the cooldown that
  // would make the next terminal one, so the next question is a formal visit.
  await page.evaluate(() => {
    delete (window as any).__deadAir.game.study.topicSpawn;
  });
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (id) => (window as any).__deadAir.game.encounters[id].problem?.prompt,
        nextId,
      ),
    )
    .toMatch(/^Read-only question \d+$/);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__deadAir.game.study.learner.attempts.length,
      ),
    )
    .toBe(2);
  expect(assessmentCalls).toEqual([]);
  const child = await page.evaluate((nextId) => {
    const g = (window as any).__deadAir.game;
    return {
      attempt: g.study.learner.attempts[1],
      question: g.encounters[nextId].problem,
    };
  }, nextId);
  expect(child.attempt.parentAttempt).toBe(issued.id);
  expect(child.attempt.id).not.toBe(issued.id);
  expect(child.question.prompt).not.toBe(issued.problem.prompt);
  expect(child.question.starter).toBe("");
});
