/** Structured-output JSON Schema for a captured quality-flow design request,
 * or undefined for retained legacy requests. */
export function designReplySchema(request: unknown): any;
/** Structure schemas by design version: fresh requests draw their floors
 * (4); 3 checks retained chain designs. */
export const STRUCTURE_SCHEMAS: Readonly<Record<3 | 4, any>>;
/** The structure-phase reply schema of one design version. */
export function structureReplySchema(version: 3 | 4): any;
