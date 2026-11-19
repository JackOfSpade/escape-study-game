import type { LearnerLedger } from "./learning-model";
import type { Contract, Objective, Roadmap, StudyState } from "./model";
import { reconcileGates, restoreFullQueues } from "./learner";

/**
 * Reversible career-focus profile. "product-feature-owner" narrows the PE
 * track's FUTURE scheduling/gates to an explicit role core (max depth 3);
 * "full" (or undefined) is the original curriculum. Source definitions,
 * objective targets/cells, ledger evidence and reviews are never changed.
 */
export type CareerFocus = "product-feature-owner" | "full";
type CareerPriority = "core" | "reference" | "optional";
type Focusable = { careerFocus?: CareerFocus };

const ROLE_MAX_PE_DEPTH = 3;
const CAREER_FOCUS_LABELS: Record<CareerFocus, string> = {
  "product-feature-owner": "Product feature owner (role profile)",
  full: "Full curriculum",
};
export const CORE_IDS: readonly string[] = [
  "PE:T01.1",
  "PE:T01.3",
  "PE:T01.5",
  "PE:T03.1",
  "PE:T04.2",
  "PE:T04.3",
  "PE:T04.4",
  "PE:T05.1",
  "PE:T05.2",
  "PE:T05.3",
  "PE:T05.4",
  "PE:T05.5",
  "PE:T06.1",
  "PE:T06.2",
  "PE:T06.3",
  "PE:T06.4",
  "PE:T06.5",
  "PE:T07.1",
  "PE:T07.2",
  "PE:T07.3",
  "PE:T07.4",
  "PE:T08.1",
  "PE:T08.2",
  "PE:T08.3",
  "PE:T09.1",
  "PE:T09.4",
  "PE:T10.1",
  "PE:T10.2",
  "PE:T11.1",
  "PE:T11.2",
  "PE:T11.3",
  "PE:T13.1",
  "PE:T13.2",
  "PE:T14.1",
  "PE:T14.2",
  "PE:T14.4",
  "PE:T14.5",
  "PE:T15.1",
  "PE:T18.1",
  "PE:T18.2",
  "PE:T18.3",
  "PE:T19.1",
  "PE:T19.3",
  "PE:T20.2",
  "PE:T20.4",
  "PE:X07.1",
  "PE:X08.1",
  "PE:X08.2",
  "PE:X08.3",
  "PE:X09.1",
  "PE:X09.2",
];
export const REFERENCE_IDS: readonly string[] = [
  "PE:T02.1",
  "PE:T02.3",
  "PE:T03.2",
  "PE:T04.1",
  "PE:T04.5",
  "PE:T08.4",
  "PE:T08.5",
  "PE:T09.2",
  "PE:T09.3",
  "PE:T09.5",
  "PE:T10.3",
  "PE:T10.4",
  "PE:T10.5",
  "PE:T11.4",
  "PE:T11.5",
  "PE:T12.1",
  "PE:T12.2",
  "PE:T12.3",
  "PE:T12.4",
  "PE:T13.3",
  "PE:T13.4",
  "PE:T13.5",
  "PE:T14.3",
  "PE:T15.2",
  "PE:T15.3",
  "PE:T15.4",
  "PE:T15.5",
  "PE:T16.1",
  "PE:T16.2",
  "PE:T16.3",
  "PE:T16.4",
  "PE:T16.5",
  "PE:T17.1",
  "PE:T17.2",
  "PE:T17.3",
  "PE:T17.4",
  "PE:T17.5",
  "PE:T18.4",
  "PE:T18.5",
  "PE:T19.2",
  "PE:T19.4",
  "PE:T20.1",
  "PE:T20.3",
  "PE:T20.5",
  "PE:X09.3",
];
const CORE = new Set(CORE_IDS),
  REFERENCE = new Set(REFERENCE_IDS);

/** The focus recorded on a ledger or study state; undefined means full. */
export const focusOf = (x: Focusable | undefined): CareerFocus | undefined =>
  x?.careerFocus;
export const roleFocused = (focus?: CareerFocus) =>
  focus === "product-feature-owner";
/** Focus governing scheduling for a study state: the live ledger's, else the study's. */
export const studyFocus = (s: StudyState): CareerFocus | undefined =>
  s.profile === "live" && s.learner
    ? focusOf(s.learner as Focusable)
    : focusOf(s as Focusable);

/** Priority of an objective under the role profile. PY is always core. */
export function careerPriority(id: string): CareerPriority {
  if (!id.startsWith("PE:")) return "core";
  if (CORE.has(id)) return "core";
  if (REFERENCE.has(id)) return "reference";
  return "optional";
}

/** Profile-specific required depth; 0 = never required/scheduled. */
export function effectiveTarget(
  o: Pick<Objective, "id" | "target">,
  focus?: CareerFocus,
): number {
  if (!roleFocused(focus) || !o.id.startsWith("PE:")) return o.target;
  if (careerPriority(o.id) !== "core") return 0;
  return Math.min(o.target, ROLE_MAX_PE_DEPTH);
}
/** The highest tier a track's gates reach under the focus. */
export const focusMaxTier = (track: string, focus?: CareerFocus) =>
  roleFocused(focus) && track === "PE" ? ROLE_MAX_PE_DEPTH : 4;

const GUIDANCE_LIMIT = 900;
/** Bounded plain-text scope policy for a contract under the focus. */
export function careerScopeGuidance(
  contract: Pick<Contract, "track" | "objectiveIds" | "depth">,
  focus?: CareerFocus,
): string {
  if (!roleFocused(focus) || contract.track !== "PE") return "";
  const priorities = contract.objectiveIds.map(careerPriority);
  const base =
    "Role profile: product engineer who owns a consumer/creative web feature end to end. Judge useful, polished, reliable UX with appropriate API, data and security correctness, not specialist infrastructure depth. Operational settings, protocol and handshake details may be supplied as facts or consulted documentation; never add them as mandatory facets outside the issued task. When the objective neither fixes a domain nor is about the learner's own projects or experience, set the question in a consumer or creative web feature, such as an editor, gallery, feed, upload or checkout.";
  const extra = priorities.includes("core")
    ? ` Ask only what the issued task states${contract.depth <= 1 ? "; at D1 keep it to bounded conceptual reasoning with at most one level of prerequisite clarification" : ""}.`
    : " This objective is working-awareness reference for the role: accept looked-up specifics, and do not treat it as a profile requirement.";
  return (base + extra).slice(0, GUIDANCE_LIMIT);
}

function counts(r: Roadmap, l: LearnerLedger | undefined, focus?: CareerFocus) {
  let passed = 0,
    required = 0;
  for (const track of ["PY", "PE"] as const)
    for (const o of r.tracks[track].objectives) {
      const target = effectiveTarget(o, focus);
      for (let d = 1; d <= target; d++) {
        required++;
        const state = l ? l.cells[o.id]?.states[d - 1] : o.cells[d - 1];
        if (state === "P") passed++;
      }
    }
  return { passed, required };
}
/** Profile progress for UI; active clearance never implies original readiness. */
export function careerProfileSummary(r: Roadmap, s: StudyState) {
  const focus: CareerFocus =
    studyFocus(s) === "product-feature-owner"
      ? "product-feature-owner"
      : "full";
  const pe = r.tracks.PE.objectives;
  return {
    focus,
    label: CAREER_FOCUS_LABELS[focus],
    active: counts(r, s.learner, focus),
    full: counts(r, s.learner, "full"),
    core: pe.filter((o) => careerPriority(o.id) === "core").length,
    reference: pe.filter((o) => careerPriority(o.id) === "reference").length,
    optional: pe.filter((o) => careerPriority(o.id) === "optional").length,
    deferred: roleFocused(focus)
      ? pe.filter((o) => careerPriority(o.id) !== "core").length
      : 0,
  };
}

/**
 * Explicitly switch the career focus. Only FUTURE scheduling and gates change:
 * evidence, cells, reviews and any in-progress formal attempt are preserved.
 * A formal question already issued for the pre-switch schedule (same ledger
 * version) stays acceptable instead of being rerolled.
 */
export function activateCareerFocus(
  r: Roadmap,
  s: StudyState,
  focus: CareerFocus = "product-feature-owner",
) {
  (s as Focusable).careerFocus = focus;
  const l = s.learner;
  if (!l) return s;
  const ledger = l as LearnerLedger & Focusable;
  const previous = ledger.careerFocus;
  if (previous === focus) {
    reconcileGates(r, l);
    return s;
  }
  // Only a question actually bound to a visit can be carried. Merely asking
  // the scheduler what would come next must not issue the pre-focus question.
  const carried = s.pending?.contract;
  if (focus === "product-feature-owner" && !roleFocused(previous))
    (
      ledger as LearnerLedger & {
        careerFullTrack?: LearnerLedger["tracks"]["PE"];
      }
    ).careerFullTrack = structuredClone(ledger.tracks.PE);
  ledger.careerFocus = focus;
  const carry = l as LearnerLedger & {
    careerCarryover?: { ledgerVersion: number; contract: Contract };
  };
  if (carried)
    carry.careerCarryover = { ledgerVersion: l.version, contract: carried };
  else delete carry.careerCarryover;
  if (!roleFocused(focus)) restoreFullQueues(r, l);
  reconcileGates(r, l);
  return s;
}
