import type { Floor } from "./model";
import type { RunFreeFloor, RunFreeRoom } from "./run-design-contract.mjs";

/** Accessors for a drawn floor (design version 4). Floor.design is typed for
 * chain floors; a drawn floor shares the slot, and everything reads it through
 * these so the cast lives in one place. */
export const freeFloor = (
  f: Pick<Floor, "design">,
): RunFreeFloor | undefined => {
  const design = f.design as unknown as Partial<RunFreeFloor> | undefined;
  return Array.isArray(design?.rooms) ? (design as RunFreeFloor) : undefined;
};
export const isFreePlan = (f: Pick<Floor, "design">) => !!freeFloor(f);

/** The drawn rooms of a free floor, or none. */
export const freeRooms = (f: Pick<Floor, "design">): RunFreeRoom[] =>
  freeFloor(f)?.rooms ?? [];
