// Storage name kept from an earlier build; renaming it needs a migration
// (see AGENTS.md).
const DB = "dead-air-durable-state",
  STORE = "saves";

/** Each instance owns its connection; rejected or closed connections are never cached. */
export function createDurableStorage(
  factory: () => Pick<IDBFactory, "open"> = () => indexedDB,
) {
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (opening) return opening;
    // Defer open so even a synchronous SecurityError can clear the assigned promise.
    const pending = Promise.resolve().then(
      () =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const req = factory().open(DB, 1);
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
export const { read: readDurable, write: writeDurable } =
  createDurableStorage();
