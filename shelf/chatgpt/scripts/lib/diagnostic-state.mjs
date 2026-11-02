import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { assertOwnerOnly } from "./private-fs.mjs";

/**
 * Owner-only JSON state for the ChatGPT diagnostic and smoke scripts under
 * `.local/chatgpt-handoff/`. Every read and write first checks that the
 * directory and file are owner-only regular entries, and writes land through
 * a private temporary file so a crash never leaves a partial state file.
 */
export function createDiagnosticState({
  directory,
  file,
  label = "Diagnostic state",
}) {
  const ownerOnly = (path) => {
    const entry = lstatSync(path.replace(/\/+$/, ""));
    assertOwnerOnly(entry, {
      message: `${label} must be owner-only and not a symlink`,
    });
  };
  const load = () => {
    ownerOnly(directory);
    ownerOnly(file);
    return JSON.parse(readFileSync(file, "utf8"));
  };
  return {
    ownerOnly,
    load,
    /** `undefined` when no state file exists yet. */
    loadIfExists: () => (existsSync(file) ? load() : undefined),
    save(state) {
      ownerOnly(directory);
      if (existsSync(file)) ownerOnly(file);
      const temporary = file + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, JSON.stringify(state), {
        flag: "wx",
        mode: 0o600,
      });
      renameSync(temporary, file);
    },
  };
}
