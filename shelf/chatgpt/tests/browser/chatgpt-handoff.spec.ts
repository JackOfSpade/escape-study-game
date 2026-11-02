import { chooseDesignedRun, startDesignedRun } from "./helpers/designed-run";
// Actual isolated queue/relay with controlled native host turns. No real ChatGPT
// account, model, learner save or service is touched by this fixture.
import { expect, test } from "@playwright/test";
import type { Server } from "node:http";
import { openGameMenu } from "./helpers/game-menu";
import { selectTopDown } from "./helpers/view-mode";
// @ts-expect-error Local .mjs relay integration.
import { createHandoffQueue } from "../../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Local .mjs relay integration.
import { createHandoffRoutes } from "../../scripts/chatgpt-handoff-routes.mjs";
// @ts-expect-error Local .mjs relay integration.
import { createStudyBridgeServer } from "../../scripts/study-bridge-server.mjs";
// @ts-expect-error The same native host tool implementation used by the connector.
import { createTerminalRelayApp } from "../../scripts/terminal-relay-app.mjs";

test("native ChatGPT transport preserves generation and question through reload; final callback rewards once before separate assisted grading", async ({
  page,
}) => {
  const q = createHandoffQueue();
  const relay = createTerminalRelayApp({ queue: q });
  const owner = { linkId: "synthetic-browser-native-owner" };
  const server: Server = createStudyBridgeServer({
    handoff: createHandoffRoutes(q, { token: "synthetic-browser-worker" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw Error("Missing isolated relay");
  const base = `http://127.0.0.1:${address.port}`;
  let chat: string | undefined;
  const tool = (name: string, args: unknown = {}) =>
    relay.call(
      name,
      name === "get_current_study_question" ||
        name === "read_study_terminal_context"
        ? { chat, ...(args as object) }
        : args,
      owner,
    ).structuredContent;
  const continuation = async (receipt: any) => {
    return (
      await relay.call(
        "get_current_study_question",
        {
          chat,
          after: receipt.completion.continuation?.after ?? {
            relayId: receipt.completion.relayId,
            turnId: receipt.completion.turnId,
            jobFingerprint: receipt.completion.jobFingerprint,
          },
        },
        owner,
      )
    ).structuredContent;
  };
  const preparation = (job: any) => {
    // Exact transport context, including original curriculum and source rows.
    // Every required chunk is read through the native context tool.
    expect(["prepare", "assess"]).toContain(job.phase);
    const packet = JSON.parse(job.prompt.slice(job.prompt.indexOf("\n{") + 1));
    const payload =
      packet.payload ??
      JSON.parse(
        Array.from(
          { length: packet.payloadManifest.parts },
          (_, index) =>
            tool("read_study_terminal_context", {
              relayId: job.relayId,
              turnId: job.turnId,
              part: "payload",
              index,
            }).text,
        ).join(""),
      );
    return { ...job, payload, requestHash: job.jobFingerprint };
  };
  const next = async (phase: string) => {
    await expect.poll(() => q.snapshot().queued).toBeGreaterThan(0);
    const job = tool("get_current_study_question");
    expect(job.phase).toBe(phase);
    return preparation(job);
  };
  const answer = (job: any, value: unknown) => {
    const receipt = tool("finish_study_preparation", {
      relayId: job.relayId,
      turnId: job.turnId,
      jobFingerprint: job.jobFingerprint,
      response: JSON.stringify(value),
    });
    expect(receipt.completion.status).toBe("sent");
    return receipt;
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  // Catch every API route before navigation: even an unexpected operation can
  // reach only this ephemeral synthetic queue, never the user's local bridge.
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (request.method() === "POST" && url.pathname === "/api/bridge")
      chat = request.postDataJSON().chatCode ?? chat;
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
  const position = () =>
    page.evaluate(() => {
      const g = (window as any).__deadAir.game,
        s = g.floors[0].stations[0];
      for (const a of g.survivors.slice(1)) a.escaped = true;
      g.zombies = [];
      g.nextSpawn = Number.MAX_SAFE_INTEGER;
      g.surge.anchor = Number.MAX_SAFE_INTEGER;
      Object.assign(g.survivors[0], { floor: 0, x: s.x, y: s.y });
      return s.encounter as string;
    });
  const save = async () => {
    await openGameMenu(page);
    await page.getByRole("button", { name: "Save run", exact: true }).click();
    await expect(page.locator("#notice")).toContainText("Run saved locally");
    await page.locator("#resume-game").click();
  };
  try {
    await page.goto("/");
    await startDesignedRun(page);
    // Keep this transport flow fast in headless Chromium's software WebGL.
    await selectTopDown(page);
    await openGameMenu(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByText("ChatGPT handoff connection", { exact: true }).click();
    await page.locator("#handoff-enable").check();
    await expect(page.locator("#bridge-label")).toContainText(
      "ChatGPT handoff",
    );
    await expect(page.locator("#bridge-detail")).toContainText("not verified");
    await expect(page.locator("#handoff-autonomous")).not.toBeChecked();
    await page.locator("#handoff-autonomous").check();
    await expect.poll(() => q.snapshot().autonomousWork).toBe(true);
    await page.locator("#handoff-autonomous").uncheck();
    await expect.poll(() => q.snapshot().autonomousWork).toBe(false);
    const previousRun = await page.evaluate(
      () => (window as any).__deadAir.game.id,
    );
    await page
      .getByRole("button", { name: "Start a live study run", exact: true })
      .click();
    await chooseDesignedRun(page);
    // Restart has always awaited the durable learning save. Position only the
    // replacement live world, after the existing asynchronous restart finishes.
    await page.waitForFunction((previous) => {
      const g = (window as any).__deadAir.game;
      return g.id !== previous && g.study.profile === "live";
    }, previousRun);
    const id = await position();
    await page.locator("#world").focus();
    await page.keyboard.press("e");
    const generation = await next("prepare");
    const time = await page.evaluate(() => (window as any).__deadAir.game.time);
    await save();
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await position();
    await page.locator("#world").focus();
    await page.keyboard.press("e");
    await expect.poll(() => q.snapshot().working).toBe(1);
    const sameGeneration = preparation(tool("get_current_study_question"));
    expect(sameGeneration.turnId).toBe(generation.turnId);
    expect(sameGeneration.requestHash).toBe(generation.requestHash);
    expect(sameGeneration.payload).toEqual(generation.payload);
    expect(q.snapshot().queued).toBe(0);
    const c = generation.payload.contract;
    await answer(generation, {
      title: "Rejected controlled reply",
      prompt: "Malformed scope fixture",
      starter: "",
      rubric: [],
      contract: c,
      scopeDefinitions: [{ id: "unsupported" }],
    });
    await expect
      .poll(() =>
        page.evaluate(
          (id) => (window as any).__deadAir.game.encounters[id].error,
          id,
        ),
      )
      .toBeTruthy();
    const retained = await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].pendingGeneration,
      id,
    );
    expect(retained.requestId).toBe(generation.payload.requestId);
    // E leaves the failed physical station; correction does not silently
    // reopen it or issue a different scheduled task.
    await page.locator("#world").focus();
    await page.keyboard.press("e");
    await openGameMenu(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByText("ChatGPT handoff connection", { exact: true }).click();
    await page
      .getByRole("button", {
        name: "Request corrected generate reply",
        exact: true,
      })
      .click();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await page.locator("#resume-game").click();
    await page.locator("#world").focus();
    await page.keyboard.press("e");
    const corrected = await next("prepare");
    expect(corrected.requestId).toBe(generation.requestId);
    expect(corrected.requestHash).toBe(generation.requestHash);
    expect(corrected.turnId).not.toBe(generation.turnId);
    const definitions = c.objectiveIds.map(
      (objectiveId: string, i: number) => ({
        id: `${objectiveId}/D${c.depth}`,
        objectiveId,
        depth: c.depth,
        sourceScope: c.scopes[i],
        facets: [
          {
            id: "scope",
            description: "Controlled full-scope transport fixture",
          },
        ],
      }),
    );
    const generatedReceipt = answer(corrected, {
      title: "Controlled native handoff question",
      prompt:
        "Explain the contract and its boundaries. Synthetic transport fixture.",
      starter: "",
      rubric: ["Controlled scope"],
      contract: c,
      scopeDefinitions: definitions,
    });
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const e = (window as any).__deadAir.game.encounters[id];
          return e.problem?.title ?? e.error ?? "still pending";
        }, id),
      )
      .toBe("Controlled native handoff question");
    await expect(page.locator("#native-study-title")).toHaveText(
      "Controlled native handoff question",
    );
    await expect(page.locator("#terminal")).toBeHidden();
    await expect(page.locator("#chat-input")).toBeHidden();
    const native = await continuation(generatedReceipt);
    expect(native.status).toBe("question");
    expect(native.questionFingerprint).toBeTruthy();
    expect(native.prompt).toContain("ordinary ChatGPT composer");
    expect(native.prompt).not.toContain("PRIVATE_HANDOFF_");
    const pending = await page.evaluate(
      (id) => (window as any).__deadAir.game.encounters[id].directStudy,
      id,
    );
    expect(native.requestId).toBe(pending.id);
    expect(
      await page.evaluate(() => (window as any).__deadAir.game.time),
    ).toBeGreaterThan(time);
    // Intermediate turns live only in the normal host chat. Nothing is posted
    // to the game until the exact final callback below.
    const nativeTranscript = [
      {
        role: "assistant",
        text: "PRIVATE_HANDOFF_HINT: consider the empty-input boundary.",
      },
      {
        role: "user",
        text: "PRIVATE_HANDOFF_ANSWER: I used that supplied boundary hint in this reasoning.",
      },
    ];
    const queued = q.snapshot().queued;
    await save();
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    await expect
      .poll(() => tool("get_current_study_question").turnId)
      .toBe(native.turnId);
    expect(tool("get_current_study_question").questionFingerprint).toBe(
      native.questionFingerprint,
    );
    expect(q.snapshot().queued).toBe(queued);
    expect(
      await page.evaluate(
        (id) => (window as any).__deadAir.game.encounters[id].tutor.length,
        id,
      ),
    ).toBe(0);
    const completion = {
      relayId: native.relayId,
      turnId: native.turnId,
      questionFingerprint: native.questionFingerprint,
      text: "Completion sent for local game validation.",
      outcome: "solved",
      transcript: nativeTranscript,
      knowledge: { facets: [{ id: "scope", status: "demonstrated" }] },
      topicAssessments: (
        JSON.parse(pending.payloadJson).topicAssessmentContext?.topicIds ?? []
      ).map((topicId: string) => ({
        topicId,
        text: "Synthetic assisted explanation of the question's scoped mechanism.",
      })),
    };
    const nativePacket = JSON.parse(
      native.prompt.slice(native.prompt.indexOf("\n{") + 1),
    );
    if (nativePacket.omitted?.includes("topicAssessmentContext"))
      tool("read_study_terminal_context", {
        relayId: native.relayId,
        turnId: native.turnId,
        part: "topicAssessmentContext",
      });
    const sent = tool("finish_study_question", completion);
    expect(sent.completion.status).toBe("sent");
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            (window as any).__deadAir.game.encounters[id].directStudy.state,
          id,
        ),
      )
      .toBe("applied");
    const completed = await page.evaluate((id) => {
      const g = (window as any).__deadAir.game,
        e = g.encounters[id];
      return {
        keys: g.survivors[0].keys,
        access: g.survivors[0].access,
        submissions: e.submissions.length,
        accepted: e.accepted,
        evidence: g.study.learner.evidence,
      };
    }, id);
    expect(completed.keys).toBe(1);
    expect(completed.access).toContain(0);
    expect(completed.submissions).toBe(1);
    expect(completed.evidence).toEqual([]);
    expect(tool("finish_study_question", completion).completion.duplicate).toBe(
      true,
    );
    const assessment = preparation(await continuation(sent)),
      packet = assessment.payload.packet;
    expect(JSON.stringify(packet)).toContain("PRIVATE_HANDOFF_HINT");
    expect(JSON.stringify(packet)).toContain("PRIVATE_HANDOFF_ANSWER");
    const artifact = packet.history.find(
      (h: any) => h.author === "human" && h.kind === "reasoning",
    );
    expect(
      packet.assistanceSources.some(
        (m: any) =>
          m.text.includes("PRIVATE_HANDOFF_HINT") && m.presented < artifact.seq,
      ),
    ).toBe(true);
    const assessedReceipt = answer(assessment, {
      findings: definitions.map((d: any) => ({
        objectiveId: d.objectiveId,
        depth: d.depth,
        facet: "scope",
        outcome: "assisted",
        evidence: [artifact.seq],
        completeCheckpointScope: false,
        execution: "not-run",
        rationale:
          "Controlled assisted fixture, never real learner achievement",
      })),
      visitOutcome: "usable",
      scopeReviews: definitions.map((d: any) => ({
        id: d.id,
        completeCoverage: true,
        rationale: "Controlled complete scope",
      })),
      helpAttributions: packet.assistanceSources.map((m: any) => ({
        messageId: m.id,
        facets: ["*"],
        rationale: "Controlled supplied-help attribution",
      })),
    });
    expect((await continuation(assessedReceipt)).status).toBe("complete");
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as any).__deadAir.game.study.assessments.at(-1).status,
        ),
      )
      .toBe("applied");
    const evidence = await page.evaluate(
      () => (window as any).__deadAir.game.study.learner.evidence,
    );
    expect(evidence.length).toBeGreaterThan(0);
    expect(
      evidence.every(
        (ev: any) =>
          ev.outcome === "assisted" && ev.provider === "chatgpt-handoff",
      ),
    ).toBe(true);
    await save();
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__deadAir);
    const restored = await page.evaluate((id) => {
      const g = (window as any).__deadAir.game,
        e = g.encounters[id];
      return {
        keys: g.survivors[0].keys,
        evidence: g.study.learner.evidence,
        submissions: e.submissions.length,
        accepted: e.accepted,
      };
    }, id);
    expect(restored.evidence).toEqual(evidence);
    expect(restored.keys).toBe(1);
    expect(restored.submissions).toBe(1);
    expect(restored.accepted).toBe(completed.accepted);
    expect(q.snapshot().queued).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
