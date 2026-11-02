import { chooseDesignedRun } from "./helpers/designed-run";
// Real issuance/persistence lifecycle with a synthetic native conversation.
import { expect, test } from "@playwright/test";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import { openGameMenu } from "./helpers/game-menu";
import { killHumanInStep } from "./native-study-harness";

test("restart saves the unfinished native task and immediately allows a new question, including after reload", async ({
  page,
}) => {
  let generations = 0;
  const nativeCalls: any[] = [];
  const assessmentCalls: any[] = [];
  const results = new Map<string, unknown>();
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (url.pathname === "/api/status")
      return json({
        mode: "chatgpt-handoff",
        label: "Synthetic native issuance",
        detail: "Synthetic fixture; no real AI",
        capabilities: ["generate", "assess", "tutor", "direct-study"],
      });
    if (url.pathname === "/api/bridge/result") {
      const id = url.searchParams.get("id")!;
      return results.has(id)
        ? json(results.get(id))
        : json({ handoff: { id, status: "working" } }, 202);
    }
    if (url.pathname === "/api/handoff/status")
      return json({
        enabled: true,
        queued: 0,
        working: nativeCalls.length,
        done: 0,
        public: { terminalRelay: { activeSessions: 1 } },
      });
    if (url.pathname !== "/api/bridge")
      return json({ error: "Unused synthetic route" }, 404);
    const { operation, payload } = request.postDataJSON();
    if (operation === "generate") {
      generations++;
      const c = payload.contract;
      return json({
        title: "Synthetic unanswered native task",
        prompt: `Read-only question ${generations}`,
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
    if (operation === "tutor" && payload.mode === "terminal-direct") {
      nativeCalls.push(payload);
      return json(
        {
          handoff: {
            id: payload.requestId,
            hash: `synthetic-${payload.requestId}`,
          },
        },
        202,
      );
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
  await expect(page.locator("#native-study-title")).toHaveText(
    "Synthetic unanswered native task",
  );
  await expect.poll(() => nativeCalls.length).toBe(1);
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(page.locator("#chat-input")).toBeHidden();
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
      session: e.directStudy,
    };
  }, id);
  expect(issued.id).toBeTruthy();
  expect(issued.attempts).toBe(1);
  expect(issued.cycle).toBe(baseline.cycle);
  expect(issued.tracks).toBe(baseline.tracks);
  expect(issued.evidence).toBe(0);
  // Walking away closes only physical station use. The ordinary ChatGPT
  // conversation and its immutable question stay available.
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
  await expect.poll(() => nativeCalls.length).toBe(2);
  expect(nativeCalls[1]).toEqual(nativeCalls[0]);
  expect(generations).toBe(1);
  const resumed = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game;
    return {
      ids: g.study.learner.attempts.map((a: any) => a.id),
      problem: g.encounters[id].problem,
      session: g.encounters[id].directStudy,
    };
  }, id);
  expect(resumed.ids).toEqual([issued.id]);
  expect(resumed.problem).toEqual(issued.problem);
  expect(resumed.session.id).toBe(issued.session.id);
  await killHumanInStep(page);
  await expect(page.locator("#start-card")).toBeHidden();
  await expect(page.locator("#native-study-status")).toContainText(
    "Continue in ChatGPT",
  );
  await page.getByRole("button", { name: "Run summary", exact: true }).click();
  await page.getByRole("button", { name: "Begin another run" }).click();
  await chooseDesignedRun(page);
  await expect(page.locator("#start-card")).toBeHidden();
  await position();
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
    (e: any) => e.directStudy?.id === issued.session.id,
  );
  expect(archive.problem.prompt).toBe("Read-only question 1");
  expect(archive.workspace).toBe("");
  expect(JSON.parse(archive.directStudy.payloadJson).problem).toEqual(
    issued.problem,
  );
  expect(after.cycle).toBe(baseline.cycle);
  expect(after.evidence).toEqual([]);
  expect(after.keys).toBe(0);
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect.poll(() => generations).toBe(2);
  await expect.poll(() => nativeCalls.length).toBe(3);
  await expect(page.locator("#native-study-status")).not.toContainText(
    "previous run",
  );
  const archivedState = await page.evaluate((session) => {
    const g = (window as any).__deadAir.game;
    return g.study.archives.find((e: any) => e.directStudy?.id === session)
      ?.directStudy.state;
  }, issued.session.id);
  expect(archivedState).toBe("superseded");
  expect(assessmentCalls).toEqual([]);
  // A late old-run completion cannot reward this run or invent learner evidence.
  results.set(issued.session.id, { complete: true, outcome: "solved" });
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally");
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await expect.poll(() => nativeCalls.length).toBe(4);
  expect(nativeCalls[3].requestId).toBe(nativeCalls[2].requestId);
  expect(assessmentCalls).toEqual([]);
  const child = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      attempt: g.study.learner.attempts[1],
      question: (Object.values(g.encounters) as any[]).find(
        (e: any) => e.directStudy,
      )?.problem,
    };
  });
  expect(child.attempt.parentAttempt).toBe(issued.id);
  expect(child.attempt.id).not.toBe(issued.id);
  expect(child.question.prompt).toBe("Read-only question 2");
  expect(child.question.starter).toBe("");
  expect(nativeCalls.at(-1).questionFingerprint).not.toBe(
    nativeCalls[0].questionFingerprint,
  );
});
