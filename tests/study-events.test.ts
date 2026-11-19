import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as settle } from "node:timers/promises";
import test from "node:test";
import { preparePracticeRooms } from "./helpers/practice-questions";
import { checkBridge, send } from "../src/ai";
import type { Roadmap } from "../src/model";
import { save } from "../src/persistence";
import { watchStudyEvents } from "../src/study-events";
import { createGame, createPlayableGame } from "./helpers/record";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));

type Logged = { type: string; data: Record<string, unknown> };
/** Collects what the study flow reports while `run` executes. */
async function watching(run: (events: Logged[]) => Promise<void>) {
  const events: Logged[] = [];
  watchStudyEvents((type, data) => events.push({ type, data }));
  try {
    await run(events);
  } finally {
    watchStudyEvents(undefined);
  }
}

test("a reply, a failed reply and a completion are each reported without the learner's words", () =>
  watching(async (events) => {
    const original = globalThis.fetch;
    let connected = false;
    let respond = async (): Promise<Response> =>
      Response.json({ text: "What changes?", complete: false });
    globalThis.fetch = async (url) =>
      String(url) === "/api/status"
        ? Response.json({
            mode: connected ? "claude-cli" : "development",
            label: "Synthetic",
            detail: "No real AI",
            capabilities: connected ? ["tutor"] : [],
          })
        : respond();
    try {
      await checkBridge();
      const g = createPlayableGame(717, r);
      preparePracticeRooms(g, r);
      const e = g.encounters["question-0"];
      e.mode = "solo";
      e.owner = "human";
      connected = true;
      await checkBridge();

      await send(g, e, "SECRET first answer", r);
      respond = async () => Response.json({ error: "outage" }, { status: 503 });
      await send(g, e, "SECRET second answer", r);
      respond = async () =>
        Response.json({ text: "Solved: all covered.", complete: true });
      await send(g, e, "SECRET final answer", r);
      await settle();

      const jobs = e.tutorRequests!;
      assert.deepEqual(
        events.map((x) => x.type).filter((t) => t !== "assessment-settled"),
        [
          "tutor-reply",
          "tutor-reply-failed",
          "question-completed",
          "tutor-reply",
        ],
      );
      assert.deepEqual(events[0].data, {
        encounter: e.id,
        request: jobs[0].id,
        complete: false,
      });
      assert.equal(events[1].data.request, jobs[1].id);
      assert.equal(typeof events[1].data.error, "string");
      assert.deepEqual(events[2].data, {
        encounter: e.id,
        submission: e.accepted,
      });
      assert.equal(events[3].data.complete, true);
      assert.doesNotMatch(JSON.stringify(events), /SECRET|Solved/);
    } finally {
      connected = false;
      await checkBridge();
      globalThis.fetch = original;
    }
  }));

test("a save that no longer fits the fallback copy is reported once, and again when it fits", () =>
  watching(async (events) => {
    let quota = 0;
    Object.defineProperty(globalThis, "indexedDB", {
      configurable: true,
      value: {
        open() {
          const req = {} as IDBOpenDBRequest;
          queueMicrotask(() => req.onerror?.call(req, new Event("error")));
          return req;
        },
      },
    });
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: (_key: string, value: string) => {
          if (value.length > quota)
            throw new DOMException("Synthetic quota", "QuotaExceededError");
        },
      },
    });
    const g = createGame(729, r);
    // The fallback copy refuses the save; IndexedDB is down too, so the save
    // itself fails, which is the caller's to report.
    await assert.rejects(save(g));
    await assert.rejects(save(g));
    quota = Infinity;
    await save(g);
    assert.deepEqual(
      events.map((x) => x.type),
      ["save-fallback-copy-failed", "save-fallback-copy-restored"],
    );
    assert.equal(typeof events[0].data.chars, "number");
    assert.match(String(events[0].data.error), /Synthetic quota/);
  }));
