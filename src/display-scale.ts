/** One display preference for the interface. Old saves
 * have no value; imported preferences must stay within the slider's bounds. */
export function displayScale(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0.75, Math.min(1.5, value))
    : 1;
}
