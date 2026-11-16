import { type Actor, type Game, type Zombie, distance } from "./model";
import { canSee, sightRadius } from "./visibility";
export const THREAT_MEMORY = { seconds: 6, max: 8, sampleSeconds: 0.25 };
interface ThreatObservation {
  id: string;
  x: number;
  y: number;
  at: number;
}
export interface ThreatMemory {
  floor: number;
  nextSample: number;
  observations: ThreatObservation[];
}
/** Read frozen observations only: never look up a hidden actor's current state. */
export function rememberedThreats(g: Game, a: Actor): ThreatObservation[] {
  const memory = a.threatMemory;
  if (!memory || memory.floor !== a.floor) return [];
  return memory.observations.filter(
    (p) => p.at <= g.time && g.time - p.at < THREAT_MEMORY.seconds,
  );
}
/** Candidates must actually belong to this world and pass the same local sight
 * test as perception. The sampled copies cannot follow an enemy through cover. */
export function rememberThreats(
  g: Game,
  a: Actor,
  observed: readonly Zombie[],
) {
  if (a.threatMemory?.floor !== a.floor) delete a.threatMemory;
  const memory = a.threatMemory,
    f = g.floors[a.floor],
    range = Math.min(9, sightRadius(f));
  const visible = (z: Zombie) =>
    g.zombies.includes(z) && z.floor === a.floor && canSee(f, a, z, range);
  let retained = rememberedThreats(g, a);
  // Own visible kills may clear a prior sighting even between position samples.
  const dead = observed.filter((z) => z.hp <= 0 && visible(z)).map((z) => z.id);
  if (dead.length) retained = retained.filter((p) => !dead.includes(p.id));
  if (!memory && !observed.length) return;
  const due = !memory || g.time >= memory.nextSample;
  const candidates = observed
    .filter((z) => z.hp > 0 && visible(z))
    .sort((b, c) => distance(a, b) - distance(a, c))
    .slice(0, THREAT_MEMORY.max);
  // A brief new sighting must survive even when it occurs between position samples.
  const fresh = candidates.map((z) => {
    const previous = retained.find((p) => p.id === z.id);
    return !due && previous
      ? previous
      : { id: z.id, x: z.x, y: z.y, at: g.time };
  });
  const currentIds = new Set(fresh.map((p) => p.id));
  const observations = [
    ...fresh,
    ...retained.filter((p) => !currentIds.has(p.id)),
  ].slice(0, THREAT_MEMORY.max);
  if (observations.length)
    a.threatMemory = {
      floor: a.floor,
      nextSample: due
        ? g.time + THREAT_MEMORY.sampleSeconds
        : memory!.nextSample,
      observations,
    };
  else delete a.threatMemory;
}
