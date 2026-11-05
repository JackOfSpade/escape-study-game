// Explicit supported inspection APIs and native conversations. Consumed world
// stations no longer open the retired editor/chat panel.
import { expect, test } from "@playwright/test";
import { enterLegacyBuilding } from "./helpers/legacy-world";
import { openGameMenu } from "./helpers/game-menu";
import { mockClaudeStudy } from "./study-harness";

for (const provider of ["claude-cli"])
  for (const failure of [false, true])
    test(`NPC outcome API ${provider}: ${failure ? "deferred validation and exact saved retry" : "validated reconstruction persists without credit"}`, async ({
      page,
    }) => {
      let materializations = 0,
        validations = 0;
      let firstValidation: any;
      await page.route("**/api/**", async (route) => {
        const request = route.request(),
          url = new URL(request.url());
        const json = (body: unknown, status = 200) =>
          route.fulfill({ status, json: body });
        if (url.pathname === "/api/status")
          return json({
            mode: provider,
            label: "Synthetic explicit outcome API",
            detail: "No native identity or learner claim",
            capabilities: ["materialize-outcome", "complete", "tutor"],
          });
        if (url.pathname === "/api/handoff/status")
          return json({
            enabled: true,
            queued: 0,
            working: 0,
            done: 0,
            public: { configured: false },
          });
        if (url.pathname !== "/api/bridge")
          return json({ error: "Unused synthetic route" }, 404);
        const { operation, payload } = request.postDataJSON();
        if (operation === "materialize-outcome") {
          materializations++;
          expect(payload.provider).toBe(provider);
          expect(JSON.stringify(payload)).not.toContain(
            "PRIVATE_OUTCOME_SECRET",
          );
          const c = payload.contract;
          return json({
            requestId: payload.requestId,
            problem: {
              title: "Synthetic completed task",
              prompt: "Explain this synthetic boundary.",
              starter: "",
              rubric: ["Synthetic scope"],
              provenance: provider,
              contract: c,
              scopeDefinitions: c.objectiveIds.map((id: string, i: number) => ({
                id: `${id}/D${c.depth}`,
                objectiveId: id,
                depth: c.depth,
                sourceScope: c.scopes[i],
                facets: [{ id: "scope", description: "Synthetic scope" }],
              })),
            },
            solution:
              "Synthetic saved survivor reasoning <img src=x onerror=window.outcomeInjected=true>",
            authors: [payload.speakers[0].id],
            refs: [payload.commitment.work[0].seq],
            execution: "not-run",
          });
        }
        if (operation === "complete") {
          validations++;
          expect(payload.provider).toBe(provider);
          expect(payload.mode).toBe("retrospective-npc-outcome");
          if (validations === 1) firstValidation = payload;
          else expect(payload).toEqual(firstValidation);
          return json({
            requestId: payload.requestId,
            complete: !failure || validations > 1,
            feedback: "Synthetic semantic review, not past execution",
            execution: "not-run",
          });
        }
        return json({ error: "Unused synthetic operation" }, 503);
      });
      await enterLegacyBuilding(page);
      const before = await page.evaluate(async () => {
        const d = (window as any).__deadAir,
          g = d.game,
          e = g.encounters["f0-room0"],
          a = g.survivors[0],
          npc = g.survivors[1],
          s = g.floors[0].stations.find((s: any) => s.encounter === e.id),
          root = "/src/";
        const { recordNpcWork } = await import(
            /* @vite-ignore */ root + "npc-cognition.ts"
          ),
          { complete } = await import(/* @vite-ignore */ root + "engine.ts");
        g.study.profile = "live";
        g.nextSpawn = Number.MAX_SAFE_INTEGER;
        g.surge.anchor = Number.MAX_SAFE_INTEGER;
        g.zombies = [];
        g.survivors = [a, npc];
        npc.milestone = 1;
        recordNpcWork(g, e, npc, false);
        e.contributors = [npc.id];
        complete(
          g,
          e.id,
          `npc-sim-${e.id}`,
          e.contributors,
          "Simulated NPC-only fixture",
        );
        e.tutor.push({
          id: "private-fixture",
          author: "human",
          kind: "human",
          text: "PRIVATE_OUTCOME_SECRET",
          seq: ++g.seq,
          worldTime: g.time,
          provenance: "private",
        });
        npc.escaped = true;
        Object.assign(a, { floor: 0, x: s.x, y: s.y });
        return {
          accepted: e.accepted,
          revision: e.revision,
          workspace: e.workspace,
          cycle: g.study.learner.cycle,
          access: [...a.access],
        };
      });
      await page.locator("#world").focus();
      await page.keyboard.press("e");
      await expect(page.locator("#terminal")).toBeHidden();
      await expect(page.locator("#notice")).toContainText("complete");
      expect(materializations).toBe(0);
      const inspect = (retry = false) =>
        page.evaluate(async (retry) => {
          const d = (window as any).__deadAir,
            root = "/src/";
          const { inspectCompletedNpcWork } = await import(
            /* @vite-ignore */ root + "ai.ts"
          );
          await inspectCompletedNpcWork(
            d.game,
            d.game.encounters["f0-room0"],
            d.roadmap,
            retry,
          );
        }, retry);
      const state = () =>
        page.evaluate(async () => {
          const d = (window as any).__deadAir,
            e = d.game.encounters["f0-room0"],
            root = "/src/";
          const { outcomeIsVisible } = await import(
            /* @vite-ignore */ root + "npc-outcome.ts"
          );
          return {
            inspection: e.outcomeInspection,
            notice: e.outcomeNotice,
            valid: outcomeIsVisible(d.game, e, d.roadmap),
          };
        });
      const save = async () => {
        await openGameMenu(page);
        await page
          .getByRole("button", { name: "Save run", exact: true })
          .click();
        await expect(page.locator("#notice")).toContainText(
          "Run saved locally",
        );
        await page.locator("#resume-game").click();
      };
      await inspect();
      if (failure) {
        const rejected = await state();
        expect(rejected.inspection.state).toBe("failed");
        expect(rejected.valid).toBe(false);
        expect(rejected.inspection.validatedContent).toBeUndefined();
        expect(rejected.notice).toContain(
          "does not have a compatible validation",
        );
        const hash = rejected.inspection.candidateHash;
        await save();
        await page.reload();
        await page.waitForFunction(() => !!(window as any).__deadAir);
        await inspect(true);
        expect((await state()).inspection.candidateHash).toBe(hash);
      }
      const reconstructed = await state();
      expect(reconstructed.valid).toBe(true);
      expect(reconstructed.inspection.state).toBe("applied");
      expect(reconstructed.inspection.candidate.solution).toContain(
        "Synthetic saved survivor reasoning <img",
      );
      expect(materializations).toBe(1);
      expect(validations).toBe(failure ? 2 : 1);
      // API retrieval does not pretend the normal gameplay interface displayed
      // a reconstruction, nor render its text as active HTML.
      expect(
        await page.evaluate(() => (window as any).outcomeInjected),
      ).toBeUndefined();
      expect(await page.locator('img[src="x"]').count()).toBe(0);
      await save();
      await page.reload();
      await page.waitForFunction(() => !!(window as any).__deadAir);
      await inspect();
      expect((await state()).inspection.candidate).toEqual(
        reconstructed.inspection.candidate,
      );
      expect(materializations).toBe(1);
      expect(validations).toBe(failure ? 2 : 1);
      const after = await page.evaluate(() => {
        const g = (window as any).__deadAir.game,
          e = g.encounters["f0-room0"],
          l = g.study.learner;
        return {
          accepted: e.accepted,
          revision: e.revision,
          workspace: e.workspace,
          cycle: l.cycle,
          access: g.survivors[0].access,
          attempts: l.attempts,
          evidence: l.evidence,
          exposures: e.history.filter(
            (h: any) =>
              h.kind === "workspace-view" &&
              h.text.includes("Reconstructed now"),
          ),
        };
      });
      expect(after.accepted).toBe(before.accepted);
      expect(after.revision).toBe(before.revision);
      expect(after.workspace).toBe(before.workspace);
      expect(after.cycle).toBe(before.cycle);
      expect(after.access).toEqual(before.access);
      expect(after.attempts).toEqual([]);
      expect(after.evidence).toEqual([]);
      expect(after.exposures).toEqual([]);
      await expect(page.locator("#terminal")).toBeHidden();
    });

test("the Claude terminal cannot steal an NPC's solo terminal; an NPC's later accepted answer stays intact while the learner's reply is retained", async ({
  page,
}) => {
  const relay = await mockClaudeStudy(page);
  await enterLegacyBuilding(page);
  const ids = await page.evaluate(() => {
    const d = (window as any).__deadAir,
      g = d.game,
      h = g.survivors[0],
      npc = g.survivors[1],
      stations = g.floors[0].stations,
      s = stations[0],
      other = stations.find((s: any) => s.encounter !== stations[0].encounter);
    const owned = g.encounters[s.encounter];
    owned.mode = "solo";
    owned.owner = npc.id;
    for (const a of g.survivors.slice(1)) a.escaped = true;
    g.nextSpawn = Number.MAX_SAFE_INTEGER;
    g.surge.anchor = Number.MAX_SAFE_INTEGER;
    g.zombies = [];
    Object.assign(h, { floor: 0, x: s.x, y: s.y });
    return {
      owned: owned.id,
      available: other.encounter,
      station: other.id,
      npc: npc.id,
    };
  });
  await page.locator("#world").focus();
  await page.keyboard.press("e");
  await expect(page.locator("#notice")).toContainText("another survivor");
  // A live run prepares its next question in the background
  // (encounterId "prepared"); nothing may be generated for or sent about the
  // NPC-owned terminal.
  expect(
    relay.calls.filter(
      (call: any) =>
        !(
          call.operation === "generate" &&
          call.payload?.encounterId === "prepared"
        ),
    ),
  ).toHaveLength(0);
  expect(
    relay.calls.filter((call: any) => call.payload?.encounterId === ids.owned),
  ).toHaveLength(0);
  expect(
    await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].owner,
      ids.owned,
    ),
  ).toBe(ids.npc);
  await page.evaluate(async (ids) => {
    const d = (window as any).__deadAir,
      g = d.game,
      e = g.encounters[ids.available],
      s = g.floors[0].stations.find((s: any) => s.id === ids.station),
      root = "/src/";
    e.mode = "solo";
    e.owner = g.survivors[0].id;
    // A live run starts with no pre-made practice questions.
    g.study.profile = "live";
    for (const each of Object.values<any>(g.encounters)) delete each.problem;
    Object.assign(g.survivors[0], { floor: 0, x: s.x, y: s.y });
    const { ensureProblem } = await import(/* @vite-ignore */ root + "ai.ts");
    await ensureProblem(g, e, d.roadmap);
    await d.interact();
  }, ids);
  await expect(page.locator("#terminal")).toBeVisible();
  // The learner answers; the reply stays in flight while the NPC is accepted.
  relay.hold();
  relay.solve();
  await page
    .locator("#chat-input")
    .fill("My own reasoning about the boundary.");
  await page.locator("#chat-input").press("Enter");
  await expect.poll(() => relay.tutorCalls().length).toBe(1);
  const accepted = await page.evaluate(async (ids) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[ids.available],
      root = "/src/",
      { complete } = await import(/* @vite-ignore */ root + "engine.ts");
    e.submissions.push({
      id: "synthetic-npc-native-acceptance",
      author: ids.npc,
      revision: e.revision + 1,
      content: "Synthetic accepted survivor work",
      seq: ++g.seq,
      status: "pending",
      feedback: "",
    });
    complete(
      g,
      e.id,
      "synthetic-npc-native-acceptance",
      [ids.npc],
      "Synthetic accepted NPC solution",
    );
    return {
      accepted: e.accepted,
      workspace: e.workspace,
      revision: e.revision,
      submissions: e.submissions,
      access: [...g.survivors[0].access],
      cycle: g.study.learner.cycle,
    };
  }, ids);
  relay.release();
  await expect
    .poll(() =>
      page.evaluate(
        (id) =>
          (window as any).__deadAir.game.encounters[id].tutorRequests?.at(-1)
            ?.state,
        ids.available,
      ),
    )
    .not.toBe("pending");
  const after = await page.evaluate((id) => {
    const g = (window as any).__deadAir.game,
      e = g.encounters[id];
    return {
      accepted: e.accepted,
      workspace: e.workspace,
      revision: e.revision,
      submissions: e.submissions,
      access: g.survivors[0].access,
      cycle: g.study.learner.cycle,
      evidence: g.study.learner.evidence,
      tutor: e.tutor,
    };
  }, ids.available);
  expect(after.accepted).toBe(accepted.accepted);
  expect(after.workspace).toBe(accepted.workspace);
  expect(after.revision).toBe(accepted.revision);
  expect(after.submissions).toEqual(accepted.submissions);
  expect(after.access).toEqual(accepted.access);
  expect(after.cycle).toBe(accepted.cycle);
  expect(after.evidence).toEqual([]);
  expect(after.tutor.some((m: any) => m.kind === "human")).toBe(true);
  await expect(page.locator("#reward-toast")).toBeHidden();
});
