const DB = "study-durable-state",
  STORE = "saves";
/** The database's name before the rename. It is still read (never created)
 * and deleted once its save has a newer copy under the new name (see
 * `retireLegacyDurable` and AGENTS.md). */
export const LEGACY_DB = "dead-air-durable-state";

/** Each instance owns its connection; rejected or closed connections are never cached. */
export function createDurableStorage(
  factory: () => Pick<IDBFactory, "open"> = () => indexedDB,
  name = DB,
) {
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (opening) return opening;
    // Defer open so even a synchronous SecurityError can clear the assigned promise.
    const pending = Promise.resolve().then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const req = factory().open(name, 1);
          let failed = false;
          const fail = (error: unknown) => {
            failed = true;
            reject(error);
          };
          req.onupgradeneeded = () => {
            if (!req.result.objectStoreNames.contains(STORE))
              req.result.createObjectStore(STORE);
          };
          req.onsuccess = () => {
            const db = req.result;
            // A blocked open cannot be cancelled; close its eventual connection.
            if (failed) {
              db.close();
              return;
            }
            const forget = () => {
              if (opening === pending) opening = undefined;
            };
            db.onversionchange = () => {
              db.close();
              forget();
            };
            db.onclose = forget;
            resolve(db);
          };
          req.onerror = () =>
            fail(req.error ?? Error("Could not open durable save storage"));
          req.onblocked = () =>
            fail(
              Error(
                "Another browser tab is blocking the save database upgrade",
              ),
            );
        }),
    );
    opening = pending;
    void pending.catch(() => {
      if (opening === pending) opening = undefined;
    });
    return pending;
  }
  async function write(key: string, value: string) {
    const db = await database();
    await new Promise<void>((resolve, reject) => {
      // Learner work should reach persistent storage before acknowledging the
      // transaction, rather than using the browser's relaxed disk-flush policy.
      const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? Error("Durable save transaction failed"));
      tx.objectStore(STORE).put(value, key);
    });
  }
  async function read(key: string) {
    const db = await database();
    return new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"),
        req = tx.objectStore(STORE).get(key);
      let value: string | null = null;
      req.onsuccess = () => {
        value = typeof req.result === "string" ? req.result : null;
      };
      // Request success can still be followed by a transaction abort.
      tx.oncomplete = () => resolve(value);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? req.error ?? Error("Could not read durable save"));
    });
  }
  return { read, write };
}

export type LegacyFactory = Pick<IDBFactory, "open"> &
  Partial<Pick<IDBFactory, "deleteDatabase" | "databases">>;

/**
 * Read-only access to a database written by an earlier build. Opening it never
 * creates it: `databases()` answers first where the browser has it, and an
 * open without a version that would create the database aborts its
 * versionchange transaction, which leaves nothing behind. Every call opens and
 * closes its own connection so the database can be deleted afterwards.
 */
export function createLegacyDurableStorage(
  factory: () => LegacyFactory = () => indexedDB,
  name = LEGACY_DB,
) {
  async function existing(): Promise<IDBDatabase | null> {
    const f = factory();
    if (typeof f.databases === "function") {
      let listed: IDBDatabaseInfo[] | undefined;
      try {
        listed = await f.databases();
      } catch {}
      if (listed && !listed.some((info) => info.name === name)) return null;
    }
    return new Promise<IDBDatabase | null>((resolve, reject) => {
      const req = f.open(name);
      let absent = false;
      req.onupgradeneeded = (event) => {
        if (event.oldVersion !== 0) return;
        absent = true;
        req.transaction?.abort();
      };
      req.onsuccess = () => {
        // A throw inside this callback would leave the promise unsettled.
        try {
          const db = req.result;
          if (absent || !db.objectStoreNames.contains(STORE)) {
            db.close();
            resolve(null);
            return;
          }
          db.onversionchange = () => db.close();
          resolve(db);
        } catch (error) {
          reject(error);
        }
      };
      req.onerror = () =>
        absent
          ? resolve(null)
          : reject(req.error ?? Error("Could not open the earlier save store"));
    });
  }
  function readAll(db: IDBDatabase) {
    return new Promise<Map<IDBValidKey, unknown>>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly"),
        store = tx.objectStore(STORE),
        keys = store.getAllKeys(),
        values = store.getAll();
      tx.oncomplete = () => {
        const entries = new Map<IDBValidKey, unknown>();
        keys.result.forEach((key, i) => entries.set(key, values.result[i]));
        resolve(entries);
      };
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? Error("Could not read the earlier save store"));
    });
  }
  /** Every stored entry, or null when the database does not exist. */
  async function entries() {
    const db = await existing();
    if (!db) return null;
    try {
      return await readAll(db);
    } finally {
      db.close();
    }
  }
  async function read(key: string) {
    const value = (await entries())?.get(key);
    return typeof value === "string" ? value : null;
  }
  /** Settles when the delete finishes, which a blocking tab can postpone. */
  function remove(onBlocked: () => void) {
    return new Promise<void>((resolve, reject) => {
      const f = factory();
      if (typeof f.deleteDatabase !== "function")
        throw Error("Deleting a database is not supported here");
      const req = f.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () =>
        reject(req.error ?? Error("Could not delete the earlier save store"));
      req.onblocked = onBlocked;
    });
  }
  return { read, entries, remove };
}

const current = createDurableStorage(),
  legacy = createLegacyDurableStorage();
/** The current database only; the save keeps its own legacy copy apart. */
export const readCurrentDurable = current.read;
export const readLegacyDurable = legacy.read;
export const writeDurable = current.write;
/** Other entries (recent diagnostics) keep their key across the rename, so a
 * value not yet written under the new database name is read from the old one. */
export async function readDurable(key: string) {
  return (await current.read(key)) ?? (await legacy.read(key));
}
/**
 * Delete the earlier build's database once its save is superseded. Entries
 * other than the save that the new database lacks are copied over first; the
 * save itself is only discarded when `mayDiscard` says a copy at least as new
 * was written under the new name. Anything unexpected keeps the database.
 */
export async function retireLegacyDurable(
  legacyKey: string,
  mayDiscard: (raw: unknown) => boolean,
  onBlocked: () => void,
): Promise<"absent" | "kept" | "deleted"> {
  const entries = await legacy.entries();
  if (!entries) return "absent";
  if (entries.has(legacyKey) && !mayDiscard(entries.get(legacyKey)))
    return "kept";
  for (const [key, value] of entries) {
    if (key === legacyKey) continue;
    if (typeof key !== "string" || typeof value !== "string") return "kept";
    if ((await current.read(key)) === null) await current.write(key, value);
  }
  await legacy.remove(onBlocked);
  return "deleted";
}
