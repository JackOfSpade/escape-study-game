import assert from "node:assert/strict";
import test from "node:test";
import { designArea } from "../src/area-design";
import type { AreaStub } from "../src/escape-types";
import type { Roadmap } from "../src/model";
import type { QualityConceptsRequest } from "../src/run-quality-contract.mjs";

// The pipeline stops at its first stage here, so the roadmap is never used.
const roadmap = {} as Roadmap;

const stub: AreaStub = {
  id: "rocket-interior",
  name: "Sounding rocket",
  brief: "The cramped interior of a sounding rocket.",
  state: "stub",
  seed: 7,
  plan: {
    name: "Sounding rocket interior",
    premise: "A two-deck sounding rocket, still fuelled, waiting on its pad.",
    rooms: [],
    people: [],
  },
};

test("designArea propagates the first stage failure without storing a draft", async () => {
  const writes: string[] = [];
  const store = new Map<string, string>();
  const previous = Reflect.get(globalThis, "localStorage");
  Reflect.set(globalThis, "localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      writes.push(key);
      store.set(key, value);
    },
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  });
  try {
    await assert.rejects(
      designArea(stub, {
        roadmap,
        signal: new AbortController().signal,
        send: async () => {
          throw Error("concepts stage failed");
        },
      }),
      /concepts stage failed/,
    );
    assert.deepEqual(writes, []);
  } finally {
    if (previous === undefined)
      Reflect.deleteProperty(globalThis, "localStorage");
    else Reflect.set(globalThis, "localStorage", previous);
  }
});

test("the place brief reaches the first request sent", async () => {
  let captured: QualityConceptsRequest | undefined;
  await assert.rejects(
    designArea(stub, {
      roadmap,
      signal: new AbortController().signal,
      send: async (request) => {
        captured = request as QualityConceptsRequest;
        throw Error("stop after capture");
      },
    }),
    /stop after capture/,
  );
  assert.ok(captured);
  assert.equal(captured.phase, "concepts");
  assert.deepEqual(captured.place, {
    name: "Sounding rocket interior",
    brief: "A two-deck sounding rocket, still fuelled, waiting on its pad.",
  });
});
