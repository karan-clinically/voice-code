// Local-first display caches. Network responses remain authoritative and replace
// these snapshots in the background after every open.

const SESSION_KEY = 'cvh_connected_sessions_v1';
const SESSION_USAGE_KEY = 'cvh_session_usage_v1';
// Session cards are only an immediate visual snapshot; every mounted list replaces
// them from the server. Keep them through a normal overnight/background interval
// so a cold PWA restore never starts with an empty screen while the radio wakes.
const SESSION_MAX_AGE = 24 * 60 * 60 * 1000;
const DB_NAME = 'cvh-local-cache';
const STORE = 'terminal-snapshots';
const TERMINAL_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const TERMINAL_MAX_CHARS = 900_000;
const TERMINAL_MAX_ENTRIES = 12;

export function readSessionCards() {
  try {
    const cached = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!cached || Date.now() - cached.savedAt > SESSION_MAX_AGE || !Array.isArray(cached.rows)) return [];
    return cached.rows;
  } catch {
    return [];
  }
}

export function writeSessionCards(rows) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ savedAt: Date.now(), rows: rows || [] }));
  } catch {
    /* private mode / quota: network behavior remains unchanged */
  }
}

export function readSessionUsage() {
  try {
    const value = JSON.parse(localStorage.getItem(SESSION_USAGE_KEY) || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

export function recordSessionView(sessionId) {
  if (sessionId == null) return;
  try {
    const usage = readSessionUsage();
    const key = String(sessionId);
    const previous = usage[key] || {};
    usage[key] = { views: (Number(previous.views) || 0) + 1, lastViewed: Date.now() };
    // Session ids are monotonic; bound this preference so years of ended sessions
    // cannot grow localStorage indefinitely.
    const bounded = Object.fromEntries(
      Object.entries(usage).sort((a, b) => (b[1]?.lastViewed || 0) - (a[1]?.lastViewed || 0)).slice(0, 100)
    );
    localStorage.setItem(SESSION_USAGE_KEY, JSON.stringify(bounded));
  } catch {
    /* private mode / quota: fall back to server ordering */
  }
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'sessionId' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function requestResult(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function boundedTerminalHtml(html) {
  const source = String(html || '');
  if (source.length <= TERMINAL_MAX_CHARS) return source;
  // Never cut through a span. Oversized snapshots become a safe plain-text tail.
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const tail = (doc.body.textContent || '').slice(-TERMINAL_MAX_CHARS);
  const escaped = tail.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return `[Older cached terminal output omitted]\n${escaped}`;
}

export async function readTerminalSnapshot(sessionId) {
  try {
    const db = await openDb();
    const row = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).get(String(sessionId)));
    db.close();
    if (!row || Date.now() - row.savedAt > TERMINAL_MAX_AGE) return null;
    return row;
  } catch {
    return null;
  }
}

export async function writeTerminalSnapshot(sessionId, html) {
  try {
    const db = await openDb();
    const writeTx = db.transaction(STORE, 'readwrite');
    writeTx.objectStore(STORE).put({ sessionId: String(sessionId), savedAt: Date.now(), html: boundedTerminalHtml(html) });
    await transactionDone(writeTx);
    const rows = await requestResult(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
    const pruneTx = db.transaction(STORE, 'readwrite');
    const pruneStore = pruneTx.objectStore(STORE);
    rows
      .sort((a, b) => b.savedAt - a.savedAt)
      .slice(TERMINAL_MAX_ENTRIES)
      .forEach((row) => pruneStore.delete(row.sessionId));
    await transactionDone(pruneTx);
    db.close();
  } catch {
    /* best-effort cache */
  }
}
