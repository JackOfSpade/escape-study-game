import { parseRoadmapDocument } from "../src/roadmap-document.ts";
import { readFileSync, writeFileSync } from "node:fs";

import { sha256 as hash } from "./lib/digest.mjs";
const raw = readFileSync("interview_prep_roadmap.md", "utf8"),
  identity = JSON.parse(readFileSync("SOURCE_INTEGRITY.json", "utf8"));
if (hash(raw) !== identity.whole_file_sha256)
  throw Error("Source changed: explicit import migration required.");
for (const [block, key] of [
  ["MERGE_RULES", "merge_rules_sha256"],
  ["PY_CURRICULUM", "py_curriculum_sha256"],
  ["PE_CURRICULUM", "pe_curriculum_sha256"],
]) {
  const content = raw
    .split(`<!-- BEGIN ${block} -->\n`)[1]
    ?.split(`<!-- END ${block} -->`)[0];
  if (!content || hash(content) !== identity.protected_blocks[key].computed)
    throw Error(`Invalid protected ${block}`);
}
const result = await parseRoadmapDocument(raw);
const output = "public/curriculum.json",
  serialized = JSON.stringify(result);
let previous;
try {
  previous = readFileSync(output, "utf8");
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
    throw error;
}
// Identical verification must not trigger Vite's public-file reload and interrupt
// a running study request whenever a build/test preflight runs.
if (previous !== serialized) writeFileSync(output, serialized);
console.log(
  `Verified revision 9; PY ${result.tracks.PY.objectives.length}, PE ${result.tracks.PE.objectives.length}; source and 3 protected digests intact.`,
);
