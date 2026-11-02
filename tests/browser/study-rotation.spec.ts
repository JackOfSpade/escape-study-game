import { expect, test, type Page } from "@playwright/test";
import {
  enterNativeGame,
  flushNativeSave,
  mockClaudeStudy,
  openNativeQuestion,
} from "./study-harness";

/** Walk to an untouched physical station, open it and report its issued track. */
async function openUntouched(page: Page) {
  // E toggles: leave the finished question's terminal before walking on.
  if (await page.locator("#terminal").isVisible()) {
    await page.locator("#leave").click();
    await expect(page.locator("#terminal")).toBeHidden();
  }
  const id = await page.evaluate(() => {
    const d = (window as any).__deadAir,
      g = d.game;
    const st = g.floors[0].stations.find(
      (s: any) =>
        g.encounters[s.encounter].state !== "consumed" &&
        !g.encounters[s.encounter].owner &&
        Math.hypot(s.x - g.survivors[0].x, s.y - g.survivors[0].y) > 3,
    );
    if (!st) throw Error("No untouched station");
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    return st.encounter as string;
  });
  // Moving away releases the previous physical station on the real game frame.
  await expect
    .poll(() =>
      page.evaluate(() => (window as any).__deadAir.game.survivors[0].station),
    )
    .toBeUndefined();
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__deadAir.game.encounters[id].problem?.contract.track,
        id,
      ),
    )
    .toBeTruthy();
  return id;
}
const trackOf = (page: Page, id: string) =>
  page.evaluate(
    (id) =>
      (window as any).__deadAir.game.encounters[id].problem.contract.track,
    id,
  );
const consumed = (page: Page, id: string) =>
  page.evaluate(
    (id) => (window as any).__deadAir.game.encounters[id].state === "consumed",
    id,
  );
async function answer(page: Page, text: string) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
}

test("practice completion, including a declared gap, rotates game questions across reload", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { eligible } = await import(
      /* @vite-ignore */ root + "curriculum.ts"
    );
    const { recordSpawn, spawnContract } = await import(
      /* @vite-ignore */ root + "topic-spawn.ts"
    );
    const { devProblem } = await import(
      /* @vite-ignore */ root + "practice-problem.ts"
    );
    const e = g.encounters[g.floors[0].stations[0].encounter];
    recordSpawn(
      g.study,
      eligible(d.roadmap, g.study),
      "synthetic-cooldown",
      g.time,
    );
    const c = spawnContract(d.roadmap, g.study);
    if (!c.practice) throw Error("Expected a variety practice fixture");
    e.problem = devProblem(g, d.roadmap, c);
    e.workspace = e.problem.starter;
  });
  await page.evaluate(() => {
    const d = (window as any).__deadAir,
      g = d.game,
      st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    return d.interact();
  });
  await expect(page.locator("#terminal")).toBeVisible();
  const id = await page.evaluate(
    () =>
      (window as any).__deadAir.game.floors[0].stations[0].encounter as string,
  );
  expect(await trackOf(page, id)).toBe("PY");
  expect(
    await page.evaluate(
      (id) =>
        (window as any).__deadAir.game.encounters[id].problem.contract.practice,
      id,
    ),
  ).toBe(true);
  relay.gap();
  await answer(page, "I do not know this part yet.");
  await expect.poll(() => consumed(page, id)).toBe(true);
  for (const track of ["PE", "PE", "PY"]) {
    const next = await openUntouched(page);
    await expect.poll(() => trackOf(page, next)).toBe(track);
    relay.solve();
    await answer(
      page,
      "Here is my complete reasoning for the scoped question.",
    );
    await expect.poll(() => consumed(page, next)).toBe(true);
  }
  const progress = await page.evaluate(() => {
    const s = (window as any).__deadAir.game.study;
    return { visits: s.visits.length, evidence: s.learner.evidence.length };
  });
  // Only the two formal PE questions are visits; practice earns none, and a
  // conversation with no knowledge report adds no learner evidence.
  expect(progress).toEqual({ visits: 2, evidence: 0 });
  await flushNativeSave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const last = await openUntouched(page);
  await expect.poll(() => trackOf(page, last)).toBe("PE");
});

test("opening another untouched physical terminal refreshes its preloaded track after practice", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  const first = await openNativeQuestion(page, "development");
  expect(await trackOf(page, first)).toBe("PY");
  relay.solve();
  await answer(page, "Here is my complete reasoning for the scoped question.");
  await expect.poll(() => consumed(page, first)).toBe(true);
  const next = await openUntouched(page);
  await expect.poll(() => trackOf(page, next)).toBe("PE");
  expect(next).not.toBe(first);
});
