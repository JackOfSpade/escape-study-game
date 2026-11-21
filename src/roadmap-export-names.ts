/** Names the roadmap export writes, with the names earlier builds wrote.
 *
 * Exports written before the study rename carry the legacy forms: the
 * `GAME_AI_ASSESSED_<OUTCOME>` evidence modes and the
 * "0.12 Game semantic scope and continuation state" heading. Those files stay
 * valid for a long time (saved exports, adopted uploads, other devices), so
 * every reader accepts both forms and new exports write only the current ones.
 * Keep the compatibility in this one place. */
export const ASSESSED_TOKEN_PREFIX = "STUDY_AI_ASSESSED_";
/** Written by exports from earlier builds; read, never newly written. */
export const LEGACY_ASSESSED_TOKEN_PREFIX = "GAME_AI_ASSESSED_";
export const ASSESSED_OUTCOMES = [
  "independent",
  "assisted",
  "contradicted",
  "unknown",
] as const;

export const assessedToken = (outcome: string) =>
  `${ASSESSED_TOKEN_PREFIX}${outcome.toUpperCase()}`;
export const legacyAssessedToken = (outcome: string) =>
  `${LEGACY_ASSESSED_TOKEN_PREFIX}${outcome.toUpperCase()}`;

/** True for an app-assessed evidence mode in either the current or legacy form. */
export const isAssessedToken = (mode: string) =>
  mode.startsWith(ASSESSED_TOKEN_PREFIX) ||
  mode.startsWith(LEGACY_ASSESSED_TOKEN_PREFIX);

/** True when the mode is exactly the app-assessed token for this outcome, in
 * either form. */
export const isAssessedTokenFor = (mode: string, outcome: string) =>
  mode === assessedToken(outcome) || mode === legacyAssessedToken(outcome);

export const SUPPLEMENT_HEADING =
  "0.12 Study semantic scope and continuation state";
/** Written by exports from earlier builds; read, never newly written. */
export const LEGACY_SUPPLEMENT_HEADING =
  "0.12 Game semantic scope and continuation state";
/** Current heading first. */
export const SUPPLEMENT_HEADINGS = [
  SUPPLEMENT_HEADING,
  LEGACY_SUPPLEMENT_HEADING,
] as const;

/** The 0.12 heading a progress block carries, current form preferred. */
export const supplementHeadingIn = (progress: string) =>
  SUPPLEMENT_HEADINGS.find((h) => progress.includes(`### ${h}\n`));
