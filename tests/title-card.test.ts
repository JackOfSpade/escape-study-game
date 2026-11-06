import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  parseRunDesign,
  RUN_DESIGN_GUIDANCE,
  TITLE_CARD_FONTS,
} from "../src/run-design-contract.mjs";

const harbor = JSON.parse(
  readFileSync("tests/fixtures/run-designs/harbor-inscriptions.json", "utf8"),
);
const card = {
  title: { font: "special-elite", color: "#f2e6c9", size: 72 },
  story: { font: "libre-baskerville", color: "#c9d6d2", size: 19 },
};
const withCard = (titleCard: unknown) => ({ ...harbor, titleCard });

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
