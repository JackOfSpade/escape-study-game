import assert from "node:assert/strict";
import { test } from "node:test";
import { settleRequest } from "../src/terminal-request";

test("a settled terminal request saves and repaints once", async () => {
  const e: { error?: string } = {};
  let done = 0;
  await settleRequest(Promise.resolve("reply"), e, () => done++);
  assert.equal(done, 1);
  assert.equal(e.error, undefined);
});

test("a terminal request that throws still saves and repaints, and shows why", async () => {
  const e: { error?: string } = {};
  let done = 0;
  const unhandled: unknown[] = [];
  const note = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", note);
  await settleRequest(
    Promise.reject(Error("relay closed mid-reply")),
    e,
    () => done++,
  );
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", note);
  assert.equal(done, 1);
  assert.equal(e.error, "Error: relay closed mid-reply");
  assert.deepEqual(unhandled, []);
});
