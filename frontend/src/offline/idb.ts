/** IndexedDB behind `PendingStore`: database `checkist-offline`, store `pending-spends`, key `id`. No dependencies.
 * Without IndexedDB (Node, a private window that refuses it) the spends live in memory until the page is closed.
 */
import { memoryStore } from './pending'
import type { PendingSpend, PendingStore } from './pending'

const DB_NAME = 'checkist-offline'
const STORE = 'pending-spends'

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

let opened: Promise<IDBDatabase> | undefined
function open(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('blocked'))
  }).catch((error: unknown) => {
    opened = undefined
    throw error
  })
  return opened
}

async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  const transaction = db.transaction(STORE, mode)
  // A write counts once it is committed, not when the request succeeded.
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
  done.catch(() => undefined)
  const result = await request(action(transaction.objectStore(STORE)))
  await done
  return result
}

const indexedStore: PendingStore = {
  list: () => run('readonly', (store) => store.getAll() as IDBRequest<PendingSpend[]>),
  put: async (spend) => { await run('readwrite', (store) => store.put(spend)) },
  remove: async (id) => { await run('readwrite', (store) => store.delete(id)) },
}

let fallback: PendingStore | undefined
/** The store of this browser: IndexedDB when it opens, memory otherwise. */
export function pendingStore(): PendingStore {
  if (typeof indexedDB === 'undefined') return (fallback ??= memoryStore())
  return {
    list: () => indexedStore.list().catch(() => (fallback ??= memoryStore()).list()),
    put: (spend) => indexedStore.put(spend).catch(() => (fallback ??= memoryStore()).put(spend)),
    remove: (id) => indexedStore.remove(id).catch(() => (fallback ??= memoryStore()).remove(id)),
  }
}
