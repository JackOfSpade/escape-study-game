/**
 * The lesson database: a store of its own, apart from the learner's saved
 * record. Lessons, lesson chat and read-state live here and nowhere else, so
 * nothing in this file can touch the save: it never opens the save's database
 * and imports none of the save modules.
 *
 * Each value is a string in the same envelope style as the save
 * ({schema, payload, checksum}), copied here rather than imported. Reading is
 * defensive: a value that is not a string, fails its checksum, has another
 * schema or does not hold a well-formed record is skipped, never deleted and
 * never thrown on, so one bad record cannot hide the others.
 *
 * Earlier builds kept lessons in a database with another name. The first open
 * copies it into the current database untouched and then deletes it; see
 * `connect` below.
 */
import { normalizeLesson } from "../scripts/lib/lesson-schema.mjs";
import { fnv1a } from "./hash";
import type { LessonMessage, LessonRecord } from "./lesson-types";
import { isRecord } from "./records";

const DB = "study-lessons",
  STORE = "lessons",
  /** Holds the one marker that says the legacy database has been copied. */
  META = "meta",
  MARKER = "legacy-migration";
/** The lesson database's name in earlier builds. It is read, copied into the
 * current database once and then deleted; it is never created. */
export const LEGACY_LESSON_DB = "dead-air-lessons";
export const LESSON_DB = DB;

/** Bounds on a stored record. Anything larger is not a record this app wrote. */
export const LESSON_STORE_LIMITS = {
  chat: 200,
  chatText: 8000,
  responses: 64,
  responseText: 4000,
  key: 200,
};

/** A lesson record plus the one extra field the tutor chat needs after a
 * reload: the gap's description. Assignable to `LessonRecord`. */
export type LessonEntry = LessonRecord & { gapDescription?: string };

interface Envelope {
  schema: 1;
  payload: string;
  checksum: number;
}

const STATES = ["pending", "ready", "failed", "interrupted"];
const SECTION_ID = /^[a-z][a-z0-9-]{0,31}$/;
const str = (v: unknown, max: number, min = 0): v is string =>
  typeof v === "string" && v.length >= min && v.length <= max;
const count = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

function validMessage(
  value: unknown,
  sectionIds: Set<string> | undefined,
): LessonMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { id, role, text, at, state, error, section } = value;
  if (
    !str(id, 120, 1) ||
    (role !== "learner" && role !== "tutor") ||
    !str(text, LESSON_STORE_LIMITS.chatText) ||
    !str(at, 64, 1) ||
    (state !== "sent" && state !== "pending" && state !== "failed") ||
    (error !== undefined && !str(error, 500)) ||
    (section !== undefined && !str(section, 32))
  )
    return undefined;
  return {
    id,
    role,
    text,
    at,
    state,
    ...(error !== undefined ? { error } : {}),
    // A pointer to a section the lesson does not have is dropped, not trusted.
    ...(section !== undefined &&
    SECTION_ID.test(section) &&
    sectionIds?.has(section)
      ? { section }
      : {}),
  };
}

/**
 * A clean copy of a stored record, or undefined when it is not one. A record
 * that holds a lesson must hold one `normalizeLesson` accepts, and the copy
 * carries the normalised lesson, never the stored one.
 */
export function validLessonRecord(value: unknown): LessonEntry | undefined {
  if (!isRecord(value)) return undefined;
  const {
    key,
    state,
    requestId,
    attempt,
    error,
    lesson,
    dropped,
    createdAt,
    readAt,
    responses,
    chat,
    chatSeq,
    gapDescription,
  } = value;
  if (
    !str(key, LESSON_STORE_LIMITS.key, 1) ||
    typeof state !== "string" ||
    !STATES.includes(state) ||
    !str(requestId, 300) ||
    !count(attempt, 100_000) ||
    (error !== undefined && !str(error, 500)) ||
    !str(createdAt, 64, 1) ||
    (readAt !== undefined && !str(readAt, 64, 1)) ||
    !count(chatSeq, 1_000_000) ||
    (gapDescription !== undefined && !str(gapDescription, 600))
  )
    return undefined;
  let clean: ReturnType<typeof normalizeLesson>["lesson"] | undefined;
  if (lesson !== undefined) {
    try {
      clean = normalizeLesson(lesson).lesson;
    } catch {
      return undefined;
    }
  }
  if (state === "ready" && !clean) return undefined;
  if (
    dropped !== undefined &&
    (!Array.isArray(dropped) ||
      dropped.length > 100 ||
      !dropped.every((d) => str(d, 300)))
  )
    return undefined;
  if (!isRecord(responses)) return undefined;
  const entries = Object.entries(responses);
  if (
    entries.length > LESSON_STORE_LIMITS.responses ||
    !entries.every(
      ([k, v]) => str(k, 80, 1) && str(v, LESSON_STORE_LIMITS.responseText),
    )
  )
    return undefined;
  if (!Array.isArray(chat) || chat.length > LESSON_STORE_LIMITS.chat)
    return undefined;
  const sectionIds = clean
    ? new Set(clean.sections.map((s) => s.id))
    : undefined;
  const messages: LessonMessage[] = [];
  for (const item of chat) {
    const message = validMessage(item, sectionIds);
    if (!message) return undefined;
    messages.push(message);
  }
  return {
    key,
    state: state as LessonRecord["state"],
    requestId,
    attempt,
    ...(error !== undefined ? { error } : {}),
    ...(clean ? { lesson: clean } : {}),
    ...(dropped !== undefined ? { dropped: [...(dropped as string[])] } : {}),
    createdAt,
    ...(readAt !== undefined ? { readAt } : {}),
    responses: Object.fromEntries(entries) as Record<string, string>,
    chat: messages,
    chatSeq,
    ...(gapDescription !== undefined ? { gapDescription } : {}),
  };
}

function encode(record: LessonEntry) {
  const payload = JSON.stringify(record);
  return JSON.stringify({
    schema: 1,
    payload,
    checksum: fnv1a(payload),
  } satisfies Envelope);
}

/** Null for any value that is not a sound record. Never throws. */
function decode(value: unknown): LessonEntry | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const e = JSON.parse(value) as Envelope;
    if (
      !isRecord(e) ||
      e.schema !== 1 ||
      typeof e.payload !== "string" ||
      fnv1a(e.payload) !== e.checksum
    )
      return undefined;
    return validLessonRecord(JSON.parse(e.payload));
  } catch {
    return undefined;
  }
}

/** The parts of IndexedDB the lesson store uses. `databases` and
 * `deleteDatabase` are optional so a bare `open` still works. */
export type LessonIdb = Pick<IDBFactory, "open"> &
  Partial<Pick<IDBFactory, "databases" | "deleteDatabase">>;

/** Resolves once a transaction commits; rejects if it aborts. */
function committed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () =>
      reject(tx.error ?? Error("The lesson database transaction failed"));
  });
}

/** The current database, created with both stores on first open. */
function openCurrent(idb: LessonIdb) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb.open(DB, 1);
    let failed = false;
    const fail = (error: unknown) => {
      failed = true;
      reject(error);
    };
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => {
      const db = req.result;
      // A blocked open cannot be cancelled; close its eventual connection.
      if (failed) {
        db.close();
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () =>
      fail(req.error ?? Error("Could not open the lesson database"));
    req.onblocked = () =>
      fail(
        Error("Another browser tab is blocking the lesson database upgrade"),
      );
  });
}

/** Whether the legacy database may exist: false only when the browser can
 * list its databases and the legacy one is not among them. */
async function mayHaveLegacy(idb: LessonIdb) {
  if (typeof idb.databases !== "function") return true;
  try {
    return (await idb.databases()).some((d) => d.name === LEGACY_LESSON_DB);
  } catch {
    return true;
  }
}

/**
 * A connection to the legacy database, or undefined when there is none. It
 * opens without a version, so an existing database is never upgraded, and
 * when the database does not exist (oldVersion 0) it aborts the versionchange
 * transaction, so the probe never creates it.
 */
async function openLegacy(idb: LessonIdb) {
  if (!(await mayHaveLegacy(idb))) return undefined;
  return new Promise<IDBDatabase | undefined>((resolve, reject) => {
    const req = idb.open(LEGACY_LESSON_DB);
    let absent = false,
      failed = false;
    req.onupgradeneeded = (event) => {
      if (event.oldVersion !== 0) return;
      absent = true;
      req.transaction?.abort();
    };
    req.onsuccess = () => {
      const db = req.result;
      if (absent || failed) {
        db.close();
        if (!failed) resolve(undefined);
        return;
      }
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = (event) => {
      // The abort above surfaces here; it is the expected "no database" answer.
      event?.preventDefault?.();
      if (absent) resolve(undefined);
      else
        reject(req.error ?? Error("Could not open the legacy lesson database"));
    };
    req.onblocked = () => {
      failed = true;
      reject(Error("The legacy lesson database is blocked"));
    };
  });
}

/** Best effort: a blocked or failed delete is not an error, and the next
 * open tries again. Deleting never creates a database. */
function removeLegacy(idb: LessonIdb) {
  const deleteDatabase = idb.deleteDatabase?.bind(idb);
  if (!deleteDatabase) return;
  void mayHaveLegacy(idb).then((maybe) => {
    if (!maybe) return;
    try {
      const req = deleteDatabase(LEGACY_LESSON_DB);
      req.onerror = (event) => event?.preventDefault?.();
    } catch {
      // Retried on a later open.
    }
  });
}

async function hasMarker(db: IDBDatabase) {
  const tx = db.transaction(META, "readonly");
  const req = tx.objectStore(META).get(MARKER);
  await committed(tx);
  return req.result !== undefined;
}

/** Every key and value in the legacy store, exactly as stored. */
async function readLegacy(legacy: IDBDatabase) {
  if (!legacy.objectStoreNames.contains(STORE))
    return { keys: [] as IDBValidKey[], values: [] as unknown[] };
  const tx = legacy.transaction(STORE, "readonly");
  const store = tx.objectStore(STORE);
  const keys = store.getAllKeys(),
    values = store.getAll();
  await committed(tx);
  if (keys.result.length !== values.result.length)
    throw Error("The legacy lesson store changed while it was read");
  return { keys: keys.result, values: values.result as unknown[] };
}

const keyId = (key: IDBValidKey) => `${typeof key}:${String(key)}`;

/**
 * Copies the legacy values into the current store in one transaction that
 * also writes the marker. Values go in as they are, never decoded, so a
 * record the reader would skip is still carried over. The marker is checked
 * inside the same read-write transaction, and such transactions on one store
 * run one at a time, so two opens racing here copy once. A key the current
 * store already holds keeps its current value.
 */
async function copyLegacy(
  db: IDBDatabase,
  legacy: { keys: IDBValidKey[]; values: unknown[] },
) {
  const tx = db.transaction([STORE, META], "readwrite");
  const lessons = tx.objectStore(STORE),
    meta = tx.objectStore(META);
  const marker = meta.get(MARKER);
  marker.onsuccess = () => {
    if (marker.result !== undefined) return;
    const have = lessons.getAllKeys();
    have.onsuccess = () => {
      const present = new Set(have.result.map(keyId));
      let copied = 0;
      legacy.keys.forEach((key, i) => {
        if (present.has(keyId(key))) return;
        lessons.put(legacy.values[i], key);
        copied++;
      });
      meta.put(
        { from: LEGACY_LESSON_DB, copied, at: new Date().toISOString() },
        MARKER,
      );
    };
  };
  await committed(tx);
}

/**
 * Opens the current database and, until it carries the migration marker,
 * moves the legacy database into it. The legacy database is deleted only
 * after the copy commits. If the copy fails, this session reads and writes
 * the untouched legacy database instead, so no lesson goes missing, and the
 * next open tries the copy again; anything written there meanwhile is carried
 * over with the rest.
 */
async function connect(idb: LessonIdb): Promise<IDBDatabase> {
  const current = await openCurrent(idb);
  if (!current.objectStoreNames.contains(META)) return current;
  try {
    if (await hasMarker(current)) {
      removeLegacy(idb);
      return current;
    }
  } catch {
    return current;
  }
  let legacy: IDBDatabase | undefined;
  try {
    legacy = await openLegacy(idb);
  } catch {
    return current;
  }
  if (!legacy) return current;
  let values;
  try {
    values = await readLegacy(legacy);
  } catch {
    legacy.close();
    return current;
  }
  try {
    await copyLegacy(current, values);
  } catch {
    current.close();
    return legacy;
  }
  legacy.close();
  removeLegacy(idb);
  return current;
}

/** Each instance owns its connection; rejected or closed connections are never cached. */
export function createLessonStore(factory: () => LessonIdb = () => indexedDB) {
  let opening: Promise<IDBDatabase> | undefined;
  function database() {
    if (opening) return opening;
    // Defer open so even a synchronous SecurityError can clear the assigned promise.
    const pending = Promise.resolve()
      .then(() => connect(factory()))
      .then((db) => {
        const forget = () => {
          if (opening === pending) opening = undefined;
        };
        db.onversionchange = () => {
          db.close();
          forget();
        };
        db.onclose = forget;
        return db;
      });
    opening = pending;
    void pending.catch(() => {
      if (opening === pending) opening = undefined;
    });
    return pending;
  }
  /** Runs one transaction and resolves with what `use` collected once the
   * transaction itself completes, not merely when its request succeeds. */
  async function transact<T>(
    mode: IDBTransactionMode,
    use: (store: IDBObjectStore, collect: (value: T) => void) => void,
    empty: T,
  ) {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      let result = empty;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () =>
        reject(tx.error ?? Error("The lesson database transaction failed"));
      use(tx.objectStore(STORE), (value) => {
        result = value;
      });
    });
  }
  return {
    /** Every sound record. Unsound values are skipped and left in place. */
    async all(): Promise<LessonEntry[]> {
      const values = await transact<unknown[]>(
        "readonly",
        (store, collect) => {
          const req = store.getAll();
          req.onsuccess = () => collect(req.result as unknown[]);
        },
        [],
      );
      const records: LessonEntry[] = [];
      for (const value of values) {
        const record = decode(value);
        if (record) records.push(record);
      }
      return records;
    },
    async put(record: LessonEntry): Promise<void> {
      // Encoded before the first await, so a later change cannot reach the write.
      const value = encode(record);
      await transact<void>(
        "readwrite",
        (store) => {
          store.put(value, record.key);
        },
        undefined,
      );
    },
    async remove(key: string): Promise<void> {
      await transact<void>(
        "readwrite",
        (store) => {
          store.delete(key);
        },
        undefined,
      );
    },
  };
}

export type LessonStore = ReturnType<typeof createLessonStore>;
export const lessonStore: LessonStore = createLessonStore();
