import { appConfig } from '../config/app'

export const syncStores = ['syncSettings', 'syncMeta', 'syncOutbox', 'syncConflicts', 'syncRemote', 'syncBackups', 'syncPeople', 'syncSpaces']
export const allStores = ['plans', 'sessions', ...syncStores]
export async function openDatabase(name = appConfig.databaseName): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('Local storage unavailable. Enable browser storage and retry.')
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(name, 2)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const name of ['plans', 'sessions']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
      for (const name of syncStores) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
      request.transaction!.objectStore('syncSettings').put({ id: 'settings', deviceId: crypto.randomUUID(), enabled: false, phase: 'local', cursor: null, commonCursor: null, failures: 0, nextRetry: 0 })
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => { blocked = true; reject(new Error('Close other Workout Companion tabs and retry.')) }
    request.onsuccess = () => { if (blocked) { request.result.close(); return } request.result.onversionchange = () => request.result.close(); resolve(request.result) }
  })
}
export function request<T>(r: IDBRequest<T>): Promise<T> { return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }) }
export type StorageNotice = { type: 'refresh' | 'local' } | { type: 'control'; enabled: boolean }
const notices = new WeakMap<IDBTransaction, StorageNotice>()
// Only confirmed local mutations wake upload scheduling, and only on commit.
export function markLocalChange(tx: IDBTransaction) { if (notices.get(tx)?.type !== 'control') notices.set(tx, { type: 'local' }) }
export function markSyncControl(tx: IDBTransaction, enabled: boolean) { notices.set(tx, { type: 'control', enabled }) }
export function announce(notice: StorageNotice = { type: 'refresh' }) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('workout-storage', { detail: notice }))
  if (typeof BroadcastChannel !== 'undefined') { const channel = new BroadcastChannel('workout-storage'); channel.postMessage(notice); channel.close() }
}
export async function transaction<T>(open: () => Promise<IDBDatabase>, stores: string[], mode: IDBTransactionMode, run: (tx: IDBTransaction) => Promise<T>): Promise<T> {
  const db = await open()
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' })
    let value: T; let failure: unknown
    tx.oncomplete = () => { db.close(); if (mode === 'readwrite') announce(notices.get(tx)); resolve(value) }
    tx.onabort = () => { db.close(); reject(failure && typeof failure === 'object' && 'name' in failure && failure.name === 'AbortError' ? new Error('Storage failed; nothing was saved.') : failure ?? tx.error ?? new Error('Storage failed; nothing was saved.')) }
    void run(tx).then(v => { value = v }, e => { failure = e?.name === 'AbortError' ? new Error('Storage failed; nothing was saved.') : e; try { tx.abort() } catch { db.close(); reject(failure) } })
  })
}
