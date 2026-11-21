import { isRecord as object } from "./is-record.mjs";

/**
 * The hint ladder. A tutor reply declares, per facet, how far its text went:
 * a free nudge, a concrete hint, or the step itself. Hints and given steps
 * cost credit, so the app lets them through only for a facet an earlier
 * tutor reply warned about (`help.offers`) and the learner then accepted
 * with the hint button (`accepts` on their message). The request carries
 * those facets as `payload.helpPolicy.unlocked`. A reply that crosses the
 * line without both is rejected before the learner sees it.
 */
export const HELP_GATE_GUIDANCE =
  "Hint ladder (whenever payload.helpPolicy is present): write help first in the JSON object, before text: help:{nudges:[facet ids],hints:[facet ids],gives:[facet ids],offers:[facet ids]}, using probe facet ids and empty arrays where nothing applies. After help, write text and complete as in every reply: complete (true or false) is required even when the reply only nudges. Each time the learner misses a facet, move one rung up for that facet, never more, and read the earlier messages' help to see which rung it has reached. Rung 1 (nudges): say which part is wrong or incomplete. Rung 2 (nudges): reword the question or narrow what to think about, without any assessed content. Rungs 1 and 2 are free: give them without warning. A free rung names the claim that is wrong or the part that is missing and stops there: it never states the correct fact, the value or the reason, and never says what the right answer contains or relies on, because the assessment records any such statement as given even when you declare it a nudge. A facet gets two free rungs at most: once two earlier replies of yours list it in nudges, do not ask the same point a third time; a reply that still finds it missed must be the warning described below, and the app rejects a third free nudge on a facet you never offered a hint on. A reply that only clarifies the question lists no facet at all. Rung 3 (hints): a concrete hint, such as a worked example on other values or where to look, that leaves the reasoning step to the learner; the part is then recorded as hinted. Rung 4 (gives): state the missing step. Rung 5 (gives): give the full answer and close that part. Rungs 4 and 5 are recorded as given. Before the first rung 3 on a facet, stop once: say in one sentence that the next hint will be recorded as answered with a hint instead of unaided, ask whether they want it, and list the facet in offers. The app accepts hints or gives only for facets in payload.helpPolicy.unlocked, which holds the facets the learner accepted a hint on by pressing the hint button under your offer, and rejects any other reply before the learner sees it. An offer alone unlocks nothing. When the facet is unlocked, continue up the ladder from rung 3 without asking again. When the learner's reply to the offer is a new attempt, judge the attempt on its merits; if it still misses, say what is still wrong on a free rung and list the facet in offers again, with no hint. When they ask for the hint in words and the facet is not unlocked, repeat the one-sentence offer and list the facet in offers so the button shows. When they want to move on, close with outcome gap. A learner who asks outright for the answer still gets the one warning first, then may be given it directly once the facet is unlocked. After rung 4 or 5 do not quiz the learner on that step again.";

const FIELDS = ["nudges", "hints", "gives", "offers"];
const ids = (value) =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every((id) => typeof id === "string" && id && id.length <= 200);

/** `help` absent, or {nudges,hints,gives,offers}, each a list of facet ids. */
export const validHelp = (help) =>
  help === undefined ||
  (object(help) && FIELDS.every((field) => ids(help[field])));

/** The facets a declaration spends credit on. */
const costly = (help) => [...new Set([...help.hints, ...help.gives])];

/**
 * The facets hints may follow on: those the learner accepted with the hint
 * button after a tutor reply offered them, and those an earlier reply already
 * hinted on (the ladder goes on, and conversations saved before acceptance
 * was recorded keep working). An offer the learner answered with a new
 * attempt unlocks nothing.
 */
export function unlockedHelp(messages) {
  const offered = new Set();
  const unlocked = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!object(m)) continue;
    if (m.kind === "human" && ids(m.accepts))
      for (const id of m.accepts) if (offered.has(id)) unlocked.add(id);
    if (m.kind !== "tutor" || !validHelp(m.help) || !m.help) continue;
    for (const id of m.help.offers) offered.add(id);
    for (const id of costly(m.help)) unlocked.add(id);
  }
  return [...unlocked];
}

/** The facets this request lets the tutor hint on, or undefined when the request predates the ladder. */
function unlockedBy(payload) {
  const policy = object(payload) ? payload.helpPolicy : undefined;
  if (!object(policy)) return undefined;
  return ids(policy.unlocked) ? policy.unlocked : [];
}

/** How many free nudges one facet gets before the tutor must offer a hint. */
const FREE_NUDGES = 2;

/**
 * The facets a declaration nudges once more although their free rungs are
 * used up and the learner was never offered a hint: asking again would only
 * repeat the question, so the reply has to make the offer instead.
 */
function exhausted(payload, help, unlocked) {
  const used = new Map();
  for (const m of Array.isArray(payload.messages) ? payload.messages : [])
    if (object(m) && m.kind === "tutor" && object(m.help) && ids(m.help.nudges))
      for (const id of new Set(m.help.nudges))
        used.set(id, (used.get(id) ?? 0) + 1);
  return [...new Set(help.nudges)].filter(
    (id) =>
      (used.get(id) ?? 0) >= FREE_NUDGES &&
      !unlocked.includes(id) &&
      !help.offers.includes(id),
  );
}

/**
 * Why a reply breaks the ladder, or undefined when it passes. `required`
 * also insists that the declaration is present (the relay does; the app
 * accepts an undeclared reply from an older relay as a free one).
 */
export function helpGateProblem(payload, answer, required = false) {
  const unlocked = unlockedBy(payload);
  if (!unlocked) return undefined;
  if (!validHelp(answer.help) || (required && answer.help === undefined))
    return "Terminal dialogue requires help:{nudges:[facet ids],hints:[facet ids],gives:[facet ids],offers:[facet ids]}, written before text";
  if (answer.help === undefined || answer.complete === true) return undefined;
  const early = costly(answer.help).filter((id) => !unlocked.includes(id));
  if (early.length)
    return `This reply gives a hint or a step the learner was not warned about (${early.join(", ")}). Rewrite text so it stays on a free rung for those facets, remove them from hints and gives, and list them in offers with a one-sentence warning that the next hint will be recorded as answered with a hint.`;
  const stuck = exhausted(payload, answer.help, unlocked);
  if (stuck.length)
    return `This reply asks the same point again after ${FREE_NUDGES} free nudges (${stuck.join(", ")}). Do not rephrase the question another time: say in one sentence that the next hint will be recorded as answered with a hint instead of unaided, ask whether they want it, and list those facets in offers.`;
  return undefined;
}

/**
 * A closing reply (complete:true) that leaves out its help declaration when
 * no facet was ever unlocked is read as declaring no help: with nothing
 * unlocked the tutor may not hint or give a step, and the gate does not check
 * a closing reply's rungs, so a correction round would only repeat the same
 * verdict at full cost. Returns true when it filled the declaration in.
 */
export function fillClosingHelp(payload, answer) {
  const unlocked = unlockedBy(payload);
  if (
    !unlocked ||
    unlocked.length ||
    !object(answer) ||
    answer.help !== undefined ||
    answer.complete !== true
  )
    return false;
  answer.help = { nudges: [], hints: [], gives: [], offers: [] };
  return true;
}

/**
 * Holds a streamed reply back until its help declaration has been read and
 * passes, so a rejected hint never appears word by word. Returns undefined
 * when the request has no ladder; otherwise a function of the raw reply so far.
 */
export function helpStreamGate(payload) {
  const unlocked = unlockedBy(payload);
  if (!unlocked) return undefined;
  let verdict;
  return (raw) => {
    if (verdict !== undefined) return verdict;
    const found = /"help"\s*:\s*(\{[^{}]*\})/.exec(raw);
    if (!found) return false;
    try {
      const help = JSON.parse(found[1]);
      verdict =
        validHelp(help) &&
        costly(help).every((id) => unlocked.includes(id)) &&
        !exhausted(payload, help, unlocked).length;
    } catch {
      verdict = false;
    }
    return verdict;
  };
}
