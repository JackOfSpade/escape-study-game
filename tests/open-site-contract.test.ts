import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CONFIG, HELIPAD, HELIPAD_RADIUS, type Roadmap } from "../src/model";
import {
  parseRunDesign,
  parseRunStructure,
} from "../src/run-design-contract.mjs";
import { designReplySchema } from "../src/run-design-schema.mjs";
import {
  SETTING_GUIDANCE,
  SITE_FORMS,
  parseSetting,
} from "../src/setting-catalog.mjs";
import { QUALITY_GUIDANCE } from "../src/run-quality-contract.mjs";
import { extractionPoints, type Site } from "../src/site";
import { createPlayableGame } from "../src/world";
import { runDesignFixture } from "./helpers/run-design";

const roadmap = JSON.parse(
  readFileSync("public/curriculum.json", "utf8"),
) as Roadmap;
/** The full v3 broadcast design: a real setting, four floors, an environment. */
const design = () =>
  JSON.parse(
    readFileSync("tests/fixtures/run-designs/radio-broadcast.json", "utf8"),
  );
/** The same design as a structure-only proposal (no environment manifest), so
 * these checks exercise the design contract rather than world construction. */
const structure = (mutate: (d: any) => void) => {
  const d: any = design();
  delete d.environment;
  mutate(d);
  return d;
};

test("the site form is catalogued, optional in the parser and required fresh", () => {
  assert.deepEqual([...SITE_FORMS], ["enclosed", "open"]);
  const setting: any = structuredClone(design().setting);
  delete setting.form;
  assert.deepEqual(parseSetting(setting), setting);
  assert.equal(parseSetting({ ...setting, form: "open" }).form, "open");
  assert.equal(parseSetting({ ...setting, form: "enclosed" }).form, "enclosed");
  const bogus = { ...setting, form: "roofless" };
  assert.throws(
    () => parseSetting(bogus),
    /setting\.form must be one of enclosed, open/,
  );
});

test("an existing enclosed v3 design still validates with and without form", () => {
  const plain: any = design();
  delete plain.setting.form;
  assert.deepEqual(parseRunDesign(plain), plain);
  const enclosed: any = design();
  enclosed.setting.form = "enclosed";
  assert.deepEqual(parseRunDesign(enclosed), enclosed);
});

test("an open design validates with its single ground floor", () => {
  const open = structure((d) => {
    d.setting.form = "open";
    d.floors = [d.floors[0]];
  });
  assert.equal(parseRunStructure(open).floors.length, 1);
  assert.equal(open.setting.form, "open");
  // The same one-floor design is rejected while it still claims to be enclosed.
  const lying = structuredClone(open);
  lying.setting.form = "enclosed";
  assert.throws(() => parseRunStructure(lying), /floors/);
});

test("open needs exactly one floor and enclosed exactly four", () => {
  const openFour = structure((d) => {
    d.setting.form = "open";
  });
  assert.equal(openFour.floors.length, 4);
  assert.throws(() => parseRunStructure(openFour), /floors/);
  const enclosedOne = structure((d) => {
    d.setting.form = "enclosed";
    d.floors = [d.floors[0]];
  });
  assert.throws(() => parseRunStructure(enclosedOne), /floors/);
});

test("only version 3 designs may carry a site form", () => {
  const legacy: any = structuredClone(runDesignFixture());
  assert.equal(legacy.version < 3, true);
  legacy.setting = structuredClone(design().setting);
  legacy.setting.form = "open";
  assert.throws(() => parseRunDesign(legacy), /unknown field/);
});

test("the fresh-request schema lists the forms and allows one to four floors", () => {
  const schema: any = designReplySchema({
    version: 3,
    designVersion: 3,
    phase: "structure",
    requestId: "req-open-site",
  });
  const proposal = schema.properties.structure;
  assert.deepEqual(proposal.properties.setting.properties.form.enum, [
    ...SITE_FORMS,
  ]);
  assert.ok(proposal.properties.setting.required.includes("form"));
  assert.equal(proposal.properties.floors.minItems, 1);
  assert.equal(proposal.properties.floors.maxItems, 4);
  // The validator, not the schema, decides which count belongs to which form.
  assert.equal(proposal.properties.floors.items.type, "object");
  // The schema only shapes live model replies, so every structure request must
  // name the form; older saved designs are re-validated by the validator,
  // which still treats an absent form as enclosed.
  const bare: any = designReplySchema({
    version: 3,
    phase: "structure",
    requestId: "req-open-site",
  }).properties.structure;
  assert.ok(bare.properties.setting.required.includes("form"));
});

test("a fresh game extracts on today's roof helipad and nowhere else", () => {
  const g = createPlayableGame(4242, roadmap);
  const points = extractionPoints(g);
  assert.equal(points.length, 1);
  assert.deepEqual(points[0], {
    floor: CONFIG.floors,
    x: HELIPAD.x,
    y: HELIPAD.y,
    radius: HELIPAD_RADIUS,
  });
  assert.equal(points[0].site, undefined);
  // Extra sites append their own ground pickups in world coordinates.
  const quay = {
    id: "quay",
    extraction: { floor: 0, x: 140, y: 60, radius: 3 },
  } as unknown as Site;
  g.sites = [quay];
  const two = extractionPoints(g);
  assert.equal(two.length, 2);
  assert.deepEqual(two[1], {
    floor: 0,
    x: 140,
    y: 60,
    radius: 3,
    site: "quay",
  });
});

test("the designer and reviewer are told to match form to the premise", () => {
  assert.match(
    SETTING_GUIDANCE,
    /open-air market is open, never a market hall/,
  );
  assert.match(SETTING_GUIDANCE, /form must match what the premise implies/);
  assert.match(
    QUALITY_GUIDANCE,
    /whether the form matches the premise \(an open-air premise built as an enclosed building, or a building premise built open, is a major finding\)/,
  );
  assert.match(
    QUALITY_GUIDANCE,
    /floor:0\.\.3 \(floor:0 only for an open site\)/,
  );
});
