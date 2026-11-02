import { expect, test } from "@playwright/test";
// @ts-expect-error Real transport modules, isolated synthetic queue only.
import { createHandoffQueue } from "../../scripts/chatgpt-handoff-queue.mjs";
// @ts-expect-error Real OAuth-bound native relay, synthetic owner only.
import * as terminalRelay from "../../scripts/terminal-relay-app.mjs";
import {
  enterNativeGame,
  nativeState,
  openNativeQuestion,
} from "./native-study-harness";
const { createTerminalRelayApp, DIRECT_TURN_INSTRUCTION } = terminalRelay;

test("ordinary chat sends one native completion through the real relay and the game awards one key", async ({
  page,
}) => {
  const queue = createHandoffQueue();
  const app = createTerminalRelayApp({ queue });
  const grant = { linkId: "browser-native-roundtrip-owner" };
  queue.enable(true);
  const calls: any[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    const json = (body: unknown, status = 200) =>
      route.fulfill({ status, json: body });
    if (url.pathname === "/api/status")
      return json({
        mode: "chatgpt-handoff",
        label: "Synthetic native relay",
        detail: "No live connector or model",
        capabilities: ["tutor", "direct-study"],
      });
    if (url.pathname === "/api/bridge") {
      const body = request.postDataJSON();
      calls.push(body);
      expect(body.operation).toBe("tutor");
      expect(body.payload.mode).toBe("terminal-direct");
      return json(
        { handoff: queue.enqueue(body.operation, body.payload) },
        202,
      );
    }
    if (url.pathname === "/api/bridge/result") {
      const value = queue.result(
        url.searchParams.get("id"),
        url.searchParams.get("hash"),
      );
      return value.status === "done"
        ? json(value.answer)
        : json({ status: "pending" }, 202);
    }
    if (url.pathname === "/api/handoff/status")
      return json({
        ...queue.snapshot(),
        public: { terminalRelay: app.status(), workerActive: false },
      });
    return json({ error: "Unexpected synthetic endpoint" }, 404);
  });
  await enterNativeGame(page);
  const id = await openNativeQuestion(page);
  await expect.poll(() => calls.length).toBe(1);
  await expect
    .poll(
      () =>
        app.call("get_current_study_question", {}, grant).structuredContent
          .status,
    )
    .toBe("question");
  const turn = app.call(
    "get_current_study_question",
    {},
    grant,
  ).structuredContent;
  const payload = calls[0].payload;
  expect(turn.questionFingerprint).toBe(payload.questionFingerprint);
  expect(
    JSON.parse(turn.prompt.slice(DIRECT_TURN_INSTRUCTION.length)).question
      .prompt,
  ).toBe(payload.problem.prompt);
  expect(turn.prompt).toContain("ordinary ChatGPT composer");
  expect(payload).not.toHaveProperty("curriculum");
  expect(payload).not.toHaveProperty("progressContext");
  const before = await nativeState(page, id);
  expect(before.submissions).toBe(0);
  expect(before.tutor.filter((m: any) => m.kind === "human")).toHaveLength(0);
  await expect(page.locator("#terminal")).toBeHidden();
  await expect(page.locator("#chat-input")).toBeHidden();
  const transcript = [
    { role: "assistant", text: payload.problem.prompt },
    { role: "user", text: "Synthetic first prediction in ordinary chat." },
    {
      role: "assistant",
      text: "Synthetic focused follow-up, assistance only.",
    },
    {
      role: "user",
      text: "Synthetic complete explanation of the issued question.",
    },
  ];
  // Intermediate ordinary chat turns cause no bridge request or learner
  // evidence in the game. Only the final attributed callback crosses over.
  expect(calls).toHaveLength(1);
  expect(
    (await nativeState(page, id)).tutor.filter((m: any) => m.kind === "human"),
  ).toHaveLength(0);
  const args = {
    relayId: turn.relayId,
    turnId: turn.turnId,
    questionFingerprint: turn.questionFingerprint,
    text: "Synthetic completion sent for validation.",
    outcome: "solved",
    transcript,
    knowledge: {
      facets: payload.probe.facets.map((f: any) => ({
        id: f.id,
        status: "demonstrated",
      })),
    },
  };
  const receipt = app.call("finish_study_question", args, grant)
    .structuredContent.completion;
  expect(receipt.status).toBe("sent");
  expect(receipt.duplicate).toBe(false);
  await expect
    .poll(async () => (await nativeState(page, id)).session.state)
    .toBe("applied");
  const after = await nativeState(page, id);
  expect(after.keys).toBe(before.keys + 1);
  expect(after.submissions).toBe(1);
  expect(after.state).toBe("consumed");
  expect(
    after.tutor.filter((m: any) => m.kind === "human").map((m: any) => m.text),
  ).toEqual([transcript[1].text, transcript[3].text]);
  expect(
    after.tutor.every(
      (m: any) => m.provenance === "chatgpt-host-model-transcript",
    ),
  ).toBe(true);
  expect(
    app.call("finish_study_question", args, grant).structuredContent.completion
      .duplicate,
  ).toBe(true);
  expect(calls).toHaveLength(1);
  expect((await nativeState(page, id)).keys).toBe(after.keys);
  expect(queue.snapshot().done).toBe(1);
  expect(errors).toEqual([]);
});
