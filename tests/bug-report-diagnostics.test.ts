import assert from "node:assert/strict";
import test from "node:test";
import { buildClientReport } from "../src/bug-report";

const snapshot = (logs: string) => ({
  url: "http://127.0.0.1:5173/",
  userAgent: "test",
  viewport: "800×600 at 1x",
  view: "map",
  terminalOpen: false,
  connection: "claude-cli: ok",
  status: {},
  logs,
});

test("damaged stored diagnostics never stop a report being built", () => {
  const damaged = JSON.stringify({
    runs: [
      null,
      "not a run",
      { id: "run-odd", started: 1, entries: "lost", audit: "lost" },
      { id: "run-events", started: 2, audit: { events: { length: 3 } } },
      {
        id: "run-good",
        started: 3,
        entries: [{ at: 7, type: "kept-entry" }],
        audit: { events: [{ type: "kept-event" }] },
      },
    ],
  });
  const report = buildClientReport(snapshot(damaged), true);
  assert.match(report, /Run run-good/);
  assert.match(report, /kept-entry/);
  assert.match(report, /kept-event/);
  assert.match(report, /Run run-odd/);
  assert.match(report, /Run run-events/);
  assert.match(
    buildClientReport(snapshot(JSON.stringify({ runs: [null, 4] })), true),
    /No runs recorded/,
  );
});
