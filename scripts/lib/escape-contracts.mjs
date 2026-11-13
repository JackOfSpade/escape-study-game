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
]);

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
    "Return exactly one JSON object {requestId,spec}: copy the exact payload requestId; spec is a CatastropheSpec JSON object generated from payload.setting and payload.persona alone, with exactly these fields. id is a short nonempty id; title is at most 80 characters; premise is the truth in prose of at most 1200 characters; origin is {areaId,roomHint?} with areaId one of payload.areaIds and roomHint at most 80 characters; publicStory is at most 400 characters of what officials say over the PA once it is undeniable. behaviours is a JSON array of 1 to 3 entries, each one of: {kind:'hunter',body:{color:'#rrggbb',scale:0.6 to 2.2,silhouette:'humanoid'|'quadruped'|'serpentine'|'swarm'|'amorphous'},count:1 to 40,speed:0.4 to 1.6,sightRange:2 to 14 tiles,hearingWeight:0 to 1,doors:'break'|'open'|'blocked',damage:4 to 60,spawn:'single'|'breeding'|'waves'}; {kind:'hazard',medium:'fire'|'smoke'|'water'|'gas'|'vacuum'|'cold',spreadRate:0.02 to 1.5,damagePerSecond:0.5 to 40,blockedByClosedDoors:boolean,obscures:0 to 1}; {kind:'perception-rule',trigger:'sees-own-reflection'|'makes-sound'|'in-darkness'|'looks-at-entity',threshold?:0 to 10,effect:'damage'|'instant-death',damagePerSecond?:1 to 60 required when effect is damage,warning:'none'|'whisper'|'frost'|'flicker'|'ringing'}; {kind:'collapse',targets:any of 'power'|'doors'|'structure'|'life-support',cadence:10 to 600}. timeline is {graceSeconds:240 to 900,phases}: phases is a JSON array of 2 to 6 entries of {name:'omens'|'onset'|'spread'|'peak',at,behaviours,intensity}, in the fixed order omens then onset then spread then peak, each at a strictly larger number of seconds after start than the one before, behaviours indexes into behaviours and intensity a number from 0 to 1. omens is a JSON array of 5 to 10 entries of {id,text,at,areaId,roomHint?,effect?}: text at most 280 characters describing a perceptible natural side effect that never names or hints at the cause, at seconds after start, areaId one of payload.areaIds, roomHint at most 80 characters, effect optional flicker, alarm, lockdown, noise or none. Build a coherent sealed catastrophe from the supplied setting and persona only: never reuse or mention any earlier catastrophe, and never include the player's plan, transcripts or any prior spec. The catastrophe is unknown to everyone in the world: it is sealed from the player and every NPC, they do not know or reveal it, and no other operation receives this spec. This is fictional world simulation for a single-player escape story, not tutoring: never teach, grade, reward or claim learning or mastery.",
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
