import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
// @ts-expect-error Self-contained local MCP server module.
import { createTerminalMcpApp } from "../../scripts/terminal-mcp-app.mjs";
// @ts-expect-error Self-contained local MCP server module.
import { createTerminalRelayApp } from "../../scripts/terminal-relay-app.mjs";
// @ts-expect-error Real local transport module.
import { createHandoffQueue } from "../../scripts/chatgpt-handoff-queue.mjs";
const html = readFileSync("public/terminal-mcp-app.html", "utf8");

// Every host fixture is synthetic, even if a real local bridge is running.
test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/status"
          ? {
              mode: "development",
              label: "Synthetic",
              detail: "No real AI",
              capabilities: [],
            }
          : {
              enabled: false,
              queued: 0,
              working: 0,
              done: 0,
              recent: [],
              public: { configured: false },
              tunnel: { state: "off", verified: false },
            },
    });
  });
});

test("MCP App host bridge starts separate conversation turns and refreshes one demo key without a polling worker", async ({
  page,
}) => {
  const app = createTerminalMcpApp(),
    grant = { linkId: "browser-synthetic" };
  const opened = app.call("open_study_terminal_demo", {}, grant);
  const prompts: string[] = [];
  await page.route("**/__terminal_app_test_rpc", async (route) => {
    const { name, args } = route.request().postDataJSON();
    try {
      await route.fulfill({ json: app.call(name, args, grant) });
    } catch (error) {
      await route.fulfill({
        json: {
          isError: true,
          content: [{ type: "text", text: String(error) }],
        },
      });
    }
  });
  await page.goto("/terminal-mcp-app.html");
  await page.evaluate(
    ({ html, opened }) => {
      document.body.replaceChildren();
      const frame = document.createElement("iframe");
      frame.id = "demo";
      frame.style.cssText = "width:100%;height:850px;border:0";
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow || !event.data?.method) return;
        const m = event.data;
        const send = (message: any) =>
          frame.contentWindow!.postMessage(message, "*");
        if (m.method === "ui/initialize") {
          send({
            jsonrpc: "2.0",
            id: m.id,
            result: { protocolVersion: "2026-01-26", hostCapabilities: {} },
          });
        } else if (m.method === "ui/notifications/initialized") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: opened,
          });
        } else if (m.method === "tools/call") {
          const r = await fetch("/__terminal_app_test_rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: m.params.name,
              args: m.params.arguments,
            }),
          });
          send({ jsonrpc: "2.0", id: m.id, result: await r.json() });
        } else if (m.method === "ui/message") {
          (window as any).hostMessages ??= [];
          (window as any).hostMessages.push(m.params);
          send({ jsonrpc: "2.0", id: m.id, result: {} });
        }
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, opened },
  );
  const ui = page.frameLocator("#demo");
  await expect(ui.locator("#answer")).toBeEnabled();
  await ui
    .locator("#answer")
    .fill("<img src=x onerror=alert('bad')> I think [2,3] is largest");
  await ui.locator("#answer").press("Enter");
  await expect(ui.locator("#status")).toContainText(
    "Message accepted by the host",
  );
  await expect(ui.locator("#send")).toBeDisabled();
  expect(await ui.locator("#messages img").count()).toBe(0);
  let s = app.call(
    "read_study_terminal_demo",
    { demoId: opened.structuredContent.demoId },
    grant,
  ).structuredContent;
  const first = s.pending.turnId;
  app.call(
    "reply_study_terminal_turn",
    {
      demoId: s.demoId,
      turnId: first,
      text: "What is its total?",
      complete: false,
    },
    grant,
  );
  await expect(ui.locator("#messages")).toContainText("What is its total?");
  await expect(ui.locator("#send")).toBeEnabled();
  await ui
    .locator("#answer")
    .fill(
      "5; subtract outgoing and add incoming. The window has two consecutive readings; stop before the incoming index reaches 3.",
    );
  await ui.locator("#answer").press("Enter");
  await expect(ui.locator("#status")).toContainText(
    "Message accepted by the host",
  );
  s = app.call(
    "read_study_terminal_demo",
    { demoId: s.demoId },
    grant,
  ).structuredContent;
  app.call(
    "reply_study_terminal_turn",
    {
      demoId: s.demoId,
      turnId: s.pending.turnId,
      text: "Solved",
      complete: true,
    },
    grant,
  );
  await expect(ui.locator("#keys")).toHaveText("1 demo key · solved");
  const sent = await page.evaluate(() => (window as any).hostMessages);
  expect(sent.length).toBe(2);
  for (const message of sent) {
    expect(message.role).toBe("user");
    expect(message.content[0].text).toMatch(/^@study\n/);
    prompts.push(message.content[0].text);
  }
  expect(prompts[1]).toContain("What is its total?");
  await page.screenshot({
    path: ".artifacts/terminal-mcp-app-harness.png",
    fullPage: true,
  });
});

test("a standalone browser refuses to pretend that a ChatGPT message bridge exists", async ({
  page,
}) => {
  await page.goto("/terminal-mcp-app.html");
  await expect(page.locator("#status")).toContainText(
    "ordinary browser tab has no ChatGPT message bridge",
  );
  await expect(page.locator("#send")).toBeDisabled();
});

test("live relay mode posts one @study turn per released game message and shows the reply without a polling worker", async ({
  page,
}) => {
  const queue = createHandoffQueue(),
    app = createTerminalRelayApp({ queue }),
    grant = { linkId: "browser-live-synthetic" };
  const opened = app.call("open_study_terminal", {}, grant);
  await page.route("**/__terminal_app_test_rpc", async (route) => {
    const { name, args } = route.request().postDataJSON();
    try {
      await route.fulfill({ json: app.call(name, args, grant) });
    } catch (error) {
      await route.fulfill({
        json: {
          isError: true,
          content: [{ type: "text", text: String(error) }],
        },
      });
    }
  });
  await page.goto("/terminal-mcp-app.html");
  await page.evaluate(
    ({ html, opened }) => {
      document.body.replaceChildren();
      const frame = document.createElement("iframe");
      frame.id = "live";
      frame.style.cssText = "width:100%;height:850px;border:0";
      (window as any).hostMessages = [];
      (window as any).toolCalls = [];
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow || !event.data?.method) return;
        const m = event.data;
        const send = (message: any) =>
          frame.contentWindow!.postMessage(message, "*");
        if (m.method === "ui/initialize") {
          send({
            jsonrpc: "2.0",
            id: m.id,
            result: { protocolVersion: "2026-01-26", hostCapabilities: {} },
          });
        } else if (m.method === "ui/notifications/initialized") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: opened,
          });
        } else if (m.method === "tools/call") {
          (window as any).toolCalls.push(m.params.name);
          const r = await fetch("/__terminal_app_test_rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: m.params.name,
              args: m.params.arguments,
            }),
          });
          send({ jsonrpc: "2.0", id: m.id, result: await r.json() });
        } else if (m.method === "ui/message") {
          (window as any).hostMessages.push(m.params);
          send({ jsonrpc: "2.0", id: m.id, result: {} });
        }
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, opened },
  );
  const ui = page.frameLocator("#live");
  await expect(ui.locator("#form")).toBeHidden();
  await expect(ui.locator("#question")).toBeHidden();
  await expect(ui.locator("#messages")).toBeHidden();
  await expect(ui.locator("#live-status")).toContainText("Release live study");
  const dialogue = (requestId: string, messages: any[]) => ({
    requestId,
    sessionId: "synthetic/e1/private",
    mode: "terminal-dialogue",
    responseFormat: { text: "string", complete: "boolean" },
    instruction: "@study: Continue this private puzzle conversation.",
    problem: {
      title: "SYNTHETIC LIVE RELAY · fixed window",
      prompt: "Readings are [1,2,3]; window of two. Largest total?",
      rubric: ["Largest total is 5", "Subtract outgoing, add incoming"],
    },
    workspace: "",
    draftRevision: 1,
    submissions: [],
    messages,
    executions: [],
    learning: { track: "PY" },
    studyPrompt: "@study",
    prompt: "@study\n" + messages.at(-1).text,
    curriculum: "Synthetic curriculum.",
    progressContext: "Synthetic progress.",
  });
  queue.enable(true);
  // The relay serves only turns whose game is still polling for the reply, so
  // this synthetic game polls each receipt the way the real client does.
  const receipts: { id: string; hash: string }[] = [];
  const polling = setInterval(() => {
    for (const r of receipts) queue.result(r.id, r.hash);
  }, 500);
  const release = (requestId: string, messages: any[]) => {
    const receipt = queue.enqueue("tutor", dialogue(requestId, messages));
    receipts.push(receipt);
    queue.result(receipt.id, receipt.hash);
    return receipt;
  };
  const first = release("synthetic-live-1", [
    {
      kind: "human",
      author: "human",
      text: "<img src=x onerror=alert('bad')> I think [2,3] is largest",
      seq: 1,
    },
  ]);
  await expect(ui.locator("#title")).toContainText("SYNTHETIC LIVE RELAY");
  await expect(ui.locator("#live-status")).toContainText(
    "Message accepted by the host",
  );
  expect(await ui.locator("#messages img").count()).toBe(0);
  await expect(ui.locator("#messages .user")).toHaveCount(1);
  let sent = await page.evaluate(() => (window as any).hostMessages);
  expect(sent.length).toBe(1);
  expect(sent[0].role).toBe("user");
  expect(sent[0].content[0].text).toMatch(/^@study\n/);
  expect(sent[0].content[0].text).toContain("Largest total is 5");
  expect(sent[0].content[0].text).toContain("reply_study_terminal_job");
  const relayId = opened.structuredContent.relayId;
  let s = app.call("read_study_terminal", { relayId }, grant).structuredContent;
  expect(s.turn.status).toBe("claimed");
  app.call(
    "reply_study_terminal_job",
    {
      relayId,
      turnId: s.turn.turnId,
      text: "What is its total?",
      complete: false,
    },
    grant,
  );
  await expect(ui.locator("#messages")).toContainText("What is its total?");
  await expect(ui.locator("#keys")).toHaveText("1 turn answered");
  expect(queue.result(first.id, first.hash).answer).toEqual({
    text: "What is its total?",
    complete: false,
  });
  await expect(ui.locator("#live-status")).toContainText(
    "Waiting for your next terminal message",
  );
  // The game sends the next message; the UI claims it and posts exactly one more turn.
  const second = release("synthetic-live-2", [
    {
      kind: "human",
      author: "human",
      text: "I think [2,3] is largest",
      seq: 1,
    },
    { kind: "tutor", author: "tutor", text: "What is its total?", seq: 2 },
    {
      kind: "human",
      author: "human",
      text: "5; subtract outgoing, add incoming; two readings; stop at the end.",
      seq: 3,
    },
  ]);
  await expect(ui.locator("#messages .user")).toHaveCount(2);
  await expect(ui.locator("#live-status")).toContainText(
    "Message accepted by the host",
  );
  sent = await page.evaluate(() => (window as any).hostMessages);
  expect(sent.length).toBe(2);
  expect(sent[1].content[0].text).toContain("stop at the end");
  s = app.call("read_study_terminal", { relayId }, grant).structuredContent;
  app.call(
    "reply_study_terminal_job",
    { relayId, turnId: s.turn.turnId, text: "Solved", complete: true },
    grant,
  );
  await expect(ui.locator("#live-status")).toContainText(
    "Completion sent to the game bridge",
  );
  await expect(ui.locator("#keys")).toHaveText("2 turns answered");
  expect(queue.result(second.id, second.hash).answer.complete).toBe(true);
  sent = await page.evaluate(() => (window as any).hostMessages);
  expect(sent.length).toBe(2);
  const calls: string[] = await page.evaluate(() => (window as any).toolCalls);
  expect(calls).not.toContain("get_study_handoff");
  expect(calls).not.toContain("stage_study_terminal_turn");
  clearInterval(polling);
  await page.screenshot({
    path: ".artifacts/terminal-relay-app-harness.png",
    fullPage: true,
  });
});

test("native live card delivers one question to ordinary chat and accepts only one final callback", async ({
  page,
}) => {
  const queue = createHandoffQueue();
  const app = createTerminalRelayApp({ queue });
  const grant = { linkId: "browser-native-synthetic" };
  const opened = app.call("open_study_terminal", {}, grant);
  await page.route("**/__terminal_app_test_rpc", async (route) => {
    const { name, args } = route.request().postDataJSON();
    try {
      await route.fulfill({ json: app.call(name, args, grant) });
    } catch (error) {
      await route.fulfill({
        json: {
          isError: true,
          content: [{ type: "text", text: String(error) }],
        },
      });
    }
  });
  await page.goto("/terminal-mcp-app.html");
  await page.evaluate(
    ({ html, opened }) => {
      document.body.replaceChildren();
      const frame = document.createElement("iframe");
      frame.id = "native";
      frame.style.cssText = "width:100%;height:850px;border:0";
      (window as any).hostMessages = [];
      (window as any).toolCalls = [];
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow || !event.data?.method) return;
        const m = event.data;
        const send = (message: any) =>
          frame.contentWindow!.postMessage(message, "*");
        if (m.method === "ui/initialize") {
          send({
            jsonrpc: "2.0",
            id: m.id,
            result: { protocolVersion: "2026-01-26", hostCapabilities: {} },
          });
        } else if (m.method === "ui/notifications/initialized") {
          send({
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params: opened,
          });
        } else if (m.method === "tools/call") {
          (window as any).toolCalls.push(m.params.name);
          const r = await fetch("/__terminal_app_test_rpc", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              name: m.params.name,
              args: m.params.arguments,
            }),
          });
          send({ jsonrpc: "2.0", id: m.id, result: await r.json() });
        } else if (m.method === "ui/message") {
          (window as any).hostMessages.push(m.params);
          send({ jsonrpc: "2.0", id: m.id, result: {} });
        }
      });
      frame.srcdoc = html;
      document.body.append(frame);
    },
    { html, opened },
  );

  const ui = page.frameLocator("#native");
  await expect(ui.locator("#form")).toBeHidden();
  await expect(ui.locator("#question")).toBeHidden();
  await expect(ui.locator("#messages")).toBeHidden();
  await expect(ui.locator("#intro")).toContainText("regular ChatGPT composer");
  queue.enable(true);
  const receipt = queue.enqueue("tutor", {
    requestId: "browser-native-question",
    sessionId: "browser-native-session",
    questionFingerprint: "browser-native-fingerprint",
    mode: "terminal-direct",
    probe: { facets: [{ id: "stale", description: "Ignore stale responses" }] },
    problem: {
      title: "SYNTHETIC NATIVE · async UI",
      prompt:
        "Two requests resolve out of order. How do you prevent stale results?",
      rubric: ["Latest request owns visible results"],
    },
    messages: [],
    guidance: "Feature ownership, bounded D1 reasoning.",
  });
  queue.result(receipt.id, receipt.hash);
  await expect
    .poll(() => page.evaluate(() => (window as any).hostMessages.length))
    .toBe(1);
  await expect(ui.locator("#live-status")).toContainText(
    "Answer in the regular ChatGPT chat",
  );
  const direct = app.call("get_current_study_question", {}, grant);
  expect(direct._meta?.ui).toBeUndefined();
  expect(direct.structuredContent.status).toBe("question");
  const turn = direct.structuredContent;
  const sent = await page.evaluate(() => (window as any).hostMessages);
  expect(sent[0].content[0].text).toContain(turn.turnId);
  expect(sent[0].content[0].text).toContain("finish_study_question");
  expect(sent[0].content[0].text).toContain(
    "Feature ownership, bounded D1 reasoning.",
  );
  const answer = {
    relayId: turn.relayId,
    turnId: turn.turnId,
    questionFingerprint: turn.questionFingerprint,
    text: "Completion sent for game validation.",
    outcome: "solved",
    transcript: [
      { role: "assistant", text: "How do you prevent stale results?" },
      {
        role: "user",
        text: "Keep a latest request ID and ignore stale responses.",
      },
    ],
    knowledge: { facets: [{ id: "stale", status: "demonstrated" }] },
  };
  const finished = app.call(
    "finish_study_question",
    answer,
    grant,
  ).structuredContent;
  expect(finished.completion.status).toBe("sent");
  expect(finished.completion.duplicate).toBe(false);
  expect(
    app.call("finish_study_question", answer, grant).structuredContent
      .completion.duplicate,
  ).toBe(true);
  await expect(ui.locator("#live-status")).toContainText(
    "Completion sent to the game bridge",
    { timeout: 10000 },
  );
  await expect(ui.locator("#keys")).toHaveText("1 turn answered");
  expect(queue.result(receipt.id, receipt.hash).answer.transcript).toEqual(
    answer.transcript,
  );
  expect(queue.snapshot().done).toBe(1);
  expect(await page.evaluate(() => (window as any).hostMessages.length)).toBe(
    1,
  );
  // Native tools may retrieve preparation while the optional card stays
  // open. Its status loop must retain that claim and never repost its prompt.
  const nativeScope = {
    runId: "browser-native-run",
    encounterId: "browser-native-next-station",
  };
  queue.enqueue(
    "generate",
    {
      requestId: "browser-native-next-preparation",
      encounterId: nativeScope.encounterId,
      contract: { track: "PY", objectiveIds: ["PY:fixture"], depth: 1 },
      curriculum: "Synthetic exact source rows",
    },
    nativeScope,
  );
  const prep = app.call(
    "get_current_study_question",
    {},
    grant,
  ).structuredContent;
  expect(prep.phase).toBe("prepare");
  await expect(ui.locator("#live-status")).toContainText(
    "preparing or reviewing",
  );
  expect(await page.evaluate(() => (window as any).hostMessages.length)).toBe(
    1,
  );
  expect(
    app.call("get_current_study_question", {}, grant).structuredContent.turnId,
  ).toBe(prep.turnId);
  const calls: string[] = await page.evaluate(() => (window as any).toolCalls);
  expect(calls).not.toContain("get_study_handoff");
  expect(calls).not.toContain("reply_study_terminal_job");
  expect(calls).not.toContain("stage_study_terminal_turn");
});
