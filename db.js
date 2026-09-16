"use strict";

// Local history store (IndexedDB). Everything stays on the machine. Each entry
// is one completed Q&A: { id, ts, url, title, note, prompt, answer, thumb, image }.
// `thumb` is a small JPEG for the list; `image` is the full screenshot for reopen.

const DB_NAME = "tab-llm";
const DB_VERSION = 1;
const STORE = "entries";
const MAX_ENTRIES = 200; // prune oldest beyond this to bound disk use

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("ts", "ts");
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

export async function addEntry(entry) {
  const db = await openDB();
  const id = await reqToPromise(store(db, "readwrite").add({ ...entry, ts: entry.ts || Date.now() }));
  pruneOld(db).catch(() => {});
  return id;
}

export async function getRecent(limit = 300) {
  const db = await openDB();
  return new Promise((res, rej) => {
    const out = [];
    const cursorReq = store(db, "readonly").index("ts").openCursor(null, "prev");
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

export async function getEntry(id) {
  const db = await openDB();
  return reqToPromise(store(db, "readonly").get(id));
}

export async function deleteEntry(id) {
  const db = await openDB();
  return reqToPromise(store(db, "readwrite").delete(id));
}

export async function clearAll() {
  const db = await openDB();
  return reqToPromise(store(db, "readwrite").clear());
}

// Keep only the newest MAX_ENTRIES; delete the oldest by ts.
async function pruneOld(db) {
  const count = await reqToPromise(store(db, "readonly").count());
  let toDelete = count - MAX_ENTRIES;
  if (toDelete <= 0) return;
  await new Promise((res, rej) => {
    const cursorReq = store(db, "readwrite").index("ts").openCursor(null, "next");
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

// Simple client-side search over the recent window (no FTS index needed at this
// scale). Matches all whitespace-separated terms across prompt/answer/title/url.
export async function search(query, { limit = 300 } = {}) {
  const recent = await getRecent(limit);
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return recent;
  return recent.filter((e) => {
    const hay = `${e.prompt || ""}\n${e.answer || ""}\n${e.title || ""}\n${e.url || ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
