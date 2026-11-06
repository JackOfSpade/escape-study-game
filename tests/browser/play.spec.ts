import { detachAuthoredScene } from "./helpers/synthetic-world";
import { chooseDesignedRun, startDesignedRun } from "./helpers/designed-run";
import { openGameMenu } from "./helpers/game-menu";
import { selectTopDown } from "./helpers/view-mode";
import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { tier4RoadmapFixture } from "../fixtures/tier4-roadmap";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import { isolateRunnerBridge } from "./helpers/runner-bridge";
import {
  enterNativeGame,
  flushNativeSave,
  killHumanInStep,
  mockClaudeStudy,
  nativeState,
  openNativeQuestion,
  seedLegacyDraft,
} from "./study-harness";

// No browser smoke case may accidentally release real model/bridge work.
// Explicit synthetic provider routes below override this safe default.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/status")
      return route.fulfill({
        json: {
          mode: "development",
          label: "Isolated smoke fixture",
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
async function expectHumanDrawn(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>("#world")!,
          rect = c.getBoundingClientRect();
        const dpr = Math.min(devicePixelRatio || 1, 2),
          x = (rect.width / 2) * dpr,
          y = (rect.height / 2) * dpr;
        const [r, green, b] = c
          .getContext("2d")!
          .getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
        return green > r + 20 && green > b + 20;
      }),
    )
    .toBe(true);
}
test("real browser: launch, movement, Claude terminal capture, running survival and exact save/reload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  await selectTopDown(page);
  await expectHumanDrawn(page);
  const start = await page.evaluate(
    () => (window as any).__deadAir.game.survivors[0].y,
  );
  await page.locator("#world").focus();
  await page.keyboard.down("w");
  await page.waitForTimeout(800);
  await page.keyboard.up("w");
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.survivors[0].y),
  ).toBeLessThan(start);
  await seedLegacyDraft(
    page,
    "exact persisted legacy draft / boundary reasoning",
  );
  const id = await openNativeQuestion(page);
  await expect(page.locator("#problem-title")).toHaveText("Synthetic question");
  const captured = await nativeState(page, id);
  const pos = await page.evaluate(() => {
    const a = (window as any).__deadAir.game.survivors[0];
    return [a.x, a.y];
  });
  // Typing in the terminal's composer does not move the human.
  await page.locator("#chat-input").focus();
  await page.keyboard.type("wasd");
  expect(
    await page.evaluate(() => {
      const a = (window as any).__deadAir.game.survivors[0];
      return [a.x, a.y];
    }),
  ).toEqual(pos);
  const time = (await nativeState(page, id)).time;
  await expect
    .poll(async () => (await nativeState(page, id)).time)
    .toBeGreaterThan(time + 0.5);
  expect(captured.workspace).toBe(
    "exact persisted legacy draft / boundary reasoning",
  );
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally");
  await page.locator("#resume-game").click();
  await flushNativeSave(page);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  const restored = await nativeState(page, id);
  expect(restored.problem).toBe(captured.problem);
  expect(restored.workspace).toBe(captured.workspace);
  // A reload never reopens the terminal on its own, and asks nothing new.
  await expect(page.locator("#terminal")).toBeHidden();
  expect(relay.tutorCalls()).toHaveLength(0);
  await expectHumanDrawn(page);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/playable-claude-terminal.png",
    fullPage: false,
  });
});

test("physical station access respects occlusion while an issued Claude question keeps its captured draft", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  await detachAuthoredScene(page);
  await selectTopDown(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    Object.assign(a, { x: 19.7, y: 15.5 });
    f.tiles = Array.from({ length: 34 }, () => Array(44).fill(0));
    f.stations = [{ ...f.stations[0], x: 21.3, y: 15.5 }];
    f.furniture = [];
    f.tiles[15][20] = 1;
  });
  await seedLegacyDraft(page, "draft kept behind a new obstruction");
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  // The live run may prepare its next question in the background (payload
  // encounterId "prepared"); nothing is asked for the occluded station.
  const stationEncounter = await page.evaluate(
    () => (window as any).__deadAir.game.floors[0].stations[0].encounter,
  );
  expect(
    relay.calls.filter((call) => call.payload?.encounterId !== "prepared"),
  ).toHaveLength(0);
  expect(
    relay.calls.filter(
      (call) => call.payload?.encounterId === stationEncounter,
    ),
  ).toHaveLength(0);
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(page.locator("#terminal-connect")).toBeHidden();
  await page.evaluate(() => {
    (window as any).__deadAir.game.floors[0].tiles[15][20] = 0;
  });
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  const opened = await page.evaluate(
    () => (window as any).__deadAir.game.floors[0].stations[0].encounter,
  );
  expect((await nativeState(page, opened)).workspace).toBe(
    "draft kept behind a new obstruction",
  );
  const issued = (await nativeState(page, opened)).problem;
  const reachable = () =>
    page.evaluate(async () => {
      const root = "/src/",
        { canReachStation } = await import(root + "engine.ts"),
        g = (window as any).__deadAir.game;
      return canReachStation(g, g.survivors[0], g.floors[0].stations[0]);
    });
  expect(await reachable()).toBe(true);
  await page.evaluate(() => {
    (window as any).__deadAir.game.floors[0].furniture = [
      {
        id: "new-door",
        kind: "door",
        x: 20.5,
        y: 15.5,
        w: 0.15,
        h: 1,
        hp: 200,
        maxHp: 200,
        floor: 0,
        rotation: 0,
        turning: 0,
        speed: 0,
        moved: 0,
        movers: [],
        credited: [],
        destroyed: false,
        open: false,
      },
    ];
  });
  await expect.poll(reachable).toBe(false);
  await expect
    .poll(async () => (await nativeState(page, opened)).station)
    .toBeUndefined();
  // The issued question and its draft stay exactly as captured.
  expect((await nativeState(page, opened)).problem).toBe(issued);
  expect((await nativeState(page, opened)).workspace).toBe(
    "draft kept behind a new obstruction",
  );
});

test("UI settings and curriculum stay in the pause menu; narrow layout remains usable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 780, height: 900 });
  await page.goto("/");
  await startDesignedRun(page);
  await openGameMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByText("Transmission settings")).toBeVisible();
  await page.getByLabel("Surge visual cues & sound captions").check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await openGameMenu(page);
  await page.getByRole("button", { name: "Inspect" }).click();
  await expect(page.locator("#inspector")).toBeVisible();
  await expect(page.locator("#inspector-content")).toContainText(
    "Original evidence is retained",
  );
  await expect(page.locator('[data-readiness="PY"]')).toContainText(
    "Checkpoint targets 2/240 · topic transfers 0/16 · selected integrations 0/6",
  );
  await expect(page.locator('[data-readiness="PE"]')).toContainText(
    "Checkpoint targets 8/337 · topic transfers 0/20 · selected integrations 0/5",
  );
  await expect(page.locator('[data-readiness="PE"]')).toContainText(
    "Observed environment skills 0/6",
  );
  await page.locator('[data-readiness="PE"] summary').click();
  await expect(page.locator('[data-readiness="PE"]')).toContainText(
    "PE:I04 · not selected",
  );
  await expect(page.locator('[data-readiness="PE"]')).toContainText(
    "Only validated independent human evidence can complete a transfer or integration",
  );
  const beforeInspect = await page.evaluate(
    () => (window as any).__deadAir.game.time,
  );
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    beforeInspect,
  );
  await page.locator('[data-readiness="PE"] summary').click();
  const originalDownload = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "Download updated merged roadmap",
      exact: true,
    })
    .click();
  const original = await originalDownload;
  expect(original.suggestedFilename()).toBe("interview_prep_roadmap.md");
  expect(await readFile((await original.path())!, "utf8")).toBe(
    await readFile("interview_prep_roadmap.md", "utf8"),
  );
  await expect(page.locator("#progress-export-status")).toContainText(
    "revision 9",
  );
  await page.screenshot({
    path: "test-results/curriculum.png",
    fullPage: true,
  });
});

test("finite 360 vision: see through closed doors in both palettes, walls and distance still hide actors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await selectTopDown(page);
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    document.querySelector<HTMLElement>("#start-card")!.hidden = true;
    g.survivors = [a];
    a.x = 20.5;
    a.y = 15.5;
    a.heading = { x: 0, y: -1 };
    f.dark = 0;
    f.stations = [];
    f.tiles = Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || x === 43 || y === 0 || y === 33 || x === 23 ? 1 : 0,
      ),
    );
    for (let y = 14; y <= 16; y++) f.tiles[y][23] = 0;
    f.furniture = [
      {
        id: "visibility-door",
        kind: "door",
        floor: 0,
        x: 23.5,
        y: 15.5,
        w: 1,
        h: 3,
        hp: 240,
        maxHp: 240,
        speed: 0,
        rotation: 0,
        destroyed: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
        open: false,
      },
    ];
    g.zombies = [
      {
        id: "hidden",
        x: 26.5,
        y: 15.5,
        floor: 0,
        hp: 60,
        stagger: 0,
        path: [],
      },
      {
        id: "visible-behind-player",
        x: 18.5,
        y: 15.5,
        floor: 0,
        hp: 60,
        stagger: 0,
        path: [],
      },
      {
        id: "too-far",
        x: 6.5,
        y: 15.5,
        floor: 0,
        hp: 60,
        stagger: 0,
        path: [],
      },
    ];
  });
  async function pixels() {
    return page.evaluate(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const c = document.querySelector<HTMLCanvasElement>("#world")!,
        rect = c.getBoundingClientRect(),
        dpr = c.width / rect.width,
        scale = Math.min(rect.width, rect.height) / 24,
        a = (window as any).__deadAir.game.survivors[0],
        ox = rect.width / 2 - a.x * scale,
        oy = rect.height / 2 - a.y * scale,
        ctx = c.getContext("2d")!;
      const pixel = (x: number, y: number) =>
        Array.from(
          ctx.getImageData(
            Math.floor((ox + x * scale) * dpr),
            Math.floor((oy + y * scale) * dpr),
            1,
            1,
          ).data,
        );
      return {
        hidden: pixel(26.5, 15.5),
        visible: pixel(18.5, 15.5),
        far: pixel(6.5, 15.5),
        background: Array.from(ctx.getImageData(1, 1, 1, 1).data),
      };
    });
  }
  const closed = await pixels();
  expect(closed.hidden).not.toEqual(closed.background);
  expect(closed.hidden[1]).toBeGreaterThan(closed.hidden[2] + 10);
  expect(closed.far).toEqual(closed.background);
  expect(closed.visible).not.toEqual(closed.background);
  await page.screenshot({
    path: "test-results/visibility-closed-door.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    (window as any).__deadAir.game.floors[0].furniture[0].open = true;
  });
  const opened = await pixels();
  expect(opened.hidden).not.toEqual(opened.background);
  expect(opened.hidden[1]).toBeGreaterThan(opened.hidden[2] + 10);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.floors[0].furniture[0].open = false;
    g.surge.state = "active";
  });
  const surge = await pixels();
  expect(surge.hidden).not.toEqual(surge.background);
  expect(surge.hidden[1]).toBeGreaterThan(surge.hidden[2] + 10);
  expect(surge.visible).not.toEqual(surge.background);
  await page.screenshot({
    path: "test-results/visibility-surge.png",
    fullPage: true,
  });
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    for (let y = 14; y <= 16; y++) g.floors[0].tiles[y][23] = 1;
  });
  const wallSurge = await pixels();
  expect(wallSurge.hidden).toEqual(wallSurge.background);
  await page.evaluate(() => {
    (window as any).__deadAir.game.surge.state = "calm";
  });
  const wallNormal = await pixels();
  expect(wallNormal.hidden).toEqual(wallNormal.background);
  expect(wallNormal.far).toEqual(wallNormal.background);
  expect(errors).toEqual([]);
});

test("partial development work survives combat death while a fresh run archives its question without transferring its lock", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterNativeGame(page);
  const draft =
    "Preserved human partial reasoning: a boundary remains unresolved.";
  await seedLegacyDraft(page, draft);
  const id = await openNativeQuestion(page, "development");
  const issued = (await nativeState(page, id)).problem;
  // A reply is still in flight when the run ends.
  relay.hold();
  relay.gap();
  await page.locator("#chat-input").fill("I do not know this part");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  const oldRun = await page.evaluate(() => (window as any).__deadAir.game.id);
  await killHumanInStep(page);
  await expect(page.locator("#start-card")).toBeHidden();
  await page.getByRole("button", { name: "Run summary" }).click();
  await page.getByRole("button", { name: "Begin another run" }).click();
  await chooseDesignedRun(page);
  await expect(page.locator("#start-card")).toBeHidden();
  const state = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.survivors = g.survivors.slice(0, 1);
    return {
      id: g.id,
      archives: g.study.archives,
      evidence: g.study.learner.evidence,
      attempts: g.study.learner.attempts,
    };
  });
  expect(state.id).not.toBe(oldRun);
  const archive = state.archives.find(
    (e: any) => e.id === id && e.runId === oldRun,
  );
  expect(archive.workspace).toBe(draft);
  expect(JSON.stringify(archive.problem)).toBe(issued);
  expect(state.evidence).toEqual([]);
  // The interrupted visit stays in the ledger as an attempt without evidence;
  // the new run starts none of its own.
  expect(state.attempts).toHaveLength(1);
  expect(state.attempts[0]).toMatchObject({
    encounter: `${oldRun}/${id}`,
    status: "interrupted",
  });
  // A late reply from the old run must not reopen it, add a gap or a key to
  // the new run, or transfer the old question's lock.
  relay.release();
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.survivors[0].keys),
  ).toBe(0);
  const next = await openNativeQuestion(page, "development");
  const current = await nativeState(page, next);
  expect(current.problem).not.toBe(issued);
  expect(current.workspace).not.toBe(draft);
  expect(current.keys).toBe(0);
  const retained = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return {
      gaps: g.study.knowledgeGaps ?? [],
      evidence: g.study.learner.evidence,
    };
  });
  // The late reply may still record the learner's own declared gap, labelled
  // with the run it belongs to, but it adds no evidence and no key.
  expect(retained.evidence).toEqual([]);
  expect(retained.gaps.every((gap: any) => gap.runId === oldRun)).toBe(true);
});

for (const fixtureKind of ["checkpoint", "transfer", "historical"] as const) {
  const finalRequirement = fixtureKind === "transfer",
    historical = fixtureKind === "historical";
  test(`controlled bridge fixture: ${finalRequirement ? "Tier 4 transfer" : historical ? "historical partial proof" : "ordinary checkpoint"}, real request flow and independent learning transaction`, async ({
    page,
  }) => {
    // This exercises the adapter with isolated synthetic responses. It does not
    // establish that any genuine Claude CLI connection is working.
    if (finalRequirement) {
      const source = tier4RoadmapFixture(
        JSON.parse(await readFile("public/curriculum.json", "utf8")),
      );
      await page.route("**/curriculum.json", (route) =>
        route.fulfill({ json: source }),
      );
    }
    await page.route("**/api/status", (route) =>
      route.fulfill({
        json: {
          mode: "claude-cli",
          label: "Test bridge fixture",
          detail: "Synthetic transport fixture only",
          capabilities: ["generate", "tutor", "group", "complete", "assess"],
        },
      }),
    );
    await page.route("**/api/bridge", async (route) => {
      const { operation, payload } = route.request().postDataJSON();
      if (operation === "generate") {
        const c = payload.contract;
        await route.fulfill({
          json: {
            title: "Isolated bridge workflow",
            prompt: "A synthetic task for browser integration verification.",
            starter: "",
            rubric: ["scope"],
            contract: c,
            scopeDefinitions: [
              {
                id: `${c.objectiveIds[0]}/${c.kind === "transfer" || c.kind === "integration" ? "T4" : `D${c.depth}`}`,
                objectiveId: c.objectiveIds[0],
                depth: c.depth,
                sourceScope: c.scopes[0],
                facets: historical
                  ? [
                      {
                        id: "historical",
                        description:
                          "Preserve next-node access before changing a linked reference",
                      },
                      {
                        id: "scope",
                        description:
                          "Explain the remaining end-of-chain boundary",
                      },
                    ]
                  : [
                      {
                        id: "scope",
                        description:
                          "Synthetic complete scope for this test fixture",
                      },
                    ],
              },
            ],
          },
        });
        return;
      }
      if (operation === "complete") {
        await route.fulfill({
          json: {
            complete: true,
            feedback: "Fixture completion response.",
            qualified: ["human"],
          },
        });
        return;
      }
      if (operation === "assess") {
        const packet = payload.packet,
          c = packet.problem.contract,
          artifact = packet.history.find(
            (h: any) => h.author === "human" && h.kind === "edit",
          );
        if (historical)
          expect(packet.historicalSourceContext).toContain("| S0006-EV16 |");
        await route.fulfill({
          json: {
            historicalMappings: historical
              ? [
                  {
                    scopeId: packet.problem.scopeDefinitions[0].id,
                    facet: "historical",
                    sourceHash: packet.sourceHash,
                    evidenceIds: ["S0006-EV16"],
                    outcome: "independent",
                    rationale:
                      "Synthetic explicit narrow source-to-facet equivalence review",
                  },
                ]
              : undefined,
            findings: [
              {
                objectiveId: c.objectiveIds[0],
                facet: "scope",
                depth: c.depth,
                outcome: "independent",
                evidence: [artifact.seq],
                completeCheckpointScope: true,
                execution: "not-run",
                rationale: "Explicitly synthetic browser-test finding.",
              },
            ],
            visitOutcome: "usable",
            scopeReviews: [
              {
                id: packet.problem.scopeDefinitions[0].id,
                completeCoverage: true,
                rationale: "Synthetic scope review.",
              },
            ],
            helpAttributions: (packet.assistanceSources ?? []).map(
              (m: any) => ({
                messageId: m.id,
                facets: [],
                rationale:
                  "Fixture prompt contains a question only and supplies no answer.",
              }),
            ),
          },
        });
        return;
      }
      await route.fulfill({ json: { text: "Fixture guidance" } });
    });
    await enterLegacyBuilding(page);
    // Every run is a live Claude run; the legacy world keeps its study state.
    await page.waitForFunction(
      () => (window as any).__deadAir.game.study.profile === "live",
    );
    await page.evaluate(
      (flags) => {
        const g = (window as any).__deadAir.game,
          s = g.floors[0].stations[0];
        if (flags.finalRequirement) {
          g.study.learner.reviews = {};
          g.study.learner.tracks.PY.cleared = 3;
          g.study.learner.tracks.PE.cleared = 3;
        }
        if (flags.historical) {
          g.study.learner.reviews = {};
          g.study.learner.tracks.PY.queue = ["T07"];
        }
        g.survivors[0].x = s.x;
        g.survivors[0].y = s.y;
      },
      { finalRequirement, historical },
    );
    await page.locator("#world").focus();
    await page.keyboard.press("e");
    await page.evaluate(async () => {
      const d = (window as any).__deadAir,
        root = "/src/";
      const { ensureProblem, presentProblem, edit, submit } = await import(
        root + "ai.ts"
      );
      const e = d.game.encounters[d.game.floors[0].stations[0].encounter];
      await ensureProblem(d.game, e, d.roadmap);
      presentProblem(d.game, e, d.roadmap);
      edit(
        d.game,
        e,
        "Human-authored integration fixture reasoning, covering the defined scope without any asserted runtime execution.",
        e.revision,
        d.roadmap,
      );
      await submit(d.game, e, d.roadmap);
    });
    await expect(page.locator("#terminal")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => {
          const g = (window as any).__deadAir.game;
          return {
            evidence: g.study.learner.evidence.length,
            reviews: g.study.assessments
              .filter((a: any) => a.status === "review-required")
              .map((a: any) => a.error ?? a.rationale ?? a),
          };
        }),
      )
      .toEqual({ evidence: 1, reviews: [] });
    const result = await page.evaluate(() => {
      const g = (window as any).__deadAir.game;
      return {
        profile: g.study.profile,
        access: g.survivors[0].access,
        attempt: g.study.learner.attempts[0].id,
        outcome: g.study.assessments[0].status,
        cycle: g.study.learner.cycle,
        sourcePasses: g.study.learner.cells["PY:T05.2"].states[0],
      };
    });
    expect(result).toEqual({
      profile: "live",
      access: [0],
      attempt: "S0008-A01",
      outcome: "applied",
      cycle: 1,
      sourcePasses: "P",
    });
    if (finalRequirement) {
      expect(
        await page.evaluate(() => {
          const l = (window as any).__deadAir.game.study.learner;
          return {
            status: l.finalProgress["PY:T01"].status,
            ordinaryCells: Object.keys(l.cells).length,
            fakeCell: l.cells["PY:T01"],
          };
        }),
      ).toEqual({ status: "P", ordinaryCells: 192, fakeCell: undefined });
    }
    if (historical)
      expect(
        await page.evaluate(() => {
          const l = (window as any).__deadAir.game.study.learner;
          return {
            status: l.cells["PY:T07.1"].states[0],
            oldRefs: l.cells["PY:T07.1"].facets["D1:historical"].evidenceIds,
            newObservations: l.evidence.length,
            reconciliations: l.historicalReviews.length,
          };
        }),
      ).toEqual({
        status: "P",
        oldRefs: ["S0006-EV16"],
        newObservations: 1,
        reconciliations: 1,
      });
    await openGameMenu(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    await expect(page.locator("#inspector-content")).toContainText(
      "Game-recorded academic visits: 1",
    );
    if (historical) {
      await page
        .getByText("Historical facet reconciliations (1)", { exact: true })
        .click();
      await expect(page.locator("#inspector-content")).toContainText(
        "S0006-EV16 observed 2026-09-18",
      );
      await expect(page.locator("#inspector-content")).toContainText(
        "Reconciliation dates record review activity, not new human demonstrations",
      );
    }
    const firstDownload = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: "Download updated merged roadmap",
        exact: true,
      })
      .click();
    const first = await firstDownload;
    const exported = await readFile((await first.path())!, "utf8");
    expect(exported).toContain("revision: 10\nprevious_revision: 9");
    expect(exported).toContain("S0008-EV01");
    if (historical) {
      expect(exported).toContain(
        "Historical facet reconciliation (no new observation IDs)",
      );
      expect([...exported.matchAll(/^\| S0006-EV16 \|/gm)]).toHaveLength(1);
    }
    if (finalRequirement) {
      expect(exported).toMatch(/\| T01 \| P \|[^\n]*S0008-EV01/);
      expect(exported).toContain("PY:T01/T4");
    }
    expect(exported).not.toContain(
      "Human-authored integration fixture reasoning",
    );
    await expect(page.locator("#progress-export-status")).toContainText(
      "revision 10",
    );
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await openGameMenu(page);
    await page.getByRole("button", { name: "Inspect" }).click();
    const secondDownload = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name: "Download updated merged roadmap",
        exact: true,
      })
      .click();
    const second = await secondDownload;
    expect(await readFile((await second.path())!, "utf8")).toBe(exported);
  });
}

// Retired shared-editor widgets have no normal player entry. Their retained
// domain behavior is covered by workspace-proposals, group-retry,
// group-availability, terminal-lifecycle and terminal-submission unit suites.
// Native browser conversation coverage lives in direct-study.spec.ts.
test("retained group API keeps private tutoring out of proposals and preserves NPC authorship", async ({
  page,
}) => {
  await page.route("**/api/status", (route) =>
    route.fulfill({
      json: {
        mode: "claude-cli",
        label: "Synthetic retained API",
        detail: "No real AI",
        capabilities: ["generate", "group"],
      },
    }),
  );
  await page.route("**/api/bridge", async (route) => {
    const { operation, payload } = route.request().postDataJSON();
    if (operation === "generate")
      return route.fulfill({
        json: {
          title: "Synthetic group API task",
          prompt: "A captured synthetic task",
          starter: "Original shared draft",
          rubric: [],
          contract: payload.contract,
        },
      });
    // Background question preparation is not part of this test.
    if (operation !== "group")
      return route.fulfill({
        status: 503,
        json: { error: "Not part of this test" },
      });
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_TUTOR_");
    return route.fulfill({
      json: {
        requestId: payload.requestId,
        sourceRevision: payload.sourceRevision,
        messages: [
          {
            author: payload.speakers[0].id,
            kind: "proposal",
            text: "Consider an empty input boundary; this is unvalidated.",
            refs: [payload.events.at(-1).seq],
            patch: {
              prefix: payload.workspace.length,
              removed: "",
              inserted: "\nNPC boundary candidate",
            },
          },
        ],
      },
    });
  });
  await enterLegacyBuilding(page);
  const result = await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      root = "/src/";
    const api = await import(root + "ai.ts"),
      proposals = await import(root + "workspace-proposals.ts");
    const e = g.encounters["f0-room0"],
      stations = g.floors[0].stations.filter((s: any) => s.encounter === e.id);
    g.study.profile = "live";
    g.paused = true;
    g.zombies = [];
    g.survivors = g.survivors.slice(0, 2);
    Object.assign(g.survivors[0], {
      x: stations[0].x,
      y: stations[0].y,
      station: stations[0].id,
    });
    Object.assign(g.survivors[1], {
      x: stations[1].x,
      y: stations[1].y,
      station: stations[1].id,
      intent: e.id,
      activity: "studying",
      thought: 10,
    });
    await api.ensureProblem(g, e, d.roadmap);
    // A private tutor reply, as the terminal conversation records one.
    e.tutor.push({
      id: "private-synthetic",
      author: "Terminal AI",
      kind: "tutor",
      text: "PRIVATE_TUTOR_REPLY",
      seq: ++g.seq,
      worldTime: g.time,
      provenance: "claude-cli",
    });
    e.history.push({
      seq: g.seq,
      author: "Terminal AI",
      kind: "tutor",
      text: "PRIVATE_TUTOR_REPLY",
      at: g.time,
      revision: e.revision,
    });
    await api.send(g, e, "group", "Propose a boundary check", d.roadmap);
    const p = e.proposals?.[0];
    if (!p) throw Error(e.error ?? "No synthetic proposal returned");
    const before = e.workspace;
    api.presentMessages(g, e, "group");
    proposals.presentWorkspaceProposal(g, e, p.id);
    proposals.reviewWorkspaceProposal(g, e, p.id, "apply");
    return {
      before,
      after: e.workspace,
      author: e.history.filter((h: any) => h.kind === "edit").at(-1).author,
      privateShown: e.tutor[0].presented !== undefined,
      evidence: g.study.learner.evidence.length,
      state: p.state,
    };
  });
  expect(result).toEqual({
    before: "Original shared draft",
    after: "Original shared draft\nNPC boundary candidate",
    author: "npc-0",
    privateShown: false,
    evidence: 0,
    state: "applied",
  });
  await expect(page.locator("#terminal")).toBeHidden();
});

test("durable saves retain a large archive beyond localStorage capacity", async ({
  page,
}) => {
  await page.goto("/");
  await startDesignedRun(page);
  const size = 8_000_000;
  await page.evaluate((size) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters["f0-room0"];
    // A controlled large-history fixture exercises the actual IndexedDB save path.
    e.workspace = "x".repeat(size);
    g.status = "ready";
    document.querySelector<HTMLElement>("#start-card")!.hidden = true;
  }, size);
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally", {
    timeout: 15000,
  });
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect(
    await page.evaluate(
      () =>
        (window as any).__deadAir.game.encounters["f0-room0"].workspace.length,
    ),
  ).toBe(size);
});

test("container workspace: real code execution preserves a captured revision while editing, leaving, survival and reload continue", async ({
  page,
}) => {
  test.skip(
    process.env.RUN_CONTAINER_BROWSER !== "1",
    "Opt-in real Docker/images dependency; npm run test:browser:runner",
  );
  await isolateRunnerBridge(page);
  await enterLegacyBuilding(page);
  await page.evaluate(async () => {
    const d = (window as any).__deadAir,
      g = d.game,
      r = d.roadmap;
    const curriculumURL: string = "/src/curriculum.ts",
      learnerURL: string = "/src/learner.ts";
    const curriculum = await import(curriculumURL),
      learner = await import(learnerURL);
    const l = learner.initialLearner(r, "test");
    for (const o of r.tracks.PY.objectives) l.cells[o.id].states[0] = "P";
    l.reviews = {};
    learner.reconcileGates(r, l);
    g.study = curriculum.initialStudy(r, "live");
    g.study.learner = l;
    const e = g.encounters["f0-room0"],
      c = curriculum.eligible(r, g.study);
    e.problem = {
      title: "Synthetic scope / actual container",
      prompt: "Browser runner fixture only",
      starter: "",
      rubric: [],
      provenance: "study-mode",
      contract: c,
      runtime: { language: "python" },
    };
    e.workspace = "";
    const station = g.floors[0].stations.find((s: any) => s.encounter === e.id);
    Object.assign(g.survivors[0], { x: station.x, y: station.y, floor: 0 });
    for (const a of g.survivors.slice(1)) a.escaped = true;
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.zombies = [];
    g.status = "playing";
    document.querySelector<HTMLElement>("#start-card")!.hidden = true;
    await d.interact();
  });
  const code = "import time\ntime.sleep(.4)\nprint('captured code output')";
  const before = await page.evaluate(() => (window as any).__deadAir.game.time);
  await page.evaluate(async (code) => {
    const d = (window as any).__deadAir,
      root = "/src/";
    const { edit } = await import(root + "ai.ts"),
      { runWorkspace } = await import(root + "execution.ts");
    const e = d.game.encounters["f0-room0"];
    edit(d.game, e, code, e.revision, d.roadmap);
    void runWorkspace(d.game, e, d.roadmap);
    edit(d.game, e, "print('later edit')", e.revision, d.roadmap);
  }, code);
  await expect(page.locator("#terminal")).toBeHidden();
  await expect
    // Docker inspection, creation and cleanup are outside the program's five-second
    // runtime limit. Match the client's twenty-second transport window, then keep
    // asserting the actual captured output and successful execution below.
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as any).__deadAir.game.encounters["f0-room0"]
              .executions?.[0]?.status,
        ),
      { timeout: 25_000 },
    )
    .toBe("finished");
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.time),
  ).toBeGreaterThan(before);
  const result = await page.evaluate(
    () => (window as any).__deadAir.game.encounters["f0-room0"].executions[0],
  );
  expect(result.code).toBe(code);
  expect(result.receipt.executed).toBe(true);
  expect(result.receipt.exitCode).toBe(0);
  expect(result.receipt.stdout).toBe("captured code output\n");
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.encounters["f0-room0"].workspace,
    ),
  ).toBe("print('later edit')");
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally");
  await page.locator("#resume-game").click();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  expect(
    await page.evaluate(
      () =>
        (window as any).__deadAir.game.encounters["f0-room0"].executions[0]
          .receipt.stdout,
    ),
  ).toBe("captured code output\n");
  const learnerBeforeObservation = await page.evaluate(() =>
    JSON.stringify((window as any).__deadAir.game.study.learner),
  );
  await openGameMenu(page);
  await page.locator("#curriculum-button").click();
  await page.locator("#environment-observations summary").click();
  await page.locator("#environment-item").selectOption("PE:ENV06");
  await page
    .locator("#environment-statement")
    .fill(
      "Synthetic browser fixture: I ran this captured program. Test-writing and full ENV scope remain unassessed.",
    );
  await page.locator("#environment-run").selectOption({ index: 1 });
  await page
    .getByRole("button", { name: "Save observation for review", exact: true })
    .click();
  await expect(page.locator("#environment-status")).toContainText(
    "No ENV pass or academic credit",
  );
  const observationDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download observation packet", exact: true })
    .click();
  const observationPath = await (await observationDownload).path();
  const observation = JSON.parse(await readFile(observationPath!, "utf8"));
  expect(observation.execution.code).toBe(code);
  expect(observation.execution.receipt.stdout).toBe("captured code output\n");
  expect(observation.status).toBe("pending-review");
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study.learner),
    ),
  ).toBe(learnerBeforeObservation);
  await page.locator("#close-inspector").click();
  expect(
    await page.evaluate(
      () => (window as any).__deadAir.game.study.learner.evidence.length,
    ),
  ).toBe(0);
});

test("roadmap review preview: uploaded Markdown reports ancestry and protected changes without altering study", async ({
  page,
}) => {
  const roadmap = JSON.parse(await readFile("public/curriculum.json", "utf8"));
  await page.goto("/");
  await startDesignedRun(page);
  await openGameMenu(page);
  await page.locator("#curriculum-button").click();
  await page.getByText("Review an updated roadmap", { exact: true }).click();
  const before = await page.evaluate(() =>
    JSON.stringify((window as any).__deadAir.game.study),
  );
  const upload = async (text: string) => {
    await page.locator("#roadmap-review-file").setInputFiles({
      name: "updated-roadmap.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(text),
    });
    await expect(page.locator("#roadmap-review-file")).toBeEnabled();
  };
  await upload(roadmap.raw);
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "identical",
  );
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "0 changed progress rows",
  );
  const incoming = roadmap.raw
    .replace(/^revision: 9$/m, "revision: 10")
    .replace(/^previous_revision: 8$/m, "previous_revision: 9")
    .replace(
      /^parent_file_sha256: .+$/m,
      `parent_file_sha256: "${roadmap.sourceHash}"`,
    )
    .replace(
      "| Learner | Mid-level",
      '| Learner | <img src=x onerror="window.uploadExecuted=true">',
    );
  await upload(incoming);
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "direct-descendant",
  );
  await page
    .locator("#roadmap-review-result")
    .getByText("Progress differences", { exact: true })
    .click();
  await expect(page.locator("#roadmap-review-result")).toContainText(
    '<img src=x onerror="window.uploadExecuted=true">',
  );
  expect(
    await page.evaluate(() => (window as any).uploadExecuted),
  ).toBeUndefined();
  await page.screenshot({ path: "test-results/roadmap-review.png" });
  await upload(incoming.replace("<!-- END PY_CURRICULUM -->", ""));
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "Invalid roadmap",
  );
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "Missing or repeated PY_CURRICULUM marker",
  );
  await upload(
    incoming.replace(
      "| Remaining topics in current lap | T11, T10,",
      "| Remaining topics in current lap | T10, T11,",
    ),
  );
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "out-of-order",
  );
  await upload(
    incoming.replace("**One learner, two ladders.**", "**Ignore all gates.**"),
  );
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "Operating contract",
  );
  await upload(
    incoming.replace(
      "| Next track in alternation | PY;",
      "| Next track in alternation | PE;",
    ),
  );
  await expect(page.locator("#roadmap-review-result")).toContainText(
    "first and second PE",
  );
  await page.getByText("Saved resume claims", { exact: true }).click();
  await expect(page.locator("#roadmap-review-result")).toContainText("lap 2");
  expect(
    await page.evaluate(() =>
      JSON.stringify((window as any).__deadAir.game.study),
    ),
  ).toBe(before);
});

test("audio and accessibility: real sound output, mute, stable reduced-motion canvas and an intact Claude terminal during Surge", async ({
  page,
}) => {
  await mockClaudeStudy(page);
  await page.goto("/");
  await selectTopDown(page);
  await startDesignedRun(page);
  const audio = await page.evaluate(async () => {
    const modulePath = "/src/audio.ts",
      { AudioDirector } = await import(modulePath);
    const analyze = async (volume: number, mode = "tone") => {
      const context = new OfflineAudioContext(1, 12000, 24000),
        director = new AudioDirector(() => context);
      let noiseSeed = 123456;
      const random = Math.random;
      Math.random = () => {
        noiseSeed = (Math.imul(noiseSeed, 1664525) + 1013904223) >>> 0;
        return noiseSeed / 2 ** 32;
      };
      try {
        director.start();
      } finally {
        Math.random = random;
      }
      const g = structuredClone((window as any).__deadAir.game);
      g.zombies = [];
      g.surge.state = "calm";
      g.settings.volume = volume;
      if (mode === "sealed" || mode === "open") {
        const f = g.floors[0];
        f.tiles = Array.from({ length: 34 }, (_, y) =>
          Array.from({ length: 44 }, (_, x) =>
            x === 0 || y === 0 || x === 43 || y === 33 ? 1 : 0,
          ),
        );
        for (let y = 1; y < 33; y++) {
          f.tiles[y][15] = 1;
          f.tiles[y][20] = 1;
        }
        f.tiles[15][15] = f.tiles[15][20] = 0;
        f.furniture = [15.5, 20.5].map((x, i) => ({
          id: `audio-barrier-${i}`,
          kind: "fridge",
          floor: 0,
          x,
          y: 15.5,
          w: 1,
          h: 1,
          hp: 100,
          maxHp: 100,
          speed: 1,
          rotation: 0,
          destroyed: mode === "open",
          movers: [],
          moved: 0,
          credited: [],
          turning: 0,
        }));
        Object.assign(g.survivors[0], { floor: 0, x: 10.5, y: 15.5 });
        g.zombies = Array.from({ length: 12 }, (_, i) => ({
          id: `audio-horde-${i}`,
          floor: 0,
          x: 25.5,
          y: 15.5,
          hp: 100,
          path: [],
          repath: 0,
          cooldown: 0,
          memory: 0,
          stagger: 0,
          origin: "outside",
        }));
      }
      director.update(g);
      if (mode === "tone") director.cue(220, 0.4, 0.12);
      if (mode === "overload")
        for (let i = 0; i < 4; i++) director.cue(60, 0.4, 0.5, 450);
      const rendered = await context.startRendering(),
        data = rendered.getChannelData(0);
      let square = 0,
        peak = 0;
      for (const v of data) {
        square += v * v;
        peak = Math.max(peak, Math.abs(v));
      }
      director.stop();
      return { rms: Math.sqrt(square / data.length), peak };
    };
    return {
      audible: await analyze(1),
      muted: await analyze(0),
      sealed: await analyze(1, "sealed"),
      open: await analyze(1, "open"),
      overload: await analyze(1, "overload"),
    };
  });
  expect(audio.audible.rms).toBeGreaterThan(0.01);
  expect(audio.audible.peak).toBeLessThan(0.2);
  expect(audio.muted.peak).toBe(0);
  expect(audio.open.rms).toBeGreaterThan(audio.sealed.rms * 10);
  expect(audio.overload.peak).toBeLessThan(0.9);
  await writeFile(
    "test-results/audio-signal.json",
    JSON.stringify(
      {
        kind: "Actual Chromium OfflineAudioContext signal measurements; synthetic acoustic scene, not human listening or live-model evidence",
        ...audio,
      },
      null,
      2,
    ),
  );
  const canvas = await page.evaluate(async () => {
    const modulePath = "/src/render.ts",
      { render } = await import(modulePath),
      g = structuredClone((window as any).__deadAir.game),
      c = document.querySelector<HTMLCanvasElement>("#world")!;
    const frame = (time: number, reduced: boolean) => {
      g.time = time;
      g.settings.reducedFlash = reduced;
      render(c, g);
      return c.toDataURL();
    };
    return {
      ordinaryChanges: frame(1, false) !== frame(2, false),
      reducedStable: frame(1, true) === frame(2, true),
    };
  });
  expect(canvas).toEqual({ ordinaryChanges: true, reducedStable: true });
  await openGameMenu(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByLabel("Surge visual cues & sound captions").check();
  await page.getByLabel("Reduced motion", { exact: true }).check();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.locator("#resume-game").click();
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      st = g.floors[0].stations[0];
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    for (const a of g.survivors.slice(1)) a.escaped = true;
    Object.assign(g.survivors[0], { x: st.x, y: st.y });
  });
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect(page.locator("#terminal")).toBeVisible();
  const id = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return g.floors[0].stations[0].encounter as string;
  });
  const captured = (await nativeState(page, id)).problem;
  expect(captured).toBeTruthy();
  await page.locator("#chat-input").focus();
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.surge.state = "warning";
    g.surge.started = g.time;
  });
  await expect(page.locator("#world-caption")).toContainText(
    "biological pulse",
  );
  await expect(page.locator("body")).toHaveClass(/reduced/);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.surge.state = "active";
    g.surge.started = g.time;
    g.surge.duration = 60;
  });
  await expect(page.locator("body")).toHaveClass(/surge/);
  await expect(page.locator("#world-caption")).toContainText(
    "horde intensified",
  );
  expect((await nativeState(page, id)).problem).toBe(captured);
  await expect(page.locator("#chat-input")).toBeFocused();
  await page.screenshot({
    path: "test-results/surge-accessibility.png",
    fullPage: false,
  });
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.surge.state = "calm";
    g.surge.anchor = g.time;
    g.surge.quietDelay = 100;
  });
  await expect(page.locator("body")).not.toHaveClass(/surge/);
  await expect(page.locator("#world-caption")).not.toContainText(
    "horde intensified",
  );
  expect((await nativeState(page, id)).problem).toBe(captured);
  await expect(page.locator("#chat-input")).toBeFocused();
});

test("equipment UI: readable effects, no wasted healing or blocked shots, physical door access and saved charges", async ({
  page,
}) => {
  await enterLegacyBuilding(page);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    for (const a of g.survivors.slice(1)) a.escaped = true;
  });
  await page.getByRole("button", { name: /Medkit/ }).click();
  await expect(page.locator("#notice")).toContainText(
    "full health; medkit kept",
  );
  await expect(page.getByRole("button", { name: /Medkit/ })).toContainText(
    "1 use",
  );
  await page.getByText("Equipment effects", { exact: true }).click();
  await expect(page.locator(".equipment-guide")).toContainText(
    "Only walls block the light and your sight; vision stays finite",
  );
  await page.locator("#world").focus();
  await page.getByRole("button", { name: /Flare/ }).click();
  await expect(page.getByRole("button", { name: /Flare/ })).toContainText(
    "1 use",
  );
  const light = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    return g.effects.find((e: any) => e.kind === "flare");
  });
  expect(light.radius).toBe(8);
  await page.evaluate(() => {
    (window as any).__deadAir.game.survivors[0].hp = 30;
  });
  await page.getByRole("button", { name: /Medkit/ }).click();
  await expect(page.locator("#health")).toHaveText("85");
  await expect(page.getByRole("button", { name: /Medkit/ })).toHaveCount(0);
  await page.evaluate(() => {
    const g = (window as any).__deadAir.game,
      a = g.survivors[0],
      f = g.floors[0];
    f.tiles = Array.from({ length: 34 }, (_, y) =>
      Array.from({ length: 44 }, (_, x) =>
        x === 0 || x === 43 || y === 0 || y === 33 ? 1 : 0,
      ),
    );
    f.stations = [];
    f.furniture = [
      {
        id: "equipment-door",
        kind: "door",
        floor: 0,
        x: 12.07,
        y: 15.5,
        w: 0.15,
        h: 2,
        hp: 100,
        maxHp: 100,
        speed: 1,
        rotation: 0,
        destroyed: false,
        open: false,
        movers: [],
        moved: 0,
        credited: [],
        turning: 0,
      },
    ];
    Object.assign(a, { x: 10.5, y: 15.5 });
    a.inventory.push({
      id: "fixture-weapon",
      kind: "weapon",
      weight: 1,
      charges: 1,
    });
    g.zombies = [
      {
        id: "covered-target",
        x: 13.5,
        y: 15.5,
        floor: 0,
        hp: 60,
        path: [],
        repath: 0,
        cooldown: 0,
        memory: 0,
        stagger: 100,
        origin: "outside",
      },
    ];
  });
  await page.getByRole("button", { name: /Limited-use weapon/ }).click();
  await expect(page.locator("#notice")).toContainText("charge kept");
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.zombies[0].hp),
  ).toBe(60);
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as any).__deadAir.game.floors[0].furniture[0].open,
      ),
    )
    .toBe(true);
  // Unlatching does not erase a physical leaf or permit firing through it.
  await page.getByRole("button", { name: /Limited-use weapon/ }).click();
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.zombies[0].hp),
  ).toBe(60);
  await page.locator("#world").focus();
  await page.keyboard.down("d");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const root = "/src/",
          { canSee } = await import(root + "visibility.ts"),
          g = (window as any).__deadAir.game;
        return (
          g.survivors[0].x > 12.6 &&
          canSee(g.floors[0], g.survivors[0], g.zombies[0], 5)
        );
      }),
    )
    .toBe(true);
  await page.keyboard.up("d");
  const shotState = () =>
    page.evaluate(async () => {
      const root = "/src/",
        { canSee } = await import(root + "visibility.ts"),
        g = (window as any).__deadAir.game;
      return {
        time: g.time,
        a: { x: g.survivors[0].x, y: g.survivors[0].y },
        z: g.zombies[0],
        door: g.floors[0].furniture[0],
        exposed: canSee(g.floors[0], g.survivors[0], g.zombies[0], 5),
        notice: g.notice,
      };
    });
  const beforeShot = await shotState();
  await page.getByRole("button", { name: /Limited-use weapon/ }).click();
  expect(
    await page.evaluate(() => (window as any).__deadAir.game.zombies[0].hp),
    JSON.stringify({ beforeShot, afterShot: await shotState() }),
  ).toBe(0);
  await expect(
    page.getByRole("button", { name: /Limited-use weapon/ }),
  ).toHaveCount(0);
  await openGameMenu(page);
  await page.getByRole("button", { name: "Save run", exact: true }).click();
  await expect(page.locator("#notice")).toContainText("Run saved locally");
  await page.locator("#resume-game").click();
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await expect(page.getByRole("button", { name: /Flare/ })).toContainText(
    "1 use",
  );
  expect(
    await page.evaluate(() => {
      const g = (window as any).__deadAir.game;
      return {
        effect: g.effects.find((e: any) => e.kind === "flare"),
        evidence: g.study.learner.evidence.length,
        hp: g.survivors[0].hp,
      };
    }),
  ).toEqual({ effect: light, evidence: 0, hp: 85 });
  await page.screenshot({
    path: "test-results/equipment-use.png",
    fullPage: false,
  });
});

test("practical observations: unreviewed output is inert, persists without changing ENV or academic status, and fits a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/");
  await startDesignedRun(page);
  const before = await page.evaluate(() => {
    const g = (window as any).__deadAir.game;
    g.zombies = [];
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    return JSON.stringify(g.study.learner);
  });
  await openGameMenu(page);
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
  const time = await page.evaluate(() => (window as any).__deadAir.game.time);
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
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => (window as any).__deadAir.game.time)).toBe(
    time,
  );
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
  await page.locator("#resume-game").click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__deadAir.game.time))
    .toBeGreaterThan(time);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__deadAir);
  await openGameMenu(page);
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
  await startDesignedRun(page);
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
  await openGameMenu(page);
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
    await page.evaluate(() => {
      (window as any).__deadAir.game.settings.view = "top-down";
    });
    await startDesignedRun(page);
    const before = await page.evaluate(async () => {
      const g = (window as any).__deadAir.game,
        root = "/src/",
        { checkBridge } = await import(root + "ai.ts");
      await checkBridge();
      g.study.profile = "live";
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      g.surge.anchor = 10000;
      for (const a of g.survivors.slice(1)) a.escaped = true;
      return JSON.stringify({
        cells: g.study.learner.cells,
        attempts: g.study.learner.attempts,
        sessions: g.study.learner.sessions,
        cycle: g.study.learner.cycle,
      });
    });
    await openGameMenu(page);
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
    await openGameMenu(page);
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
    await openGameMenu(page);
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
