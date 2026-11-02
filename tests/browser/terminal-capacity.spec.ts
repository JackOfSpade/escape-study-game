import { expect, test } from "@playwright/test";
import { openGameMenu } from "./helpers/game-menu";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import { mockClaudeStudy } from "./study-harness";

test("late player retains an initial Claude question after nineteen NPC completions, including migrated saved draft and exact reload identity", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterLegacyBuilding(page);
  const draft =
    "Late arrival: my unsent saved reasoning stays at this exact terminal.";
  const baseline = await page.evaluate(async (draft) => {
    const root = "/src/",
      { complete } = await import(/* @vite-ignore */ root + "engine.ts"),
      g = (window as any).__deadAir.game,
      a = g.survivors[0];
    // A live run starts with no pre-made practice questions.
    g.study.profile = "live";
    for (const each of Object.values<any>(g.encounters)) delete each.problem;
    const tasks = Object.values(g.encounters).filter(
      (e: any) => e.floor === 0 && e.reward === "stairs",
    ) as any[];
    if (tasks.length !== 20)
      throw Error(
        `Expected twenty initial opportunities, found ${tasks.length}`,
      );
    for (const [i, npc] of g.survivors.slice(1).entries()) {
      complete(
        g,
        tasks[i].id,
        `capacity-fixture-${i}`,
        [npc.id],
        "Controlled NPC completion; no human evidence",
      );
      npc.escaped = true;
    }
    const remaining = tasks.filter((e) => e.state !== "consumed");
    if (remaining.length !== 1)
      throw Error("Expected one initial opportunity left");
    const e = remaining[0],
      s = g.floors[0].stations.find((s: any) => s.encounter === e.id);
    // Migration input from a former in-game composer, never submitted. It must
    // travel as unsent context, without becoming a human answer or evidence.
    e.chatDraft = draft;
    Object.assign(a, { floor: 0, x: s.x, y: s.y });
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
    g.zombies = [];
    const { topicSpawn } = g.study;
    return {
      id: e.id,
      room: e.questionRoom ?? e.id,
      access: [...a.access],
      learning: JSON.stringify([
        g.study.learner.evidence,
        g.study.learner.cells,
      ]),
      spawns: JSON.stringify(topicSpawn?.recent ?? []),
      count: Object.keys(g.encounters).length,
    };
  }, draft);
  expect(baseline.access).toEqual([]);
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  // The unsent draft returns to the composer and is never sent as an answer.
  await expect(page.locator("#chat-input")).toHaveValue(draft);
  expect(relay.tutorCalls()).toHaveLength(0);
  const problem = await page.evaluate(
    (id) => (window as any).__deadAir.game.encounters[id].problem,
    baseline.id,
  );
  expect(problem.prompt).toBeTruthy();
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.time))
    .toBeGreaterThan(time + 0.4);
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally");
  await page.locator("#resume-game").click();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const after = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[id],
      { topicSpawn } = g.study;
    return {
      owner: e.owner,
      access: g.survivors[0].access,
      learning: JSON.stringify([
        g.study.learner.evidence,
        g.study.learner.cells,
      ]),
      spawns: topicSpawn.recent,
      count: Object.keys(g.encounters).length,
      consumed: Object.values(g.encounters).filter(
        (e: any) =>
          e.floor === 0 && e.reward === "stairs" && e.state === "consumed",
      ).length,
      problem: e.problem,
      draft: e.chatDraft,
      humanArtifacts: e.history.filter((h: any) => h.author === "human"),
    };
  }, baseline.id);
  expect(after.owner).toBe("human");
  expect(after.access).toEqual([]);
  expect(after.learning).toBe(baseline.learning);
  expect(after.problem).toEqual(problem);
  expect(after.draft).toBe(draft);
  expect(relay.tutorCalls()).toHaveLength(0);
  expect(after.humanArtifacts).toEqual([]);
  expect(JSON.stringify(after.spawns.slice(0, -1))).toBe(baseline.spawns);
  expect(after.spawns.at(-1)).toMatchObject({
    encounter: baseline.room,
    profile: "live",
  });
  expect(after.count).toBe(baseline.count);
  expect(after.consumed).toBe(19);
  await page.screenshot({
    path: "test-results/late-native-terminal-capacity.png",
  });
});
