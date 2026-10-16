/**
 * Device key store (IndexedDB). Private keys are stored as non-extractable CryptoKey objects:
 * scripts on the page can use them to decrypt, but their bytes can never be read back out.
 * Signing out deletes everything here (the server also sends Clear-Site-Data).
 */

export interface StoredKey {
  kid: string;
  publicKey: string;
  privateKey: CryptoKey;
  createdAt: string;
}

export interface StoredIdentity {
  userId: string;
  /** Newest (active) first; older keys are kept to read older messages. */
  keys: StoredKey[];
  /** AES key derived from the recovery key, kept so the backup can be re-sealed after a rotation. */
  backupKey: CryptoKey | null;
  backupSalt: string | null;
  backupIterations: number | null;
}

/** What this device has seen of a contact's identity key (trust-on-first-use + manual verification). */
export interface KeyPin {
  id: string; // `${myUserId}:${peerUserId}`
  kid: string;
  verified: boolean;
  verifiedAt: string | null;
  /** Set when the key changed after it had been verified; cleared by re-verifying or dismissing. */
  changedAfterVerify: boolean;
}

const DB_NAME = 'cove-e2ee';
const VERSION = 1;
let dbp: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('identity')) d.createObjectStore('identity', { keyPath: 'userId' });
        if (!d.objectStoreNames.contains('pins')) d.createObjectStore('pins', { keyPath: 'id' });
      };
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => {
          d.close();
          dbp = null;
        };
        resolve(d);
      };
      req.onerror = () => {
        dbp = null;
        reject(req.error ?? new Error('IndexedDB unavailable'));
      };
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }
  return dbp;
}

async function run<T>(store: 'identity' | 'pins', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req ? (req.result as T) : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const keystore = {
  getIdentity: (userId: string) => run<StoredIdentity>('identity', 'readonly', (s) => s.get(userId) as IDBRequest<StoredIdentity>),
  putIdentity: (v: StoredIdentity) => run('identity', 'readwrite', (s) => void s.put(v)),
  deleteIdentity: (userId: string) => run('identity', 'readwrite', (s) => void s.delete(userId)),
  getPin: (id: string) => run<KeyPin>('pins', 'readonly', (s) => s.get(id) as IDBRequest<KeyPin>),
  putPin: (v: KeyPin) => run('pins', 'readwrite', (s) => void s.put(v)),
  /** Remove every key and pin from this device. */
  async wipe() {
    try {
      const d = await db();
      d.close();
    } catch {
      /* not open */
    }
    dbp = null;
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    });
  },
  supported: () => typeof indexedDB !== 'undefined' && !!globalThis.crypto?.subtle,
};
