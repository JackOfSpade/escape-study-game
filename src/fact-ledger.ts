/**
 * Fact ledger and player journal (docs/ESCAPE_REDESIGN.md section 4).
 *
 * The ledger is plain saved JSON (`Game.escape.ledger`), so every function here
 * mutates the object it is given and returns the record it created. History is
 * append-only: a fact is never rewritten, only superseded by a later one.
 */

import type {
  Fact,
  FactLedger,
  FactSource,
  FactVisibility,
  JournalEntry,
} from "./escape-types";

export interface FactInput {
  text: string;
  subject: Fact["subject"];
  source: FactSource;
  visibility: FactVisibility[];
  /** Loop it was committed in. Omitted from the stored fact when not given. */
  loop?: number;
  /** World fact that stays true across loops. Default: false. */
  durable?: boolean;
}

export interface FactViewer {
  npcId?: string;
  role?: string;
  areaId?: string;
  documents?: readonly string[];
}

const MAX_TEXT = 280;
const MAX_LINE = 160;
const ADDRESSED_KINDS: readonly string[] = ["npc", "role", "document", "area"];

export function emptyLedger(): FactLedger {
  return { facts: [], journal: [], seq: 0 };
}

/** "public", "hidden", or "<kind>:<non-empty id>" for an addressed visibility. */
function validVisibilityEntry(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  if (entry === "public" || entry === "hidden") return true;
  const colon = entry.indexOf(":");
  if (colon < 0) return false;
  return (
    ADDRESSED_KINDS.includes(entry.slice(0, colon)) &&
    entry.slice(colon + 1).length > 0
  );
}

/** Shared validation. Throws before anything is written to the ledger. */
function validate(input: FactInput, at: number): string {
  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text.length === 0) throw new Error("fact text is empty");
  if (text.length > MAX_TEXT)
    throw new Error(`fact text is longer than ${MAX_TEXT} characters`);
  const visibility = input.visibility;
  if (!Array.isArray(visibility) || visibility.length === 0)
    throw new Error("fact needs at least one visibility entry");
  for (const entry of visibility) {
    if (!validVisibilityEntry(entry))
      throw new Error(`invalid visibility entry: ${String(entry)}`);
  }
  if (visibility.length > 1 && visibility.includes("hidden"))
    throw new Error("hidden visibility cannot be combined with other entries");
  if (!Number.isFinite(at)) throw new Error("fact time is not finite");
  return text;
}

export function commitFact(l: FactLedger, input: FactInput, at: number): Fact {
  const text = validate(input, at);
  const fact: Fact = {
    id: `f${++l.seq}`,
    text,
    subject: input.subject,
    source: input.source,
    visibility: [...input.visibility],
    at,
    durable: input.durable === true,
  };
  if (input.loop !== undefined) fact.loop = input.loop;
  l.facts.push(fact);
  return fact;
}

/** Facts that are still true and hold across every loop. */
export function durableFacts(l: FactLedger): Fact[] {
  return currentFacts(l).filter((fact) => fact.durable === true);
}

export function supersede(
  l: FactLedger,
  oldId: string,
  input: FactInput,
  at: number,
): Fact {
  const old = factById(l, oldId);
  if (!old) throw new Error(`unknown fact: ${oldId}`);
  if (old.supersededBy)
    throw new Error(
      `fact ${oldId} is already superseded by ${old.supersededBy}`,
    );
  const fact = commitFact(l, input, at);
  old.supersededBy = fact.id;
  return fact;
}

export function currentFacts(l: FactLedger): Fact[] {
  return l.facts.filter((fact) => !fact.supersededBy);
}

export function factById(l: FactLedger, id: string): Fact | undefined {
  return l.facts.find((fact) => fact.id === id);
}

/** Any single matching entry is enough (OR matrix); "hidden" never matches. */
function matchesVisibility(fact: Fact, viewer: FactViewer): boolean {
  const documents = viewer.documents ?? [];
  for (const entry of fact.visibility) {
    if (entry === "public") return true;
    if (entry === "hidden") continue;
    const colon = entry.indexOf(":");
    if (colon < 0) continue;
    const kind = entry.slice(0, colon);
    const id = entry.slice(colon + 1);
    if (kind === "npc" && viewer.npcId !== undefined && id === viewer.npcId)
      return true;
    if (
      kind === "role" &&
      viewer.role !== undefined &&
      id.toLowerCase() === viewer.role.toLowerCase()
    )
      return true;
    if (kind === "area" && viewer.areaId !== undefined && id === viewer.areaId)
      return true;
    if (kind === "document" && documents.includes(id)) return true;
  }
  return false;
}

export function factsVisibleTo(
  l: FactLedger,
  viewer: FactViewer,
  options: { includeSuperseded?: boolean } = {},
): Fact[] {
  return l.facts.filter((fact) => {
    if (!options.includeSuperseded && fact.supersededBy) return false;
    if (fact.visibility.includes("hidden")) return false;
    return matchesVisibility(fact, viewer);
  });
}

export function learn(
  l: FactLedger,
  factId: string,
  line: string,
  via: JournalEntry["via"],
  at: number,
): JournalEntry | undefined {
  const fact = factById(l, factId);
  if (!fact) throw new Error(`unknown fact: ${factId}`);
  if (fact.visibility.includes("hidden"))
    throw new Error(`the player can never learn hidden fact ${factId}`);
  if (knows(l, factId)) return undefined;
  const text = typeof line === "string" ? line.trim() : "";
  if (text.length === 0) throw new Error("journal line is empty");
  if (text.length > MAX_LINE)
    throw new Error(`journal line is longer than ${MAX_LINE} characters`);
  const entry: JournalEntry = { factId, line: text, learnedAt: at, via };
  l.journal.push(entry);
  return entry;
}

export function knows(l: FactLedger, factId: string): boolean {
  return l.journal.some((entry) => entry.factId === factId);
}

export function journalLines(l: FactLedger): string[] {
  return l.journal
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.learnedAt - b.entry.learnedAt || a.index - b.index)
    .map(({ entry }) => {
      const fact = factById(l, entry.factId);
      return fact && fact.supersededBy
        ? `${entry.line} (outdated)`
        : entry.line;
    });
}

export function factDigest(facts: readonly Fact[], max: number): string[] {
  const count = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (count === 0) return [];
  return facts.slice(-count).map((fact) => `${fact.id}: ${fact.text}`);
}
