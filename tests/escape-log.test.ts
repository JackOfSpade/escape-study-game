import assert from "node:assert/strict";
import test from "node:test";
import {
  ESCAPE_LOG_LIMIT,
  condenseTimeline,
  epiloguePacket,
  fallbackEpilogue,
  formatClock,
  logEvent,
  validateEpilogue,
} from "../src/escape-log";
import type {
  AreaGraph,
  AreaStub,
  CatastropheSpec,
  EscapeEvent,
  EscapeEventKind,
  PhaseName,
} from "../src/escape-types";

const spec = (phases: [PhaseName, number][]): CatastropheSpec => ({
  id: "test-catastrophe",
  title: "The excavation device",
  premise: "A drill breached a sealed pocket of gas under the colony",
  origin: { areaId: "lab" },
  behaviours: [],
  timeline: {
    graceSeconds: 240,
    phases: phases.map(([name, at]) => ({
      name,
      at,
      behaviours: [0],
      intensity: 1,
    })),
  },
  omens: [],
  publicStory: "A routine pressure test is under way",
});

const event = (
  at: number,
  kind: EscapeEventKind,
  areaId: string,
  text: string,
): EscapeEvent => ({
  at,
  kind,
  areaId,
  text,
});

const stub = (
  id: string,
  name: string,
  state: AreaStub["state"],
  brief = `${name} is a place`,
): AreaStub => ({
  id,
  name,
  brief,
  state,
  seed: 7,
});

const areaGraph = (...stubs: AreaStub[]): AreaGraph => ({
  start: stubs[0].id,
  current: stubs[0].id,
  areas: Object.fromEntries(stubs.map((s) => [s.id, s])),
  portals: [],
});

test("logEvent trims text to 240 characters", () => {
  const log: EscapeEvent[] = [];
  logEvent(log, event(5, "pa", "lab", "a".repeat(300)));
  assert.equal(log.length, 1);
  assert.equal(log[0].text.length, 240);
  assert.equal(log[0].text, "a".repeat(240));
  assert.equal(log[0].at, 5);
  assert.equal(log[0].kind, "pa");
});

test("logEvent keeps the newest 600 events", () => {
  const log: EscapeEvent[] = [];
  for (let i = 0; i < ESCAPE_LOG_LIMIT + 50; i++)
    logEvent(log, event(i, "pa", "lab", `notice ${i}`));
  assert.equal(log.length, ESCAPE_LOG_LIMIT);
  assert.equal(log[0].text, "notice 50");
  assert.equal(log[log.length - 1].text, `notice ${ESCAPE_LOG_LIMIT + 49}`);
});

test("logEvent never drops the first phase event of a phase or a player-end event", () => {
  const log: EscapeEvent[] = [];
  logEvent(log, event(10, "phase", "lab", "the onset phase begins"));
  logEvent(log, event(12, "player-end", "lab", "the player died in the lab"));
  for (let i = 0; i < ESCAPE_LOG_LIMIT + 20; i++)
    logEvent(log, event(100 + i, "pa", "lab", `notice ${i}`));
  assert.equal(log.length, ESCAPE_LOG_LIMIT);
  assert.equal(log[0].text, "the onset phase begins");
  assert.equal(log[1].text, "the player died in the lab");
  // The oldest unprotected event went instead: `notice 0` .. `notice 21` are gone.
  assert.equal(log[2].text, "notice 22");
  assert.equal(log[log.length - 1].text, `notice ${ESCAPE_LOG_LIMIT + 19}`);
});

test("logEvent protects only the first phase event of each phase name", () => {
  const log: EscapeEvent[] = [];
  logEvent(log, event(1, "phase", "lab", "the spread phase begins"));
  logEvent(log, event(2, "phase", "lab", "the spread phase deepens"));
  for (let i = 0; i < ESCAPE_LOG_LIMIT; i++)
    logEvent(log, event(100 + i, "pa", "lab", `notice ${i}`));
  assert.equal(log.length, ESCAPE_LOG_LIMIT);
  assert.equal(log[0].text, "the spread phase begins");
  assert.equal(
    log.filter((e) => e.text === "the spread phase deepens").length,
    0,
    "the repeated phase announcement is droppable",
  );
  assert.equal(log[1].text, "notice 1");
});

test("formatClock renders mm:ss with minutes past 59", () => {
  assert.equal(formatClock(0), "00:00");
  assert.equal(formatClock(9), "00:09");
  assert.equal(formatClock(61), "01:01");
  assert.equal(formatClock(3599), "59:59");
  assert.equal(formatClock(4503), "75:03");
  assert.equal(formatClock(-5), "00:00");
});

test("condenseTimeline groups by phase, calm included, in time order", () => {
  const s = spec([
    ["peak", 600],
    ["onset", 300],
  ]);
  const log = [
    event(620, "pa", "hold", "the alarm sounds"),
    event(90, "pa", "lab", "the drill hums"),
    event(650, "pa", "cellar", "the lights fail"),
    event(400, "pa", "lab", "the lights flicker"),
  ];
  const out = condenseTimeline(log, s, { lab: "Lab", hold: "Hold" });
  assert.deepEqual(
    out.map((g) => g.phase),
    ["calm", "onset", "peak"],
  );
  assert.deepEqual(out[0].lines, ["[01:30] Lab: the drill hums"]);
  assert.deepEqual(out[1].lines, ["[06:40] Lab: the lights flicker"]);
  assert.deepEqual(out[2].lines, [
    "[10:20] Hold: the alarm sounds",
    "[10:50] cellar: the lights fail",
  ]);
});

test("condenseTimeline collapses consecutive identical area and text with a count", () => {
  const log = [
    event(10, "pa", "lab", "hiss"),
    event(20, "pa", "lab", "hiss"),
    event(30, "pa", "lab", "hiss"),
    event(40, "pa", "hold", "hiss"),
    event(50, "pa", "lab", "hiss"),
  ];
  const out = condenseTimeline(log, spec([]), { lab: "Lab", hold: "Hold" });
  assert.deepEqual(out, [
    {
      phase: "calm",
      lines: [
        "[00:10] Lab: hiss (x3)",
        "[00:40] Hold: hiss",
        "[00:50] Lab: hiss",
      ],
    },
  ]);
});

test("condenseTimeline collapses only clusters of more than two deaths", () => {
  const log = [
    event(100, "death", "lab", "smoke"),
    event(110, "death", "lab", "a fall"),
    event(200, "death", "lab", "smoke"),
    event(210, "death", "lab", "fire"),
    event(220, "death", "lab", "smoke"),
    event(400, "death", "hold", "smoke"),
    event(460, "death", "hold", "fire"),
    event(520, "death", "hold", "a fall"),
  ];
  const out = condenseTimeline(log, spec([]), { lab: "Lab", hold: "Hold" });
  assert.deepEqual(out, [
    {
      phase: "calm",
      lines: [
        "[01:40] Lab: smoke",
        "[01:50] Lab: a fall",
        "[03:20] Lab: 3 people died (smoke, fire)",
        "[06:40] Hold: smoke",
        "[07:40] Hold: fire",
        "[08:40] Hold: a fall",
      ],
    },
  ]);
});

test("condenseTimeline caps at 120 lines, keeping phase, evacuation and player-end lines", () => {
  const log: EscapeEvent[] = [
    event(1, "phase", "lab", "the onset watch begins"),
    event(2, "evacuation", "lab", "the lab is evacuated"),
    event(3, "player-end", "lab", "the player is lost"),
  ];
  for (let i = 0; i < 200; i++)
    log.push(event(100 + i, "pa", "lab", `noise ${i}`));
  const out = condenseTimeline(log, spec([["onset", 10]]), { lab: "Lab" });
  const lines = out.flatMap((g) => g.lines);
  assert.equal(lines.length, 120);
  assert.ok(lines.includes("[00:01] Lab: the onset watch begins"));
  assert.ok(lines.includes("[00:02] Lab: the lab is evacuated"));
  assert.ok(lines.includes("[00:03] Lab: the player is lost"));
  assert.equal(
    lines.includes("[01:40] Lab: noise 0"),
    false,
    "the oldest ordinary line is dropped first",
  );
  assert.ok(
    lines.includes("[04:59] Lab: noise 199"),
    "the newest ordinary line survives",
  );
});

test("epiloguePacket splits visited and unbuilt areas and carries outcome and time", () => {
  const s = spec([["onset", 300]]);
  const areas = areaGraph(
    stub("bridge", "Bridge", "ready"),
    stub("hold", "Hold", "stub", "crates stacked to the ceiling"),
    stub("dome", "Dome", "failed", "a cracked glass roof"),
  );
  const log = [event(400, "pa", "bridge", "the alarm sounds")];
  const p = epiloguePacket({
    spec: s,
    log,
    areas,
    persona: { name: "Ana Ortiz", role: "flight engineer" },
    outcome: "died",
    endedAt: 754,
  });
  assert.equal(p.title, "The excavation device");
  assert.equal(
    p.premise,
    "A drill breached a sealed pocket of gas under the colony",
  );
  assert.equal(p.publicStory, "A routine pressure test is under way");
  assert.deepEqual(p.persona, { name: "Ana Ortiz", role: "flight engineer" });
  assert.equal(p.outcome, "died");
  assert.equal(p.endedAt, "12:34");
  assert.deepEqual(p.visitedAreas, ["Bridge"]);
  assert.deepEqual(p.unbuiltAreas, [
    { name: "Hold", brief: "crates stacked to the ceiling" },
    { name: "Dome", brief: "a cracked glass roof" },
  ]);
  assert.deepEqual(
    p.timeline,
    condenseTimeline(log, s, { bridge: "Bridge", hold: "Hold", dome: "Dome" }),
  );
  for (const phrase of [
    "premise",
    "timeline",
    "probably",
    "no headings",
    "at most six short paragraphs",
    "fate",
  ])
    assert.ok(p.instruction.includes(phrase), `instruction mentions ${phrase}`);
});

test("fallbackEpilogue is deterministic, covers premise, phases, unbuilt areas and fate", () => {
  const s = spec([
    ["onset", 300],
    ["peak", 900],
  ]);
  const areas = areaGraph(
    stub("bridge", "Bridge", "ready"),
    stub("hold", "Hold", "stub", "crates stacked to the ceiling"),
    stub("dome", "Dome", "queued", "a cracked glass roof"),
  );
  const p = epiloguePacket({
    spec: s,
    log: [
      event(10, "pa", "bridge", "the alarm sounds"),
      event(400, "pa", "bridge", "lights flicker"),
      event(420, "pa", "bridge", "the alarm sounds"),
      event(950, "death", "bridge", "smoke"),
    ],
    areas,
    persona: { name: "Ana Ortiz", role: "flight engineer" },
    outcome: "escaped",
    endedAt: 1200,
  });
  const text = fallbackEpilogue(p);
  assert.equal(fallbackEpilogue(p), text, "the fallback is deterministic");
  assert.ok(
    text.includes("A drill breached a sealed pocket of gas under the colony."),
    "premise sentence is stated",
  );
  assert.ok(
    text.includes(
      "During the calm hours, 1 event was logged, beginning with [00:10] Bridge: the alarm sounds.",
    ),
    "calm phase is summarised",
  );
  assert.ok(
    text.includes(
      "During the onset, 2 events were logged, beginning with [06:40] Bridge: lights flicker and then [07:00] Bridge: the alarm sounds.",
    ),
    "onset phase summarises its line count and first two lines",
  );
  assert.ok(
    text.includes(
      "During the peak, 1 event was logged, beginning with [15:50] Bridge: smoke.",
    ),
    "peak phase is summarised",
  );
  for (const area of p.unbuiltAreas)
    assert.ok(text.includes(area.name), `${area.name} is mentioned`);
  assert.ok(
    text.includes(
      "Hold was never entered in that loop, though it probably was much as planned: crates stacked to the ceiling.",
    ),
    "unbuilt area is described as probable",
  );
  assert.ok(
    text.includes("Ana Ortiz, the flight engineer, got out alive."),
    "fate sentence is last",
  );
  assert.ok(text.length <= 4000);
  assert.ok(
    text.indexOf("A drill breached") < text.indexOf("During the calm hours") &&
      text.indexOf("During the peak") <
        text.indexOf("Hold was never entered") &&
      text.indexOf("Hold was never entered") < text.indexOf("Ana Ortiz"),
    "premise, phases, unbuilt areas, then fate",
  );
});

test("fallbackEpilogue stays within 4000 characters for many unbuilt areas", () => {
  const stubs = [stub("bridge", "Bridge", "ready")];
  for (let i = 0; i < 80; i++)
    stubs.push(
      stub(`a${i}`, `Area ${i}`, "stub", "a long corridor ".repeat(8)),
    );
  const p = epiloguePacket({
    spec: spec([]),
    log: [event(10, "pa", "bridge", "the alarm sounds")],
    areas: areaGraph(...stubs),
    persona: { name: "Ana Ortiz", role: "flight engineer" },
    outcome: "quit",
    endedAt: 61,
  });
  const text = fallbackEpilogue(p);
  assert.ok(
    text.length <= 4000,
    `fallback stayed at ${text.length} characters`,
  );
});

test("validateEpilogue accepts plain trimmed prose and rejects markup, URLs and bad lengths", () => {
  const prose =
    "The drill breached the pocket and the colony filled with gas. Ana did not get out.";
  assert.equal(validateEpilogue(`  ${prose}  `), prose);
  assert.equal(validateEpilogue("x".repeat(40)), "x".repeat(40));
  assert.equal(validateEpilogue("x".repeat(39)), undefined);
  assert.equal(validateEpilogue("y".repeat(4001)), undefined);
  assert.equal(validateEpilogue(undefined), undefined);
  assert.equal(validateEpilogue(42), undefined);
  assert.equal(validateEpilogue(`${"z".repeat(50)} <b>a tag</b>`), undefined);
  assert.equal(
    validateEpilogue(`${"z".repeat(50)} https://example.com`),
    undefined,
  );
  assert.equal(
    validateEpilogue(`${"z".repeat(50)} http://example.com`),
    undefined,
  );
  assert.equal(
    validateEpilogue(`${"z".repeat(50)} 3 < 4 people`),
    `${"z".repeat(50)} 3 < 4 people`,
    "a bare less-than sign is not markup",
  );
});
