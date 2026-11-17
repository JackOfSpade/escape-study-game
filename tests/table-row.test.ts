import assert from "node:assert/strict";
import test from "node:test";
import { CELL_SEPARATOR } from "../src/table-row";

test("an escaped pipe stays inside its cell; plain pipes still separate", () => {
  assert.deepEqual("| a | b |".split(CELL_SEPARATOR), ["", " a ", " b ", ""]);
  assert.deepEqual("| x \\| y | z |".split(CELL_SEPARATOR), [
    "",
    " x \\| y ",
    " z ",
    "",
  ]);
  // An escaped backslash before a pipe leaves the pipe a separator.
  assert.deepEqual("| x \\\\| y |".split(CELL_SEPARATOR), [
    "",
    " x \\\\",
    " y ",
    "",
  ]);
  assert.deepEqual("| &#124; |".split(CELL_SEPARATOR), ["", " &#124; ", ""]);
});
