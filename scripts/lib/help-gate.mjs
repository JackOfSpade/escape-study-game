import { isRecord as object } from "./is-record.mjs";

/**
 * Help that costs credit is opt-in, and the app enforces it. A tutor reply
 * declares which facets its text supplies help for and which it offers help
 * on. The learner confirms an offer with a button; that press travels as
 * `payload.helpPolicy.confirmed` on the next turn. A reply that supplies
 * unconfirmed help is rejected before the learner sees it.
 */
export const HELP_GATE_GUIDANCE =
  "Help gate (whenever payload.helpPolicy is present): write help first in the JSON object, before text: help:{supplies:[facet ids],offers:[facet ids]}. supplies lists every probe facet for which this reply's text states an assessed fact, value, pointer to the relevant line or reasoning step that the learner has not already given. offers lists the facets for which this reply warns that help would be recorded as answered with help and asks the learner to choose. Use empty arrays when neither applies. While complete is false, supplies may hold only ids listed in payload.helpPolicy.confirmed; the app rejects any other reply before the learner sees it, so withhold that content and put the facet in offers instead. The learner confirms by pressing a button the app shows whenever offers is not empty, and that press arrives as payload.helpPolicy.confirmed on the next turn. A typed yes is not a confirmation: reply by asking them to press Get the help, with the facet in offers again. When confirmed lists a facet, supply that help now and list it in supplies.";

const ids = (value) =>
  Array.isArray(value) &&
  value.length <= 64 &&
  value.every((id) => typeof id === "string" && id && id.length <= 200);

/** `help` absent, or {supplies:[facet ids],offers:[facet ids]}. */
export const validHelp = (help) =>
  help === undefined ||
  (object(help) && ids(help.supplies) && ids(help.offers));

/** The facets this turn's request lets the tutor supply help for, or undefined when the request predates the gate. */
export function confirmedHelp(payload) {
  const policy = object(payload) ? payload.helpPolicy : undefined;
  if (!object(policy)) return undefined;
  return ids(policy.confirmed) ? policy.confirmed : [];
}

/**
 * Why a reply breaks the help gate, or undefined when it passes. `required`
 * also insists that the declaration is present (the relay does; the app
 * accepts an undeclared reply from an older relay as supplying nothing).
 */
export function helpGateProblem(payload, answer, required = false) {
  const confirmed = confirmedHelp(payload);
  if (!confirmed) return undefined;
  if (!validHelp(answer.help) || (required && answer.help === undefined))
    return "Terminal dialogue requires help:{supplies:[facet ids],offers:[facet ids]}, written before text";
  if (answer.help === undefined || answer.complete === true) return undefined;
  const unconfirmed = answer.help.supplies.filter(
    (id) => !confirmed.includes(id),
  );
  if (unconfirmed.length)
    return `This reply supplies help the learner has not confirmed (${unconfirmed.join(", ")}). Rewrite text so it withholds that content, set help.supplies to [] and list those facets in help.offers with a one-sentence warning and the choice of getting the help, trying again or moving on.`;
  return undefined;
}

/**
 * Holds a streamed reply back until its help declaration has been read and
 * passes, so rejected help never appears word by word. Returns undefined when
 * the request has no gate; otherwise a function of the raw reply so far.
 */
export function helpStreamGate(payload) {
  const confirmed = confirmedHelp(payload);
  if (!confirmed) return undefined;
  let verdict;
  return (raw) => {
    if (verdict !== undefined) return verdict;
    const found = /"help"\s*:\s*(\{[^{}]*\})/.exec(raw);
    if (!found) return false;
    try {
      const help = JSON.parse(found[1]);
      verdict =
        validHelp(help) && help.supplies.every((id) => confirmed.includes(id));
    } catch {
      verdict = false;
    }
    return verdict;
  };
}
