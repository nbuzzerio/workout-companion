import { validateSession, type Plan, type Session } from './workouts'
import { allStores, openDatabase, request, transaction } from './database'
import { enqueue } from './sync-store'
export { openDatabase } from './database'

export class SessionStore {
  readonly open: () => Promise<IDBDatabase>
  constructor(open: () => Promise<IDBDatabase> = openDatabase) { this.open = open }
  async ensurePlan(plan: Plan) {
    return transaction(this.open, allStores, 'readwrite', async tx => {
      const object = tx.objectStore('plans'); const prior = await request(object.get(plan.id))
      if (prior && prior.version !== 1) throw new Error('Unsupported plan version. Data retained.')
      // A remote tombstone must not be undone by the built-in demo initializer.
      const meta = await request(tx.objectStore('syncMeta').get(`plan:${plan.id}`))
      if (!prior && !meta) { await request(object.add(plan)); await enqueue(tx, 'plan', plan) }
    })
  }
  async list(date?: string): Promise<Session[]> {
    return transaction(this.open, ['sessions'], 'readonly', async tx => {
      const rows = await request(tx.objectStore('sessions').getAll()) as Session[]
      rows.forEach(validateSession)
      return rows.filter(s => !date || s.date === date).sort((a, b) => b.date.localeCompare(a.date))
    })
  }
  async plans(): Promise<Plan[]> {
    return transaction(this.open, ['plans'], 'readonly', async tx => request(tx.objectStore('plans').getAll()) as Promise<Plan[]>)
  }
  async reopen(id: string) { return (await this.list()).find(s => s.id === id) }
  async save(session: Session): Promise<Session> {
    validateSession(session); const snapshot = structuredClone(session)
    return transaction(this.open, allStores, 'readwrite', async tx => {
      const object = tx.objectStore('sessions'); const prior = await request(object.get(snapshot.id)) as Session | undefined
      if ((prior && (prior.version !== 1 || prior.status === 'completed' || prior.revision !== snapshot.revision || prior.date !== snapshot.date || prior.planId !== snapshot.planId)) || (!prior && snapshot.revision !== 0)) throw new Error('Session changed or completed. Reopen the saved session.')
      const saved = { ...snapshot, revision: snapshot.revision + 1 }
      await request(object.put(saved)); await enqueue(tx, 'session', saved)
      return saved
    })
  }
  async complete(session: Session) { return this.save({ ...session, status: 'completed' }) }
}
