import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
export function assertOwnerOnly(stat, options = {}) {
  const {
    kind,
    maxBytes,
    message = "Unsafe file or directory permissions",
  } = options;
  if (
    stat.isSymbolicLink() ||
    (kind === "file" && !stat.isFile()) ||
    (kind === "directory" && !stat.isDirectory()) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    (stat.mode & 0o077) !== 0 ||
    (maxBytes !== undefined && stat.size > maxBytes)
  ) {
    throw Error(message);
  }
}
export function privateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const s = lstatSync(directory);
  assertOwnerOnly(s, {
    kind: "directory",
    message: "Bridge directory must be private, owner-owned and not a symlink",
  });
}
export function writePrivate(file, data) {
  privateDirectory(dirname(file));
  const tmp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
  renameSync(tmp, file);
}
