/**
 * AI operations for the escape redesign (docs/ESCAPE_REDESIGN.md, sections
 * 3-7 and 10). Each operation has fixed contract prose and a validator that
 * throws a specific Error and otherwise returns the normalised answer.
 *
 * Plain data only: no imports, so the gateway can cache the prose verbatim.
 */

export const ESCAPE_OPERATIONS = Object.freeze([
  "escape-engage",
  "escape-converse",
  "escape-pa",
  "escape-intent",
  "escape-epilogue",
  "escape-area",
  "escape-catastrophe",
  "escape-plan",
  "escape-truth",
]);

/** The ways out and the things a step may need; mirrored in src/escape-types.ts. */
export const PLAN_MEANS = Object.freeze([
  "walk-out",
  "drive",
  "fly",
  "sail",
  "climb",
  "tunnel",
  "hide",
  "call-help",
  "wait",
  "other",
]);
export const PLAN_RESOURCES = Object.freeze([
  "none",
  "exit",
  "vehicle",
  "fuel",
  "key",
  "tool",
  "phone",
  "radio",
  "power",
  "rope",
  "boat",
  "aircraft",
  "weapon",
  "disguise",
  "person",
  "window",
  "roof",
  "tunnel",
  "supplies",
]);
/** What each way out cannot do without; the way that works never has one walled. */
const VIABLE_NEEDS = Object.freeze({
  "walk-out": ["exit"],
  drive: ["vehicle", "fuel", "key"],
  fly: ["aircraft", "fuel"],
  sail: ["boat"],
  climb: ["roof", "rope"],
  tunnel: ["tunnel", "tool"],
  hide: ["supplies"],
  "call-help": ["phone", "radio", "power"],
  wait: [],
  other: [],
});

export const ESCAPE_CONTRACTS = Object.freeze({
  "escape-engage":
    'Return exactly one JSON object {requestId,facts,task?,reply?,area?}: copy the exact payload requestId; facts is a JSON array of 0 to 4 entries, each one {text,subject:{kind,id},visibility}; task is optional {title,unit,steps,objectId}; reply is an optional spoken line. This is fictional world simulation for a single-player escape story, not tutoring: never teach, grade, reward or claim learning or mastery. facts are plain sentences of at most 280 characters a person could learn by engaging with the named object, area, person or document; subject.kind is area, object, npc, system, route or task; visibility is a JSON array of 1 to 8 strings, for example ["public"] or ["npc:<id>","role:<role>"], never a bare string: each entry lists who may know the fact and is public, npc:<id>, role:<role>, document:<id> or area:<id>, never hidden. task titles are at most 80 characters, unit at most 24, steps an integer from 1 to 8 and objectId a supplied object. reply is at most 240 characters. area is optional {name,brief,transition,objectId,distance?}: name 1 to 60 characters, brief 1 to 600 characters, transition one of airlock, hatch, lift, vehicle, door or walk, and objectId a non-empty string naming a supplied object. distance is near or far: near means within walking distance, so the place becomes a building next to the current one; far means it needs travel, so it becomes a separate region reached at the edge of the world. A missing distance means near. exit is optional and must be a boolean: exit true marks a place that takes the player away (a vehicle ride out, a launch, an evacuation transport), not just another room to explore. Use only the supplied setting, persona, known facts, area and object summaries and never contradict them. The catastrophe is unknown to everyone, including you: never invent, hint at, name or reveal what is going to happen.',
  "escape-converse":
    "Return exactly one JSON object {requestId,speakerId,text,outcome}: copy the exact payload requestId, set speakerId to payload.speaker.id, write one spoken line in text of 1 to 200 characters of plain speech without markup, code, lists or URLs, and one structured outcome. outcome is an NpcOutcome: {kind:'none'}, {kind:'share-fact',factId}, {kind:'lead',targetId}, {kind:'follow'}, {kind:'stop-following'}, {kind:'refuse'}, {kind:'ask-for-proof'}, {kind:'agree-with-conditions',condition}, {kind:'report'}, {kind:'watch'}, {kind:'intervene'}, {kind:'detain'}, {kind:'unlock',doorId} or {kind:'alarm',delta}. This is fictional world simulation, not tutoring: never teach, grade, reward or claim learning. The speaker knows only the supplied social summary, visible facts and overheard utterances; never invent knowledge, events, other characters' private thoughts or facts the speaker was not given. The catastrophe is unknown to everyone in this world: never invent, hint at, name or reveal it.",
  "escape-pa":
    "Return exactly one JSON object {requestId,kind,text,effect?}: copy the exact payload requestId; kind is routine, incident, borderline or escalation and must equal payload.kind whenever it is supplied; text is one announcement of 1 to 220 characters of plain speech without markup or URLs; effect is optional. effect is {kind:'power',roomId,power:'lit'|'dim'|'outage'}, {kind:'lockdown',roomId}, {kind:'evacuate'} or {kind:'none'}, and roomId must be one of payload.rooms ids. This is fictional world simulation, not tutoring: never teach, grade, reward or claim learning. Most announcements are routine; escalate only when the supplied phase says the trouble is public. The catastrophe is unknown to everyone: officials and you do not know or reveal what it really is. After onset an announcement may repeat payload.publicStory, the official version, without adding any other account of the cause.",
  "escape-intent":
    "Return exactly one JSON object {requestId,goals}: copy the exact payload requestId; goals is a JSON array of 0 to 5 entries of {areaId,goal,confidence}, sorted from highest confidence to lowest, each areaId one of payload.areaIds, goal a plain sentence of at most 120 characters, confidence a number from 0 to 1. This is only a private guess about what the player will try next, used to decide which areas to build in the background. It is fictional world simulation, not tutoring: never teach, grade, reward or claim learning. Predict plausible player goals from the supplied signals only and never claim to know the player's mind. The catastrophe is unknown to everyone: infer nothing about it and never invent, hint at, name or reveal it.",
  "escape-epilogue":
    "Return exactly one JSON object {requestId,text}: copy the exact payload requestId; text is 40 to 4000 characters of plain prose without markup, headings, lists, code or URLs. This is the only operation that receives the catastrophe premise: write a short retrospective of the most recent loop, stating what was really happening and what the supplied event log shows actually happened, and phrasing what happened in areas never built as likely rather than certain. This is fictional world simulation, not tutoring: never teach, grade, reward or claim learning. Never invent events, deaths, dialogue or discoveries the log does not support, and never address the player as a learner.",
  "escape-area":
    "Return exactly one JSON object {requestId,areaId,name,premise,rooms,people}: copy the exact payload requestId, areaId equal to payload.areaId, name at most 60 characters, premise at most 600 characters, rooms is a JSON array of 3 to 12 entries of {name,purpose} with name at most 40 and purpose at most 120 characters, and people is a JSON array of 0 to 12 entries of {name,role,activity} each at most 40, 40 and 120 characters. Expand the supplied stub into a building brief the map generator can build: ordinary working rooms and ordinary people with ordinary days. This is fictional world simulation, not tutoring: never teach, grade, reward or claim learning. The people know only the supplied facts. The catastrophe is unknown to everyone, including you: never invent, hint at, foreshadow or reveal it, and never design rooms around it.",
  "escape-catastrophe":
    "Return exactly one JSON object {requestId,spec} through the structured reply: copy the exact payload requestId; spec is a CatastropheSpec, and the reply schema fixes every field name, enum, length, count and numeric range. What the fields mean: title names the catastrophe; premise is the truth in prose, read only by the epilogue; origin.areaId is where it starts and roomHint the room; publicStory is what officials say over the PA once it is undeniable. Each behaviour is one threat mechanism: hunter is bodies that chase the player (body silhouette and scale shape them, spawn is single, breeding or waves, doors says whether they break, open or are stopped by doors); hazard is a spreading medium (fire, smoke, water, gas, vacuum, cold) that closed doors may hold back; perception-rule is a rule that hurts whoever breaks it (seeing their reflection, making sound above threshold, standing in darkness, looking at it) after a learnable warning; collapse is the place failing (power, doors, structure, life support) every cadence seconds. Rules the schema cannot check: phases run in the fixed order omens then onset then spread then peak, each name at most once, each at a strictly larger number of seconds after start than the one before; omens starts before timeline.graceSeconds and onset starts at or after it; phase behaviours are indexes into behaviours, and every behaviour is active in onset or a later phase; a makes-sound rule needs threshold and a damage effect needs damagePerSecond; omen ids are unique and every omen happens before the last phase; omen text describes a perceptible natural side effect that never names or hints at the cause. Fit the place physically: payload.setting gives the venue, site form, ground, neighbours, weather and, when present, the outdoors (enclosure, backdrop, kinds of terrain around the building); the threat must come from, travel through and act on that physical place and its people, and the omens must be things that place could plausibly show. payload.recent lists the last catastrophes this player met, newest first, as titles, behaviour kinds, hunter silhouettes and spawn modes, hazard media and perception triggers: choose a different threat mechanism, not a renamed or recoloured one, so a recent hunter that spawns in waves and breaks doors must not return as another humanoid hunter in waves under a new name, and avoid repeating the same combination of behaviour kinds when another fits the place. When payload.repeated is present it summarises an earlier answer to this same request that was set aside because its behaviour signature matched a recent catastrophe: build a different mechanism from it as well. Build a coherent sealed catastrophe from the supplied setting and persona only: never mention any earlier catastrophe, and never include the player's plan, transcripts or any prior spec. The catastrophe is unknown to everyone in the world: it is sealed from the player and every NPC, they do not know or reveal it, and no other operation receives this spec. This is fictional world simulation for a single-player escape story, not tutoring: never teach, grade, reward or claim learning or mastery.",
  "escape-plan": `Return exactly one JSON object {requestId,verdict,reply,means,steps}: copy the exact payload requestId. This is fictional world simulation for a single-player escape story, not tutoring: never teach, grade, reward or claim learning. The player character has thought of a way to get out of the place (payload.plan). You are the part of the world that makes that plan something they can physically try; you are not a judge of whether it will save them, and The catastrophe is unknown to everyone, including you: you do not know what is coming or what is secretly wrong here, so never invent, predict, warn, hint or refuse on those grounds. verdict is possible when the plan could believably be attempted in this particular place (payload.place and payload.setting): the things it needs are things such a place would plausibly have, even if nobody has mentioned them yet (a staff car at a planetarium, a ladder at a workshop). verdict is impossible only when it needs something this place could not have (a boat on Mars, a helicopter in a cellar) or is not a way out at all; then give only requestId, verdict and reply. reply is the character's own thought in the first person, 1 to 240 characters of plain speech: for possible, where to start; for impossible, why that cannot be here. means is the kind of way out, one of ${PLAN_MEANS.join("|")}. steps is a JSON array of 1 to 6 entries {kind,text,label,anchorId,resource,seconds,npcId?} in the order they must be done: kind is reach (get to a spot), fetch (pick something up there), work (do something there for a while) or ask (get a named person to help); text is what to do, at most 120 characters, as the character would put it; label names the thing or place the step happens at, at most 40 characters; anchorId is one of payload.anchors ids, the real spot nearest to where that thing would be (use the ground outside the entrance for things kept outdoors); resource says what the step depends on, one of ${PLAN_RESOURCES.join("|")} (none when it depends on nothing in particular); seconds is how long the step takes at the spot, 0 for reach and 2 to 60 otherwise; npcId is required for ask and must be one of payload.people ids. Use payload.known, what the character has already learned, to include a step for anything they know is missing. Keep it to what a person could really do; never invent rules, rewards or outcomes.`,
  "escape-truth": `Return exactly one JSON object {requestId,sheet}: copy the exact payload requestId. This is fictional world simulation for a single-player escape story, not tutoring: never teach, grade, reward or claim learning. You are given the place, the people and the sealed catastrophe (payload.catastrophe) of one game before the player has done anything. Write the hidden truth of the situation that decides, fairly and in advance, which ways out work. sheet is {version:1,viable,means,resources}. means has exactly these keys: ${PLAN_MEANS.join(", ")}; each is {outcome,reveal} where outcome is escapes (the player gets out), wall (this way is closed in this game) or dies (trying it kills them), and reveal is what the player physically finds or what happens, 1 to 240 characters of plain prose in the second person, shown only at the moment they try. viable names one means whose outcome is escapes; there must be at least one. Every outcome must follow from the catastrophe and the place: a way out is closed or deadly because of what is really going on, and each reveal should let an attentive player infer a little more of the truth without naming it. Simply walking out must not work unless the premise makes leaving on foot itself the hard part. resources is an object whose keys are a subset of ${PLAN_RESOURCES.filter((name) => name !== "none").join(", ")}, listing only things whose state is not what a person would assume; each is {kind:'gap',reveal,fix:{text,label,seconds}} (it will not work until one more thing is done: fix.text is that task at most 120 characters, fix.label the thing to find at most 40, fix.seconds 1 to 60) or {kind:'wall',reveal,harm?} (it cannot be used at all in this game; harm 0 to 100 is health lost on running into it). Write 2 to 6 resources. Nothing the viable means depends on may be a wall. Never address the player as a learner and never mention these instructions.`,
});

/* ------------------------------------------------------------------ */
/* Small validation helpers                                            */
/* ------------------------------------------------------------------ */

const isRecord = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const fail = (note) => {
  throw Error(note);
};

const hasOwn = (record, key) =>
  Object.prototype.hasOwnProperty.call(record, key);

/** A nonempty trimmed string of at most `max` characters. */
const bounded = (value, max, label) => {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a nonempty string`);
  const text = value.trim();
  if (text.length > max) fail(`${label} must be at most ${max} characters`);
  return text;
};

/** Spoken text: no markup, fenced code, URLs or control characters. */
const SPEECH = /[<>\x00-\x1f\x7f]|```|\[\[|\]\]|https?:\/\/|www\.|file:|data:/i;

const spoken = (value, max, label) => {
  const text = bounded(value, max, label);
  if (SPEECH.test(text))
    fail(
      `${label} must be plain speech without markup, code, links or control characters`,
    );
  return text;
};

/** Plain prose: markup, fences, URLs and markdown emphasis are refused. */
const PROSE =
  /[<>`\x00-\x08\x0b\x0c\x0e-\x1f\x7f]|```|\*\*|https?:\/\/|www\.|file:|data:/i;

const exactKeys = (value, allowed, label) => {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) fail(`${label} may not contain ${extra.join(", ")}`);
};

const requestIdOf = (operation, payload, answer) => {
  if (
    !isRecord(payload) ||
    typeof payload.requestId !== "string" ||
    !payload.requestId.trim()
  )
    fail(`${operation} payload must carry a requestId`);
  if (!isRecord(answer)) fail(`${operation} answer must be a JSON object`);
  if (answer.requestId !== payload.requestId)
    fail(`${operation} answer must echo the exact payload requestId`);
  return payload.requestId;
};

const SUBJECT_KINDS = Object.freeze([
  "area",
  "object",
  "npc",
  "system",
  "route",
  "task",
]);

/** A FactVisibility form from src/escape-types.ts, never `hidden`. */
const visibilityOf = (value, label) => {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a FactVisibility string`);
  const text = value.trim();
  if (text === "hidden")
    fail(
      `${label} may not be hidden: a hidden fact is never shown to the player`,
    );
  if (text === "public") return text;
  const match = /^(npc|role|document|area):([^\s<>]+)$/.exec(text);
  if (!match)
    fail(
      `${label} must be public, npc:<id>, role:<role>, document:<id> or area:<id>`,
    );
  return text;
};

/* ------------------------------------------------------------------ */
/* escape-engage                                                       */
/* ------------------------------------------------------------------ */

const engage = (payload, answer) => {
  exactKeys(
    answer,
    ["requestId", "facts", "task", "reply", "area"],
    "escape-engage answer",
  );
  if (!Array.isArray(answer.facts) || answer.facts.length > 4)
    fail("escape-engage facts must be an array of 0 to 4 entries");
  const facts = answer.facts.map((fact, index) => {
    const label = `escape-engage facts[${index}]`;
    if (!isRecord(fact)) fail(`${label} must be an object`);
    exactKeys(fact, ["text", "subject", "visibility"], label);
    if (!isRecord(fact.subject)) fail(`${label}.subject must be {kind,id}`);
    exactKeys(fact.subject, ["kind", "id"], `${label}.subject`);
    if (!SUBJECT_KINDS.includes(fact.subject.kind))
      fail(
        `${label}.subject.kind must be area, object, npc, system, route or task`,
      );
    if (
      !Array.isArray(fact.visibility) ||
      !fact.visibility.length ||
      fact.visibility.length > 8
    )
      fail(`${label}.visibility must list 1 to 8 FactVisibility entries`);
    const visibility = fact.visibility.map((value, at) =>
      visibilityOf(value, `${label}.visibility[${at}]`),
    );
    if (new Set(visibility).size !== visibility.length)
      fail(`${label}.visibility must not repeat an entry`);
    return {
      text: bounded(fact.text, 280, `${label}.text`),
      subject: {
        kind: fact.subject.kind,
        id: bounded(fact.subject.id, 160, `${label}.subject.id`),
      },
      visibility,
    };
  });
  let task;
  if (answer.task !== undefined) {
    const label = "escape-engage task";
    if (!isRecord(answer.task))
      fail(`${label} must be {title,unit,steps,objectId}`);
    exactKeys(answer.task, ["title", "unit", "steps", "objectId"], label);
    if (
      !Number.isInteger(answer.task.steps) ||
      answer.task.steps < 1 ||
      answer.task.steps > 8
    )
      fail(`${label}.steps must be an integer from 1 to 8`);
    task = {
      title: bounded(answer.task.title, 80, `${label}.title`),
      unit: bounded(answer.task.unit, 24, `${label}.unit`),
      steps: answer.task.steps,
      objectId: bounded(answer.task.objectId, 160, `${label}.objectId`),
    };
  }
  let area;
  if (answer.area !== undefined) {
    const label = "escape-engage area";
    if (!isRecord(answer.area))
      fail(`${label} must be {name,brief,transition,objectId,exit?,distance?}`);
    exactKeys(
      answer.area,
      ["name", "brief", "transition", "objectId", "exit", "distance"],
      label,
    );
    if (answer.area.exit !== undefined && typeof answer.area.exit !== "boolean")
      fail(`${label}.exit must be a boolean when present`);
    if (
      answer.area.distance !== undefined &&
      !["near", "far"].includes(answer.area.distance)
    )
      fail(`${label}.distance must be near or far when present`);
    if (
      !["airlock", "hatch", "lift", "vehicle", "door", "walk"].includes(
        answer.area.transition,
      )
    )
      fail(
        `${label}.transition must be airlock, hatch, lift, vehicle, door or walk`,
      );
    area = {
      name: bounded(answer.area.name, 60, `${label}.name`),
      brief: bounded(answer.area.brief, 600, `${label}.brief`),
      transition: answer.area.transition,
      objectId: bounded(answer.area.objectId, 160, `${label}.objectId`),
      // Older answers carried no distance: near (a building to walk to) is the
      // safe reading, since a far place would silently become unreachable.
      distance: answer.area.distance === "far" ? "far" : "near",
    };
    if (answer.area.exit !== undefined) area.exit = answer.area.exit;
  }
  const normalised = { requestId: payload.requestId, facts };
  if (task) normalised.task = task;
  if (answer.reply !== undefined)
    normalised.reply = bounded(answer.reply, 240, "escape-engage reply");
  if (area) normalised.area = area;
  return normalised;
};

/* ------------------------------------------------------------------ */
/* escape-converse                                                     */
/* ------------------------------------------------------------------ */

const NPC_OUTCOMES = Object.freeze({
  none: [],
  "share-fact": ["factId"],
  lead: ["targetId"],
  follow: [],
  "stop-following": [],
  refuse: [],
  "ask-for-proof": [],
  "agree-with-conditions": ["condition"],
  report: [],
  watch: [],
  intervene: [],
  detain: [],
  unlock: ["doorId"],
  alarm: ["delta"],
});

/** Validate only the NpcOutcome kind and the fields that kind requires. */
const npcOutcome = (value, label) => {
  if (
    !isRecord(value) ||
    typeof value.kind !== "string" ||
    !hasOwn(NPC_OUTCOMES, value.kind)
  )
    fail(`${label} must be an NpcOutcome with a kind from src/escape-types.ts`);
  const required = NPC_OUTCOMES[value.kind];
  exactKeys(value, ["kind", ...required], label);
  const normalised = { kind: value.kind };
  for (const key of required) {
    if (key === "delta") {
      if (typeof value.delta !== "number" || !Number.isFinite(value.delta))
        fail(`${label}.delta must be a finite number`);
      normalised.delta = value.delta;
    } else {
      normalised[key] = bounded(value[key], 160, `${label}.${key}`);
    }
  }
  return normalised;
};

const converse = (payload, answer) => {
  if (
    !isRecord(payload.speaker) ||
    typeof payload.speaker.id !== "string" ||
    !payload.speaker.id.trim()
  )
    fail("escape-converse payload must carry speaker.id");
  exactKeys(
    answer,
    ["requestId", "speakerId", "text", "outcome"],
    "escape-converse answer",
  );
  if (answer.speakerId !== payload.speaker.id)
    fail("escape-converse speakerId must equal payload.speaker.id");
  return {
    requestId: payload.requestId,
    speakerId: payload.speaker.id,
    text: spoken(answer.text, 200, "escape-converse text"),
    outcome: npcOutcome(answer.outcome, "escape-converse outcome"),
  };
};

/* ------------------------------------------------------------------ */
/* escape-pa                                                           */
/* ------------------------------------------------------------------ */

const PA_KINDS = Object.freeze([
  "routine",
  "incident",
  "borderline",
  "escalation",
]);

const pa = (payload, answer) => {
  exactKeys(
    answer,
    ["requestId", "kind", "text", "effect"],
    "escape-pa answer",
  );
  if (!PA_KINDS.includes(answer.kind))
    fail("escape-pa kind must be routine, incident, borderline or escalation");
  if (payload.kind !== undefined && answer.kind !== payload.kind)
    fail("escape-pa kind must equal payload.kind when it is supplied");
  const rooms = Array.isArray(payload.rooms)
    ? payload.rooms.filter(
        (room) => isRecord(room) && typeof room.id === "string",
      )
    : [];
  const roomId = (value, label) => {
    const id = bounded(value, 160, label);
    if (!rooms.some((room) => room.id === id))
      fail(`${label} must be one of payload.rooms ids`);
    return id;
  };
  const normalised = {
    requestId: payload.requestId,
    kind: answer.kind,
    text: spoken(answer.text, 220, "escape-pa text"),
  };
  if (answer.effect !== undefined) {
    const value = answer.effect;
    const label = "escape-pa effect";
    if (!isRecord(value) || typeof value.kind !== "string")
      fail(`${label} must be {kind:'power'|'lockdown'|'evacuate'|'none',...}`);
    if (value.kind === "power") {
      exactKeys(value, ["kind", "roomId", "power"], label);
      if (!["lit", "dim", "outage"].includes(value.power))
        fail(`${label}.power must be lit, dim or outage`);
      normalised.effect = {
        kind: "power",
        roomId: roomId(value.roomId, `${label}.roomId`),
        power: value.power,
      };
    } else if (value.kind === "lockdown") {
      exactKeys(value, ["kind", "roomId"], label);
      normalised.effect = {
        kind: "lockdown",
        roomId: roomId(value.roomId, `${label}.roomId`),
      };
    } else if (value.kind === "evacuate" || value.kind === "none") {
      exactKeys(value, ["kind"], label);
      normalised.effect = { kind: value.kind };
    } else {
      fail(`${label}.kind must be power, lockdown, evacuate or none`);
    }
  }
  return normalised;
};

/* ------------------------------------------------------------------ */
/* escape-intent                                                       */
/* ------------------------------------------------------------------ */

const intent = (payload, answer) => {
  exactKeys(answer, ["requestId", "goals"], "escape-intent answer");
  const areaIds = Array.isArray(payload.areaIds)
    ? payload.areaIds.filter((id) => typeof id === "string")
    : [];
  if (!Array.isArray(answer.goals) || answer.goals.length > 5)
    fail("escape-intent goals must be an array of 0 to 5 entries");
  let previous = Infinity;
  const goals = answer.goals.map((goal, index) => {
    const label = `escape-intent goals[${index}]`;
    if (!isRecord(goal)) fail(`${label} must be an object`);
    exactKeys(goal, ["areaId", "goal", "confidence"], label);
    if (typeof goal.areaId !== "string" || !areaIds.includes(goal.areaId))
      fail(`${label}.areaId must be one of payload.areaIds`);
    if (
      typeof goal.confidence !== "number" ||
      !Number.isFinite(goal.confidence) ||
      goal.confidence < 0 ||
      goal.confidence > 1
    )
      fail(`${label}.confidence must be a number from 0 to 1`);
    if (goal.confidence > previous)
      fail(
        "escape-intent goals must be sorted by confidence from highest to lowest",
      );
    previous = goal.confidence;
    return {
      areaId: goal.areaId,
      goal: bounded(goal.goal, 120, `${label}.goal`),
      confidence: goal.confidence,
    };
  });
  return { requestId: payload.requestId, goals };
};

/* ------------------------------------------------------------------ */
/* escape-epilogue                                                     */
/* ------------------------------------------------------------------ */

const epilogue = (payload, answer) => {
  exactKeys(answer, ["requestId", "text"], "escape-epilogue answer");
  if (typeof answer.text !== "string")
    fail("escape-epilogue text must be a string");
  const text = answer.text.trim();
  if (text.length < 40 || text.length > 4000)
    fail("escape-epilogue text must be 40 to 4000 characters of plain prose");
  if (PROSE.test(text))
    fail(
      "escape-epilogue text must be plain prose without markup, code, emphasis or links",
    );
  return { requestId: payload.requestId, text };
};

/* ------------------------------------------------------------------ */
/* escape-area                                                         */
/* ------------------------------------------------------------------ */

const area = (payload, answer) => {
  if (typeof payload.areaId !== "string" || !payload.areaId.trim())
    fail("escape-area payload must carry areaId");
  exactKeys(
    answer,
    ["requestId", "areaId", "name", "premise", "rooms", "people"],
    "escape-area answer",
  );
  if (answer.areaId !== payload.areaId)
    fail("escape-area areaId must equal payload.areaId");
  const name = bounded(answer.name, 60, "escape-area name");
  const premise = bounded(answer.premise, 600, "escape-area premise");
  if (
    !Array.isArray(answer.rooms) ||
    answer.rooms.length < 3 ||
    answer.rooms.length > 12
  )
    fail("escape-area rooms must list 3 to 12 rooms");
  const rooms = answer.rooms.map((room, index) => {
    const label = `escape-area rooms[${index}]`;
    if (!isRecord(room)) fail(`${label} must be an object`);
    exactKeys(room, ["name", "purpose"], label);
    return {
      name: bounded(room.name, 40, `${label}.name`),
      purpose: bounded(room.purpose, 120, `${label}.purpose`),
    };
  });
  if (!Array.isArray(answer.people) || answer.people.length > 12)
    fail("escape-area people must list 0 to 12 people");
  const people = answer.people.map((person, index) => {
    const label = `escape-area people[${index}]`;
    if (!isRecord(person)) fail(`${label} must be an object`);
    exactKeys(person, ["name", "role", "activity"], label);
    return {
      name: bounded(person.name, 40, `${label}.name`),
      role: bounded(person.role, 40, `${label}.role`),
      activity: bounded(person.activity, 120, `${label}.activity`),
    };
  });
  return {
    requestId: payload.requestId,
    areaId: payload.areaId,
    name,
    premise,
    rooms,
    people,
  };
};

/* ------------------------------------------------------------------ */
/* escape-catastrophe                                                  */
/* ------------------------------------------------------------------ */

const CATASTROPHE_SPEC_FIELDS = Object.freeze([
  "id",
  "title",
  "premise",
  "origin",
  "behaviours",
  "timeline",
  "omens",
  "publicStory",
]);

/**
 * Structural check only: the spec must be a plain object carrying every
 * CatastropheSpec field. The numeric/logical bounds are validated client side
 * by validateCatastrophe in src/catastrophe.ts.
 */
const catastrophe = (payload, answer) => {
  exactKeys(answer, ["requestId", "spec"], "escape-catastrophe answer");
  if (!isRecord(answer.spec))
    fail("escape-catastrophe spec must be a JSON object");
  const missing = CATASTROPHE_SPEC_FIELDS.filter(
    (field) => !hasOwn(answer.spec, field),
  );
  if (missing.length)
    fail(`escape-catastrophe spec must contain ${missing.join(", ")}`);
  return { requestId: payload.requestId, spec: answer.spec };
};

/* ------------------------------------------------------------------ */
/* escape-plan                                                         */
/* ------------------------------------------------------------------ */

const STEP_KINDS = Object.freeze(["reach", "fetch", "work", "ask"]);

const idsOf = (list) =>
  Array.isArray(list)
    ? list
        .map((entry) => (isRecord(entry) ? entry.id : undefined))
        .filter((id) => typeof id === "string")
    : [];

const plan = (payload, answer) => {
  exactKeys(
    answer,
    ["requestId", "verdict", "reply", "means", "steps"],
    "escape-plan answer",
  );
  const reply = spoken(answer.reply, 240, "escape-plan reply");
  if (answer.verdict === "impossible")
    return { requestId: payload.requestId, verdict: "impossible", reply };
  if (answer.verdict !== "possible")
    fail("escape-plan verdict must be possible or impossible");
  if (!PLAN_MEANS.includes(answer.means))
    fail(`escape-plan means must be one of ${PLAN_MEANS.join(", ")}`);
  if (
    !Array.isArray(answer.steps) ||
    answer.steps.length < 1 ||
    answer.steps.length > 6
  )
    fail("escape-plan steps must be an array of 1 to 6 entries");
  const anchors = idsOf(payload.anchors),
    people = idsOf(payload.people);
  const steps = answer.steps.map((step, index) => {
    const label = `escape-plan steps[${index}]`;
    if (!isRecord(step)) fail(`${label} must be an object`);
    exactKeys(
      step,
      ["kind", "text", "label", "anchorId", "resource", "seconds", "npcId"],
      label,
    );
    if (!STEP_KINDS.includes(step.kind))
      fail(`${label}.kind must be reach, fetch, work or ask`);
    if (typeof step.anchorId !== "string" || !anchors.includes(step.anchorId))
      fail(`${label}.anchorId must be one of payload.anchors ids`);
    if (!PLAN_RESOURCES.includes(step.resource))
      fail(`${label}.resource must be one of ${PLAN_RESOURCES.join(", ")}`);
    if (
      typeof step.seconds !== "number" ||
      !Number.isFinite(step.seconds) ||
      step.seconds < 0 ||
      step.seconds > 60
    )
      fail(`${label}.seconds must be a number from 0 to 60`);
    if (step.kind !== "reach" && step.seconds < 2)
      fail(`${label}.seconds must be at least 2 unless kind is reach`);
    const out = {
      kind: step.kind,
      text: bounded(step.text, 120, `${label}.text`),
      label: bounded(step.label, 40, `${label}.label`),
      anchorId: step.anchorId,
      resource: step.resource,
      seconds: step.kind === "reach" ? 0 : Math.round(step.seconds),
    };
    if (step.kind === "ask") {
      if (typeof step.npcId !== "string" || !people.includes(step.npcId))
        fail(`${label}.npcId must be one of payload.people ids for an ask`);
      out.npcId = step.npcId;
    } else if (hasOwn(step, "npcId") && step.npcId !== undefined)
      fail(`${label}.npcId is only allowed when kind is ask`);
    return out;
  });
  return {
    requestId: payload.requestId,
    verdict: "possible",
    reply,
    means: answer.means,
    steps,
  };
};

/* ------------------------------------------------------------------ */
/* escape-truth                                                        */
/* ------------------------------------------------------------------ */

const truth = (payload, answer) => {
  exactKeys(answer, ["requestId", "sheet"], "escape-truth answer");
  const sheet = answer.sheet;
  if (!isRecord(sheet)) fail("escape-truth sheet must be an object");
  exactKeys(
    sheet,
    ["version", "viable", "means", "resources"],
    "escape-truth sheet",
  );
  if (sheet.version !== 1) fail("escape-truth sheet.version must be 1");
  if (!isRecord(sheet.means))
    fail("escape-truth sheet.means must be an object");
  exactKeys(sheet.means, PLAN_MEANS, "escape-truth sheet.means");
  const means = {};
  for (const name of PLAN_MEANS) {
    const rule = sheet.means[name],
      label = `escape-truth sheet.means.${name}`;
    if (!isRecord(rule)) fail(`${label} is required`);
    exactKeys(rule, ["outcome", "reveal"], label);
    if (!["escapes", "wall", "dies"].includes(rule.outcome))
      fail(`${label}.outcome must be escapes, wall or dies`);
    means[name] = {
      outcome: rule.outcome,
      reveal: bounded(rule.reveal, 240, `${label}.reveal`),
    };
  }
  if (!PLAN_MEANS.includes(sheet.viable))
    fail("escape-truth sheet.viable must name a means");
  if (means[sheet.viable].outcome !== "escapes")
    fail(
      "escape-truth sheet.viable must name a means whose outcome is escapes",
    );
  if (!isRecord(sheet.resources))
    fail("escape-truth sheet.resources must be an object");
  const names = Object.keys(sheet.resources);
  if (names.length < 2 || names.length > 6)
    fail("escape-truth sheet.resources must list 2 to 6 things");
  const resources = {};
  for (const name of names) {
    const label = `escape-truth sheet.resources.${name}`;
    if (name === "none" || !PLAN_RESOURCES.includes(name))
      fail(`${label} is not a known resource`);
    const entry = sheet.resources[name];
    if (!isRecord(entry)) fail(`${label} must be an object`);
    const reveal = bounded(entry.reveal, 240, `${label}.reveal`);
    if (entry.kind === "wall") {
      exactKeys(entry, ["kind", "reveal", "harm"], label);
      const harm = entry.harm ?? 0;
      if (typeof harm !== "number" || !(harm >= 0 && harm <= 100))
        fail(`${label}.harm must be a number from 0 to 100`);
      resources[name] = { kind: "wall", reveal, harm: Math.round(harm) };
    } else if (entry.kind === "gap") {
      exactKeys(entry, ["kind", "reveal", "fix"], label);
      if (!isRecord(entry.fix)) fail(`${label}.fix must be an object`);
      exactKeys(entry.fix, ["text", "label", "seconds"], `${label}.fix`);
      if (
        typeof entry.fix.seconds !== "number" ||
        !(entry.fix.seconds >= 1 && entry.fix.seconds <= 60)
      )
        fail(`${label}.fix.seconds must be a number from 1 to 60`);
      resources[name] = {
        kind: "gap",
        reveal,
        fix: {
          text: bounded(entry.fix.text, 120, `${label}.fix.text`),
          label: bounded(entry.fix.label, 40, `${label}.fix.label`),
          seconds: Math.round(entry.fix.seconds),
        },
      };
    } else fail(`${label}.kind must be gap or wall`);
  }
  for (const name of VIABLE_NEEDS[sheet.viable])
    if (resources[name]?.kind === "wall")
      fail(
        `escape-truth sheet.resources.${name} may not be a wall: the viable way out (${sheet.viable}) depends on it`,
      );
  return {
    requestId: payload.requestId,
    sheet: { version: 1, viable: sheet.viable, means, resources },
  };
};

/* ------------------------------------------------------------------ */
/* Dispatch                                                            */
/* ------------------------------------------------------------------ */

const VALIDATORS = Object.freeze({
  "escape-engage": engage,
  "escape-converse": converse,
  "escape-pa": pa,
  "escape-intent": intent,
  "escape-epilogue": epilogue,
  "escape-area": area,
  "escape-catastrophe": catastrophe,
  "escape-plan": plan,
  "escape-truth": truth,
});

/**
 * Validate one escape answer against its payload. Throws Error with a
 * specific message on any violation; otherwise returns the normalised answer.
 */
export function validateEscapeAnswer(operation, payload, answer) {
  if (!hasOwn(VALIDATORS, operation))
    fail(`Unsupported escape operation: ${String(operation)}`);
  requestIdOf(operation, payload, answer);
  return VALIDATORS[operation](payload, answer);
}
