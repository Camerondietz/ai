/**
 * Minimal promise wrapper around IndexedDB. All workspace data lives here, in
 * this browser profile only. Nothing is synced anywhere.
 */
export type StoreName = 'kv' | 'conversations' | 'prompts' | 'datasets' | 'evals' | 'models' | 'usage';

/** Stores holding user records (keyPath "id"). "kv" holds settings and the vault. */
export const DATA_STORES = ['conversations', 'prompts', 'datasets', 'evals', 'models', 'usage'] as const;
export type DataStoreName = (typeof DATA_STORES)[number];

const DB_NAME = 'ai-workbench';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        for (const name of DATA_STORES) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgraded or deleted the database: release our handle.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
      req.onblocked = () => reject(new Error('Database is blocked by another open tab of this app.'));
    });
    dbPromise.catch(() => {
      dbPromise = null;
    });
  }
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

export async function dbGet<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return (await request(db.transaction(store, 'readonly').objectStore(store).get(key))) as T | undefined;
}

export async function dbGetAll<T>(store: StoreName): Promise<T[]> {
  const db = await openDb();
  return (await request(db.transaction(store, 'readonly').objectStore(store).getAll())) as T[];
}

export async function dbPut(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  if (key === undefined) os.put(value);
  else os.put(value, key);
  await complete(tx);
}

export async function dbBulkPut(store: StoreName, values: unknown[]): Promise<void> {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  for (const value of values) os.put(value);
  await complete(tx);
}

export async function dbDelete(store: StoreName, key: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await complete(tx);
}

export async function dbClear(store: StoreName): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await complete(tx);
}

/** Permanently removes the whole database (used by "Wipe all data"). */
export async function dbDestroy(): Promise<void> {
  if (dbPromise) {
    try {
      (await dbPromise).close();
    } catch {
      // ignore
    }
    dbPromise = null;
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to delete database'));
    req.onblocked = () => resolve();
  });
}
