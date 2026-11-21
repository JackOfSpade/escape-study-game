/**
 * A small in-memory IndexedDB for the lesson store's tests. It models what the
 * store relies on: named databases with versions, an upgrade that can be
 * aborted (and then creates nothing), transactions that commit all or nothing
 * and run one at a time, deleteDatabase that waits for open connections, and
 * databases(). Requests and events are answered asynchronously.
 */

type Rows = Map<string, unknown>;
interface DbState {
  version: number;
  stores: Map<string, Rows>;
  connections: Set<FakeConnection>;
}
interface FakeConnection {
  name: string;
  closed: boolean;
  db: IDBDatabase;
}

const domError = (name: string, message = name) =>
  new DOMException(message, name);
const later = () => new Promise<void>((r) => setTimeout(r, 0));
const sortedKeys = (rows: Rows) => [...rows.keys()].sort();

export interface FakeLessonIdbFaults {
  /** Every open of this name fires `blocked` and nothing else. */
  blockOpen?: (name: string) => boolean;
  /** A put in this database under this key fails, aborting its transaction. */
  failPut?: (db: string, key: string) => boolean;
  /** Reads (get/getAll/getAllKeys) in this database fail. */
  failRead?: (db: string) => boolean;
  /** deleteDatabase of this name fails. */
  failDelete?: (name: string) => boolean;
}

export function fakeLessonIdb(faults: FakeLessonIdbFaults = {}) {
  const dbs = new Map<string, DbState>();
  const log = {
    opened: [] as string[],
    deleted: [] as string[],
    puts: [] as string[],
    created: [] as string[],
  };
  let chain: Promise<void> = Promise.resolve();

  function connection(name: string, state: DbState): FakeConnection {
    const conn: FakeConnection = {
      name,
      closed: false,
      db: {} as IDBDatabase,
    };
    Object.assign(conn.db, {
      name,
      get version() {
        return state.version;
      },
      get objectStoreNames() {
        return { contains: (n: string) => state.stores.has(n) };
      },
      close() {
        conn.closed = true;
        state.connections.delete(conn);
        settleDeletes();
      },
      transaction(scope: string | string[], mode?: IDBTransactionMode) {
        if (conn.closed) throw domError("InvalidStateError");
        const list = typeof scope === "string" ? [scope] : [...scope];
        for (const n of list)
          if (!state.stores.has(n)) throw domError("NotFoundError");
        return transaction(name, state, list, mode ?? "readonly");
      },
    });
    state.connections.add(conn);
    return conn;
  }

  function transaction(
    dbName: string,
    state: DbState,
    scope: string[],
    mode: IDBTransactionMode,
  ) {
    const tx = {} as IDBTransaction;
    const ops: (() => void)[] = [];
    const work = new Map<string, Rows>();
    let aborted = false;
    let error: DOMException | null = null;
    const request = (run: () => unknown) => {
      const req = {} as IDBRequest;
      ops.push(() => {
        try {
          Object.assign(req, { result: run(), readyState: "done" });
          req.onsuccess?.call(req, new Event("success"));
        } catch (e) {
          Object.assign(req, { error: e, readyState: "done" });
          req.onerror?.call(req, new Event("error"));
          error = e as DOMException;
          aborted = true;
        }
      });
      return req;
    };
    Object.assign(tx, {
      mode,
      get error() {
        return error;
      },
      abort() {
        aborted = true;
        error = domError("AbortError");
      },
      objectStore(n: string) {
        if (!scope.includes(n)) throw domError("NotFoundError");
        const rows = () => work.get(n)!;
        const read = () => {
          if (faults.failRead?.(dbName)) throw domError("UnknownError");
        };
        return {
          get: (key: string) =>
            request(() => (read(), structuredClone(rows().get(key)))),
          getAll: () =>
            request(() => {
              read();
              const r = rows();
              return sortedKeys(r).map((k) => structuredClone(r.get(k)));
            }),
          getAllKeys: () => request(() => (read(), sortedKeys(rows()))),
          count: () => request(() => rows().size),
          put: (value: unknown, key: string) =>
            request(() => {
              if (mode !== "readwrite") throw domError("ReadOnlyError");
              if (faults.failPut?.(dbName, key))
                throw domError("QuotaExceededError");
              log.puts.push(`${dbName}/${n}/${key}`);
              rows().set(key, structuredClone(value));
              return key;
            }),
          delete: (key: string) =>
            request(() => {
              if (mode !== "readwrite") throw domError("ReadOnlyError");
              rows().delete(key);
              return undefined;
            }),
        };
      },
    });
    // Transactions run one at a time, in the order they were created, and
    // commit all of their writes or none.
    chain = chain.then(async () => {
      await later();
      for (const n of scope) work.set(n, new Map(state.stores.get(n)!));
      for (;;) {
        while (ops.length && !aborted) ops.shift()!();
        if (aborted) break;
        await later();
        if (!ops.length) break;
      }
      if (aborted) {
        error ??= domError("AbortError");
        tx.onerror?.call(tx, new Event("error"));
        tx.onabort?.call(tx, new Event("abort"));
        return;
      }
      for (const [n, rows] of work) state.stores.set(n, rows);
      tx.oncomplete?.call(tx, new Event("complete"));
    });
    return tx;
  }

  const deletes: { name: string; finish: () => void }[] = [];
  function settleDeletes() {
    for (const d of [...deletes]) {
      const state = dbs.get(d.name);
      if (state && state.connections.size) continue;
      deletes.splice(deletes.indexOf(d), 1);
      d.finish();
    }
  }

  const factory = {
    open(name: string, version?: number) {
      log.opened.push(`${name}@${version}`);
      const req = {} as IDBOpenDBRequest;
      setTimeout(() => {
        if (faults.blockOpen?.(name)) {
          req.onblocked?.call(req, {} as IDBVersionChangeEvent);
          return;
        }
        const existing = dbs.get(name);
        const oldVersion = existing?.version ?? 0;
        const newVersion = version ?? (existing ? existing.version : 1);
        if (newVersion < oldVersion) {
          Object.assign(req, { error: domError("VersionError") });
          req.onerror?.call(req, new Event("error"));
          return;
        }
        const state: DbState = existing ?? {
          version: 0,
          stores: new Map(),
          connections: new Set(),
        };
        if (newVersion === oldVersion) {
          const conn = connection(name, state);
          Object.assign(req, { result: conn.db, transaction: null });
          req.onsuccess?.call(req, new Event("success"));
          return;
        }
        const before = new Map(state.stores);
        const conn = connection(name, state);
        let aborted = false;
        const vtx = {
          abort() {
            aborted = true;
          },
        } as IDBTransaction;
        const created: string[] = [];
        Object.assign(conn.db, {
          createObjectStore(n: string) {
            state.stores.set(n, new Map());
            created.push(n);
          },
        });
        Object.assign(req, { result: conn.db, transaction: vtx });
        req.onupgradeneeded?.call(req, {
          oldVersion,
          newVersion,
        } as IDBVersionChangeEvent);
        if (aborted) {
          // An aborted upgrade leaves nothing behind, not even a new database.
          state.stores = before;
          state.connections.delete(conn);
          conn.closed = true;
          Object.assign(req, {
            result: undefined,
            transaction: null,
            error: domError("AbortError"),
          });
          req.onerror?.call(req, new Event("error", { cancelable: true }));
          return;
        }
        state.version = newVersion;
        for (const n of created) log.created.push(`${name}/${n}`);
        dbs.set(name, state);
        Object.assign(req, { transaction: null });
        req.onsuccess?.call(req, new Event("success"));
      }, 0);
      return req;
    },
    deleteDatabase(name: string) {
      const req = {} as IDBOpenDBRequest;
      setTimeout(() => {
        if (faults.failDelete?.(name)) {
          Object.assign(req, { error: domError("UnknownError") });
          req.onerror?.call(req, new Event("error", { cancelable: true }));
          return;
        }
        const state = dbs.get(name);
        for (const c of [...(state?.connections ?? [])])
          c.db.onversionchange?.call(c.db, {} as IDBVersionChangeEvent);
        deletes.push({
          name,
          finish: () => {
            if (dbs.delete(name)) log.deleted.push(name);
            req.onsuccess?.call(req, new Event("success"));
          },
        });
        if ((dbs.get(name)?.connections.size ?? 0) > 0)
          req.onblocked?.call(req, {} as IDBVersionChangeEvent);
        settleDeletes();
      }, 0);
      return req;
    },
    async databases() {
      return [...dbs].map(([name, s]) => ({ name, version: s.version }));
    },
  };

  /** Seeds a database directly, as an earlier build would have left it. */
  function seed(name: string, stores: Record<string, Record<string, unknown>>) {
    dbs.set(name, {
      version: 1,
      stores: new Map(
        Object.entries(stores).map(([n, rows]) => [
          n,
          new Map(Object.entries(rows)),
        ]),
      ),
      connections: new Set(),
    });
  }
  /** Waits until every queued request, transaction and delete has run. */
  async function settle() {
    for (let i = 0; i < 20; i++) {
      await chain;
      await later();
    }
  }
  return {
    factory,
    /** The same fake without `databases()`, as in browsers that lack it. */
    withoutListing: () => ({
      open: factory.open,
      deleteDatabase: factory.deleteDatabase,
    }),
    log,
    seed,
    settle,
    rows: (db: string, store: string) => dbs.get(db)?.stores.get(store),
    exists: (name: string) => dbs.has(name),
  };
}
