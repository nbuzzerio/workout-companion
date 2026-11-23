import { useEffect, useRef, useState } from 'react'
import { ExerciseFeedbackFields } from './ExerciseFeedback'
import { PerformanceFields } from './PerformanceFields'
import { getGuide, readActual, setActual, type ResultCorrection } from './guided-workout'
import { formatSet, type ExerciseFeedback, type Session } from './workouts'

interface Props {
  session: Session
  busy: boolean
  error: string
  onChange: () => void
  onError: (message: string) => void
  onSave: (corrections: ResultCorrection[]) => void
  onCancel: () => void
}

export function RecordedResultsEditor({ session, busy, error, onChange, onError, onSave, onCancel }: Props) {
  const [setEdits, setSetEdits] = useState<Record<string, Record<string, string>>>({})
  const [feedbackEdits, setFeedbackEdits] = useState<Record<number, ExerciseFeedback>>({})
  const guide = getGuide(session)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])

  function corrections() {
    return session.exercises.flatMap((exercise, exerciseIndex): ResultCorrection[] => {
      const changes: ResultCorrection[] = []
      const feedback = feedbackEdits[exerciseIndex]
      if (feedback) changes.push({ exerciseIndex, feedback })
      guide.sets[exerciseIndex].forEach((set, setIndex) => {
        const actual = setActual(set)
        const fields = setEdits[`${exerciseIndex}:${setIndex}`]
        if (!actual || !fields) return
        try { changes.push({ exerciseIndex, setIndex, actual: readActual(actual, fields) }) }
        catch (error) { throw new Error(`${exercise.name}, set ${setIndex + 1}. ${(error as Error).message}`, { cause: error }) }
      })
      return changes
    })
  }

  return <form className="day-editor" onSubmit={event => {
    event.preventDefault()
    try { onSave(corrections()) }
    catch (error) { onError((error as Error).message) }
  }}>
    <h2 ref={heading} tabIndex={-1}>Correct recorded results</h2>
    <p className="editor-context">{session.demo ? 'Demo workout' : 'Workout'} · {session.date}. Save corrections to this completed workout.</p>
    <fieldset disabled={busy}>
      {session.exercises.map((exercise, exerciseIndex) => <section className="exercise" key={exerciseIndex} aria-label={exercise.name}>
        <h3>{exercise.name}</h3>
        {guide.sets[exerciseIndex].map((set, setIndex) => {
          const actual = setActual(set)
          const key = `${exerciseIndex}:${setIndex}`
          return <div className="editor-set" key={key}>
            <div className="editor-set-heading"><strong>Set {setIndex + 1}</strong>{session.guidance && <span>Planned {formatSet(set.target)}</span>}</div>
            {actual ? <PerformanceFields performance={actual} label={`${exercise.name} recorded set ${setIndex + 1}`} fields={setEdits[key]}
              onChange={fields => { setSetEdits(edits => ({ ...edits, [key]: fields })); onChange() }} />
              : <p>Skipped{set.outcome?.status === 'skipped' && set.outcome.reason && <span className="skip-reason">{set.outcome.reason}</span>}</p>}
          </div>
        })}
        <ExerciseFeedbackFields feedback={feedbackEdits[exerciseIndex] ?? exercise.feedback} disabled={busy}
          onChange={feedback => { setFeedbackEdits(edits => ({ ...edits, [exerciseIndex]: feedback })); onChange() }} />
      </section>)}
      {error && <p role="alert">{error}</p>}
      <div className="actions editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary">Save corrections</button>
      </div>
    </fieldset>
  </form>
}
