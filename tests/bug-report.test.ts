import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  collapseRepeats,
  createBugReports,
} from "../scripts/bug-report-route.mjs";
import { buildClientReport } from "../src/bug-report";

const snapshot = (logs: string) => ({
  url: "http://127.0.0.1:5173/",
  userAgent: "test",
  viewport: "800×600 at 1x",
  view: "question",
  terminalOpen: true,
  connection: "claude-cli: ok",
  status: { save: "Saving study session…" },
  question: {
    title: "Late deliveries",
    provenance: "Claude CLI · Started in 4 earlier runs",
    state: "in-progress",
    prompt: "SECRET-PROMPT",
    messages: [{ kind: "human", author: "You", text: "SECRET-ANSWER" }],
    requests: [{ state: "interrupted", error: "timeout" }],
  },
  logs,
});
const logs = (entries: number) =>
  JSON.stringify({
    runs: [
      {
        id: "run-1",
        started: "2026-11-15",
        entries: Array.from({ length: entries }, (_, at) => ({
          at,
          type: "snapshot",
          data: "x".repeat(200),
        })),
        audit: { events: [{ type: "study-request", at: 1 }] },
      },
    ],
  });

test("the browser report carries hidden provenance and honours the opt-out", () => {
  const full = buildClientReport(snapshot(logs(3)), true);
  assert.match(full, /Started in 4 earlier runs/);
  assert.match(full, /SECRET-PROMPT/);
  assert.match(full, /interrupted \(timeout\)/);
  assert.match(full, /study-request/);
  const lean = buildClientReport(snapshot(logs(3)), false);
  assert.doesNotMatch(lean, /SECRET-PROMPT|SECRET-ANSWER/);
  assert.match(lean, /1 human/);
});

test("oversized diagnostics drop the oldest detail entries, never events", () => {
  const report = buildClientReport(snapshot(logs(2000)), true, 40_000);
  assert.ok(report.length < 60_000);
  assert.match(report, /older omitted for size/);
  assert.match(report, /"at":1999/);
  assert.doesNotMatch(report, /"at":0,/);
  assert.match(report, /study-request/);
  assert.match(buildClientReport(snapshot("{"), true), /could not be read/);
});

test("repeated crash blocks collapse to one copy and a count", () => {
  const block = ["Error: listen EADDRINUSE", "    at x", "Node.js v26"];
  assert.deepEqual(collapseRepeats([...block, ...block, ...block, "ok"]), [
    ...block,
    "… the previous 3 lines repeated 2 more times",
    "ok",
  ]);
  assert.deepEqual(collapseRepeats(["a", "b"]), ["a", "b"]);
});

async function withRoute(
  options: Record<string, unknown>,
  run: (
    post: (body: unknown, type?: string) => Promise<Response>,
  ) => Promise<void>,
) {
  const directory = join(mkdtempSync(join(tmpdir(), "bug-report-")), "out");
  const reports = createBugReports({ directory, ...options });
  const server = createServer(async (req, res) => {
    try {
      if (!(await reports.route(req, res))) res.writeHead(404).end();
    } catch (error) {
      res.writeHead((error as { status?: number }).status ?? 500).end();
    }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as { port: number };
  try {
    await run((body, type = "application/json") =>
      fetch(`http://127.0.0.1:${port}/api/bug-report`, {
        method: "POST",
        headers: { "Content-Type": type },
        body: JSON.stringify(body),
      }),
    );
  } finally {
    server.close();
  }
  return directory;
}

test("saving writes one private file and copies only its path", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bug-report-logs-"));
  const log = join(scratch, "service.log");
  writeFileSync(log, "boot\nboom\nboom\nboom\n");
  const usageLog = join(scratch, "usage.jsonl");
  writeFileSync(
    usageLog,
    `${JSON.stringify({ at: "t", operation: "generate", outcome: "rejected", durationMs: 1500 })}\nnot json\n`,
  );
  let tick = Date.UTC(2026, 10, 15);
  const directory = await withRoute(
    {
      usageLog,
      logs: [{ title: "Bridge log", path: log }],
      status: () => "connected",
      now: () => tick++,
      limits: { retention: 2 },
    },
    async (post) => {
      const saved = await (
        await post({
          mode: "save",
          description: "It broke",
          client: "## Browser",
        })
      ).json();
      assert.equal(saved.delivery, "file-pointer");
      const markdown = readFileSync(saved.savedPath, "utf8");
      assert.match(markdown, /It broke/);
      assert.match(markdown, /## Browser/);
      assert.match(markdown, /Claude connection: connected/);
      assert.match(markdown, /generate .*rejected .*1\.5/);
      assert.match(markdown, /boom\n… the previous line repeated 2 more times/);
      assert.match(saved.clipboardText, /It broke/);
      assert.ok(saved.clipboardText.includes(saved.savedPath));
      assert.doesNotMatch(saved.clipboardText, /## Browser/);
      for (let i = 0; i < 3; i++)
        await post({ mode: "save", description: "", client: "" });
      const rendered = await (
        await post({ mode: "render", description: "", client: "" })
      ).json();
      assert.match(rendered.markdown, /No description given/);
      assert.equal((await post({ mode: "save" })).status, 400);
      assert.equal(
        (
          await post(
            { mode: "save", description: "", client: "" },
            "text/plain",
          )
        ).status,
        415,
      );
    },
  );
  // Rendering saves nothing, and only the newest two reports are kept.
  assert.equal(readdirSync(directory).length, 2);
});

test("a usage log line that is valid JSON but not a row never fails the report", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "bug-report-usage-"));
  const usageLog = join(scratch, "usage.jsonl");
  writeFileSync(
    usageLog,
    `null\n7\n[1]\n${JSON.stringify({ at: "t", operation: "tutor", outcome: "accepted", durationMs: 2500 })}\n`,
  );
  await withRoute({ usageLog }, async (post) => {
    const response = await post({
      mode: "render",
      description: "",
      client: "",
    });
    assert.equal(response.status, 200);
    const { markdown } = await response.json();
    assert.match(markdown, /Newest 1 of the usage log; 0 did not end accepted/);
    assert.match(markdown, /tutor .*accepted .*2\.5/);
  });
});
