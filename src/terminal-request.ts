/**
 * A request the open terminal started (a message, a submission, a retry).
 * Whether it resolves or throws, `done` runs once so the result is saved and
 * shown; a throw is recorded on the encounter, where the terminal's status
 * line reports it, instead of becoming an unhandled rejection.
 */
export function settleRequest(
  pending: Promise<unknown>,
  e: { error?: string },
  done: () => void,
): Promise<void> {
  return pending
    .catch((error) => {
      e.error = String(error);
    })
    .then(done);
}
