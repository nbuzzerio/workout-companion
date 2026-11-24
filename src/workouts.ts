import { z } from 'zod'

const measurement = z.number().finite().nonnegative()
const reps = measurement.int()
const perSide = z.boolean().optional()
const nonblank = z.string().refine(value => value.trim().length > 0)
export const weekdaySchema = z.number().int().min(0).max(6)
const standardKinds = [
  z.object({ kind: z.literal('weight'), pounds: measurement, reps, perSide }).passthrough(),
  z.object({ kind: z.literal('machine'), position: z.string().regex(/^P\d+$/), reps, perSide }).passthrough(),
  z.object({ kind: z.literal('hold'), seconds: measurement, perSide }).passthrough(),
] as const
export const standardPerformanceSchema = z.discriminatedUnion('kind', standardKinds)
export const performanceSchema = z.discriminatedUnion('kind', [
  ...standardKinds,
  z.object({ kind: z.literal('bodyweight'), reps, perSide }).passthrough(),
  z.object({ kind: z.literal('band'), resistance: nonblank, reps, perSide }).passthrough(),
  z.object({ kind: z.literal('freeform'), value: nonblank }).passthrough(),
])
export const guidanceSchema = z.object({
  cursor: measurement.int(),
  sets: z.array(z.array(z.object({
    target: performanceSchema,
    outcome: z.discriminatedUnion('status', [
      z.object({ status: z.literal('recorded'), actual: performanceSchema }),
      z.object({ status: z.literal('skipped'), reason: nonblank.optional() }),
    ]).optional(),
  })).max(100)).max(200),
})

export type Performance = z.infer<typeof performanceSchema>
export type StandardPerformance = z.infer<typeof standardPerformanceSchema>
export type Guidance = z.infer<typeof guidanceSchema>
export const rirChoices = ['0', '1', '2', '3', '4+', 'N/A'] as const
export const mobilityChoices = ['Great', 'Tight', 'Very tight'] as const
export const exerciseFeedbackSchema = z.object({
  rir: z.enum(rirChoices).optional(),
  mobility: z.enum(mobilityChoices).optional(),
  painNotes: z.string().optional(),
  coachNotes: z.string().optional(),
}).passthrough()
export type ExerciseFeedback = z.infer<typeof exerciseFeedbackSchema>
// Version 1 sync accepts weight, machine and hold in sets. A richer plan
// supplies its full prescription in the optional exercise field.
export interface Exercise { id: string; name: string; sets: StandardPerformance[]; prescription?: Performance[]; musclesSource?: string }
export interface PlanExercise extends Exercise { coachNotes?: string }
export interface SessionExercise extends Exercise { feedback?: ExerciseFeedback }
export interface Plan { version: 1; id: string; name: string; weekday: 0 | 1 | 2 | 3 | 4 | 5 | 6; demo: boolean; exercises: PlanExercise[]; workoutDate?: string }
export interface Session { version: 1; id: string; planId: string; planWeekday?: Plan['weekday']; actualsStartEmpty?: true; date: string; demo: boolean; revision: number; status: 'active' | 'completed'; exercises: SessionExercise[]; guidance?: Guidance }
export function sessionWeekday(session: Session, plan?: Plan) {
  return session.planWeekday ?? plan?.weekday ?? new Date(`${session.date}T12:00:00Z`).getUTCDay()
}
export const plannedSets = (exercise: Exercise) => exercise.prescription ?? exercise.sets
export function isStandardPerformance(set: Performance): set is StandardPerformance {
  return set.kind === 'weight' || set.kind === 'machine' || set.kind === 'hold'
}
export const sourceExamples = ['46×10 | 55×10 | 63×10 | 72×8', 'P9×12 | P10×10']
export const demoPlan: Plan = { version: 1, id: 'demo-monday-v1', name: 'DEMO Monday', weekday: 1, demo: true, exercises: [
  { id: 'deadlift', name: 'DB Deadlift', sets: [46, 55, 63, 72].map((pounds, i) => ({ kind: 'weight', pounds, reps: i === 3 ? 8 : 10 })) },
  { id: 'extension', name: 'Leg Extension', sets: [{ kind: 'machine', position: 'P9', reps: 12 }, { kind: 'machine', position: 'P10', reps: 10 }] },
  { id: 'press', name: 'Seated Military Press', sets: [{ kind: 'weight', pounds: 20, reps: 10 }] },
] }
export function assertDate(date: string) {
  const day = new Date(`${date}T12:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== date) throw new Error('Choose a valid calendar date.')
}
export function createPlan(input: Omit<Plan, 'id' | 'version'>): Plan { return { ...structuredClone(input), id: crypto.randomUUID(), version: 1 } }
export function createSession(plan: Plan, date: string): Session {
  assertDate(date)
  const exercises = structuredClone(plan.exercises).map(({ coachNotes, ...exercise }) => ({
    ...exercise, ...(coachNotes && { feedback: { coachNotes } }),
  }))
  return { version: 1, id: crypto.randomUUID(), planId: plan.id, date, demo: plan.demo, revision: 0, status: 'active', exercises }
}
export function validateSession(s: Session) {
  if (s.version !== 1) throw new Error('Unsupported record version. Data retained.')
  assertDate(s.date)
  if (!s.id || !s.planId || !Number.isInteger(s.revision) || s.revision < 0 || !['active', 'completed'].includes(s.status)) throw new Error('Invalid session record.')
  if (s.planWeekday !== undefined && !weekdaySchema.safeParse(s.planWeekday).success) throw new Error('Invalid scheduled weekday. Data retained.')
  for (const exercise of s.exercises) {
    if (!exercise.sets.every(set => standardPerformanceSchema.safeParse(set).success)) throw new Error('Use nonnegative measurements, whole reps and machine positions such as P9.')
    if (exercise.feedback !== undefined && !exerciseFeedbackSchema.safeParse(exercise.feedback).success) throw new Error('Invalid exercise feedback. Data retained.')
  }
  if (s.guidance !== undefined && (!guidanceSchema.safeParse(s.guidance).success || !validGuidanceProgress(s))) throw new Error('Invalid guided workout progress. Data retained.')
}
export function validGuidanceProgress(session: Pick<Session, 'guidance' | 'exercises' | 'status'>) {
  const guide = session.guidance
  if (!guide) return true
  const steps = guide.sets.flat()
  return guide.sets.length === session.exercises.length && guide.cursor <= steps.length
    && steps.slice(0, guide.cursor).every(step => step.outcome)
    && (session.status !== 'completed' || guide.cursor === steps.length)
}
export function updateSet(session: Session, exerciseId: string, index: number, performance: StandardPerformance): Session {
  if (session.status === 'completed') throw new Error('Completed history is read-only.')
  if (session.guidance) throw new Error('Use the guided workout to edit this session.')
  const copy = structuredClone(session)
  const exercise = copy.exercises.find(item => item.id === exerciseId)
  if (!exercise || !exercise.sets[index]) throw new Error('Set not found.')
  exercise.sets[index] = performance
  validateSession(copy)
  return copy
}
export const formatSet = (set: Performance) => formatPerformance(set, ' × ')
export const formatCompactSet = (set: Performance) => formatPerformance(set, '×')

function formatPerformance(set: Performance, separator: string) {
  if (set.kind === 'freeform') return set.value
  const side = set.perSide ? ' per side' : ''
  switch (set.kind) {
    case 'hold': return `${set.seconds} sec${side}`
    case 'weight': return `${set.pounds} lb${separator}${set.reps}${side}`
    case 'machine': return `${set.position}${separator}${set.reps}${side}`
    case 'bodyweight': return `Bodyweight${separator}${set.reps}${side}`
    case 'band': return `${set.resistance} band${separator}${set.reps}${side}`
  }
}
