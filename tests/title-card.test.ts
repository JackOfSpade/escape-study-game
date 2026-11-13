import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  parseRunDesign,
  RUN_DESIGN_GUIDANCE,
  runDesignNoveltyErrors,
  TITLE_CARD_FONTS,
  titleCardSpoilerErrors,
} from "../src/run-design-contract.mjs";

const harbor = JSON.parse(
  readFileSync("tests/fixtures/run-designs/harbor-inscriptions.json", "utf8"),
);
const card = {
  title: { font: "special-elite", color: "#f2e6c9", size: 72 },
  story: { font: "libre-baskerville", color: "#c9d6d2", size: 19 },
};
const withCard = (titleCard: unknown) => ({ ...harbor, titleCard });
const GROUPS = [
  "sans",
  "condensed",
  "serif",
  "display",
  "mono",
  "techno",
  "handwritten",
  "horror",
];

test("a design may carry its own title-card typography", () => {
  assert.deepEqual(parseRunDesign(withCard(card)).titleCard, card);
  // Older designs have none and remain valid.
  assert.equal(parseRunDesign(harbor).titleCard, undefined);
});

test("title-card typography is limited to the catalog, readable colors and bounded sizes", () => {
  const variant = (role: "title" | "story", patch: object) =>
    withCard({ ...card, [role]: { ...card[role], ...patch } });
  assert.throws(
    () => parseRunDesign(variant("title", { font: "comic-sans" })),
    /titleCard\.title\.font/,
  );
  assert.throws(
    () => parseRunDesign(variant("story", { color: "red" })),
    /six-digit hex/,
  );
  // Dark navy cannot be read on the black card.
  assert.throws(
    () => parseRunDesign(variant("story", { color: "#1a1f3a" })),
    /too dark to read on black/,
  );
  // Mid grey is large enough contrast for a title but not for body text.
  assert.doesNotThrow(() =>
    parseRunDesign(variant("title", { color: "#666666" })),
  );
  assert.throws(
    () => parseRunDesign(variant("story", { color: "#666666" })),
    /too dark/,
  );
  assert.throws(
    () => parseRunDesign(variant("title", { size: 200 })),
    /titleCard\.title\.size/,
  );
  assert.throws(
    () => parseRunDesign(variant("story", { size: 16.5 })),
    /titleCard\.story\.size/,
  );
  assert.throws(
    () => parseRunDesign(withCard({ ...card, subtitle: card.title })),
    /titleCard has an unknown field/,
  );
  assert.throws(
    () => parseRunDesign(variant("title", { url: "https://example.com" })),
    /unknown field/,
  );
});

test("the designer is told about every title-card font and the black screen", () => {
  assert.match(RUN_DESIGN_GUIDANCE, /Include titleCard/);
  assert.match(RUN_DESIGN_GUIDANCE, /pure black screen/);
  for (const font of Object.keys(TITLE_CARD_FONTS))
    assert.ok(RUN_DESIGN_GUIDANCE.includes(font), font);
});

// (a) The catalog is large and every entry is fully described.
test("every catalog font has a family, fallback and a valid feel group", () => {
  const entries = Object.entries(TITLE_CARD_FONTS);
  assert.ok(
    entries.length >= 60,
    `expected at least 60 fonts, got ${entries.length}`,
  );
  for (const [key, font] of entries) {
    assert.ok(
      typeof font.family === "string" && font.family.trim().length > 0,
      `${key} needs a family`,
    );
    assert.ok(
      typeof font.fallback === "string" && font.fallback.trim().length > 0,
      `${key} needs a fallback stack`,
    );
    assert.ok(GROUPS.includes(font.group), `${key} has group ${font.group}`);
  }
});

// (b) Guidance names every key inside its group clause.
test("the guidance groups every catalog key by feel", () => {
  for (const key of Object.keys(TITLE_CARD_FONTS))
    assert.ok(RUN_DESIGN_GUIDANCE.includes(key), key);
  for (const group of GROUPS)
    assert.ok(RUN_DESIGN_GUIDANCE.includes(`${group}: `), group);
});

// (c) The newly added fonts parse as real design choices.
test("a design may pair two of the new fonts", () => {
  const chosen = {
    title: { font: "im-fell-english", color: "#f2e6c9", size: 72 },
    story: { font: "eb-garamond", color: "#c9d6d2", size: 19 },
  };
  assert.deepEqual(parseRunDesign(withCard(chosen)).titleCard, chosen);
});

// (d) Spoilers are reported per field with the offending word.
test("titleCardSpoilerErrors names the field and the spoiler word", () => {
  const premise = titleCardSpoilerErrors({
    ...harbor,
    premise: "Low tide bares the causeway at dusk and the dead walk it.",
  });
  assert.equal(premise.length, 1);
  assert.match(premise[0], /^premise mentions "the dead";/);
  const opening = titleCardSpoilerErrors({
    ...harbor,
    opening: "Zombies wade ashore at low tide.",
  });
  assert.equal(opening.length, 1);
  assert.match(opening[0], /^opening mentions "Zombies";/);
});

// (e) Ordinary phrasing and the harbor fixture itself stay clean.
test("the dead of night and the harbor fixture are not spoilers", () => {
  assert.deepEqual(
    titleCardSpoilerErrors({
      ...harbor,
      opening: "They worked through the dead of night.",
    }),
    [],
  );
  assert.deepEqual(titleCardSpoilerErrors(harbor), []);
});

// (f) Novelty repair carries the spoiler check even on a first design.
test("runDesignNoveltyErrors includes spoilers with no recent designs", () => {
  const errors = runDesignNoveltyErrors(
    { ...harbor, premise: "The infected gather at the harbor mouth." },
    [],
  );
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^premise mentions "infected";/);
});

// (g) The guidance states the no-foreshadowing rule and the pairing advice.
test("the guidance keeps the catastrophe off the opening card", () => {
  assert.match(
    RUN_DESIGN_GUIDANCE,
    /must never name, hint at or foreshadow the catastrophe/,
  );
  assert.match(
    RUN_DESIGN_GUIDANCE,
    /pair a title face with a readable story face/,
  );
});
