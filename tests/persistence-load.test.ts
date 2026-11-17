import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setImmediate as settle } from "node:timers/promises";
import test from "node:test";
import type { Roadmap } from "../src/model";
import {
  decode,
  encode,
  exportRecoveryBackup,
  load,
  rejectedCopy,
  save,
} from "../src/persistence";
import { createGame } from "./helpers/record";

const roadmap: Roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
);
const copies = {
  durable: null as string | null,
  local: null as string | null,
  durableError: false,
  localError: false,
};
const writes: { transaction: IDBTransaction; value: string }[] = [];
const db = {
  transaction(_store: string, mode: IDBTransactionMode) {
    const tx = {} as IDBTransaction;
    Object.assign(tx, {
      objectStore() {
        return {
          get() {
            const request = { result: copies.durable } as IDBRequest;
            queueMicrotask(() => {
              if (copies.durableError) {
                Object.assign(tx, {
                  error: new DOMException(
                    "Synthetic disk error",
                    "UnknownError",
                  ),
                });
                tx.onabort?.call(tx, new Event("abort"));
              } else {
                request.onsuccess?.call(request, new Event("success"));
                tx.oncomplete?.call(tx, new Event("complete"));
              }
            });
            return request;
          },
          put(value: string) {
            assert.equal(mode, "readwrite");
            writes.push({ transaction: tx, value });
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
      const request = { result: db } as unknown as IDBOpenDBRequest;
      queueMicrotask(() =>
        request.onsuccess?.call(request, new Event("success")),
      );
      return request;
    },
  },
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem() {
      if (copies.localError)
        throw new DOMException("Synthetic policy denial", "SecurityError");
      return copies.local;
    },
    setItem(_key: string, value: string) {
      copies.local = value;
    },
  },
});

test("unreadable storage is not mistaken for an empty save", async () => {
  copies.durableError = true;
  await assert.rejects(load(), /could not be read/);
  copies.durableError = false;
  copies.localError = true;
  await assert.rejects(load(), /could not be read/);
  copies.durableError = true;
  await assert.rejects(load(), /could not be read/);
  copies.durableError = copies.localError = false;
  assert.equal(await load(), null);
});

test("an unreadable store cannot silently replace newer work with the other valid copy", async () => {
  const g = createGame(729, roadmap);
  copies.local = encode(g);
  copies.durableError = true;
  await assert.rejects(load(), /could not be read/);
  assert.equal(JSON.parse(await exportRecoveryBackup()).local, copies.local);
  copies.durableError = false;
  copies.durable = copies.local;
  copies.localError = true;
  await assert.rejects(load(), /could not be read/);
  assert.equal(
    JSON.parse(await exportRecoveryBackup()).durable,
    copies.durable,
  );
  copies.localError = false;
  copies.durable = copies.local = null;
});

test("recovery export preserves damaged bytes and reports unreadable copies", async () => {
  copies.local = "";
  await assert.rejects(load(), /integrity checks/);
  copies.local = null;
  copies.durable = "";
  await assert.rejects(load(), /integrity checks/);
  copies.local = "synthetic damaged local save";
  copies.durable = "synthetic damaged durable save";
  await assert.rejects(load(), /integrity checks/);
  const backup = JSON.parse(await exportRecoveryBackup());
  assert.equal(backup.format, "dead-air-recovery-v1");
  assert.equal(backup.local, copies.local);
  assert.equal(backup.durable, copies.durable);
  copies.durableError = true;
  const partial = JSON.parse(await exportRecoveryBackup());
  assert.equal(partial.local, copies.local);
  assert.equal(partial.durable, null);
  assert.match(partial.durableError, /Synthetic disk error/);
  copies.durableError = false;
  copies.durable = copies.local = null;
});

test("a copy refused while the other loads is reported with its exact bytes", async () => {
  const g = createGame(731, roadmap);
  const good = JSON.stringify({ format: 2, serial: 5, data: encode(g) });
  copies.durable = copies.local = good;
  assert.equal((await load())!.id, g.id);
  assert.equal(rejectedCopy(), undefined, "two valid copies refuse nothing");
  // The damaged copy could be the newer checkpoint: its serial is unreadable.
  copies.durable = `${good.slice(0, -40)}synthetic damage`;
  assert.equal((await load())!.id, g.id);
  assert.deepEqual(
    { store: rejectedCopy()?.store, raw: rejectedCopy()?.raw },
    { store: "durable", raw: copies.durable },
  );
  assert.ok(rejectedCopy()!.reason);
  copies.durable = good;
  copies.local = "synthetic damaged local save";
  assert.equal((await load())!.id, g.id);
  assert.equal(rejectedCopy()?.store, "local");
  assert.equal(rejectedCopy()?.raw, "synthetic damaged local save");
  // Nothing loaded at all is the existing integrity failure, not a notice.
  copies.durable = "synthetic damaged durable save";
  await assert.rejects(load(), /integrity checks/);
  assert.equal(rejectedCopy(), undefined);
  copies.durable = copies.local = null;
  assert.equal(await load(), null);
  assert.equal(rejectedCopy(), undefined);
});

test("a draft larger than one megabyte has a full synchronous checkpoint before its durable write settles", async () => {
  const g = createGame(730, roadmap),
    e = g.encounters["question-0"];
  e.workspace = "Synthetic unfinished answer ".repeat(45_000);
  const pending = save(g);
  assert.ok(copies.local && copies.local.length > 1_000_000);
  const stored = JSON.parse(copies.local);
  assert.equal(decode(stored.data).encounters[e.id].workspace, e.workspace);
  assert.equal(writes.length, 0, "the synchronous copy precedes any IDB work");
  await settle();
  assert.equal(writes.length, 1);
  // Termination before IDB commit must leave a coherent complete recovery copy.
  assert.equal((await load())!.encounters[e.id].workspace, e.workspace);
  writes[0].transaction.onabort?.call(
    writes[0].transaction,
    new Event("abort"),
  );
  await pending;
});
