/**
 * A small in-memory IndexedDB for unit tests: named databases with versions,
 * versionchange transactions that can be aborted, `databases()`,
 * `deleteDatabase()` with blocking connections, and injectable failures. Only
 * the calls `src/storage.ts` makes are implemented.
 */
type Stores = Map<string, Map<IDBValidKey, unknown>>;
interface Connection {
  db: IDBDatabase;
  name: string;
  closed: boolean;
}

export function fakeIndexedDB() {
  const databases = new Map<string, { version: number; stores: Stores }>();
  const connections: Connection[] = [];
  const pendingDeletes: { name: string; finish(): void }[] = [];
  /** Every open call, in order, with the version it asked for. */
  const opens: { name: string; version?: number }[] = [];
  const failures = {
    open: new Set<string>(),
    read: new Set<string>(),
    write: new Set<string>(),
    delete: new Set<string>(),
  };
  /** Readwrite transactions held open until `release()`. */
  let holdWrites = false;
  const held: (() => void)[] = [];
  const later = (fn: () => void) => setTimeout(fn, 0);
  const error = (message: string, name = "UnknownError") =>
    new DOMException(message, name);

  function connect(name: string, stores: Stores, version: number) {
    const connection = { name, closed: false } as Connection;
    const db = {
      name,
      version,
      objectStoreNames: {
        contains: (store: string) => stores.has(store),
      },
      createObjectStore(store: string) {
        stores.set(store, new Map());
      },
      close() {
        connection.closed = true;
        settleDeletes();
      },
      transaction(store: string, mode: IDBTransactionMode) {
        if (connection.closed)
          throw error("The connection is closed", "InvalidStateError");
        return transaction(name, stores, store, mode);
      },
    } as unknown as IDBDatabase;
    connection.db = db;
    connections.push(connection);
    return connection;
  }

  function transaction(
    name: string,
    stores: Stores,
    storeName: string,
    mode: IDBTransactionMode,
  ) {
    const tx = {} as IDBTransaction;
    const ops: {
      request: IDBRequest;
      run(data: Map<IDBValidKey, unknown>): unknown;
    }[] = [];
    const request = (run: (data: Map<IDBValidKey, unknown>) => unknown) => {
      const req = {} as IDBRequest;
      ops.push({ request: req, run });
      return req;
    };
    const sorted = (data: Map<IDBValidKey, unknown>) =>
      [...data.keys()].sort((a, b) => String(a).localeCompare(String(b)));
    Object.assign(tx, {
      objectStore: () => ({
        get: (key: IDBValidKey) => request((data) => data.get(key)),
        getAllKeys: () => request((data) => sorted(data)),
        getAll: () => request((data) => sorted(data).map((k) => data.get(k))),
        put: (value: unknown, key: IDBValidKey) =>
          request((data) => void data.set(key, value)),
        delete: (key: IDBValidKey) => request((data) => void data.delete(key)),
      }),
    });
    const settle = (abort: boolean) => {
      const failing =
        abort || failures[mode === "readonly" ? "read" : "write"].has(name);
      if (failing) {
        Object.assign(tx, { error: error("Synthetic disk error") });
        tx.onabort?.call(tx, new Event("abort"));
        return;
      }
      const data = stores.get(storeName)!;
      // Writes apply to a copy and commit only with the transaction.
      const working = new Map(data);
      for (const op of ops) {
        Object.assign(op.request, { result: op.run(working) });
        op.request.onsuccess?.call(op.request, new Event("success"));
      }
      if (mode === "readwrite") {
        data.clear();
        for (const [k, v] of working) data.set(k, v);
      }
      tx.oncomplete?.call(tx, new Event("complete"));
    };
    later(() => {
      if (mode === "readwrite" && holdWrites)
        held.push(() => settle(heldAbort));
      else settle(false);
    });
    return tx;
  }
  let heldAbort = false;

  function settleDeletes() {
    for (const pending of [...pendingDeletes])
      if (!connections.some((c) => c.name === pending.name && !c.closed)) {
        pendingDeletes.splice(pendingDeletes.indexOf(pending), 1);
        pending.finish();
      }
  }

  const factory = {
    open(name: string, version?: number) {
      opens.push({ name, version });
      const req = {} as IDBOpenDBRequest;
      later(() => {
        if (failures.open.has(name)) {
          Object.assign(req, { error: error("Synthetic open failure") });
          req.onerror?.call(req, new Event("error"));
          return;
        }
        const existing = databases.get(name);
        const oldVersion = existing?.version ?? 0;
        const newVersion = version ?? (oldVersion || 1);
        if (newVersion < oldVersion) {
          Object.assign(req, { error: error("Lower version", "VersionError") });
          req.onerror?.call(req, new Event("error"));
          return;
        }
        const stores: Stores = existing?.stores ?? new Map();
        const connection = connect(name, stores, newVersion);
        Object.assign(req, { result: connection.db });
        if (newVersion > oldVersion) {
          let aborted = false;
          Object.assign(req, {
            transaction: {
              abort() {
                aborted = true;
              },
            },
          });
          req.onupgradeneeded?.call(req, {
            oldVersion,
            newVersion,
          } as IDBVersionChangeEvent);
          Object.assign(req, { transaction: null });
          if (aborted) {
            connection.closed = true;
            Object.assign(req, {
              result: undefined,
              error: error("Version change aborted", "AbortError"),
            });
            req.onerror?.call(req, new Event("error"));
            return;
          }
          databases.set(name, { version: newVersion, stores });
        }
        req.onsuccess?.call(req, new Event("success"));
      });
      return req;
    },
    deleteDatabase(name: string) {
      const req = {} as IDBOpenDBRequest;
      later(() => {
        if (failures.delete.has(name)) {
          Object.assign(req, { error: error("Synthetic delete failure") });
          req.onerror?.call(req, new Event("error"));
          return;
        }
        for (const c of connections)
          if (c.name === name && !c.closed)
            c.db.onversionchange?.call(c.db, {} as IDBVersionChangeEvent);
        const finish = () => {
          databases.delete(name);
          req.onsuccess?.call(req, new Event("success"));
        };
        if (connections.some((c) => c.name === name && !c.closed)) {
          pendingDeletes.push({ name, finish });
          req.onblocked?.call(req, {} as IDBVersionChangeEvent);
        } else finish();
      });
      return req;
    },
    async databases() {
      return [...databases].map(([name, { version }]) => ({ name, version }));
    },
  };

  return {
    factory,
    opens,
    failures,
    /** Install as `globalThis.indexedDB`; without `databases()` when asked. */
    install(options: { withDatabases?: boolean } = {}) {
      const value =
        options.withDatabases === false
          ? { open: factory.open, deleteDatabase: factory.deleteDatabase }
          : factory;
      Object.defineProperty(globalThis, "indexedDB", {
        configurable: true,
        value,
      });
    },
    has: (name: string) => databases.has(name),
    names: () => [...databases.keys()],
    /** Create a database with a "saves" store holding these entries. */
    seed(name: string, entries: Record<string, unknown>, version = 1) {
      const stores: Stores = new Map([
        ["saves", new Map(Object.entries(entries))],
      ]);
      databases.set(name, { version, stores });
    },
    get(name: string, key: string) {
      return databases.get(name)?.stores.get("saves")?.get(key);
    },
    set(name: string, key: string, value: unknown) {
      databases.get(name)?.stores.get("saves")?.set(key, value);
    },
    /** Remove every database; open connections are closed first. */
    reset() {
      for (const c of connections) c.closed = true;
      for (const c of connections) c.db.onclose?.call(c.db, new Event("close"));
      connections.length = 0;
      databases.clear();
      failures.open.clear();
      failures.read.clear();
      failures.write.clear();
      failures.delete.clear();
      opens.length = 0;
      holdWrites = false;
      held.length = 0;
    },
    hold() {
      holdWrites = true;
    },
    /** Settle held writes, committing them or aborting them. */
    release(abort = false) {
      holdWrites = false;
      heldAbort = abort;
      for (const settle of held.splice(0)) settle();
      heldAbort = false;
    },
    /** A connection another tab keeps open, ignoring versionchange. */
    stubbornConnection(name: string) {
      const entry = databases.get(name)!;
      return connect(name, entry.stores, entry.version);
    },
  };
}

export function fakeLocalStorage() {
  const items = new Map<string, string>();
  const failures = { read: false, write: new Set<string>() };
  const storage = {
    getItem(key: string) {
      if (failures.read)
        throw new DOMException("Synthetic policy denial", "SecurityError");
      return items.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (failures.write.has(key))
        throw new DOMException("Synthetic quota", "QuotaExceededError");
      items.set(key, value);
    },
    removeItem(key: string) {
      items.delete(key);
    },
  };
  return {
    storage,
    items,
    failures,
    install() {
      Object.defineProperty(globalThis, "localStorage", {
        configurable: true,
        value: storage,
      });
    },
    reset() {
      items.clear();
      failures.read = false;
      failures.write.clear();
    },
  };
}
