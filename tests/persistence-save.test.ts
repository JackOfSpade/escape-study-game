import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as settle } from "node:timers/promises";
import test from "node:test";
import type { Roadmap } from "../src/model";
import { decode, load, save } from "../src/persistence";
import { createGame } from "./helpers/record";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
test("a failed older durable write cannot overwrite a newer successful local checkpoint", async () => {
  const writes: IDBTransaction[] = [],
    values = new Map<string, string>();
  const db = {
    transaction() {
      const tx = {} as IDBTransaction;
      Object.assign(tx, {
        objectStore() {
          return {
            put() {
              writes.push(tx);
            },
            get() {
              const req = { result: undefined } as IDBRequest;
              queueMicrotask(() => {
                req.onsuccess?.call(req, new Event("success"));
                tx.oncomplete?.call(tx, new Event("complete"));
              });
              return req;
            },
          };
        },
      });
      return tx;
    },
  };
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open() {
        const req = { result: db } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => req.onsuccess?.call(req, new Event("success")));
        return req;
      },
    },
  });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (value.length >= 1_000_000)
          throw new DOMException("Synthetic local quota", "QuotaExceededError");
        values.set(key, value);
      },
    },
  });
  const g = createGame(728, r),
    e = g.encounters["question-0"];
  // This browser's local quota rejects the large checkpoint. A later compact
  // checkpoint can still be written while the first durable transaction is held.
  e.workspace = "Synthetic older content ".repeat(60_000);
  const older = save(g);
  await settle();
  assert.equal(writes.length, 1);
  assert.equal(values.size, 0);
  e.workspace = "Synthetic newest human draft";
  const newest = save(g);
  assert.equal(values.size, 1);
  writes[0].onabort?.call(writes[0], new Event("abort"));
  await older;
  await settle();
  assert.equal(writes.length, 2);
  writes[1].onabort?.call(writes[1], new Event("abort"));
  await newest;
  const local = JSON.parse([...values.values()][0]);
  assert.ok(
    decode(local.data).encounters[e.id].workspace ===
      "Synthetic newest human draft",
    "An older fallback replaced the newest human draft",
  );
  assert.equal((await load())!.encounters[e.id].workspace, e.workspace);
});
