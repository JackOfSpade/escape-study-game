import { ensureDoor } from "./doors";
import type { Game } from "./model";

/**
 * Escape redesign: the building has ordinary doors and no gating.
 *
 * The world is built with the legacy force-field rules, so every room door and
 * the main gate is a field door that meters passes and needs keys. An escape
 * run instead wants plain hinged doors plus free run of every floor. This is
 * called from `createEscapeState`, which receives the already-built game, and
 * is idempotent: a second call finds no fields left and only re-checks access.
 */
export function openEscapeWorld(g: Game): void {
  for (const floor of g.floors ?? []) {
    for (const o of floor.furniture ?? []) {
      if (o.kind !== "door" && o.kind !== "gate") continue;
      if (!o.field) continue;
      // The field owns the metered leaf, its pass count and its key cost;
      // dropping it leaves the frame, id, position, health and appearance.
      delete o.field;
      delete o.lock;
      o.open = false;
      o.turning = 0;
      // Turn the object into a plain hinged door, closed, latched and
      // unlocked. `ensureDoor` also upgrades the legacy main-gate shutter.
      ensureDoor(o, floor);
    }
  }
  const access = (g.floors ?? []).map((f, i) =>
    typeof f.index === "number" ? f.index : i,
  );
  for (const a of g.survivors ?? []) {
    const had = a.access ?? [];
    if (
      had.length === access.length &&
      access.every((index) => had.includes(index))
    )
      continue;
    a.access = [...access];
  }
}
