import { isRecord as object } from "./is-record.mjs";

/**
 * Knowledge-probe reply fields shared by the Claude gateway, the live terminal
 * relay app and the synthetic demo app. The game validates the same shape
 * again in src/knowledge-probe.ts (parseProbeReply); this module only keeps
 * the transport-side checks and JSON Schema in one place.
 */
export const FINDING_STATUSES = ["demonstrated", "implied", "gap"];
export const FLUENCY = ["fluent", "partial", "guessing", "declared-gap"];
export const OUTCOMES = ["solved", "gap"];
const optionalString = (value) =>
  value === undefined || typeof value === "string";

/** JSON Schema properties for the optional probe fields of a reply tool. */
export const probeReplyProperties = () => ({
  outcome: {
    type: "string",
    enum: OUTCOMES,
    description:
      "Only with complete:true. solved: the learner's own answers solve it. gap: the learner declared they do not know what remains and no lower-level facet is left to probe; the game records the gap and still grants its once-only key.",
  },
  knowledge: {
    type: "object",
    description:
      "Facet-level judgment. Use ids from the turn's probe.facets, or declare a prerequisite part the question did not list with partOf and description. A demonstrated facet whose correct answer necessarily needed other facets marks those implied with impliedBy. signal says how the latest answer was given.",
    properties: {
      facets: {
        type: "array",
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 200 },
            status: { type: "string", enum: FINDING_STATUSES },
            impliedBy: { type: "string", minLength: 1, maxLength: 200 },
            note: { type: "string", maxLength: 400 },
            partOf: {
              type: "string",
              minLength: 1,
              maxLength: 200,
              description:
                "Declares a prerequisite part the question did not list: the known facet id it is part of. Requires description.",
            },
            description: { type: "string", minLength: 1, maxLength: 200 },
          },
          required: ["id", "status"],
          additionalProperties: false,
        },
      },
      signal: {
        type: "object",
        properties: {
          fluency: { type: "string", enum: FLUENCY },
          note: { type: "string", maxLength: 400 },
        },
        required: ["fluency"],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
});

/** `outcome` absent, or one of the allowed values. */
export const validProbeOutcome = (args) =>
  args.outcome === undefined || OUTCOMES.includes(args.outcome);

/** `knowledge` absent, or {facets?:[{id,status,impliedBy?,note?,partOf?,description?}],signal?:{fluency,note?}}. */
export function validProbeKnowledge(args) {
  if (args.knowledge === undefined) return true;
  const k = args.knowledge;
  if (!object(k)) return false;
  if (
    k.facets !== undefined &&
    (!Array.isArray(k.facets) ||
      k.facets.length > 64 ||
      k.facets.some(
        (f) =>
          !object(f) ||
          typeof f.id !== "string" ||
          !FINDING_STATUSES.includes(f.status) ||
          !optionalString(f.impliedBy) ||
          !optionalString(f.note) ||
          !optionalString(f.partOf) ||
          !optionalString(f.description),
      ))
  )
    return false;
  if (
    k.signal !== undefined &&
    (!object(k.signal) ||
      !FLUENCY.includes(k.signal.fluency) ||
      !optionalString(k.signal.note))
  )
    return false;
  return true;
}

/** Shape check matching the queue's terminal-dialogue validation. */
export const validProbeReply = (args) =>
  validProbeOutcome(args) && validProbeKnowledge(args);

/** The reply the game receives: text and complete, plus the optional probe fields when given. */
export const probeReplyFields = (args) => ({
  text: args.text,
  complete: args.complete,
  ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
  ...(args.knowledge !== undefined ? { knowledge: args.knowledge } : {}),
});

export const PROBE_REPLY_ERROR =
  "Expected bounded text, complete:boolean and, optionally, outcome solved|gap and knowledge {facets:[{id,status}],signal?} for this turn";
