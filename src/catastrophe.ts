/**
 * The sealed catastrophe spec (docs/ESCAPE_REDESIGN.md section 3).
 *
 * Pure data in, pure data out: no DOM, no engine imports, only the shared
 * contracts from ./escape-types. The validator bounds every number so the
 * engine can always run a generated spec; the timeline helpers turn that spec
 * into a phase, a behaviour set and an omen schedule at a game time.
 */
import type {
  Behaviour,
  CatastrophePhase,
  CatastropheSpec,
  Omen,
  PhaseName,
} from "./escape-types";

/** Every numeric bound the validator enforces, frozen for callers to share. */
export const CATASTROPHE_LIMITS = Object.freeze({
  titleMaxChars: 80,
  premiseMaxChars: 1200,
  publicStoryMaxChars: 400,
  roomHintMaxChars: 80,
  behaviourMin: 1,
  behaviourMax: 3,
  hunterScaleMin: 0.6,
  hunterScaleMax: 2.2,
  hunterCountMin: 1,
  hunterCountMax: 40,
  hunterSpeedMin: 0.4,
  hunterSpeedMax: 1.6,
  hunterSightRangeMin: 2,
  hunterSightRangeMax: 14,
  hearingWeightMin: 0,
  hearingWeightMax: 1,
  hunterDamageMin: 4,
  hunterDamageMax: 60,
  hazardSpreadRateMin: 0.02,
  hazardSpreadRateMax: 1.5,
  hazardDamagePerSecondMin: 0.5,
  hazardDamagePerSecondMax: 40,
  obscuresMin: 0,
  obscuresMax: 1,
  perceptionDamagePerSecondMin: 1,
  perceptionDamagePerSecondMax: 60,
  thresholdMin: 0,
  thresholdMax: 10,
  collapseCadenceMin: 10,
  collapseCadenceMax: 600,
  graceSecondsMin: 240,
  graceSecondsMax: 900,
  phaseMin: 2,
  phaseMax: 6,
  intensityMin: 0,
  intensityMax: 1,
  omenMin: 5,
  omenMax: 10,
  omenTextMaxChars: 280,
});

const PHASE_NAMES: readonly string[] = ["omens", "onset", "spread", "peak"];
const BEHAVIOUR_KINDS: readonly string[] = [
  "hunter",
  "hazard",
  "perception-rule",
  "collapse",
];
const SILHOUETTES: readonly string[] = [
  "humanoid",
  "quadruped",
  "serpentine",
  "swarm",
  "amorphous",
];
const DOOR_RULES: readonly string[] = ["break", "open", "blocked"];
const SPAWN_RULES: readonly string[] = ["single", "breeding", "waves"];
const HAZARD_MEDIA: readonly string[] = [
  "fire",
  "smoke",
  "water",
  "gas",
  "vacuum",
  "cold",
];
const PERCEPTION_TRIGGERS: readonly string[] = [
  "sees-own-reflection",
  "makes-sound",
  "in-darkness",
  "looks-at-entity",
];
const PERCEPTION_EFFECTS: readonly string[] = ["damage", "instant-death"];
const WARNINGS: readonly string[] = [
  "none",
  "whisper",
  "frost",
  "flicker",
  "ringing",
];
const COLLAPSE_TARGETS: readonly string[] = [
  "power",
  "doors",
  "structure",
  "life-support",
];
const OMEN_EFFECTS: readonly string[] = [
  "flicker",
  "alarm",
  "lockdown",
  "noise",
  "none",
];

const SPEC_FIELDS: readonly string[] = [
  "id",
  "title",
  "premise",
  "origin",
  "behaviours",
  "timeline",
  "omens",
  "publicStory",
];
const ORIGIN_FIELDS: readonly string[] = ["areaId", "roomHint"];
const PHASE_FIELDS: readonly string[] = [
  "name",
  "at",
  "behaviours",
  "intensity",
];
const OMEN_FIELDS: readonly string[] = [
  "id",
  "text",
  "at",
  "areaId",
  "roomHint",
  "effect",
];

type Problems = string[];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const show = (value: unknown) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

function reportUnknown(
  out: Problems,
  value: Record<string, unknown>,
  prefix: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) out.push(`${prefix}${key}: unknown field`);
  }
}

function checkText(
  out: Problems,
  path: string,
  value: unknown,
  max?: number,
): value is string {
  if (typeof value !== "string" || value.trim() === "") {
    out.push(`${path}: expected a non-empty string`);
    return false;
  }
  if (max !== undefined && value.trim().length > max) {
    out.push(
      `${path}: expected at most ${max} characters, got ${value.trim().length}`,
    );
    return false;
  }
  return true;
}

function checkOptionalText(
  out: Problems,
  path: string,
  value: unknown,
  max: number,
): boolean {
  return value === undefined || checkText(out, path, value, max);
}

function checkNumber(
  out: Problems,
  path: string,
  value: unknown,
  min: number,
  max: number,
): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    out.push(`${path}: expected a finite number`);
    return false;
  }
  if (value < min || value > max) {
    out.push(`${path}: expected ${min}..${max}, got ${value}`);
    return false;
  }
  return true;
}

function checkInteger(
  out: Problems,
  path: string,
  value: unknown,
  min: number,
  max: number,
): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    out.push(`${path}: expected a finite number`);
    return false;
  }
  if (!Number.isInteger(value) || value < min || value > max) {
    out.push(`${path}: expected an integer ${min}..${max}, got ${value}`);
    return false;
  }
  return true;
}

function checkBoolean(out: Problems, path: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    out.push(`${path}: expected a boolean, got ${show(value)}`);
    return false;
  }
  return true;
}

function checkOneOf(
  out: Problems,
  path: string,
  value: unknown,
  options: readonly string[],
): boolean {
  if (typeof value !== "string" || !options.includes(value)) {
    out.push(
      `${path}: expected one of ${options.map((o) => `"${o}"`).join(", ")}, got ${show(value)}`,
    );
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* Behaviours                                                          */
/* ------------------------------------------------------------------ */

const HUNTER_FIELDS: readonly string[] = [
  "kind",
  "body",
  "count",
  "speed",
  "sightRange",
  "hearingWeight",
  "doors",
  "damage",
  "spawn",
];
const BODY_FIELDS: readonly string[] = ["color", "scale", "silhouette"];
const HAZARD_FIELDS: readonly string[] = [
  "kind",
  "medium",
  "spreadRate",
  "damagePerSecond",
  "blockedByClosedDoors",
  "obscures",
];
const PERCEPTION_FIELDS: readonly string[] = [
  "kind",
  "trigger",
  "threshold",
  "effect",
  "damagePerSecond",
  "warning",
];
const COLLAPSE_FIELDS: readonly string[] = ["kind", "targets", "cadence"];

function validateBody(out: Problems, path: string, value: unknown): void {
  if (!isRecord(value)) {
    out.push(`${path}: expected an object`);
    return;
  }
  reportUnknown(out, value, `${path}.`, BODY_FIELDS);
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) {
    out.push(
      `${path}.color: expected a hex colour like "#a1b2c3", got ${show(value.color)}`,
    );
  }
  checkNumber(
    out,
    `${path}.scale`,
    value.scale,
    CATASTROPHE_LIMITS.hunterScaleMin,
    CATASTROPHE_LIMITS.hunterScaleMax,
  );
  checkOneOf(out, `${path}.silhouette`, value.silhouette, SILHOUETTES);
}

function validateHunter(
  out: Problems,
  path: string,
  value: Record<string, unknown>,
): void {
  reportUnknown(out, value, `${path}.`, HUNTER_FIELDS);
  validateBody(out, `${path}.body`, value.body);
  checkInteger(
    out,
    `${path}.count`,
    value.count,
    CATASTROPHE_LIMITS.hunterCountMin,
    CATASTROPHE_LIMITS.hunterCountMax,
  );
  checkNumber(
    out,
    `${path}.speed`,
    value.speed,
    CATASTROPHE_LIMITS.hunterSpeedMin,
    CATASTROPHE_LIMITS.hunterSpeedMax,
  );
  checkNumber(
    out,
    `${path}.sightRange`,
    value.sightRange,
    CATASTROPHE_LIMITS.hunterSightRangeMin,
    CATASTROPHE_LIMITS.hunterSightRangeMax,
  );
  checkNumber(
    out,
    `${path}.hearingWeight`,
    value.hearingWeight,
    CATASTROPHE_LIMITS.hearingWeightMin,
    CATASTROPHE_LIMITS.hearingWeightMax,
  );
  checkOneOf(out, `${path}.doors`, value.doors, DOOR_RULES);
  checkNumber(
    out,
    `${path}.damage`,
    value.damage,
    CATASTROPHE_LIMITS.hunterDamageMin,
    CATASTROPHE_LIMITS.hunterDamageMax,
  );
  checkOneOf(out, `${path}.spawn`, value.spawn, SPAWN_RULES);
}

function validateHazard(
  out: Problems,
  path: string,
  value: Record<string, unknown>,
): void {
  reportUnknown(out, value, `${path}.`, HAZARD_FIELDS);
  checkOneOf(out, `${path}.medium`, value.medium, HAZARD_MEDIA);
  checkNumber(
    out,
    `${path}.spreadRate`,
    value.spreadRate,
    CATASTROPHE_LIMITS.hazardSpreadRateMin,
    CATASTROPHE_LIMITS.hazardSpreadRateMax,
  );
  checkNumber(
    out,
    `${path}.damagePerSecond`,
    value.damagePerSecond,
    CATASTROPHE_LIMITS.hazardDamagePerSecondMin,
    CATASTROPHE_LIMITS.hazardDamagePerSecondMax,
  );
  checkBoolean(out, `${path}.blockedByClosedDoors`, value.blockedByClosedDoors);
  checkNumber(
    out,
    `${path}.obscures`,
    value.obscures,
    CATASTROPHE_LIMITS.obscuresMin,
    CATASTROPHE_LIMITS.obscuresMax,
  );
}

function validatePerception(
  out: Problems,
  path: string,
  value: Record<string, unknown>,
): void {
  reportUnknown(out, value, `${path}.`, PERCEPTION_FIELDS);
  checkOneOf(out, `${path}.trigger`, value.trigger, PERCEPTION_TRIGGERS);
  checkOneOf(out, `${path}.effect`, value.effect, PERCEPTION_EFFECTS);
  if (value.trigger === "makes-sound" && value.threshold === undefined) {
    out.push(`${path}.threshold: required when trigger is "makes-sound"`);
  } else if (value.threshold !== undefined) {
    checkNumber(
      out,
      `${path}.threshold`,
      value.threshold,
      CATASTROPHE_LIMITS.thresholdMin,
      CATASTROPHE_LIMITS.thresholdMax,
    );
  }
  if (value.effect === "damage" && value.damagePerSecond === undefined) {
    out.push(`${path}.damagePerSecond: required when effect is "damage"`);
  } else if (value.damagePerSecond !== undefined) {
    checkNumber(
      out,
      `${path}.damagePerSecond`,
      value.damagePerSecond,
      CATASTROPHE_LIMITS.perceptionDamagePerSecondMin,
      CATASTROPHE_LIMITS.perceptionDamagePerSecondMax,
    );
  }
  checkOneOf(out, `${path}.warning`, value.warning, WARNINGS);
}

function validateCollapse(
  out: Problems,
  path: string,
  value: Record<string, unknown>,
): void {
  reportUnknown(out, value, `${path}.`, COLLAPSE_FIELDS);
  if (!Array.isArray(value.targets)) {
    out.push(`${path}.targets: expected an array`);
  } else if (value.targets.length === 0) {
    out.push(`${path}.targets: expected at least one target`);
  } else {
    const seen = new Set<string>();
    value.targets.forEach((target, index) => {
      if (
        !checkOneOf(out, `${path}.targets[${index}]`, target, COLLAPSE_TARGETS)
      )
        return;
      if (seen.has(target as string)) {
        out.push(`${path}.targets: duplicate target ${show(target)}`);
      }
      seen.add(target as string);
    });
  }
  checkNumber(
    out,
    `${path}.cadence`,
    value.cadence,
    CATASTROPHE_LIMITS.collapseCadenceMin,
    CATASTROPHE_LIMITS.collapseCadenceMax,
  );
}

function validateBehaviour(out: Problems, value: unknown, path: string): void {
  if (!isRecord(value)) {
    out.push(`${path}: expected an object`);
    return;
  }
  if (!checkOneOf(out, `${path}.kind`, value.kind, BEHAVIOUR_KINDS)) return;
  if (value.kind === "hunter") validateHunter(out, path, value);
  else if (value.kind === "hazard") validateHazard(out, path, value);
  else if (value.kind === "perception-rule")
    validatePerception(out, path, value);
  else validateCollapse(out, path, value);
}

/** Validates every behaviour and returns how many entries the array holds. */
function validateBehaviours(out: Problems, value: unknown): number {
  if (!Array.isArray(value)) {
    out.push("behaviours: expected an array");
    return 0;
  }
  if (
    value.length < CATASTROPHE_LIMITS.behaviourMin ||
    value.length > CATASTROPHE_LIMITS.behaviourMax
  ) {
    out.push(
      `behaviours: expected ${CATASTROPHE_LIMITS.behaviourMin}..${CATASTROPHE_LIMITS.behaviourMax} entries, got ${value.length}`,
    );
  }
  value.forEach((entry, index) =>
    validateBehaviour(out, entry, `behaviours[${index}]`),
  );
  return value.length;
}

/* ------------------------------------------------------------------ */
/* Origin, timeline and omens                                          */
/* ------------------------------------------------------------------ */

function validateOrigin(
  out: Problems,
  value: unknown,
  areaIds: readonly string[],
): void {
  if (!isRecord(value)) {
    out.push("origin: expected an object");
    return;
  }
  reportUnknown(out, value, "origin.", ORIGIN_FIELDS);
  if (typeof value.areaId !== "string" || !areaIds.includes(value.areaId)) {
    out.push(
      `origin.areaId: expected one of ${areaIds.map((id) => `"${id}"`).join(", ") || "the known areas"}, got ${show(value.areaId)}`,
    );
  }
  checkOptionalText(
    out,
    "origin.roomHint",
    value.roomHint,
    CATASTROPHE_LIMITS.roomHintMaxChars,
  );
}

function validateTimeline(
  out: Problems,
  value: unknown,
  behaviourCount: number,
): number | undefined {
  if (!isRecord(value)) {
    out.push("timeline: expected an object");
    return undefined;
  }
  reportUnknown(out, value, "timeline.", ["graceSeconds", "phases"]);
  const graceOk = checkNumber(
    out,
    "timeline.graceSeconds",
    value.graceSeconds,
    CATASTROPHE_LIMITS.graceSecondsMin,
    CATASTROPHE_LIMITS.graceSecondsMax,
  );
  const grace = graceOk ? (value.graceSeconds as number) : undefined;
  if (!Array.isArray(value.phases)) {
    out.push("timeline.phases: expected an array");
    return undefined;
  }
  const phases = value.phases;
  if (
    phases.length < CATASTROPHE_LIMITS.phaseMin ||
    phases.length > CATASTROPHE_LIMITS.phaseMax
  ) {
    out.push(
      `timeline.phases: expected ${CATASTROPHE_LIMITS.phaseMin}..${CATASTROPHE_LIMITS.phaseMax} entries, got ${phases.length}`,
    );
  }
  const seenNames = new Set<string>();
  let previousAt: number | undefined;
  let lastAt: number | undefined;
  let onsetIndex = -1;
  phases.forEach((phase, index) => {
    const path = `timeline.phases[${index}]`;
    if (!isRecord(phase)) {
      out.push(`${path}: expected an object`);
      return;
    }
    reportUnknown(out, phase, `${path}.`, PHASE_FIELDS);
    if (checkOneOf(out, `${path}.name`, phase.name, PHASE_NAMES)) {
      if (seenNames.has(phase.name as string)) {
        out.push(`${path}.name: duplicate phase name ${show(phase.name)}`);
      }
      seenNames.add(phase.name as string);
      if (phase.name === "onset" && onsetIndex === -1) onsetIndex = index;
    }
    if (index === 0 && phase.name !== "omens") {
      out.push(`${path}.name: the first phase must be "omens"`);
    }
    if (typeof phase.at === "number" && Number.isFinite(phase.at)) {
      const at = phase.at;
      if (at < 0) {
        out.push(`${path}.at: expected a value at or after 0, got ${at}`);
      }
      if (previousAt !== undefined && at <= previousAt) {
        out.push(
          `${path}.at: expected a value greater than the previous phase, got ${at}`,
        );
      }
      if (
        index === 0 &&
        grace !== undefined &&
        phase.name === "omens" &&
        at >= grace
      ) {
        out.push(
          `${path}.at: expected a value before the grace period, got ${at}`,
        );
      }
      if (
        phase.name === "onset" &&
        onsetIndex === index &&
        grace !== undefined &&
        at < grace
      ) {
        out.push(
          `${path}.at: expected the onset phase at or after the grace period, got ${at}`,
        );
      }
      previousAt = at;
      lastAt = at;
    } else {
      out.push(`${path}.at: expected a finite number`);
    }
    if (!Array.isArray(phase.behaviours)) {
      out.push(`${path}.behaviours: expected an array`);
    } else {
      const seenIndexes = new Set<number>();
      phase.behaviours.forEach((entry, entryIndex) => {
        if (
          behaviourCount < 1 ||
          !checkInteger(
            out,
            `${path}.behaviours[${entryIndex}]`,
            entry,
            0,
            behaviourCount - 1,
          )
        )
          return;
        if (seenIndexes.has(entry as number)) {
          out.push(`${path}.behaviours: duplicate behaviour index ${entry}`);
        }
        seenIndexes.add(entry as number);
      });
    }
    checkNumber(
      out,
      `${path}.intensity`,
      phase.intensity,
      CATASTROPHE_LIMITS.intensityMin,
      CATASTROPHE_LIMITS.intensityMax,
    );
  });
  if (onsetIndex === -1) {
    out.push('timeline.phases: expected a phase named "onset"');
  } else {
    const active = new Set<number>();
    phases.forEach((phase, index) => {
      if (index < onsetIndex || !isRecord(phase)) return;
      if (!Array.isArray(phase.behaviours)) return;
      for (const entry of phase.behaviours) {
        if (
          typeof entry === "number" &&
          Number.isInteger(entry) &&
          entry >= 0 &&
          entry < behaviourCount
        ) {
          active.add(entry);
        }
      }
    });
    for (let index = 0; index < behaviourCount; index += 1) {
      if (!active.has(index)) {
        out.push(
          `timeline.phases: behaviour ${index} is never active at or after onset`,
        );
      }
    }
  }
  return lastAt;
}

function validateOmens(
  out: Problems,
  value: unknown,
  areaIds: readonly string[],
  lastPhaseAt: number | undefined,
): void {
  if (!Array.isArray(value)) {
    out.push("omens: expected an array");
    return;
  }
  if (
    value.length < CATASTROPHE_LIMITS.omenMin ||
    value.length > CATASTROPHE_LIMITS.omenMax
  ) {
    out.push(
      `omens: expected ${CATASTROPHE_LIMITS.omenMin}..${CATASTROPHE_LIMITS.omenMax} entries, got ${value.length}`,
    );
  }
  const seenIds = new Set<string>();
  value.forEach((omen, index) => {
    const path = `omens[${index}]`;
    if (!isRecord(omen)) {
      out.push(`${path}: expected an object`);
      return;
    }
    reportUnknown(out, omen, `${path}.`, OMEN_FIELDS);
    if (checkText(out, `${path}.id`, omen.id)) {
      if (seenIds.has(omen.id)) {
        out.push(`${path}.id: duplicate omen id ${show(omen.id)}`);
      }
      seenIds.add(omen.id);
    }
    checkText(
      out,
      `${path}.text`,
      omen.text,
      CATASTROPHE_LIMITS.omenTextMaxChars,
    );
    if (typeof omen.at === "number" && Number.isFinite(omen.at)) {
      if (omen.at < 0) {
        out.push(`${path}.at: expected a value at or after 0, got ${omen.at}`);
      }
      if (lastPhaseAt !== undefined && omen.at >= lastPhaseAt) {
        out.push(
          `${path}.at: expected a value before the last phase, got ${omen.at}`,
        );
      }
    } else {
      out.push(`${path}.at: expected a finite number`);
    }
    if (typeof omen.areaId !== "string" || !areaIds.includes(omen.areaId)) {
      out.push(
        `${path}.areaId: expected one of ${areaIds.map((id) => `"${id}"`).join(", ") || "the known areas"}, got ${show(omen.areaId)}`,
      );
    }
    checkOptionalText(
      out,
      `${path}.roomHint`,
      omen.roomHint,
      CATASTROPHE_LIMITS.roomHintMaxChars,
    );
    if (omen.effect !== undefined) {
      checkOneOf(out, `${path}.effect`, omen.effect, OMEN_EFFECTS);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Validation entry point                                              */
/* ------------------------------------------------------------------ */

/**
 * Returns every problem with `spec` in one pass, each as
 * `"<json-ish path>: <what is wrong>"`. An empty array means valid.
 */
export function validateCatastrophe(
  spec: unknown,
  areaIds: readonly string[],
): string[] {
  const out: Problems = [];
  if (!isRecord(spec)) return ["spec: expected an object"];
  reportUnknown(out, spec, "", SPEC_FIELDS);
  checkText(out, "id", spec.id);
  checkText(out, "title", spec.title, CATASTROPHE_LIMITS.titleMaxChars);
  checkText(out, "premise", spec.premise, CATASTROPHE_LIMITS.premiseMaxChars);
  checkText(
    out,
    "publicStory",
    spec.publicStory,
    CATASTROPHE_LIMITS.publicStoryMaxChars,
  );
  validateOrigin(out, spec.origin, areaIds);
  const behaviourCount = validateBehaviours(out, spec.behaviours);
  const lastPhaseAt = validateTimeline(out, spec.timeline, behaviourCount);
  validateOmens(out, spec.omens, areaIds, lastPhaseAt);
  return out;
}

/* ------------------------------------------------------------------ */
/* Timeline queries                                                    */
/* ------------------------------------------------------------------ */

/** Seconds after start at which the onset phase begins. */
export function onsetAt(spec: CatastropheSpec): number {
  const onset = spec.timeline.phases.find((phase) => phase.name === "onset");
  return onset ? onset.at : Number.POSITIVE_INFINITY;
}

/** The phase, intensity and active behaviours at game time `t`. */
export function catastropheState(
  spec: CatastropheSpec,
  t: number,
): {
  phase: PhaseName | "calm";
  intensity: number;
  behaviours: Behaviour[];
  onset: boolean;
} {
  const phases = spec.timeline.phases;
  const reached: CatastrophePhase[] = [];
  for (const phase of phases) {
    if (phase.at <= t) reached.push(phase);
  }
  if (reached.length === 0) {
    return {
      phase: "calm",
      intensity: 0,
      behaviours: [],
      onset: false,
    };
  }
  let current = reached[0]!;
  for (const phase of reached) {
    if (phase.at >= current.at) current = phase;
  }
  const indexes = new Set<number>();
  for (const phase of reached) {
    if (phase.name === "omens") continue;
    for (const index of phase.behaviours) indexes.add(index);
  }
  const behaviours: Behaviour[] = [];
  for (const index of [...indexes].sort((a, b) => a - b)) {
    const behaviour = spec.behaviours[index];
    if (behaviour) behaviours.push(behaviour);
  }
  return {
    phase: current.name,
    intensity: current.intensity,
    behaviours,
    onset: t >= onsetAt(spec),
  };
}

/** Omens that fall in the half-open window `from < at <= to`. */
export function omensDue(
  spec: CatastropheSpec,
  from: number,
  to: number,
): Omen[] {
  return spec.omens
    .filter((omen) => omen.at > from && omen.at <= to)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ------------------------------------------------------------------ */
/* Deterministic offline fallback spec                                 */
/* ------------------------------------------------------------------ */

const FALLBACK_OMEN_TIMES: readonly number[] = [20, 60, 120, 180, 240, 300];
const FALLBACK_OMEN_TEXTS: readonly string[] = [
  "The lights stutter twice and settle.",
  "A sensor on the service ring reports a fault that clears itself.",
  "Someone down the corridor complains of a headache and a metallic taste.",
  "A door latches on its own and refuses the next badge swipe.",
  "The ventilation hum drops a note, then returns.",
  "A maintenance panel clicks open with nothing behind it.",
];

/** Small integer hash of the seed; deterministic for any finite number. */
function seedHash(seed: number): number {
  const value = Number.isFinite(seed) ? Math.trunc(seed) : 0;
  let hash = 0x811c9dc5;
  for (const shift of [0, 8, 16, 24]) {
    hash ^= (value >>> shift) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0x5bd1e995);
  hash ^= hash >>> 15;
  return hash >>> 0;
}

const FALLBACK_TEMPLATE_COUNT = 4;

function fallbackTimeline(
  graceSeconds: number,
  behaviourCount: number,
): CatastropheSpec["timeline"] {
  const phases: CatastrophePhase[] = [
    { name: "omens", at: 45, behaviours: [], intensity: 0.2 },
    { name: "onset", at: graceSeconds, behaviours: [0], intensity: 0.5 },
    {
      name: "spread",
      at: graceSeconds + 120,
      behaviours: behaviourCount > 1 ? [1] : [],
      intensity: 0.75,
    },
    { name: "peak", at: graceSeconds + 240, behaviours: [0], intensity: 1 },
  ];
  return { graceSeconds, phases };
}

function fallbackOmens(areaId: string): Omen[] {
  return FALLBACK_OMEN_TEXTS.map((text, index) => ({
    id: `omen-${index + 1}`,
    text,
    at: FALLBACK_OMEN_TIMES[index] ?? 0,
    areaId,
    effect: index === 0 ? "flicker" : index === 1 ? "alarm" : "none",
  }));
}

/**
 * A bounded, validating spec drawn from four templates by a hash of the seed.
 * Used by seed-only games and tests, so the same seed always yields the same
 * deep-equal spec.
 */
export function fallbackCatastrophe(
  seed: number,
  areaId: string,
): CatastropheSpec {
  const hash = seedHash(seed);
  const token = hash.toString(16).padStart(8, "0");
  const template = hash % FALLBACK_TEMPLATE_COUNT;
  const graceSeconds = CATASTROPHE_LIMITS.graceSecondsMin + template * 120;
  const omens = fallbackOmens(areaId);
  if (template === 0) {
    return {
      id: `fallback-hunter-${token}`,
      title: "Something is loose in the service corridors",
      premise:
        "A breeding pack of predators escaped the bio-lab through a maintenance shaft and now hunts the service corridors by sound.",
      origin: { areaId, roomHint: "Service corridor" },
      behaviours: [
        {
          kind: "hunter",
          body: {
            color: "#5b4a3f",
            scale: 1.05,
            silhouette: "quadruped",
          },
          count: 6,
          speed: 1.1,
          sightRange: 9,
          hearingWeight: 0.8,
          doors: "break",
          damage: 18,
          spawn: "waves",
        },
      ],
      timeline: fallbackTimeline(graceSeconds, 1),
      omens,
      publicStory:
        "A routine pest-control exercise is under way. Please keep to the lit corridors.",
    };
  }
  if (template === 1) {
    return {
      id: `fallback-hazard-${token}`,
      title: "The recycling plant is venting",
      premise:
        "A cracked coolant line is feeding an unseen fire in the walls; smoke fills the ring room by room while the power grid sheds load.",
      origin: { areaId, roomHint: "Recycling plant" },
      behaviours: [
        {
          kind: "hazard",
          medium: "smoke",
          spreadRate: 0.35,
          damagePerSecond: 6,
          blockedByClosedDoors: true,
          obscures: 0.7,
        },
        { kind: "collapse", targets: ["power", "doors"], cadence: 90 },
      ],
      timeline: fallbackTimeline(graceSeconds, 2),
      omens,
      publicStory:
        "Maintenance is clearing a minor ventilation fault. There is no need to leave the ring.",
    };
  }
  if (template === 2) {
    return {
      id: `fallback-perception-${token}`,
      title: "Do not look at the polished panels",
      premise:
        "The mirror-polished survey panels carry a latent charge that turns a reflected gaze into a measured, lethal pulse through the optic nerve.",
      origin: { areaId, roomHint: "Survey lounge" },
      behaviours: [
        {
          kind: "perception-rule",
          trigger: "sees-own-reflection",
          effect: "damage",
          damagePerSecond: 12,
          warning: "flicker",
        },
      ],
      timeline: fallbackTimeline(graceSeconds, 1),
      omens,
      publicStory:
        "The survey lounge is closed for polishing. Reflections may be unreliable; staff should look away.",
    };
  }
  return {
    id: `fallback-collapse-${token}`,
    title: "The station is shedding sections",
    premise:
      "Fatigue cracks in the spine frame are propagating; the structure fails in sequence, dropping decks and cutting power and life support as it goes.",
    origin: { areaId, roomHint: "Spine junction" },
    behaviours: [
      {
        kind: "collapse",
        targets: ["power", "structure", "life-support"],
        cadence: 45,
      },
    ],
    timeline: fallbackTimeline(graceSeconds, 1),
    omens,
    publicStory:
      "Structural surveys are running all shift. Small tremors are expected and should be ignored.",
  };
}
