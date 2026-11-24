import { sessionWeekday, validateSession, type PlanExercise, type Plan, type Session } from './workouts'
import { correctCompletedResults, type ResultCorrection } from './guided-workout'
import { planSchema, same } from './sync'
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
  async saveImportedPlan(plan: Plan, expected?: Plan): Promise<Plan> {
    const saved = structuredClone(plan)
    const original = structuredClone(expected)
    if (!saved.workoutDate || !planSchema.safeParse(saved).success) throw new Error('Check the workout date, exercise names and planned targets.')
    return transaction(this.open, allStores, 'readwrite', async tx => {
      const object = tx.objectStore('plans')
      const plans = await request(object.getAll()) as Plan[]
      const prior = plans.find(plan => plan.id === saved.id)
      if (!same(prior, original) || (prior && (prior.workoutDate !== saved.workoutDate || prior.weekday !== saved.weekday))) {
        throw new Error('The plan for this date and day changed. Reopen the import to review the latest plan.')
      }
      const sessions = await request(tx.objectStore('sessions').getAll()) as Session[]
      if (sessions.some(session => session.status === 'active' && session.date === saved.workoutDate
        && sessionWeekday(session, plans.find(plan => plan.id === session.planId)) === saved.weekday)) {
        throw new Error('An active workout exists for this date and day. Resume and finish it before importing.')
      }
      if (same(prior, saved)) return saved
      await request(object.put(saved))
      await enqueue(tx, 'plan', saved)
      return saved
    })
  }
  async savePlan(expected: Plan, exercises: PlanExercise[]): Promise<Plan> {
    const original = structuredClone(expected)
    const changes = structuredClone(exercises)
    return transaction(this.open, allStores, 'readwrite', async tx => {
      const object = tx.objectStore('plans')
      const prior = await request(object.get(original.id)) as Plan | undefined
      if (!prior || prior.version !== 1 || !same(prior, original)) throw new Error('Plan changed. Reopen the editor to load the latest plan.')
      const saved = { ...prior, exercises: changes }
      if (!planSchema.safeParse(saved).success) throw new Error('Check the exercise names and planned targets.')
      if (same(prior, saved)) return prior
      await request(object.put(saved))
      await enqueue(tx, 'plan', saved)
      return saved
    })
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
  async correctResults(expected: Session, corrections: ResultCorrection[]): Promise<Session> {
    const original = structuredClone(expected)
    const changes = structuredClone(corrections)
    return transaction(this.open, allStores, 'readwrite', async tx => {
      const object = tx.objectStore('sessions')
      const prior = await request(object.get(original.id)) as Session | undefined
      if (!prior || !same(prior, original)) throw new Error('Workout changed. Reopen the saved workout to load the latest results.')
      const corrected = correctCompletedResults(prior, changes)
      if (same(prior, corrected)) return prior
      const saved = { ...corrected, revision: prior.revision + 1 }
      validateSession(saved)
      await request(object.put(saved))
      await enqueue(tx, 'session', saved)
      return saved
    })
  }
}
