import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as settle } from "node:timers/promises";
import test from "node:test";
import type { Roadmap } from "../src/model";
import { decode, encode, save } from "../src/persistence";
import { createGame } from "../src/world";

const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
test("a background checkpoint skips the local mirror, reaches IndexedDB and falls back if that fails", async () => {
  const puts: string[] = [],
    writes: IDBTransaction[] = [],
    values = new Map<string, string>();
  let setItemCalls = 0;
  const db = {
    transaction() {
      const tx = {} as IDBTransaction;
      Object.assign(tx, {
        objectStore() {
          return {
            put(value: string) {
              puts.push(value);
              writes.push(tx);
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
        setItemCalls++;
        values.set(key, value);
      },
    },
  });
  const g = createGame(729, r);
  const durable = save(g, { background: true });
  await settle();
  assert.equal(setItemCalls, 0, "an autosave must not block on localStorage");
  assert.equal(writes.length, 1);
  assert.equal(decode(JSON.parse(puts[0]).data).seed, g.seed);
  // The expensive design re-check is skipped only for autosaves, and the
  // loader still rejects a checkpoint that would have failed it.
  const tampered = createGame(730, r);
  tampered.floors[0].design = {} as never;
  assert.throws(() => encode(tampered));
  assert.throws(() => decode(encode(tampered, { revalidate: false })));
  writes[0].oncomplete?.call(writes[0], new Event("complete"));
  await durable;
  assert.equal(setItemCalls, 0);

  const failing = save(g, { background: true });
  await settle();
  writes[1].onabort?.call(writes[1], new Event("abort"));
  await failing;
  assert.equal(setItemCalls, 1, "a failed durable write still lands locally");

  const explicit = save(g);
  assert.equal(setItemCalls, 2, "explicit saves keep their synchronous mirror");
  await settle();
  writes[2].oncomplete?.call(writes[2], new Event("complete"));
  await explicit;
});
