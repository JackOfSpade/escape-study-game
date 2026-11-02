import { startDesignedRun } from "./helpers/designed-run";
import { expect, test } from "@playwright/test";
import {
  enterNativeGame,
  flushNativeSave,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
} from "./study-harness";

test("a reply that cannot be accepted keeps the exact request, and its retry announces one key on the game canvas", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect(page.locator("#workspace")).toBeHidden();
  relay.reply(() => ({
    text: "Solved.",
    complete: true,
    knowledge: { facets: "not-a-report" },
  }));
  await page.locator("#chat-input").fill("My complete reasoning");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  const retry = page.locator("button[data-question-retry]");
  await expect(retry).toBeVisible();
  const interrupted = await nativeState(page, id);
  expect(interrupted.keys).toBe(0);
  expect(interrupted.submissions).toBe(0);
  relay.solve();
  await retry.click();
  await expect.poll(() => relay.tutorCalls().length).toBe(2);
  expect(relay.tutorCalls()[1].payload).toEqual(relay.tutorCalls()[0].payload);
  await expect(page.locator("#reward-toast")).toBeVisible();
  await expect(page.locator("#reward-toast")).toHaveText("Key granted");
  await expect(page.locator("#hud-keys")).toHaveText("1 key");
  const completed = await nativeState(page, id);
  expect(completed.keys).toBe(1);
  expect(completed.submissions).toBe(1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await flushNativeSave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await expect(page.locator("#hud-keys")).toHaveText("1 key");
  await expect(page.locator("#reward-toast")).toBeHidden();
  expect((await nativeState(page, id)).submissions).toBe(1);
  expect(relay.tutorCalls()).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("a legacy shared question keeps private tutor history out of public group requests", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  let group: any;
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation !== "group") return route.fallback();
    group = body.payload;
    return route.fulfill({
      json: {
        requestId: group.requestId,
        sourceRevision: group.sourceRevision,
        messages: [
          {
            author: group.speakers[0].id,
            kind: "question",
            text: "What changes in the current shared draft?",
            refs: [],
          },
        ],
      },
    });
  });
  await page.goto("/");
  await startDesignedRun(page);
  const id = await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const { ensureProblem, npcCanRespond } = await import(
      /* @vite-ignore */ root + "ai.ts"
    );
    const { claimStation } = await import(
      /* @vite-ignore */ root + "engine.ts"
    );
    const station = g.floors[0].stations[0],
      e = g.encounters[station.encounter];
    for (const a of g.survivors.slice(1)) a.escaped = true;
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
    await ensureProblem(g, e, d.roadmap);
    e.mode = "shared";
    e.workspace = "Shared synthetic draft";
    g.floors[0].stations[1].encounter = e.id;
    e.tutor.push({
      id: "private-synthetic",
      author: "Terminal AI",
      kind: "tutor",
      text: "PRIVATE_TUTOR_SENTINEL",
      seq: ++g.seq,
      worldTime: g.time,
      provenance: "claude-cli",
    });
    Object.assign(g.survivors[0], { floor: 0, x: station.x, y: station.y });
    await d.interact();
    const a = g.survivors[1],
      seat = g.floors[0].stations[1];
    Object.assign(a, {
      escaped: false,
      alive: true,
      floor: 0,
      intent: e.id,
      thought: 10,
      x: seat.x,
      y: seat.y,
      activity: "studying",
      path: [],
      repath: 0,
      fleeUntil: 0,
    });
    for (const field of [
      "vault",
      "stairTravel",
      "stairwell",
      "target",
      "navTarget",
      "routeProgress",
      "studyLoop",
      "fleeTarget",
      "fleeFloor",
    ])
      delete a[field];
    if (!claimStation(g, a, seat.id) || !npcCanRespond(g, e, a))
      throw Error("Synthetic group participant unavailable");
    g.paused = true;
    return e.id as string;
  });
  await expect(page.locator("#terminal")).toBeVisible();
  expect(relay.tutorCalls()).toHaveLength(0);
  await page.evaluate(async (id) => {
    const root = "/src/",
      { send } = await import(/* @vite-ignore */ root + "ai.ts");
    const d = (window as any).__deadAir;
    await send(
      d.game,
      d.game.encounters[id],
      "group",
      "What assumption should the group check?",
      d.roadmap,
    );
  }, id);
  expect(group.workspace).toBe("Shared synthetic draft");
  expect(JSON.stringify(group)).not.toContain("PRIVATE_TUTOR_SENTINEL");
  const result = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[id];
    return {
      public: e.group.map((m: any) => m.text),
      submissions: e.submissions.length,
      keys: g.survivors[0].keys,
    };
  }, id);
  expect(result.public).toContain("What changes in the current shared draft?");
  expect(result.public.join(" ")).not.toContain("PRIVATE_TUTOR_SENTINEL");
  expect(result.submissions).toBe(0);
  expect(result.keys).toBe(0);
});
