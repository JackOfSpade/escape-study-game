import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { fallbackCatastrophe } from "../src/catastrophe";
import {
  CATASTROPHE_HISTORY_KEY,
  CATASTROPHE_HISTORY_LIMIT,
  catastropheSignature,
  parseCatastropheHistory,
  recentCatastrophes,
  rememberCatastrophe,
  repeatsRecent,
  summarizeCatastrophe,
} from "../src/catastrophe-history";
import type {
  Behaviour,
  CatastropheSpec,
  HunterBehaviour,
} from "../src/escape-types";

const store = new Map<string, string>();
let original: PropertyDescriptor | undefined;
beforeEach(() => {
  store.clear();
  original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, "localStorage", original);
  else Reflect.deleteProperty(globalThis, "localStorage");
});

const hunter = (
  silhouette: "humanoid" | "quadruped",
  spawn: "waves" | "single",
): HunterBehaviour => ({
  kind: "hunter",
  body: { color: "#334455", scale: 1, silhouette },
  count: 6,
  speed: 1,
  sightRange: 8,
  hearingWeight: 0.5,
  doors: "break",
  damage: 12,
  spawn,
});
const withBehaviours = (title: string, behaviours: Behaviour[]) =>
  ({ ...fallbackCatastrophe(3, "dorm"), title, behaviours }) as CatastropheSpec;

test("the signature is sorted kinds plus hunter silhouette and spawn", () => {
  const a = summarizeCatastrophe(
    withBehaviours("The Hollow Men", [
      hunter("humanoid", "waves"),
      {
        kind: "collapse",
        targets: ["power"],
        cadence: 60,
      },
    ]),
  );
  const renamed = summarizeCatastrophe(
    withBehaviours("The Pale Walkers", [
      { kind: "collapse", targets: ["doors"], cadence: 90 },
      {
        ...hunter("humanoid", "waves"),
        body: { color: "#ff0000", scale: 2, silhouette: "humanoid" },
      },
    ]),
  );
  assert.equal(catastropheSignature(a), "collapse+hunter|humanoid/waves");
  assert.equal(catastropheSignature(a), catastropheSignature(renamed));
  const other = summarizeCatastrophe(
    withBehaviours("Something", [hunter("quadruped", "single")]),
  );
  assert.notEqual(catastropheSignature(a), catastropheSignature(other));
});

test("repeatsRecent looks only at the newest three", () => {
  const target = summarizeCatastrophe(
    withBehaviours("A", [hunter("humanoid", "waves")]),
  );
  const filler = (title: string) =>
    summarizeCatastrophe(
      withBehaviours(title, [hunter("quadruped", "single")]),
    );
  assert.equal(repeatsRecent(target, [filler("1"), filler("2"), target]), true);
  assert.equal(
    repeatsRecent(target, [filler("1"), filler("2"), filler("3"), target]),
    false,
  );
});

test("history keeps the newest eight and never stores premise text", () => {
  for (let i = 0; i < 11; i++)
    rememberCatastrophe(
      withBehaviours(`Catastrophe ${i}`, [hunter("humanoid", "waves")]),
    );
  const recent = recentCatastrophes();
  assert.equal(recent.length, CATASTROPHE_HISTORY_LIMIT);
  assert.equal(recent[0]!.title, "Catastrophe 10");
  assert.equal(recent[7]!.title, "Catastrophe 3");
  const spec = fallbackCatastrophe(3, "dorm");
  rememberCatastrophe(spec);
  const raw = store.get(CATASTROPHE_HISTORY_KEY)!;
  assert.equal(raw.includes(spec.premise), false);
  assert.equal(raw.includes(spec.publicStory), false);
  assert.equal(raw.includes(spec.omens[0]!.text), false);
  assert.deepEqual(Object.keys(JSON.parse(raw)[0]).sort(), [
    "hunters",
    "kinds",
    "media",
    "title",
    "triggers",
  ]);
});

test("stored history is read defensively", () => {
  store.set(CATASTROPHE_HISTORY_KEY, "not json");
  assert.deepEqual(recentCatastrophes(), []);
  const good = summarizeCatastrophe(
    withBehaviours("Good", [hunter("humanoid", "waves")]),
  );
  assert.deepEqual(
    parseCatastropheHistory([
      { ...good, premise: "secret truth" },
      {
        title: "Bad",
        kinds: ["teleport"],
        hunters: [],
        media: [],
        triggers: [],
      },
      "junk",
    ]),
    [good],
  );
  Reflect.deleteProperty(globalThis, "localStorage");
  assert.deepEqual(recentCatastrophes(), []);
  rememberCatastrophe(fallbackCatastrophe(3, "dorm")); // must not throw
});
