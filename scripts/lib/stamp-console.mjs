/** Service logs are appended across restarts, so every line carries the time it
 * was written; without it a crash loop cannot be told from one old failure. */
export function stampConsole(target = console, now = () => new Date()) {
  for (const level of ["log", "warn", "error"]) {
    const write = target[level].bind(target);
    target[level] = (...parts) => write(now().toISOString(), ...parts);
  }
}
