export type Performance = { kind: 'weight'; pounds: number; reps: number } | { kind: 'machine'; position: string; reps: number } | { kind: 'hold'; seconds: number }
export interface Exercise { id: string; name: string; sets: Performance[]; musclesSource?: string }
export interface Plan { version: 1; id: string; name: string; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; demo: boolean; exercises: Exercise[] }
export interface Session { version: 1; id: string; planId: string; date: string; demo: boolean; revision: number; status: 'active' | 'completed'; exercises: Exercise[] }
export const sourceExamples = ['46×10 | 55×10 | 63×10 | 72×8', 'P9×12 | P10×10']
export const demoPlan: Plan = { version: 1, id: 'demo-monday-v1', name: 'DEMO Monday', weekday: 1, demo: true, exercises: [
  { id: 'deadlift', name: 'DB Deadlift', sets: [46, 55, 63, 72].map((pounds, i) => ({ kind: 'weight', pounds, reps: i === 3 ? 8 : 10 })) },
  { id: 'extension', name: 'Leg Extension', sets: [{ kind: 'machine', position: 'P9', reps: 12 }, { kind: 'machine', position: 'P10', reps: 10 }] },
  { id: 'press', name: 'Seated Military Press', sets: [{ kind: 'weight', pounds: 20, reps: 10 }] },
] }
export function assertDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date) throw new Error('Choose a valid calendar date.')
}
export function createPlan(input: Omit<Plan, 'id' | 'version'>): Plan { return { ...structuredClone(input), id: crypto.randomUUID(), version: 1 } }
export function createSession(plan: Plan, date: string): Session {
  assertDate(date)
  return { version: 1, id: crypto.randomUUID(), planId: plan.id, date, demo: plan.demo, revision: 0, status: 'active', exercises: structuredClone(plan.exercises) }
}
export function validateSession(s: Session) {
  if (s.version !== 1) throw new Error('Unsupported record version. Data retained.')
  assertDate(s.date)
  if (!s.id || !s.planId || !Number.isInteger(s.revision) || s.revision < 0 || !['active', 'completed'].includes(s.status)) throw new Error('Invalid session record.')
  for (const exercise of s.exercises) for (const set of exercise.sets) {
    const numbers = set.kind === 'hold' ? [set.seconds] : set.kind === 'weight' ? [set.pounds, set.reps] : set.kind === 'machine' ? [set.reps] : [NaN]
    if (numbers.some(n => !Number.isFinite(n) || n < 0) || (set.kind !== 'hold' && !Number.isInteger(set.reps)) || (set.kind === 'machine' && !/^P\d+$/.test(set.position))) throw new Error('Use nonnegative measurements, whole reps and machine positions such as P9.')
  }
}
export function updateSet(session: Session, exerciseId: string, index: number, performance: Performance): Session {
  if (session.status === 'completed') throw new Error('Completed history is read-only.')
  const copy = structuredClone(session)
  const exercise = copy.exercises.find(item => item.id === exerciseId)
  if (!exercise || !exercise.sets[index]) throw new Error('Set not found.')
  exercise.sets[index] = performance
  validateSession(copy)
  return copy
}
export function formatSet(set: Performance) { return set.kind === 'hold' ? `${set.seconds} sec` : `${set.kind === 'machine' ? set.position : `${set.pounds} lb`} × ${set.reps}` }
