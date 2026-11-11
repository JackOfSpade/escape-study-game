/**
 * Roadmap reconciliation replies describe the proposed file as a list of
 * exact edits to the local roadmap instead of the whole file. A complete
 * roadmap is several hundred thousand characters, more than a model will
 * write back in one reply, while the changes a reconciliation makes are small.
 * The client applies the edits to its own exact local snapshot, so every
 * byte it does not change is preserved by construction.
 */

export const ROADMAP_EDIT_LIMITS = Object.freeze({
  maxEdits: 1000,
  maxFindLength: 20_000,
  maxReplaceLength: 200_000,
});

/** The outcome that keeps the local roadmap and proposes nothing to adopt. */
export const KEEP_LOCAL = "keep-local";

export const ROADMAP_EDIT_GUIDANCE =
  "Describe the proposed file as edits, never as the whole file: edits is an ordered array of {find,replace} applied to payload.local. Each find is exact text that occurs exactly once in the document as it stands after the previous edits (include enough neighbouring text to make it unique); replace is the exact new text, or an empty string to delete. To add rows, find the row they follow and replace it with itself plus the new rows. Copy incoming rows exactly. Every part of local you do not edit is kept byte for byte, so update header fields such as revision and parent_file_sha256 with edits too. If the incoming file should not be adopted at all, return outcome:'keep-local' with rationale and decisions and no edits; that keeps the local roadmap unchanged and is a complete answer, not a failure.";

const occurrences = (text, find) => {
  let count = 0;
  for (let at = text.indexOf(find); at !== -1; at = text.indexOf(find, at + 1))
    if (++count > 1) break;
  return count;
};

/** Apply ordered exact-match edits; throws naming the first edit that fails. */
export function applyRoadmapEdits(local, edits) {
  if (typeof local !== "string") throw Error("Local roadmap is not text");
  if (!Array.isArray(edits) || !edits.length)
    throw Error(
      "edits must be a non-empty array; return outcome 'keep-local' to keep the local roadmap",
    );
  if (edits.length > ROADMAP_EDIT_LIMITS.maxEdits)
    throw Error(`edits has more than ${ROADMAP_EDIT_LIMITS.maxEdits} entries`);
  let text = local;
  edits.forEach((edit, index) => {
    const label = `edits[${index}]`;
    if (!edit || typeof edit !== "object" || Array.isArray(edit))
      throw Error(`${label} must be an object {find,replace}`);
    const { find, replace } = edit;
    if (typeof find !== "string" || !find)
      throw Error(`${label}.find must be non-empty text`);
    if (typeof replace !== "string")
      throw Error(`${label}.replace must be text`);
    if (find.length > ROADMAP_EDIT_LIMITS.maxFindLength)
      throw Error(
        `${label}.find is longer than ${ROADMAP_EDIT_LIMITS.maxFindLength} characters`,
      );
    if (replace.length > ROADMAP_EDIT_LIMITS.maxReplaceLength)
      throw Error(
        `${label}.replace is longer than ${ROADMAP_EDIT_LIMITS.maxReplaceLength} characters`,
      );
    const count = occurrences(text, find);
    if (count === 0)
      throw Error(`${label}.find does not occur in the document at that point`);
    if (count > 1)
      throw Error(
        `${label}.find occurs more than once; include more neighbouring text`,
      );
    const at = text.indexOf(find);
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  });
  if (text === local)
    throw Error(
      "edits leave the local roadmap unchanged; return outcome 'keep-local' instead",
    );
  return text;
}

/**
 * Turn an edit-based reply into the proposal shape the client reviews: the
 * edits become the complete `canonical` file. A reply that already carries
 * `canonical` (older saved requests) or keeps local is returned unchanged.
 */
export function expandRoadmapReconciliation(local, answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer))
    return answer;
  if (answer.outcome === KEEP_LOCAL || !Array.isArray(answer.edits))
    return answer;
  const { edits, ...rest } = answer;
  return { ...rest, canonical: applyRoadmapEdits(local, edits) };
}
