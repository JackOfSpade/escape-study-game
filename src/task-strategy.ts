import { type Actor, type Game, type Station, distance } from "./model";
import { survivorPaths } from "./navigation";
import { stationAtHome } from "./site-stamp";
import {
  CONTACT_PENALTY,
  routeContacts,
  routeExposure,
} from "./survivor-strategy";
import { canSee, sightRadius } from "./visibility";

/** Select among remembered, eligible tasks. Hidden enemies and unseen stations
 * cannot influence the ranking; this does not issue or solve a problem. */
export function chooseTaskStation(g: Game, a: Actor, candidates: Station[]) {
  const f = g.floors[a.floor],
    weight = a.inventory.reduce((n, i) => n + i.weight, 0);
  const enemies = g.zombies.filter(
    (z) =>
      z.hp > 0 &&
      z.floor === a.floor &&
      canSee(f, a, z, Math.min(9, sightRadius(f))),
  );
  // Every cheap rejection first, so the remaining stations share one search
  // instead of paying for a full Dijkstra each.
  const eligible: Station[] = [];
  for (const s of candidates) {
    // A person only works at its own building's stations.
    if (!stationAtHome(a, s)) continue;
    if (!f.stations.includes(s) || !a.seen.includes(s.id)) continue;
    const e = g.encounters[s.encounter];
    if (
      !e ||
      e.floor !== a.floor ||
      e.state === "consumed" ||
      (e.mode === "solo" && e.owner && e.owner !== a.id)
    )
      continue;
    if (
      e.reward === "loot" &&
      (weight >= 3 || (a.role !== "medic" && a.risk <= 0.65))
    )
      continue;
    eligible.push(s);
  }
  const routes = survivorPaths(f, a, eligible);
  const ranked: { station: Station; score: number }[] = [];
  eligible.forEach((s, i) => {
    const route = routes[i];
    if (!route.length && !(distance(a, s) < 1.3 && canSee(f, a, s, 1.9)))
      return;
    const e = g.encounters[s.encounter];
    if (!e) return;
    let cost = 0,
      from = { x: a.x, y: a.y };
    for (const p of route) {
      cost +=
        distance(from, p) +
        (p.action === "vault" ? 2 : p.action === "door" ? 1 : 0);
      from = p;
    }
    const occupied = g.survivors.some(
      (b) =>
        b.id !== a.id &&
        b.alive &&
        !b.escaped &&
        b.floor === a.floor &&
        b.station === s.id &&
        b.activity !== "fleeing" &&
        canSee(f, a, b),
    );
    // A solo reservation is a destination claim, not merely a less attractive
    // seat. Penalizing it still sent several bots toward the same finite task.
    if (occupied && e.mode === "solo") return;
    const defenseRole =
      a.role === "builder" || (a.social > 0.7 && a.risk < 0.7);
    const lootCost =
      e.reward === "loot" && !a.access.includes(a.floor)
        ? a.hp < 55 && !a.inventory.some((i) => i.kind === "medkit")
          ? 3
          : a.role === "medic"
            ? 6
            : 10
        : 0;
    ranked.push({
      station: s,
      score:
        cost +
        lootCost +
        (occupied ? (defenseRole ? 2 : 8) : 0) +
        routeContacts(a, route, enemies) * CONTACT_PENALTY +
        routeExposure(a, route, enemies) * (3 + (1 - a.risk) * 3),
    });
  });
  return ranked.sort(
    (b, c) => b.score - c.score || b.station.id.localeCompare(c.station.id),
  )[0]?.station;
}
