import { preparePracticeRooms } from "./helpers/practice-questions";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assess } from "../src/ai";
import { beginVisit, eligible, initialStudy } from "../src/curriculum";
import {
  beginLearningAttempt,
  initialLearner,
  interruptLearningAttempt,
  practiceContract,
} from "../src/learner";
import type { Roadmap, Track } from "../src/model";
import { decode, encode } from "../src/persistence";
import {
  pickSpawnTopic,
  recordSpawn,
  setTopicEnabled,
  SPAWN_COOLDOWN,
  spawnCandidates,
  spawnContract,
  spawnState,
  topicEnabled,
  topicOf,
} from "../src/topic-spawn";
import { createPlayableGame } from "../src/world";
const r: Roadmap = JSON.parse(readFileSync("public/curriculum.json", "utf8"));
const formalFor = (s: ReturnType<typeof initialStudy>) => eligible(r, s);

test("spawn candidates are the track's unfinished tier topics, queue first then rotation, without duplicates", () => {
  const s = initialStudy(r);
  for (const track of ["PY", "PE"] as Track[]) {
    const candidates = spawnCandidates(r, s, track);
    assert.ok(candidates.length >= 2, `${track} needs variety candidates`);
    assert.equal(new Set(candidates).size, candidates.length);
    const queued = s.queues[track].filter((t) => candidates.includes(t));
    assert.deepEqual(candidates.slice(0, queued.length), queued);
    for (const topic of candidates)
      assert.ok(
        r.tracks[track].objectives.some(
          (o) => topicOf(o.id) === topic && o.cells[0] !== "P",
        ),
        `${track}:${topic} must have an unfinished D1 objective`,
      );
  }
  assert.equal(topicOf("PY:T05.2"), "T05");
  assert.equal(topicOf("nonsense"), "");
});

test("the formal topic spawns first, then cooled topics rotate in, gaps first, and the formal visit stays reachable", () => {
  const s = initialStudy(r);
  const formal = formalFor(s);
  const formalTopic = topicOf(formal.objectiveIds[0]);
  const track = formal.track;
  assert.deepEqual(pickSpawnTopic(r, s, formal), {
    topic: formalTopic,
    practice: false,
  });
  // The formal topic is spawned until it is on cooldown.
  for (let i = 0; i < SPAWN_COOLDOWN; i++)
    recordSpawn(s, formal, `room-${i}`, i);
  const first = pickSpawnTopic(r, s, formal);
  assert.equal(first.practice, true);
  assert.notEqual(first.topic, formalTopic);
  const candidates = spawnCandidates(r, s, track).filter(
    (t) => t !== formalTopic,
  );
  assert.equal(first.topic, candidates[0], "breadth follows curriculum order");
  const practice = spawnContract(r, s, formal);
  assert.equal(practice.practice, true);
  assert.equal(practice.track, track);
  assert.equal(practice.depth, 1);
  assert.equal(practice.review, false);
  assert.equal(topicOf(practice.objectiveIds[0]), first.topic);
  assert.match(
    practice.scheduleNote!,
    new RegExp(`formal visit remains ${formalTopic}`),
  );
  assert.match(practice.id, /^practice-/);
  // Once the practice topic is on cooldown too, the next pick moves on; the
  // formal topic returns as soon as it has cooled.
  for (let i = 0; i < SPAWN_COOLDOWN; i++)
    recordSpawn(s, practice, `room-p${i}`, 10 + i);
  const second = pickSpawnTopic(r, s, formal);
  assert.equal(second.practice, false, "formal cooled: it spawns again");
  assert.equal(second.topic, formalTopic);
  recordSpawn(s, formal, "room-f", 20);
  const third = pickSpawnTopic(r, s, formal);
  assert.equal(third.practice, true);
  assert.notEqual(third.topic, first.topic, "still cooling");
  assert.notEqual(third.topic, formalTopic);
  // An open recorded gap on a cooled topic takes priority over breadth order.
  const gapTopic = candidates.at(-1)!;
  assert.notEqual(gapTopic, third.topic);
  s.knowledgeGaps = [
    {
      id: "gap",
      encounter: "earlier/e",
      runId: "earlier",
      track,
      objectiveIds: [
        r.tracks[track].objectives.find((o) => topicOf(o.id) === gapTopic)!.id,
      ],
      depth: 1,
      facet: { id: "f", description: "F" },
      statement: "no",
      requestId: "q",
      provider: "study-mode",
      at: "2026-10-18T00:00:00.000Z",
    },
  ];
  assert.equal(pickSpawnTopic(r, s, formal).topic, gapTopic);
  s.knowledgeGaps[0].resolved = {
    at: "2026-10-19T00:00:00.000Z",
    encounter: "later/e",
    requestId: "q2",
    status: "demonstrated",
  };
  assert.notEqual(
    pickSpawnTopic(r, s, formal).topic,
    gapTopic,
    "closed gaps are ordinary",
  );
  // Disabled topics never spawn as practice; the formal topic cannot be removed.
  for (const topic of candidates) setTopicEnabled(s, track, topic, false);
  assert.equal(topicEnabled(s, track, candidates[0]), false);
  assert.deepEqual(pickSpawnTopic(r, s, formal), {
    topic: formalTopic,
    practice: false,
  });
  setTopicEnabled(s, track, candidates[0], true);
  assert.equal(topicEnabled(s, track, candidates[0]), true);
  assert.equal(spawnState(s).disabled.length, candidates.length - 1);
  for (const topic of candidates) setTopicEnabled(s, track, topic, true);
  assert.deepEqual(spawnState(s).disabled, []);
  // A due review is the formal visit like any other: it spawns whenever it has
  // cooled and still lets other terminals vary.
  assert.equal(
    pickSpawnTopic(r, s, { ...formal, review: true }).practice,
    true,
  );
  spawnState(s).recent = [];
  assert.equal(
    pickSpawnTopic(r, s, { ...formal, review: true }).practice,
    false,
  );
  // The spawn history is bounded.
  for (let i = 0; i < 100; i++) recordSpawn(s, formal, `x${i}`, i);
  assert.equal(spawnState(s).recent.length, 60);
  assert.equal(spawnState(s).recent.at(-1)!.encounter, "x99");
});

test("a fresh run spawns varied room topics on the formal track, keeps the formal visit, and practice rooms never bind a visit", async () => {
  const g = createPlayableGame(42, r);
  preparePracticeRooms(g, r);
  const rooms = new Map<string, string[]>();
  for (const e of Object.values(g.encounters))
    if (e.questionRoom && e.problem)
      rooms.set(e.questionRoom, [...(rooms.get(e.questionRoom) ?? []), e.id]);
  assert.ok(rooms.size >= 4);
  const formal = eligible(r, g.study);
  const contracts = [...rooms.values()].map(
    (ids) => g.encounters[ids[0]].problem!.contract,
  );
  const onTrack = contracts.filter((c) => c.track === formal.track);
  assert.ok(onTrack.length >= 3);
  const topics = new Set(onTrack.map((c) => topicOf(c.objectiveIds[0])));
  assert.ok(topics.size >= 2, "subsequent rooms are not one branch");
  const formalRooms = contracts.filter((c) => !c.practice);
  assert.ok(formalRooms.length >= 1, "the scheduled visit is reachable");
  assert.ok(
    formalRooms.every(
      (c) =>
        JSON.stringify(c.objectiveIds) === JSON.stringify(formal.objectiveIds),
    ),
  );
  for (let i = 1; i < onTrack.length; i++)
    if (i >= SPAWN_COOLDOWN)
      assert.ok(
        onTrack
          .slice(i - SPAWN_COOLDOWN, i)
          .map((c) => topicOf(c.objectiveIds[0]))
          .filter((t) => t === topicOf(onTrack[i].objectiveIds[0])).length <= 1,
        "a topic is not spawned twice within its cooldown while alternatives exist",
      );
  // Every station in a room shares the room's question and contract.
  for (const ids of rooms.values())
    for (const id of ids)
      assert.deepEqual(g.encounters[id].problem, g.encounters[ids[0]].problem);
  assert.deepEqual(
    spawnState(g.study).recent.map((x: { encounter: string }) => x.encounter),
    [...rooms.keys()],
  );
  // Practice rooms never become the scheduled visit; a formal room does.
  const practiceRoom = [...rooms.values()].find(
    (ids) => g.encounters[ids[0]].problem!.contract.practice,
  )!;
  const formalRoom = [...rooms.values()].find(
    (ids) => !g.encounters[ids[0]].problem!.contract.practice,
  )!;
  beginVisit(r, g.study, g.encounters[practiceRoom[0]]);
  assert.equal(g.study.pending, undefined);
  await assess(g, g.encounters[practiceRoom[0]], r);
  assert.equal(g.study.assessments.length, 0);
  beginVisit(r, g.study, g.encounters[formalRoom[0]]);
  assert.equal(
    (g.study.pending as { encounter: string } | undefined)?.encounter,
    `${g.id}/${formalRoom[0]}`,
  );
  // Spawn state and the practice flag survive save/reload and carry into a new run.
  const restored = decode(encode(g));
  assert.deepEqual(restored.study.topicSpawn, g.study.topicSpawn);
  assert.equal(
    restored.encounters[practiceRoom[0]].problem!.contract.practice,
    true,
  );
  delete restored.study.pending;
  const next = createPlayableGame(43, r, restored.study);
  preparePracticeRooms(next, r);
  assert.ok(spawnState(next.study).recent.length > rooms.size);
});

test("a live practice contract mirrors the formal bookkeeping, is marked practice, and never binds a learning attempt", () => {
  const l = initialLearner(r);
  const s = initialStudy(r, "live");
  s.learner = l;
  const formal = eligible(r, s);
  const track = formal.track;
  const candidate = spawnCandidates(r, s, track).find(
    (t) => t !== topicOf(formal.objectiveIds[0]),
  )!;
  const c = practiceContract(r, l, track, candidate)!;
  assert.equal(c.practice, true);
  assert.equal(c.kind, "checkpoint");
  assert.equal(c.depth, l.tracks[track].tier);
  assert.equal(c.track, track);
  assert.equal(topicOf(c.objectiveIds[0]), candidate);
  assert.equal(c.ledgerVersion, l.version);
  assert.equal(c.review, false);
  assert.match(c.id, /^practice-live-/);
  const passed = r.tracks[track].objectives.find(
    (o) => l.cells[o.id].states[l.tracks[track].tier - 1] === "P",
  );
  if (passed)
    assert.equal(
      r.tracks[track].objectives.some(
        (o) =>
          topicOf(o.id) === topicOf(passed.id) &&
          l.cells[o.id].states[l.tracks[track].tier - 1] !== "P",
      ) || practiceContract(r, l, track, topicOf(passed.id)) === undefined,
      true,
    );
  for (let i = 0; i < SPAWN_COOLDOWN; i++) recordSpawn(s, formal, `e${i}`, i);
  const spawned = spawnContract(r, s, formal);
  assert.equal(spawned.practice, true);
  const g = createPlayableGame(7, r, s);
  const e = Object.values(g.encounters).find((x) => x.mode === "solo")!;
  e.problem = {
    title: "Practice",
    prompt: "Practice",
    rubric: ["x"],
    starter: "",
    provenance: "study-mode",
    contract: spawned,
  };
  beginVisit(r, g.study, e);
  assert.equal(l.attempts.length, 0);
  assert.equal(g.study.pending, undefined);
});

test("development spawns never cool the live scheduled visit", () => {
  const s = initialStudy(r);
  const devFormal = formalFor(s);
  for (let i = 0; i < SPAWN_COOLDOWN; i++)
    recordSpawn(s, devFormal, `dev-room-${i}`, i);
  assert.equal(pickSpawnTopic(r, s, devFormal).practice, true);
  s.profile = "live";
  s.learner = initialLearner(r);
  const formal = formalFor(s);
  assert.deepEqual(pickSpawnTopic(r, s, formal), {
    topic: topicOf(formal.objectiveIds[0]),
    practice: false,
  });
  // Live spawns cool live terminals, and entries saved without a profile
  // still count for both.
  recordSpawn(s, formal, "live-room-0", 10);
  spawnState(s).recent.push({
    track: formal.track,
    topic: topicOf(formal.objectiveIds[0]),
    encounter: "legacy-entry",
    at: 11,
  });
  assert.equal(pickSpawnTopic(r, s, formal).practice, true);
  assert.equal(spawnState(s).recent.at(-2)!.profile, "live");
});

test("an interrupted formal visit resumes as the next formal question despite its cooldown", () => {
  const s = initialStudy(r, "live");
  const l = (s.learner = initialLearner(r));
  const formal = formalFor(s);
  const g = createPlayableGame(7, r, s);
  const [first, second] = Object.values(g.encounters).filter(
    (x) => x.mode === "solo",
  );
  const problem = (contract: typeof formal) => ({
    title: "Formal",
    prompt: "Formal",
    rubric: ["x"],
    starter: "",
    provenance: "study-mode" as const,
    contract,
  });
  first.problem = problem(formal);
  const issued = beginLearningAttempt(r, l, first);
  recordSpawn(s, formal, first.id, 0);
  // While the visit is bound, the cooled topic gives other terminals practice.
  assert.equal(pickSpawnTopic(r, s, formal).practice, true);
  interruptLearningAttempt(l, first);
  assert.deepEqual(pickSpawnTopic(r, s, formal), {
    topic: topicOf(formal.objectiveIds[0]),
    practice: false,
  });
  const resumed = spawnContract(r, s);
  assert.equal(resumed.practice, undefined);
  second.problem = problem(resumed);
  const child = beginLearningAttempt(r, l, second);
  assert.equal(child.parentAttempt, issued.id);
  recordSpawn(s, resumed, second.id, 1);
  // Once resumed, the ordinary cooldown applies again.
  assert.equal(pickSpawnTopic(r, s, formal).practice, true);
});
