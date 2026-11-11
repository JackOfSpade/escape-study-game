import { expect, test, type Page } from "@playwright/test";
import {
  enterNativeGame,
  flushNativeSave,
  killHumanInStep,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
} from "./study-harness";

/** Answer generation with a long question planned as two parts. */
async function segmentedGeneration(page: Page) {
  const generations: unknown[] = [];
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation !== "generate") return route.fallback();
    generations.push(body);
    const c = body.payload.contract;
    const facets = [
      { id: "trace", description: "Traces the loop" },
      { id: "fix", description: "Fixes the boundary" },
    ];
    await route.fulfill({
      json: {
        title: "Synthetic two-part question",
        prompt: "Trace the loop, then fix its boundary. Synthetic fixture.",
        starter: "",
        rubric: ["Traces the loop", "Fixes the boundary"],
        contract: c,
        estimatedSolveSeconds: 1200,
        segments: [
          {
            goal: "Trace the loop.",
            rubricItems: [0],
            facets: ["trace"],
            estimatedSolveSeconds: 600,
          },
          {
            goal: "Fix the boundary.",
            rubricItems: [1],
            facets: ["fix"],
            estimatedSolveSeconds: 600,
          },
        ],
        scopeDefinitions: c.objectiveIds.map((id: string, i: number) => ({
          id: `${id}/D${c.depth}`,
          objectiveId: id,
          depth: c.depth,
          sourceScope: c.scopes[i],
          facets,
        })),
      },
    });
  });
  return generations;
}

async function say(page: Page, text: string) {
  await page.locator("#chat-input").fill(text);
  await page.locator("#chat-input").press("Enter");
}

const thread = (page: Page) =>
  page.evaluate(() => {
    const t = (window as any).__deadAir.game.study.thread;
    return t && JSON.parse(JSON.stringify(t));
  });

/** Stand at a station and press E, as the player does. */
async function openStation(page: Page, index: number) {
  const id = await page.evaluate(async (index) => {
    const d = (window as any).__deadAir,
      g = d.game;
    const stations = g.floors[0].stations;
    const st = stations[index];
    const e = g.encounters[st.encounter];
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    await d.interact();
    return e.id as string;
  }, index);
  await expect(page.locator("#terminal")).toBeVisible();
  return id;
}

async function reload(page: Page) {
  await flushNativeSave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir?.game);
}

test("a cut-off reply resumes after reload with the exact history, and the next terminal continues the next part", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const generations = await segmentedGeneration(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  const keys = (await nativeState(page, id)).keys;
  const started = await thread(page);
  expect(started.segment).toBe(0);
  await expect(page.locator("#terminal-provenance")).toContainText(
    "Part 1 of 2: Trace the loop. Finishing",
  );

  await say(page, "It visits every index once");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  expect(relay.tutorCalls()[0].payload.segment.goal).toBe("Trace the loop.");
  await expect
    .poll(async () => (await nativeState(page, id)).tutor.length)
    .toBe(2);

  // The second reply is cut off by a reload while it is in flight.
  relay.hold();
  await say(page, "The last index is out of range");
  await expect.poll(() => relay.tutorCalls().length).toBe(2);
  const cutOff = relay.tutorCalls()[1].payload;
  await reload(page);
  relay.release();
  relay.reply(() => ({ text: "Right. Why out of range?", complete: false }));

  await openStation(page, 0);
  await expect.poll(() => relay.tutorCalls().length).toBe(3);
  expect(relay.tutorCalls()[2].payload).toEqual(cutOff);
  await expect
    .poll(async () => (await nativeState(page, id)).tutor.length)
    .toBe(4);
  const resumed = await nativeState(page, id);
  expect(
    resumed.tutor
      .filter((m: any) => m.kind === "human")
      .map((m: any) => m.text),
  ).toEqual(["It visits every index once", "The last index is out of range"]);
  await expect(page.locator("#messages")).toContainText(
    "Right. Why out of range?",
  );

  relay.reply(() => ({
    text: "Part one done.",
    complete: true,
    segmentSummary: "Traced the loop; found the off-by-one.",
  }));
  await say(page, "Because <= reaches length");
  await expect
    .poll(async () => (await nativeState(page, id)).state)
    .toBe("consumed");
  expect((await nativeState(page, id)).keys).toBe(keys + 1);
  expect((await thread(page)).segment).toBe(1);

  // After another reload, a different terminal continues part two.
  await reload(page);
  expect((await nativeState(page, id)).keys).toBe(keys + 1);
  const next = await openStation(page, 1);
  expect(next).not.toBe(id);
  await expect(page.locator("#terminal-provenance")).toContainText(
    "Part 2 of 2: Fix the boundary. Finishing",
  );
  await expect(page.locator("#messages")).toContainText(
    "Earlier visit · part 1 · completed",
  );
  await expect(page.locator("#messages")).toContainText(
    "Because <= reaches length",
  );
  // The second terminal continued the question; nothing new was generated.
  expect(generations).toHaveLength(1);
  relay.reply(() => ({ text: "What should replace it?", complete: false }));
  await say(page, "Use < instead");
  await expect.poll(() => relay.tutorCalls().length).toBe(5);
  const part2 = relay.tutorCalls()[4].payload.segment;
  expect(part2.index).toBe(1);
  expect(part2.earlier[0].summary).toBe(
    "Traced the loop; found the off-by-one.",
  );
});

test("after death and reload the part keeps its chat and progress, and finishing it grants no key", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await segmentedGeneration(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  const keys = (await nativeState(page, id)).keys;
  await say(page, "My first step");
  await expect
    .poll(async () => (await nativeState(page, id)).tutor.length)
    .toBe(2);
  await killHumanInStep(page);
  await reload(page);
  const after = await nativeState(page, id);
  expect(after.tutor.map((m: any) => m.text)).toContain("My first step");
  expect((await thread(page)).segment).toBe(0);
  await page.getByRole("button", { name: "Run summary" }).click();
  await page.getByRole("button", { name: "Continue in the terminal" }).click();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#messages")).toContainText("My first step");
  relay.solve("Part one done.");
  await say(page, "My final answer for part one");
  await expect.poll(async () => (await thread(page)).segment).toBe(1);
  const t = await thread(page);
  expect(t.visits[0].completed).toBe(true);
  expect(t.visits[0].keyGranted).toBe(false);
  expect((await nativeState(page, id)).keys).toBe(keys);
});
