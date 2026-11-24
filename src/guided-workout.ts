import { createSession, isStandardPerformance, performanceSchema, plannedSets, type ExerciseFeedback, type Guidance, type Performance, type Plan, type Session } from './workouts.ts'

export function startGuidedWorkout(plan: Plan, date: string): Session {
  const session = createSession(plan, date)
  const sets = session.exercises.map(exercise => plannedSets(exercise).map(target => ({ target })))
  for (const exercise of session.exercises) delete exercise.prescription
  return applyGuide({ ...session, planWeekday: plan.weekday, ...(plan.workoutDate && { actualsStartEmpty: true }) }, { cursor: 0, sets })
}

export function recoverLegacyDraft(session: Session) {
  if (session.guidance || session.revision > 0 || session.status !== 'active') return session
  // An unsaved legacy snapshot has editable defaults but no recorded-set
  // markers. Keep those values as prefills and require each set to be logged.
  const sets = session.exercises.map(exercise => exercise.sets.map(target => ({ target })))
  return applyGuide(session, { cursor: 0, sets })
}

// Older records have only one snapshot. Keep their actual values and use them
// as the starting target when continuing a legacy session.
export function getGuide(session: Session): Guidance {
  return session.guidance ?? {
    cursor: session.status === 'completed' ? session.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0) : 0,
    sets: session.exercises.map(exercise => exercise.sets.map(actual => ({
      target: actual, outcome: { status: 'recorded', actual },
    }))),
  }
}

export function guideSteps(guide: Guidance) {
  return guide.sets.flatMap((sets, exerciseIndex) => sets.map((set, setIndex) => ({ ...set, exerciseIndex, setIndex })))
}

export function setActual(step: Guidance['sets'][number][number]) {
  return step.outcome?.status === 'recorded' ? step.outcome.actual : undefined
}

function applyGuide(session: Session, guidance: Guidance): Session {
  if (session.status === 'completed') throw new Error('Completed history is read-only.')
  // Project only recorded, server-compatible measurements into the version 1
  // sets field. The guided slots keep the full targets, actuals and skips.
  const exercises = session.exercises.map((exercise, index) => ({
    ...exercise,
    sets: recordedStandardSets(guidance.sets[index]),
  }))
  return { ...session, exercises, guidance }
}

function recordedStandardSets(sets: Guidance['sets'][number]) {
  return sets.map(setActual).filter(actual => actual !== undefined && isStandardPerformance(actual))
}

export function recordFeedback(session: Session, exerciseIndex: number, feedback: ExerciseFeedback): Session {
  if (session.status !== 'active') throw new Error('Open recorded results to correct a completed workout.')
  return { ...session, exercises: session.exercises.map((exercise, index) =>
    index === exerciseIndex ? { ...exercise, feedback } : exercise) }
}

export type ResultCorrection = { exerciseIndex: number } & (
  { setIndex: number; actual: Performance } | { feedback: ExerciseFeedback }
)

export function correctCompletedResults(session: Session, corrections: ResultCorrection[]): Session {
  if (session.status !== 'completed') throw new Error('Resume the active workout to edit its results.')
  const corrected = structuredClone(session)
  for (const correction of corrections) {
    const { exerciseIndex } = correction
    const exercise = corrected.exercises[exerciseIndex]
    if (!exercise) throw new Error('Recorded exercise not found.')
    if ('feedback' in correction) {
      exercise.feedback = correction.feedback
    } else if (corrected.guidance) {
      const sets = corrected.guidance.sets[exerciseIndex]
      const set = sets[correction.setIndex]
      if (set?.outcome?.status !== 'recorded') throw new Error('Recorded set not found.')
      set.outcome = { ...set.outcome, actual: correction.actual }
      exercise.sets = recordedStandardSets(sets)
    } else {
      if (!exercise.sets[correction.setIndex] || !isStandardPerformance(correction.actual)) throw new Error('Recorded set not found.')
      exercise.sets[correction.setIndex] = correction.actual
    }
  }
  return corrected
}

export function movePrevious(session: Session) {
  const guide = getGuide(session)
  return applyGuide(session, { ...guide, cursor: Math.max(0, guide.cursor - 1) })
}

export function movePastSkipped(session: Session) {
  const guide = getGuide(session)
  if (guideSteps(guide)[guide.cursor]?.outcome?.status !== 'skipped') throw new Error('Set must be recorded or skipped.')
  return applyGuide(session, { ...guide, cursor: guide.cursor + 1 })
}

export function recordSet(session: Session, actual: Performance, advance: boolean) {
  const guide = structuredClone(getGuide(session))
  const step = guideSteps(guide)[guide.cursor]
  if (!step) throw new Error('Set not found.')
  guide.sets[step.exerciseIndex][step.setIndex].outcome = { status: 'recorded', actual }
  if (advance) guide.cursor++
  return applyGuide(session, guide)
}

export function skipSets(session: Session, scope: 'set' | 'exercise', explanation: string) {
  const guide = structuredClone(getGuide(session))
  const step = guideSteps(guide)[guide.cursor]
  if (!step) throw new Error('Set not found.')
  const reason = explanation.trim()
  const outcome = { status: 'skipped' as const, ...(reason ? { reason } : {}) }
  const exercise = guide.sets[step.exerciseIndex]
  if (scope === 'set') {
    exercise[step.setIndex].outcome = outcome
    guide.cursor++
  } else {
    for (const set of exercise) if (!set.outcome) set.outcome = outcome
    guide.cursor += exercise.length - step.setIndex
  }
  return applyGuide(session, guide)
}

type Field = {
  name: 'pounds' | 'position' | 'resistance' | 'reps' | 'seconds' | 'value'
  label: string
  value: string
  inputMode: 'text' | 'decimal' | 'numeric'
}

export function actualFields(set: Performance): Field[] {
  if (set.kind === 'freeform') return [{ name: 'value', label: 'Performance', value: set.value, inputMode: 'text' }]
  const side = set.perSide ? ' per side' : ''
  if (set.kind === 'hold') return [{ name: 'seconds', label: `Duration${side} (seconds)`, value: String(set.seconds), inputMode: 'decimal' }]
  const fields: Field[] = []
  if (set.kind === 'weight') fields.push({ name: 'pounds', label: 'Dumbbell weight (lb)', value: String(set.pounds), inputMode: 'decimal' })
  if (set.kind === 'machine') fields.push({ name: 'position', label: 'Machine position', value: set.position, inputMode: 'text' })
  if (set.kind === 'band') fields.push({ name: 'resistance', label: 'Band resistance', value: set.resistance, inputMode: 'text' })
  fields.push({ name: 'reps', label: `Repetitions${side}`, value: String(set.reps), inputMode: 'numeric' })
  return fields
}

export function readActual(base: Performance, edited?: Record<string, string>, requireEntered = false): Performance {
  if (!edited && !requireEntered) return base
  const actual = { ...base }
  for (const { name, value, inputMode } of actualFields(base)) {
    const text = edited?.[name] ?? (requireEntered ? '' : value)
    if (name === 'value') actual[name] = text
    else if (name === 'position') actual[name] = text.trim().toUpperCase()
    else if (inputMode === 'text') actual[name] = text.trim()
    else actual[name] = /^(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(text.trim()) ? Number(text.replace(',', '.')) : NaN
  }
  const result = performanceSchema.safeParse(actual)
  if (result.success) return result.data
  if (actual.kind === 'machine' && !/^P\d+$/.test(actual.position)) throw new Error('Enter a machine position such as P9.')
  if (actual.kind === 'band' && !actual.resistance) throw new Error('Enter the band resistance.')
  if (actual.kind === 'freeform') throw new Error('Enter your performance.')
  throw new Error('Enter nonnegative measurements and whole repetitions.')
}

export const draftKey = 'workout-companion-draft-v1'
export interface WorkoutDraft {
  session: Session
  fields?: Record<string, string>
}
