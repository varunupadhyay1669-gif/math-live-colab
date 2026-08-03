// Keeping a lesson's capture alive across a reload.
//
// The class pack lived in a React ref: a browser crash, an accidental refresh,
// or a laptop going to sleep at minute 40 threw away the whole lesson — the
// board frames, the transcript, every answered question. That is the one
// failure a tutor cannot recover from, because the lesson is over.
//
// IndexedDB rather than localStorage: a lesson's snapshots run to megabytes and
// would blow the ~5MB string quota within ten minutes. This is a deliberately
// tiny wrapper — one store, four operations — because a dependency for this
// would be larger than the code.

const DB_NAME = 'mathslive';
const DB_VERSION = 1;
const STORE = 'packs';

export interface StoredPack {
  /** room + start date — one pack per room per day, so a reload rejoins it. */
  key: string;
  room: string;
  startedAt: number;
  savedAt: number;
  /** The serialised ClassPack state plus the exporter's side tables. */
  state: unknown;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    // Private browsing and a full disk both land here rather than throwing.
    req.onblocked = () => reject(new Error('indexeddb blocked'));
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error);
    t.oncomplete = () => db.close();
  }));
}

/** room + the day it started. Two lessons in one room on one day share a pack. */
export function packKey(room: string, startedAt: number): string {
  const d = new Date(startedAt);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${room || 'room'}:${date}`;
}

/**
 * Never throws. A failed save must not interrupt a lesson — the in-memory pack
 * is still intact, and the next autosave will try again.
 */
export async function savePack(entry: StoredPack): Promise<boolean> {
  try {
    await tx('readwrite', store => store.put(entry));
    return true;
  } catch {
    return false;
  }
}

export async function loadPack(key: string): Promise<StoredPack | null> {
  try {
    const found = await tx<StoredPack | undefined>('readonly', store => store.get(key));
    return found ?? null;
  } catch {
    return null;
  }
}

export async function listPacks(): Promise<StoredPack[]> {
  try {
    const all = await tx<StoredPack[]>('readonly', store => store.getAll());
    return (all || []).sort((a, b) => b.startedAt - a.startedAt);
  } catch {
    return [];
  }
}

export async function deletePack(key: string): Promise<void> {
  try { await tx('readwrite', store => store.delete(key)); } catch { /* nothing to do */ }
}

/**
 * Drop anything older than a fortnight.
 *
 * These hold a student's board work and what was said, so they should not
 * accumulate on a shared machine indefinitely. A fortnight is long enough to
 * re-export a pack you forgot to save.
 */
export async function prunePacks(maxAgeMs = 14 * 24 * 3600 * 1000, now = Date.now()): Promise<number> {
  const all = await listPacks();
  const stale = all.filter(p => now - p.startedAt > maxAgeMs);
  for (const p of stale) await deletePack(p.key);
  return stale.length;
}
