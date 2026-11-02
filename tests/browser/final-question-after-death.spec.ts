import { expect, test } from "@playwright/test";
import {
  enterNativeGame,
  flushNativeSave,
  killHumanInStep,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
} from "./study-harness";

test("combat death keeps the open question answerable without forcing a menu; final answers still count", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  const pending = await nativeState(page, id);
  expect(pending.problem).toBeTruthy();
  await killHumanInStep(page);
  await expect(page.locator("body")).toHaveClass(/spectating/);
  await expect(page.locator("#start-card")).toBeHidden();
  const died = await nativeState(page, id);
  expect(died.problem).toBe(pending.problem);
  expect(died.alive).toBe(false);
  expect(died.station).toBeUndefined();
  expect(typeof died.endedAt).toBe("number");
  await expect
    .poll(async () => (await nativeState(page, id)).time)
    .toBeGreaterThan(died.time + 0.25);
  await page.getByRole("button", { name: "Run summary" }).click();
  await expect(
    page.getByRole("button", { name: "Continue in the terminal" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Continue in the terminal" }).click();
  await expect(page.locator("#start-card")).toBeHidden();
  await expect(page.locator("#terminal")).toBeVisible();
  expect(relay.tutorCalls()).toHaveLength(0);
  relay.gap();
  await page.locator("#chat-input").fill("Honestly I do not know this part");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  await expect
    .poll(async () => (await nativeState(page, id)).gaps.length)
    .toBe(1);
  const finished = await nativeState(page, id);
  expect(finished.keys).toBe(pending.keys);
  expect(
    finished.tutor.some(
      (m: any) => m.kind === "human" && m.text.includes("do not know"),
    ),
  ).toBe(true);
  expect(finished.endedAt).toBe(died.endedAt);
  await expect(page.locator("#reward-toast")).toBeHidden();
  await flushNativeSave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const restored = await nativeState(page, id);
  expect(restored.keys).toBe(pending.keys);
  expect(restored.gaps).toHaveLength(1);
});

test("an open question survives death and page reload with the same issued question", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  const issued = (await nativeState(page, id)).problem;
  await killHumanInStep(page);
  await expect(page.locator("#start-card")).toBeHidden();
  await flushNativeSave(page);
  const asked = relay.calls.filter((c) => c.operation === "generate").length;
  await page.reload();
  await expect(page.locator("#start-card")).toBeHidden();
  await expect(page.locator("#spectator")).toBeVisible();
  expect((await nativeState(page, id)).problem).toBe(issued);
  expect(relay.calls.filter((c) => c.operation === "generate")).toHaveLength(
    asked,
  );
  expect((await nativeState(page, id)).keys).toBe(0);
});

test("a delayed generation survives combat death and reload, resumes its exact request, then opens the final question without a menu", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  const generations: any[] = [];
  let generated: any;
  // The first request is lost with the connection; later ones are answered.
  await page.route("**/api/bridge", async (route) => {
    const body = route.request().postDataJSON();
    if (body.operation !== "generate") return route.fallback();
    generations.push(body);
    if (!generated) return route.abort("connectionreset");
    await route.fulfill({ json: generated });
  });
  await enterNativeGame(page);
  const id = await page.evaluate(() => {
    const d = (window as any).__deadAir,
      g = d.game;
    g.study.profile = "live";
    const st = g.floors[0].stations[0],
      e = g.encounters[st.encounter];
    for (const peer of Object.values(g.encounters) as any[])
      if (
        peer === e ||
        (e.questionRoom && peer.questionRoom === e.questionRoom)
      ) {
        delete peer.problem;
        delete peer.problemPresentedSequence;
        peer.workspace = "";
        peer.revision = 0;
        peer.state = "available";
      }
    e.mode = "solo";
    e.owner = "human";
    Object.assign(g.survivors[0], { floor: 0, x: st.x, y: st.y });
    return e.id as string;
  });
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect
    .poll(() => generations.some((g) => g.payload.encounterId === id))
    .toBe(true);
  const original = generations.find((g) => g.payload.encounterId === id);
  expect(original.payload.requestId).toBeTruthy();
  await killHumanInStep(page);
  await expect(page.locator("#spectator")).toBeVisible();
  await page.evaluate(async () => {
    const root = "/src/",
      { save, flushSaves } = await import(
        /* @vite-ignore */ root + "persistence.ts"
      );
    await save((window as any).__deadAir.game);
    await flushSaves();
  });
  const lost = generations.length;
  const contract = original.payload.contract;
  generated = {
    title: "Synthetic delayed question",
    prompt:
      "Explain the issued contract and its boundary. Synthetic transport fixture.",
    starter: "",
    rubric: ["Explain the captured source scope"],
    contract,
    scopeDefinitions: contract.objectiveIds.map(
      (objectiveId: string, i: number) =>
        original.payload.existingScopeDefinitions?.[
          `${objectiveId}/D${contract.depth}`
        ] ?? {
          id: `${objectiveId}/D${contract.depth}`,
          objectiveId,
          depth: contract.depth,
          sourceScope: contract.scopes[i],
          facets: [
            {
              id: `delayed-scope-${i}`,
              description: "Captured source scope and its boundary",
            },
          ],
        },
    ),
  };
  await page.reload();
  await page.getByRole("button", { name: "Run summary" }).click();
  await page.getByRole("button", { name: "Continue in the terminal" }).click();
  await expect.poll(() => generations.length).toBeGreaterThan(lost);
  expect(generations.at(-1)).toEqual(original);
  await expect(page.locator("#start-card")).toBeHidden();
  await expect(page.locator("#terminal")).toBeVisible();
  await expect(page.locator("#problem-title")).toHaveText(
    "Synthetic delayed question",
  );
  relay.gap();
  await page.locator("#chat-input").fill("I do not know the boundary");
  await page.locator("#chat-input").press("Enter");
  await expect
    .poll(async () => (await nativeState(page, id)).gaps.length)
    .toBe(1);
  const result = await nativeState(page, id);
  expect(result.status).toBe("dead");
  expect(result.keys).toBe(0);
  expect(relay.tutorCalls()).toHaveLength(1);
  await expect(page.locator("#reward-toast")).toBeHidden();
});
