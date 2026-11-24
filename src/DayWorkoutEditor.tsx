import { useEffect, useRef, useState } from 'react'
import { ExerciseFeedbackSummary } from './ExerciseFeedback'
import { PerformanceFields } from './PerformanceFields'
import { readActual } from './guided-workout'
import { isStandardPerformance, plannedSets, type PlanExercise, type Performance, type Plan } from './workouts'

const targetDefaults = {
  weight: { kind: 'weight', pounds: 0, reps: 10 },
  machine: { kind: 'machine', position: 'P1', reps: 10 },
  hold: { kind: 'hold', seconds: 30 },
  bodyweight: { kind: 'bodyweight', reps: 10 },
  band: { kind: 'band', resistance: '', reps: 10 },
  freeform: { kind: 'freeform', value: '' },
} satisfies Record<Performance['kind'], Performance>

interface TargetDraft { id: string; base: Performance; fields?: Record<string, string> }
interface ExerciseDraft { exercise: PlanExercise; name: string; targets: TargetDraft[] }

function newTarget(base: Performance = targetDefaults.weight): TargetDraft {
  // Validate newly added targets even if the default fields are untouched.
  return { id: crypto.randomUUID(), base, fields: {} }
}

function toExercise({ exercise, name, targets }: ExerciseDraft, index: number): PlanExercise {
  if (!name.trim()) throw new Error(`Enter a name for exercise ${index + 1}.`)
  const sets = targets.map(({ base, fields }, index) => {
    try { return readActual(base, fields) }
    catch (error) { throw new Error(`${name}, set ${index + 1}. ${(error as Error).message}`, { cause: error }) }
  })
  const saved = { ...exercise, name: name === exercise.name ? name : name.trim() }
  const original = plannedSets(exercise)
  if (sets.length === original.length && sets.every((set, index) => set === original[index])) return saved
  saved.sets = sets.filter(isStandardPerformance)
  if (exercise.prescription || saved.sets.length !== sets.length) saved.prescription = sets
  return saved
}

interface Props {
  plan: Plan
  weekday: string
  importing?: boolean
  replacing?: boolean
  busy: boolean
  error: string
  onChange: () => void
  onError: (message: string) => void
  onSave: (exercises: PlanExercise[]) => void
  onCancel: () => void
}

export function DayWorkoutEditor({ plan, weekday, importing, replacing, busy, error, onChange, onError, onSave, onCancel }: Props) {
  const [exercises, setExercises] = useState<ExerciseDraft[]>(() => plan.exercises.map(exercise => ({
    exercise, name: exercise.name, targets: plannedSets(exercise).map(base => ({ id: crypto.randomUUID(), base })),
  })))
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])

  const edit = (next: ExerciseDraft[]) => { setExercises(next); onChange() }
  const update = (index: number, next: ExerciseDraft) => edit(exercises.map((item, i) => i === index ? next : item))
  function move(from: number, to: number) {
    const next = [...exercises]
    const [item] = next.splice(from, 1)
    next.splice(to, 0, item)
    edit(next)
  }

  return <form className={plan.workoutDate ? 'day-editor dated-editor' : 'day-editor'} onSubmit={event => {
    event.preventDefault()
    try { onSave(exercises.map(toExercise)) }
    catch (error) { onError((error as Error).message) }
  }}>
    <h2 ref={heading} tabIndex={-1}>{importing ? 'Review imported workout' : "Edit Day's Workout"}</h2>
    <p className="editor-context">{plan.workoutDate
      ? <>{weekday} · {plan.workoutDate}. {importing
        ? (replacing ? 'Confirming will replace the one-time plan for this date and day.' : 'Confirming will save a one-time plan for this date and day.')
        : 'Changes apply to this one-time plan.'}</>
      : <>{weekday} · {plan.name}. Changes apply to future workouts on this weekly plan. Use Exercise feedback in the guided workout to record RIR, mobility, and notes.</>}
    </p>
    <fieldset disabled={busy}>
      {exercises.map((item, index) => {
        const { exercise, name, targets } = item
        const rowLabel = name.trim() || `Exercise ${index + 1}`
        return <article className="exercise" key={exercise.id}>
          <div className="exercise-title">
            <label>Exercise {index + 1} name<input value={name} onChange={event => update(index, { ...item, name: event.target.value })} /></label>
            <div className="actions">
              <button type="button" aria-label={`Move ${rowLabel} up`} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
              <button type="button" aria-label={`Move ${rowLabel} down`} disabled={index === exercises.length - 1} onClick={() => move(index, index + 1)}>↓</button>
              <button type="button" aria-label={`Remove ${rowLabel}`} onClick={() => edit(exercises.filter((_, i) => i !== index))}>Remove exercise</button>
            </div>
          </div>
          {exercise.coachNotes && <ExerciseFeedbackSummary feedback={{ coachNotes: exercise.coachNotes }} />}
          {targets.map(({ id, base, fields }, setIndex) => {
            const label = `${rowLabel} set ${setIndex + 1}`
            const editTarget = (next: TargetDraft) => update(index, { ...item, targets: targets.map((target, i) => i === setIndex ? next : target) })
            return <div className="editor-set" key={id}>
              <div className="editor-set-heading"><h3>Set {setIndex + 1}</h3>
                <button type="button" aria-label={`Remove ${label}`} onClick={() => update(index, { ...item, targets: targets.filter((_, i) => i !== setIndex) })}>Remove set</button></div>
              <div className="target-fields">
                <label>Target type<select aria-label={`${label} target type`} value={base.kind}
                  onChange={event => {
                    const kind = event.target.value as Performance['kind']
                    editTarget({ id, base: targetDefaults[kind], fields: {} })
                  }}>
                  <option value="weight">Weight + reps</option><option value="machine">Machine position + reps</option>
                  <option value="hold">Timed hold</option><option value="bodyweight">Bodyweight</option>
                  <option value="band">Band</option><option value="freeform">Freeform notation</option>
                </select></label>
                <PerformanceFields performance={base} label={label} fields={fields} onChange={fields => editTarget({ id, base, fields })} />
              </div>
              {base.kind !== 'freeform' && <label className="per-side"><input type="checkbox" aria-label={`${label} per side`} checked={Boolean(base.perSide)}
                onChange={event => editTarget({ id, base: { ...base, perSide: event.target.checked }, fields })} />Per side</label>}
            </div>
          })}
          <button type="button" aria-label={`Add set to ${rowLabel}`} disabled={targets.length >= 100} onClick={() => {
            const last = targets.at(-1)
            const target = newTarget(last?.base)
            update(index, { ...item, targets: [...targets, { ...target, fields: last?.fields ?? target.fields }] })
          }}>Add set</button>
        </article>
      })}
      <button type="button" disabled={exercises.length >= 200} onClick={() => {
        const exercise = { id: crypto.randomUUID(), name: '', sets: [] }
        edit([...exercises, { exercise, name: '', targets: [newTarget()] }])
      }}>Add exercise</button>
      {error && <p role="alert">{error}</p>}
      <div className="actions editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary">{importing ? 'Confirm import' : 'Save workout plan'}</button>
      </div>
    </fieldset>
  </form>
}
