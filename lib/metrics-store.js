/**
 * metrics-store.js — the metrics buffer (IndexedDB).
 *
 * DELIBERATELY a SEPARATE database from db.js ("tab-llm").
 *
 * The reason is not technical, it is privacy: the history database can hold
 * patient text (questions, answers, screenshots), whereas the metrics database
 * never can. Keeping both in one file would make that boundary a mere
 * convention; separate databases make it verifiable ("clear
 * tab-llm-metrics" = metrics cleared, and nothing else).
 *
 * A second reason: no need to bump db.js's DB_VERSION and migrate history.
 *
 * NO sanitisation happens here — that is lib/metrics.js's responsibility.
 * This module writes what it is given.
 */

const DB_NAME = 'tab-llm-metrics';
const DB_VERSION = 1;
const STORE = 'events';

/**
 * A cap so that memory does not grow without bound while the collector is
 * unavailable. Past the cap the OLDEST are dropped: recent events are worth
 * more than old ones.
 */
export const MAX_EVENTS = 5000;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        os.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function store(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function reqToPromise(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

/** Appends one event. @returns {Promise<number>} the record id */
export async function append(event) {
  const db = await openDB();
  const id = await reqToPromise(store(db, 'readwrite').add(event));
  prune(db).catch(() => {});
  return id;
}

/**
 * Reads the oldest events (FIFO — sent in the order they happened).
 * @returns {Promise<Array<{id:number}>>}
 */
export async function readBatch(limit = 500) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const out = [];
    const cursorReq = store(db, 'readonly').index('ts').openCursor(null, 'next');
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur && out.length < limit) {
        out.push(cur.value);
        cur.continue();
      } else {
        res(out);
      }
    };
    cursorReq.onerror = () => rej(cursorReq.error);
  });
}

/** Deletes sent events by id. Called ONLY after a 2xx from the collector. */
export async function remove(ids) {
  if (!ids?.length) return;
  const db = await openDB();
  const os = store(db, 'readwrite');
  await Promise.all(ids.map((id) => reqToPromise(os.delete(id))));
}

export async function count() {
  const db = await openDB();
  return reqToPromise(store(db, 'readonly').count());
}

export async function clear() {
  const db = await openDB();
  return reqToPromise(store(db, 'readwrite').clear());
}

/** Everything, for export (stage 1 — no backend, the user downloads a file). */
export async function readAll() {
  return readBatch(MAX_EVENTS);
}

/** Keeps only the MAX_EVENTS most recent; the oldest are dropped. */
async function prune(db) {
  const total = await reqToPromise(store(db, 'readonly').count());
  let toDelete = total - MAX_EVENTS;
  if (toDelete <= 0) return;
  await new Promise((res, rej) => {
    const cursorReq = store(db, 'readwrite').index('ts').openCursor(null, 'next');
    cursorReq.onsuccess = () => {
      const cur = cursorReq.result;
      if (cur && toDelete > 0) {
        cur.delete();
        toDelete--;
        cur.continue();
      } else {
        res();
      }
    };
    cursorReq.onerror = () => rej(cursorReq.error);
  });
}
