import { setActual } from './guided-workout'
import type { Exercise, ExerciseFeedback, Performance, Session } from './workouts'

export type ExerciseReference = Pick<Exercise, 'id' | 'name'>
export interface RecordedSet { index: number; actual: Performance }
export interface ExerciseResult {
  sessionId: string
  date: string
  status: Session['status']
  sets: RecordedSet[]
  feedback?: ExerciseFeedback
}

const normalizedName = (value: string) => value.trim().replace(/\s+/gu, ' ').toLowerCase()

export function earlierWorkouts(sessions: readonly Session[], date: string | undefined, demo: boolean | undefined) {
  if (!date || demo === undefined) return []
  return sessions.filter(session => session.date < date && session.demo === demo
    && (session.status === 'completed' || session.guidance !== undefined))
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
}

export function recentExerciseResults(sessions: readonly Session[], exercises: readonly ExerciseReference[], exerciseIndex: number) {
  const exercise = exercises[exerciseIndex]
  const name = normalizedName(exercise.name)
  const useName = name && exercises.filter(item => normalizedName(item.name) === name).length === 1
  const results: ExerciseResult[] = []

  for (const session of sessions) {
    const byId = session.exercises.filter(item => item.id === exercise.id)
    // Imports and copied weeks can assign new IDs. A duplicate name cannot identify a row reliably.
    const matches = byId.length || !useName ? byId : session.exercises.filter(item => normalizedName(item.name) === name)
    if (matches.length !== 1) continue
    const recorded = matches[0]
    const slots = session.guidance?.sets[session.exercises.indexOf(recorded)]
    const sets = slots ? slots.flatMap((slot, index) => {
      const actual = setActual(slot)
      return actual ? [{ index, actual }] : []
    }) : recorded.sets.map((actual, index) => ({ index, actual }))
    const { feedback } = recorded
    if (!sets.length && !feedback?.rir && !feedback?.mobility && !feedback?.painNotes?.trim() && !feedback?.coachNotes?.trim()) continue
    results.push({ sessionId: session.id, date: session.date, status: session.status, sets, feedback })
    if (results.length === 3) break
  }
  return results
}

const signedNumber = new Intl.NumberFormat('en-US', { signDisplay: 'exceptZero', maximumSignificantDigits: 12 })

function changes(...measurements: [amount: number, unit: string][]) {
  return measurements.filter(([amount]) => amount !== 0)
    .map(([amount, unit]) => `${signedNumber.format(amount)} ${unit === 'reps' && Math.abs(amount) === 1 ? 'rep' : unit}`)
    .join(', ') || 'No change'
}

export function performanceChange(actual: Performance, previous: Performance) {
  if (actual.kind === 'freeform' || previous.kind === 'freeform' || Boolean(actual.perSide) !== Boolean(previous.perSide)) return
  if (actual.kind === 'weight' && previous.kind === 'weight') return changes([actual.pounds - previous.pounds, 'lb'], [actual.reps - previous.reps, 'reps'])
  if (actual.kind === 'hold' && previous.kind === 'hold') return changes([actual.seconds - previous.seconds, 'sec'])
  if ((actual.kind === 'bodyweight' && previous.kind === 'bodyweight')
    || (actual.kind === 'machine' && previous.kind === 'machine' && actual.position === previous.position)
    || (actual.kind === 'band' && previous.kind === 'band' && normalizedName(actual.resistance) === normalizedName(previous.resistance))) {
    return changes([actual.reps - previous.reps, 'reps'])
  }
}

export function previousSetChange(results: readonly ExerciseResult[], current: ExerciseResult, set: RecordedSet) {
  for (const result of results) {
    // Session records store a calendar date without a time of day.
    if (result.date >= current.date) continue
    const prior = result.sets.find(item => item.index === set.index)
    const change = prior && performanceChange(set.actual, prior.actual)
    if (change) return { date: result.date, change }
  }
}
