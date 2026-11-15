import { validateSession, type Plan, type Session } from './workouts'
import { appConfig } from '../config/app'

// Initial additive schema. Never clear stores; reject unknown record versions.
export async function openDatabase(name = appConfig.databaseName): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('Local storage unavailable. Enable browser storage and retry.')
  return new Promise((resolve, reject) => {
    let blocked = false
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('plans', { keyPath: 'id' })
      request.result.createObjectStore('sessions', { keyPath: 'id' })
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => { blocked = true; reject(new Error('Close other Workout Companion tabs and retry.')) }
    request.onsuccess = () => { if (blocked) { request.result.close(); return } request.result.onversionchange = () => request.result.close(); resolve(request.result) }
  })
}
export class SessionStore {
  private readonly open: () => Promise<IDBDatabase>

  constructor(open: () => Promise<IDBDatabase> = openDatabase) {
    this.open = open
  }
  private async transaction<T>(store: string, mode: IDBTransactionMode, run: (object: IDBObjectStore, result: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    const db = await this.open()
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode)
      let value: T
      let failure: Error | undefined
      tx.oncomplete = () => { db.close(); resolve(value) }
      tx.onabort = tx.onerror = () => { db.close(); reject(failure ?? tx.error ?? new Error('Storage failed; nothing was saved.')) }
      try { run(tx.objectStore(store), next => { value = next }, error => { failure = error; tx.abort() }) }
      catch (error) { failure = error as Error; tx.abort() }
    })
  }
  async ensurePlan(plan: Plan) {
    return this.transaction<void>('plans', 'readwrite', (object, _result, fail) => {
      const request = object.get(plan.id)
      request.onsuccess = () => {
        if (request.result && request.result.version !== 1) { fail(new Error('Unsupported plan version. Data retained.')); return }
        if (!request.result) object.add(plan)
      }
    })
  }
  async list(date?: string): Promise<Session[]> {
    return this.transaction<Session[]>('sessions', 'readonly', (object, result, fail) => {
      const request = object.getAll()
      request.onsuccess = () => {
        try { const rows = request.result as Session[]; rows.forEach(validateSession); result(rows.filter(s => !date || s.date === date).sort((a, b) => b.date.localeCompare(a.date))) }
        catch (error) { fail(error as Error) }
      }
    })
  }
  async reopen(id: string) { return (await this.list()).find(s => s.id === id) }
  async save(session: Session): Promise<Session> {
    validateSession(session)
    const snapshot = structuredClone(session)
    return this.transaction<Session>('sessions', 'readwrite', (object, result, fail) => {
      const request = object.get(snapshot.id)
      request.onsuccess = () => {
        const prior = request.result as Session | undefined
        if ((prior && (prior.version !== 1 || prior.status === 'completed' || prior.revision !== snapshot.revision || prior.date !== snapshot.date || prior.planId !== snapshot.planId)) || (!prior && snapshot.revision !== 0)) { fail(new Error('Session changed or completed. Reopen the saved session.')); return }
        const saved = { ...snapshot, revision: snapshot.revision + 1 }
        object.put(saved)
        result(saved)
      }
    })
  }
  async complete(session: Session) { return this.save({ ...session, status: 'completed' }) }
}
