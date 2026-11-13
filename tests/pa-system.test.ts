import assert from "node:assert/strict";
import { test } from "node:test";
import type { Announcement, AnnouncementKind } from "../src/escape-types";
import {
  PA_TIMING,
  announcementWeight,
  chooseKind,
  fallbackAnnouncement,
  nextAnnouncementAt,
  paListeners,
  recordAnnouncement,
  validateAnnouncement,
} from "../src/pa-system";

const ROOMS = [
  { id: "room-lab", name: "Lab" },
  { id: "room-store", name: "Storage" },
];

const PUBLIC_STORY = "A gas leak has been confirmed in the building.";

/** rng that walks a fixed script, repeating its last value forever. */
function scripted(values: readonly number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}

function makeFallback(
  kind: AnnouncementKind,
  rng: () => number,
  seq = 7,
): Announcement {
  return fallbackAnnouncement(
    {
      kind,
      areaId: "area-central",
      areaName: "Central Wing",
      rooms: ROOMS,
      publicStory: PUBLIC_STORY,
      now: 1234,
      seq,
    },
    rng,
  );
}

function baseAnnouncement(): Announcement {
  return {
    id: "pa1",
    at: 100,
    kind: "routine",
    text: "Conditions around the Central Wing remain steady.",
    areaId: "area-central",
  };
}

test("PA_TIMING exposes the documented frozen windows", () => {
  assert.equal(Object.isFrozen(PA_TIMING), true);
  assert.equal(Object.isFrozen(PA_TIMING.routineBeforeOnset), true);
  assert.equal(Object.isFrozen(PA_TIMING.routineAfterOnset), true);
  assert.equal(Object.isFrozen(PA_TIMING.first), true);
  assert.deepEqual({ ...PA_TIMING.routineBeforeOnset }, { min: 150, max: 420 });
  assert.deepEqual({ ...PA_TIMING.routineAfterOnset }, { min: 60, max: 150 });
  assert.deepEqual({ ...PA_TIMING.first }, { min: 40, max: 90 });
});

test("nextAnnouncementAt hits both ends of every window", () => {
  assert.equal(
    nextAnnouncementAt(0, false, () => 0),
    40,
  );
  assert.equal(
    nextAnnouncementAt(0, false, () => 0.999),
    90,
  );
  assert.equal(
    nextAnnouncementAt(0, true, () => 0),
    40,
  );
  assert.equal(
    nextAnnouncementAt(0, true, () => 0.999),
    90,
  );

  assert.equal(
    nextAnnouncementAt(1000, false, () => 0),
    1150,
  );
  assert.equal(
    nextAnnouncementAt(1000, false, () => 0.999),
    1420,
  );
  assert.equal(
    nextAnnouncementAt(1000, true, () => 0),
    1060,
  );
  assert.equal(
    nextAnnouncementAt(1000, true, () => 0.999),
    1150,
  );
});

test("nextAnnouncementAt stays inside the window for the midpoint", () => {
  assert.equal(
    nextAnnouncementAt(500, false, () => 0.5),
    785,
  );
  assert.equal(
    nextAnnouncementAt(500, true, () => 0.5),
    605,
  );
  assert.equal(
    nextAnnouncementAt(-5, false, () => 0.5),
    60,
  );
});

test("chooseKind follows the pre-onset distribution boundaries", () => {
  const pick = (r: number) =>
    chooseKind({ phase: "omens", onset: false, recentKinds: [] }, () => r);
  assert.equal(pick(0), "routine");
  assert.equal(pick(0.699), "routine");
  assert.equal(pick(0.7), "incident");
  assert.equal(pick(0.899), "incident");
  assert.equal(pick(0.9), "borderline");
  assert.equal(pick(0.999), "borderline");
  assert.equal(pick(1), "borderline");
});

test("chooseKind follows the post-onset distribution boundaries", () => {
  const pick = (r: number) =>
    chooseKind({ phase: "spread", onset: true, recentKinds: [] }, () => r);
  assert.equal(pick(0), "escalation");
  assert.equal(pick(0.599), "escalation");
  assert.equal(pick(0.6), "incident");
  assert.equal(pick(0.849), "incident");
  assert.equal(pick(0.85), "routine");
  assert.equal(pick(0.999), "routine");
});

test("borderline is locked before the omens phase and its share goes to routine", () => {
  assert.equal(
    chooseKind({ phase: "calm", onset: false, recentKinds: [] }, () => 0.799),
    "routine",
  );
  assert.equal(
    chooseKind({ phase: "calm", onset: false, recentKinds: [] }, () => 0.8),
    "incident",
  );
  assert.equal(
    chooseKind({ phase: "calm", onset: false, recentKinds: [] }, () => 0.999),
    "incident",
  );
  const picked = new Set<AnnouncementKind>();
  for (let i = 0; i < 1000; i += 1) {
    picked.add(
      chooseKind(
        { phase: "calm", onset: false, recentKinds: [] },
        () => i / 1000,
      ),
    );
  }
  assert.deepEqual([...picked].sort(), ["incident", "routine"]);
});

test("three identical kinds in a row advance to the next calm kind", () => {
  assert.equal(
    chooseKind(
      { phase: "omens", onset: false, recentKinds: ["routine", "routine"] },
      () => 0,
    ),
    "incident",
  );
  assert.equal(
    chooseKind(
      { phase: "omens", onset: false, recentKinds: ["incident", "incident"] },
      () => 0.75,
    ),
    "borderline",
  );
  assert.equal(
    chooseKind(
      {
        phase: "omens",
        onset: false,
        recentKinds: ["borderline", "borderline"],
      },
      () => 0.95,
    ),
    "routine",
  );
  assert.equal(
    chooseKind(
      {
        phase: "spread",
        onset: true,
        recentKinds: ["escalation", "escalation"],
      },
      () => 0,
    ),
    "routine",
  );
  // Two in a row is still allowed; only the third is redirected.
  assert.equal(
    chooseKind(
      { phase: "omens", onset: false, recentKinds: ["incident"] },
      () => 0.75,
    ),
    "incident",
  );
});

test("a long run never contains three identical kinds", () => {
  const recent: AnnouncementKind[] = [];
  let previous = "";
  let streak = 0;
  for (let i = 0; i < 60; i += 1) {
    const kind = chooseKind(
      { phase: "omens", onset: false, recentKinds: recent },
      () => (i % 10) / 10,
    );
    recent.push(kind);
    streak = kind === previous ? streak + 1 : 1;
    previous = kind;
    assert.ok(streak <= 2, `three ${kind} in a row at step ${i}`);
  }
  assert.equal(recent.length, 60);
});

const KINDS = ["routine", "incident", "borderline", "escalation"] as const;

test("every fallback kind returns a valid announcement", () => {
  for (const kind of KINDS) {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const announcement = makeFallback(kind, scripted([r, r]));
      assert.equal(announcement.id, "pa7");
      assert.equal(announcement.at, 1234);
      assert.equal(announcement.kind, kind);
      assert.equal(announcement.areaId, "area-central");
      assert.equal(announcement.text, announcement.text.trim());
      assert.ok(
        announcement.text.length >= 1 && announcement.text.length <= 220,
      );
      assert.deepEqual(validateAnnouncement(announcement, ROOMS), []);
    }
  }
});

test("routine fallbacks cover six generic themes with no setting nouns", () => {
  const texts = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    texts.add(makeFallback("routine", scripted([0.5, i / 100])).text);
  }
  assert.equal(texts.size, 7);
  for (const text of texts) {
    assert.ok(
      text.includes("Central Wing"),
      `routine text should name the area: ${text}`,
    );
    assert.doesNotMatch(text, /snow|mars|rocket|zombie|spacecraft/i);
  }
});

test("incident fallbacks cover four unrelated incidents", () => {
  const texts = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    texts.add(makeFallback("incident", scripted([0.5, i / 100])).text);
  }
  assert.equal(texts.size, 5);
  for (const text of texts) {
    assert.ok(text.length <= 220);
    assert.doesNotMatch(text, /snow|mars|rocket|zombie|spacecraft/i);
  }
});

test("power and lockdown effects reference a supplied room", () => {
  const power = makeFallback("incident", scripted([0.9, 0]));
  assert.deepEqual(power.effect, {
    kind: "power",
    roomId: "room-store",
    power: "outage",
  });
  const lockdown = makeFallback("incident", scripted([0, 0.25]));
  assert.deepEqual(lockdown.effect, { kind: "lockdown", roomId: "room-lab" });
  for (let i = 0; i < 100; i += 1) {
    const effect = makeFallback(
      "incident",
      scripted([i / 100, i / 100]),
    ).effect;
    if (effect?.kind === "power" || effect?.kind === "lockdown") {
      assert.ok(ROOMS.some((room) => room.id === effect.roomId));
    }
  }
});

test("borderline fallbacks cover unusual readings and avoiding a room", () => {
  const texts = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    texts.add(makeFallback("borderline", scripted([0.5, i / 100])).text);
  }
  assert.equal(texts.size, 2);
  for (const text of texts) {
    assert.ok(
      validateAnnouncement(
        { ...baseAnnouncement(), kind: "borderline", text },
        ROOMS,
      ).length === 0,
    );
  }
});

test("escalation fallbacks use the public story and include an evacuation", () => {
  const texts = new Set<string>();
  for (const r of [0.01, 0.34, 0.67]) {
    const announcement = makeFallback("escalation", scripted([0, r]));
    assert.ok(
      announcement.text.includes(PUBLIC_STORY),
      `escalation text missing story: ${announcement.text}`,
    );
    texts.add(announcement.text);
  }
  assert.equal(texts.size, 3);
  const evacuation = makeFallback("escalation", scripted([0, 0.99]));
  assert.deepEqual(evacuation.effect, { kind: "evacuate" });
  assert.ok(evacuation.text.includes(PUBLIC_STORY));
});

test("validateAnnouncement accepts a complete announcement", () => {
  assert.deepEqual(validateAnnouncement(baseAnnouncement(), ROOMS), []);
  const withExtras = {
    ...baseAnnouncement(),
    factId: "fact-1",
    effect: { kind: "power", roomId: "room-lab", power: "outage" },
  };
  assert.deepEqual(validateAnnouncement(withExtras, ROOMS), []);
});

test("validateAnnouncement rejects unknown fields", () => {
  assert.deepEqual(
    validateAnnouncement({ ...baseAnnouncement(), colour: "red" }, ROOMS),
    ["unknown field: colour"],
  );
});

test("validateAnnouncement rejects a bad kind", () => {
  assert.deepEqual(
    validateAnnouncement({ ...baseAnnouncement(), kind: "gossip" }, ROOMS),
    ["kind is not a valid announcement kind"],
  );
});

test("validateAnnouncement rejects bad text", () => {
  assert.deepEqual(
    validateAnnouncement(
      { ...baseAnnouncement(), text: "x".repeat(221) },
      ROOMS,
    ),
    ["text must be 1..220 characters"],
  );
  assert.deepEqual(
    validateAnnouncement({ ...baseAnnouncement(), text: "   " }, ROOMS),
    ["text must be trimmed"],
  );
  assert.deepEqual(
    validateAnnouncement({ ...baseAnnouncement(), text: "" }, ROOMS),
    ["text must be 1..220 characters"],
  );
});

test("validateAnnouncement rejects bad fields and unknown rooms", () => {
  assert.deepEqual(
    validateAnnouncement(
      {
        ...baseAnnouncement(),
        effect: { kind: "power", roomId: "room-x", power: "outage" },
      },
      ROOMS,
    ),
    ["effect roomId is not a known room: room-x"],
  );
  assert.deepEqual(
    validateAnnouncement(
      { ...baseAnnouncement(), effect: { kind: "lockdown" } },
      ROOMS,
    ),
    ["effect roomId must be a non-empty string"],
  );
  assert.deepEqual(
    validateAnnouncement(
      { ...baseAnnouncement(), effect: { kind: "teleport" } },
      ROOMS,
    ),
    ["effect kind must be power, lockdown, evacuate or none"],
  );
  assert.deepEqual(
    validateAnnouncement(
      { ...baseAnnouncement(), at: Number.POSITIVE_INFINITY },
      ROOMS,
    ),
    ["at must be a finite number"],
  );
  const missing = { ...baseAnnouncement() } as Record<string, unknown>;
  delete missing.text;
  assert.deepEqual(validateAnnouncement(missing, ROOMS), [
    "text must be a string",
  ]);
  assert.deepEqual(validateAnnouncement(null, ROOMS), [
    "announcement must be an object",
  ]);
});

test("paListeners keeps living indoor actors on a floor with a speaker", () => {
  const actors = [
    {
      id: "z",
      floor: 1,
      x: 3,
      y: 4,
      alive: true,
      indoor: true,
      areaId: "hall",
    },
    {
      id: "a",
      floor: 1,
      x: 1,
      y: 1,
      alive: true,
      indoor: true,
      areaId: "hall",
    },
    {
      id: "dead",
      floor: 1,
      x: 1,
      y: 1,
      alive: false,
      indoor: true,
      areaId: "hall",
    },
    {
      id: "outside",
      floor: 1,
      x: 1,
      y: 1,
      alive: true,
      indoor: false,
      areaId: "hall",
    },
    {
      id: "elsewhere",
      floor: 1,
      x: 1,
      y: 1,
      alive: true,
      indoor: true,
      areaId: "wing",
    },
    {
      id: "no-speaker-floor",
      floor: 4,
      x: 1,
      y: 1,
      alive: true,
      indoor: true,
      areaId: "hall",
    },
  ];
  const speakers = [
    { areaId: "hall", floor: 1 },
    { areaId: "wing", floor: 4 },
  ];
  assert.deepEqual(paListeners(actors, speakers, "hall"), ["a", "z"]);
  assert.deepEqual(paListeners(actors, speakers, "wing"), []);
  assert.deepEqual(paListeners(actors, [], "hall"), []);
});

test("announcementWeight scores content for NPC alarm", () => {
  assert.equal(
    announcementWeight({ ...baseAnnouncement(), kind: "routine" }),
    0.02,
  );
  assert.equal(
    announcementWeight({ ...baseAnnouncement(), kind: "incident" }),
    0.12,
  );
  assert.equal(
    announcementWeight({ ...baseAnnouncement(), kind: "borderline" }),
    0.2,
  );
  assert.equal(
    announcementWeight({ ...baseAnnouncement(), kind: "escalation" }),
    0.7,
  );
  assert.equal(
    announcementWeight({
      ...baseAnnouncement(),
      kind: "escalation",
      effect: { kind: "evacuate" },
    }),
    0.9,
  );
  assert.equal(
    announcementWeight({
      ...baseAnnouncement(),
      kind: "incident",
      effect: { kind: "power", roomId: "room-lab", power: "outage" },
    }),
    0.12,
  );
});

test("recordAnnouncement keeps only the newest 64", () => {
  const list: Announcement[] = [];
  for (let i = 1; i <= 70; i += 1) {
    recordAnnouncement(list, { ...baseAnnouncement(), id: `pa${i}`, at: i });
  }
  assert.equal(list.length, 64);
  assert.equal(list[0]?.id, "pa7");
  assert.equal(list[63]?.id, "pa70");
  recordAnnouncement(list, { ...baseAnnouncement(), id: "pa71", at: 71 });
  assert.equal(list.length, 64);
  assert.equal(list[0]?.id, "pa8");
  assert.equal(list[63]?.id, "pa71");
});
