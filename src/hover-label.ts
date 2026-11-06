/** How long an object's name stays up once the cursor settles on it. */
export const HOVER_LABEL_MS = 2000;

/** Small pure timer shared by first-person and top-down. The name shows for
 * HOVER_LABEL_MS after the cursor lands on a target, stays hidden while the
 * cursor remains on it, and returns only for a different target or after the
 * cursor has left (update with undefined) and come back. */
export class HoverLabel {
  private id: string | undefined;
  private since = 0;

  update(id: string | undefined, now: number) {
    if (id !== this.id) {
      this.id = id;
      this.since = now;
    }
    return id !== undefined && now - this.since < HOVER_LABEL_MS;
  }

  reset() {
    this.id = undefined;
  }
}
