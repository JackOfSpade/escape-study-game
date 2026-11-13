import assert from "node:assert/strict";
import { test } from "node:test";
import {
  commitFact,
  currentFacts,
  durableFacts,
  emptyLedger,
  factById,
  factDigest,
  factsVisibleTo,
  journalLines,
  knows,
  learn,
  supersede,
  type FactInput,
} from "../src/fact-ledger";

const baseFact = (over: Partial<FactInput> = {}): FactInput => ({
  text: "Rocket hatch needs a flight-crew badge.",
  subject: { kind: "object", id: "rocket-hatch" },
  source: "design",
  visibility: ["public"],
  ...over,
});

test("emptyLedger is empty and ids sequence per ledger", () => {
  const l = emptyLedger();
  assert.deepEqual({ ...l }, { facts: [], journal: [], seq: 0 });
  // fresh arrays each call
  assert.notEqual(emptyLedger().facts, l.facts);
  assert.notEqual(emptyLedger().journal, l.journal);
  const a = commitFact(l, baseFact(), 1);
  const b = commitFact(l, baseFact({ text: "  Door is jammed.  " }), 2);
  assert.equal(a.id, "f1");
  assert.equal(b.id, "f2");
  assert.equal(b.text, "Door is jammed.");
  assert.equal(l.seq, 2);
  assert.deepEqual(
    l.facts.map((f) => f.id),
    ["f1", "f2"],
  );
  // a rejected commit must not consume an id or append a fact
  assert.throws(() => commitFact(l, baseFact({ text: "   " }), 3), {
    message: "fact text is empty",
  });
  assert.equal(l.seq, 2);
  assert.equal(l.facts.length, 2);
  assert.equal(commitFact(l, baseFact(), 4).id, "f3");
});

test("commitFact rejects every invalid input without writing", () => {
  const l = emptyLedger();
  assert.throws(() => commitFact(l, baseFact({ text: "" }), 1), {
    message: "fact text is empty",
  });
  assert.throws(() => commitFact(l, baseFact({ text: "   \n\t " }), 1), {
    message: "fact text is empty",
  });
  assert.throws(() => commitFact(l, baseFact({ text: "x".repeat(281) }), 1), {
    message: "fact text is longer than 280 characters",
  });
  assert.throws(() => commitFact(l, baseFact({ visibility: [] }), 1), {
    message: "fact needs at least one visibility entry",
  });
  for (const bad of [
    "secret",
    "",
    "npc:",
    "role:",
    "document:",
    "area:",
    "public:x",
    "hidden:x",
    "team:red",
    "npc",
  ]) {
    assert.throws(
      () => commitFact(l, baseFact({ visibility: [bad as never] }), 1),
      { message: `invalid visibility entry: ${bad}` },
    );
  }
  assert.throws(
    () => commitFact(l, baseFact({ visibility: ["hidden", "public"] }), 1),
    { message: "hidden visibility cannot be combined with other entries" },
  );
  assert.throws(
    () =>
      commitFact(
        l,
        baseFact({ visibility: ["hidden", "npc:ortiz", "document:map"] }),
        1,
      ),
    { message: "hidden visibility cannot be combined with other entries" },
  );
  for (const at of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    assert.throws(() => commitFact(l, baseFact(), at), {
      message: "fact time is not finite",
    });
  }
  assert.deepEqual({ ...l }, { facts: [], journal: [], seq: 0 });
  // 280 characters is allowed
  const long = commitFact(l, baseFact({ text: "y".repeat(280) }), 0);
  assert.equal(long.text.length, 280);
  assert.equal(long.id, "f1");
});

test("supersede keeps history and never rewrites the old fact", () => {
  const l = emptyLedger();
  const old = commitFact(l, baseFact({ text: "Hatch is shut." }), 1);
  assert.equal(old.supersededBy, undefined);
  const fresh = supersede(
    l,
    old.id,
    baseFact({ text: "Hatch is jammed open." }),
    5,
  );
  assert.equal(fresh.id, "f2");
  assert.equal(old.text, "Hatch is shut.");
  assert.equal(old.visibility.length, 1);
  assert.equal(old.supersededBy, "f2");
  assert.equal(fresh.supersededBy, undefined);
  assert.equal(factById(l, "f1"), old);
  assert.deepEqual(
    currentFacts(l).map((f) => f.id),
    ["f2"],
  );
  assert.deepEqual(
    l.facts.map((f) => f.id),
    ["f1", "f2"],
  );
  assert.equal(l.seq, 2);

  assert.throws(() => supersede(l, "f99", baseFact(), 6), {
    message: "unknown fact: f99",
  });
  assert.throws(() => supersede(l, "f1", baseFact({ text: "Third." }), 7), {
    message: "fact f1 is already superseded by f2",
  });
  // failed supersedes change nothing
  assert.equal(l.seq, 2);
  assert.equal(l.facts.length, 2);
  assert.equal(old.supersededBy, "f2");

  // a later fact can itself be superseded; the chain is kept
  const third = supersede(
    l,
    "f2",
    baseFact({ text: "Hatch is welded shut." }),
    8,
  );
  assert.equal(third.id, "f3");
  assert.equal(factById(l, "f2")!.supersededBy, "f3");
  assert.equal(old.supersededBy, "f2");
  assert.deepEqual(
    currentFacts(l).map((f) => f.id),
    ["f3"],
  );
  assert.equal(factById(l, "nope"), undefined);
});

test("factsVisibleTo applies the OR matrix and never shows hidden facts", () => {
  const l = emptyLedger();
  const pub = commitFact(l, baseFact({ visibility: ["public"] }), 1);
  const sealed = commitFact(l, baseFact({ visibility: ["hidden"] }), 2);
  const npc = commitFact(l, baseFact({ visibility: ["npc:ortiz"] }), 3);
  const role = commitFact(l, baseFact({ visibility: ["role:Guard"] }), 4);
  const area = commitFact(l, baseFact({ visibility: ["area:dock"] }), 5);
  const doc = commitFact(l, baseFact({ visibility: ["document:manifest"] }), 6);
  const multi = commitFact(
    l,
    baseFact({ visibility: ["role:engineer", "document:manifest"] }),
    7,
  );
  const other = commitFact(l, baseFact({ visibility: ["npc:chen"] }), 8);
  const ids = (
    viewer: Parameters<typeof factsVisibleTo>[1],
    options?: Parameters<typeof factsVisibleTo>[2],
  ) => factsVisibleTo(l, viewer, options).map((f) => f.id);

  assert.deepEqual(ids({}), ["f1"]);
  assert.deepEqual(ids({ documents: [] }), ["f1"]);
  assert.deepEqual(ids({ npcId: "ortiz" }), ["f1", "f3"]);
  // npc ids are compared exactly
  assert.deepEqual(ids({ npcId: "Ortiz" }), ["f1"]);
  // roles are compared case-insensitively
  assert.deepEqual(ids({ role: "guard" }), ["f1", "f4"]);
  assert.deepEqual(ids({ role: "GUARD" }), ["f1", "f4"]);
  assert.deepEqual(ids({ role: "guardsman" }), ["f1"]);
  assert.deepEqual(ids({ role: "" }), ["f1"]);
  assert.deepEqual(ids({ areaId: "dock" }), ["f1", "f5"]);
  assert.deepEqual(ids({ areaId: "dock", documents: ["manifest"] }), [
    "f1",
    "f5",
    "f6",
    "f7",
  ]);
  assert.deepEqual(ids({ documents: ["manifest"] }), ["f1", "f6", "f7"]);
  assert.deepEqual(ids({ documents: ["nap"] }), ["f1"]);
  assert.deepEqual(ids({ documents: ["manifest", "nap"] }), ["f1", "f6", "f7"]);
  // any single entry is enough
  assert.deepEqual(ids({ npcId: "ortiz", role: "engineer" }), [
    "f1",
    "f3",
    "f7",
  ]);
  assert.deepEqual(
    ids({
      npcId: "ortiz",
      role: "GUARD",
      areaId: "dock",
      documents: ["manifest"],
    }),
    ["f1", "f3", "f4", "f5", "f6", "f7"],
  );
  assert.deepEqual(
    factsVisibleTo(l, {
      npcId: "ortiz",
      role: "GUARD",
      areaId: "dock",
      documents: ["manifest"],
    }),
    [pub, npc, role, area, doc, multi],
  );
  // the sealed fact and unrelated addressees never match
  assert.deepEqual(ids({ npcId: "chen" }), ["f1", "f8"]);
  assert.equal(factsVisibleTo(l, { npcId: "chen" })[0], pub);
  assert.equal(other.visibility.includes("hidden"), false);

  // superseded facts are excluded unless asked for; hidden stays out either way
  supersede(
    l,
    area.id,
    baseFact({ text: "Dock doors are now sealed.", visibility: ["area:dock"] }),
    9,
  );
  assert.deepEqual(ids({ areaId: "dock" }), ["f1", "f9"]);
  assert.deepEqual(ids({ areaId: "dock" }, { includeSuperseded: true }), [
    "f1",
    "f5",
    "f9",
  ]);
  assert.deepEqual(
    ids(
      {
        npcId: "ortiz",
        role: "guard",
        areaId: "dock",
        documents: ["manifest"],
      },
      { includeSuperseded: true },
    ),
    ["f1", "f3", "f4", "f5", "f6", "f7", "f9"],
  );
  assert.equal(
    factsVisibleTo(l, { npcId: "ortiz" }, { includeSuperseded: true }).some(
      (f) => f === sealed,
    ),
    false,
  );
  assert.equal(factById(l, "f5"), area);
  assert.equal(area.supersededBy, "f9");
});

test("learn is idempotent and rejects hidden and unknown facts", () => {
  const l = emptyLedger();
  const fact = commitFact(l, baseFact(), 1);
  const sealed = commitFact(l, baseFact({ visibility: ["hidden"] }), 2);
  const later = commitFact(
    l,
    baseFact({ text: "Ortiz carries the badge." }),
    3,
  );

  const entry = learn(
    l,
    "f1",
    "  Hatch: needs a flight-crew badge.  ",
    "conversation",
    10,
  );
  assert.deepEqual(entry, {
    factId: "f1",
    line: "Hatch: needs a flight-crew badge.",
    learnedAt: 10,
    via: "conversation",
  });
  assert.deepEqual(l.journal, [entry]);
  assert.equal(knows(l, "f1"), true);
  assert.equal(knows(l, "f3"), false);

  // idempotent: nothing new, nothing changed
  assert.equal(learn(l, "f1", "something else entirely", "pa", 11), undefined);
  assert.equal(learn(l, "f1", "x".repeat(400), "pa", 12), undefined);
  assert.equal(l.journal.length, 1);
  assert.equal(l.journal[0].line, "Hatch: needs a flight-crew badge.");
  assert.equal(l.journal[0].learnedAt, 10);

  assert.throws(() => learn(l, "f99", "gone", "pa", 13), {
    message: "unknown fact: f99",
  });
  assert.throws(() => learn(l, sealed.id, "sealed", "pa", 13), {
    message: "the player can never learn hidden fact f2",
  });
  assert.throws(() => learn(l, later.id, "  ", "pa", 13), {
    message: "journal line is empty",
  });
  assert.throws(() => learn(l, later.id, "z".repeat(161), "pa", 13), {
    message: "journal line is longer than 160 characters",
  });
  assert.equal(l.journal.length, 1);
  assert.equal(knows(l, "f2"), false);
  assert.equal(knows(l, "f99"), false);

  const ok = learn(l, later.id, "  Ortiz carries the badge.  ", "document", 14);
  assert.equal(ok!.line, "Ortiz carries the badge.");
  assert.equal(ok!.via, "document");
  assert.equal(l.journal.length, 2);
  // exactly 160 characters is allowed
  assert.equal(
    learn(l, fact.id, "w".repeat(160), "observation", 15),
    undefined,
  );
  const extra = commitFact(l, baseFact({ text: "Vent is loose." }), 4);
  assert.equal(
    learn(l, extra.id, "w".repeat(160), "observation", 15)!.line.length,
    160,
  );
});

test("journalLines orders by learnedAt, stable for ties, marking outdated facts", () => {
  const l = emptyLedger();
  assert.deepEqual(journalLines(l), []);
  const a = commitFact(l, baseFact({ text: "A." }), 1);
  const b = commitFact(l, baseFact({ text: "B." }), 2);
  const c = commitFact(l, baseFact({ text: "C." }), 3);
  learn(l, b.id, "B line", "document", 20);
  learn(l, a.id, "A line", "conversation", 10);
  learn(l, c.id, "C line", "pa", 10);
  assert.deepEqual(journalLines(l), ["A line", "C line", "B line"]);
  supersede(l, b.id, baseFact({ text: "B changed." }), 25);
  assert.deepEqual(journalLines(l), ["A line", "C line", "B line (outdated)"]);
  // the old fact is untouched, including its text
  assert.equal(factById(l, b.id)!.text, "B.");
  assert.equal(factById(l, b.id)!.supersededBy, "f4");
});

test("factDigest keeps the newest facts, newest last, capped by max", () => {
  const l = emptyLedger();
  const f = [
    commitFact(l, baseFact({ text: "One." }), 1),
    commitFact(l, baseFact({ text: "Two." }), 2),
    commitFact(l, baseFact({ text: "Three." }), 3),
    commitFact(l, baseFact({ text: "Four." }), 4),
  ];
  assert.deepEqual(factDigest(l.facts, 2), ["f3: Three.", "f4: Four."]);
  assert.deepEqual(factDigest(l.facts, 1), ["f4: Four."]);
  assert.deepEqual(factDigest(l.facts, 4), [
    "f1: One.",
    "f2: Two.",
    "f3: Three.",
    "f4: Four.",
  ]);
  assert.deepEqual(factDigest(l.facts, 10), [
    "f1: One.",
    "f2: Two.",
    "f3: Three.",
    "f4: Four.",
  ]);
  assert.deepEqual(factDigest(l.facts, 0), []);
  assert.deepEqual(factDigest([], 3), []);
  assert.deepEqual(factDigest(f.slice(2), 2), ["f3: Three.", "f4: Four."]);
});

test("commitFact stores durable as a boolean and loop only when given", () => {
  const l = emptyLedger();
  const plain = commitFact(l, baseFact(), 1);
  assert.equal(plain.durable, false);
  assert.equal("loop" in plain, false);

  const durable = commitFact(
    l,
    baseFact({ text: "The hatch needs a badge.", durable: true, loop: 0 }),
    2,
  );
  assert.equal(durable.durable, true);
  assert.equal(durable.loop, 0);

  const event = commitFact(
    l,
    baseFact({ text: "The PA announced an outage.", durable: false, loop: 3 }),
    3,
  );
  assert.equal(event.durable, false);
  assert.equal(event.loop, 3);

  // durable is only true for an explicit true, never a truthy value
  const loose = commitFact(
    l,
    baseFact({ text: "Loose input.", durable: 1 as never }),
    4,
  );
  assert.equal(loose.durable, false);
});

test("supersede carries loop and durable onto the replacement fact", () => {
  const l = emptyLedger();
  const old = commitFact(l, baseFact(), 1);
  const fresh = supersede(
    l,
    old.id,
    baseFact({
      text: "The hatch now opens for anyone.",
      durable: true,
      loop: 2,
    }),
    2,
  );
  assert.equal(fresh.durable, true);
  assert.equal(fresh.loop, 2);
  assert.equal(old.supersededBy, fresh.id);
});

test("durableFacts keeps only current durable facts", () => {
  const l = emptyLedger();
  assert.deepEqual(durableFacts(l), []);

  const world = commitFact(
    l,
    baseFact({ text: "The hatch needs a badge.", durable: true }),
    1,
  );
  commitFact(l, baseFact({ text: "The PA announced an outage." }), 2);
  const replaced = commitFact(
    l,
    baseFact({ text: "The lift is locked.", durable: true, loop: 1 }),
    3,
  );
  assert.deepEqual(
    durableFacts(l).map((f) => f.id),
    [world.id, replaced.id],
  );

  const replacement = supersede(
    l,
    replaced.id,
    baseFact({ text: "The lift is unlocked.", durable: true }),
    4,
  );
  assert.deepEqual(
    durableFacts(l).map((f) => f.id),
    [world.id, replacement.id],
  );
  // a superseded durable fact drops out of the current view
  assert.equal(durableFacts(l).includes(replaced), false);
  // durableFacts does not mutate the ledger
  assert.equal(l.facts.length, 4);
  assert.equal(currentFacts(l).length, 3);
});
