export declare const ESCAPE_OPERATIONS: readonly string[];
export declare const ESCAPE_CONTRACTS: Readonly<Record<string, string>>;
/** The ways out a plan may use; mirrors PLAN_MEANS in src/escape-types.ts. */
export declare const PLAN_MEANS: readonly string[];
/** What a plan step may depend on; mirrors PLAN_RESOURCES in src/escape-types.ts. */
export declare const PLAN_RESOURCES: readonly string[];
/** Throws with a specific message on any violation; returns the normalised answer. */
export declare function validateEscapeAnswer(
  operation: string,
  payload: unknown,
  answer: unknown,
): unknown;
