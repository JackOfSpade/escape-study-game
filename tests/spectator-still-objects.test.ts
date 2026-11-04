import assert from "node:assert/strict";
import test from "node:test";
import { strikeShake } from "../src/render";

// sin(39t) is non-zero at each of these sample times.
const times = [10.01, 12.34, 100.5];

test("damaged objects hold still unless a strike just landed", () => {
  for (const time of times) {
    // Worn, damaged or long-ago struck objects never shake.
    assert.equal(strikeShake({}, time), 0);
    assert.equal(strikeShake({ struckAt: time - 5 }, time), 0);
  }
});

test("a fresh strike shakes briefly, except under reduced flashing", () => {
  for (const time of times) {
    const object = { struckAt: time - 0.1 };
    assert.notEqual(strikeShake(object, time), 0);
    assert.equal(strikeShake(object, time, true), 0);
    assert.equal(strikeShake(object, time + 0.3), 0);
  }
  // A save restored from a later time cannot leave an object shaking forever.
  assert.equal(strikeShake({ struckAt: 50 }, 10), 0);
});
