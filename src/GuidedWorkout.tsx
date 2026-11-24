import { useEffect, useRef, useState } from 'react'
import { getGuide, guideSteps, movePastSkipped, movePrevious, readActual, recordFeedback, recordSet, setActual, skipSets, type WorkoutDraft } from './guided-workout'
import { ExerciseFeedbackFields, ExerciseFeedbackSummary } from './ExerciseFeedback'
import { ExerciseProgression } from './ExerciseProgression'
import { GoogleSheetsExport } from './GoogleSheetsExport'
import { PerformanceFields } from './PerformanceFields'
import { formatSet, type Session } from './workouts'

interface Props {
  draft: WorkoutDraft
  day: string
  history: readonly Session[]
  busy: boolean
  error: string
  onChange: (draft: WorkoutDraft) => void
  onError: (message: string) => void
  onFinish: () => void
}

export function GuidedWorkout({ draft, day, history, busy, error, onChange, onError, onFinish }: Props) {
  const { session, fields } = draft
  const guide = getGuide(session)
  const steps = guideSteps(guide)
  const step = steps[guide.cursor]
  const heading = useRef<HTMLHeadingElement>(null)
  const completed = session.status === 'completed'
  useEffect(() => { heading.current?.focus() }, [session.id, guide.cursor, completed])
  const goBack = () => {
    try {
      const actual = step && setActual(step)
      const current = step && fields ? recordSet(session, readActual(actual ?? step.target, fields, session.actualsStartEmpty && !actual), false) : session
      onChange({ session: movePrevious(current) })
    } catch (error) { onError((error as Error).message) }
  }

  if (completed || !step) {
    const recorded = steps.filter(setActual).length
    const skipped = steps.filter(item => item.outcome?.status === 'skipped').length
    const exercisesDone = guide.sets.filter(sets => sets.some(setActual)).length
    return <section className="guide-card workout-summary" aria-labelledby="workout-summary-title">
      <p className="guide-kicker">{session.demo ? 'Demo workout' : 'Workout'} · {session.date}</p>
      <h2 id="workout-summary-title" ref={heading} tabIndex={-1}>{completed ? 'Workout finished' : 'Review workout'}</h2>
      <dl className="summary-counts">
        <div><dt>Exercises logged</dt><dd>{exercisesDone}</dd></div>
        <div><dt>Sets recorded</dt><dd>{recorded}</dd></div>
        <div><dt>Sets skipped</dt><dd>{skipped}</dd></div>
      </dl>
      {error && <p role="alert">{error}</p>}
      {completed ? <GoogleSheetsExport session={session} day={day} /> : <div className="guide-nav">
        <button type="button" disabled={busy || !steps.length} onClick={goBack}>Previous Set</button>
        <button type="button" className="primary" disabled={busy} onClick={onFinish}>Finish Workout</button>
      </div>}
      {session.exercises.map((exercise, index) => (!completed || guide.sets[index].length > 0 || exercise.feedback) && <section className="summary-exercise" key={index}>
        <h3>{exercise.name}</h3>
        <ol>{guide.sets[index].map(({ target, outcome }, setIndex) => <li key={setIndex}>
          <span className="summary-set">Set {setIndex + 1}</span>
          <div>{outcome?.status === 'recorded' ? formatSet(outcome.actual)
            : <>Skipped{outcome?.reason && <span className="skip-reason">{outcome.reason}</span>}</>}
            {session.guidance && <small>Planned {formatSet(target)}</small>}
          </div>
        </li>)}</ol>
        {completed ? <ExerciseFeedbackSummary feedback={exercise.feedback} /> : <details className="feedback-details">
          <summary>Exercise feedback</summary>
          <ExerciseFeedbackFields feedback={exercise.feedback} disabled={busy}
            onChange={feedback => onChange({ ...draft, session: recordFeedback(session, index, feedback) })} />
        </details>}
      </section>)}
    </section>
  }

  const exercise = session.exercises[step.exerciseIndex]
  const exerciseSets = guide.sets[step.exerciseIndex]
  const nonempty = guide.sets.filter(sets => sets.length).length
  const exerciseNumber = guide.sets.slice(0, step.exerciseIndex + 1).filter(sets => sets.length).length
  const next = steps[guide.cursor + 1]
  const nextLabel = !next ? 'Review Workout' : next.exerciseIndex === step.exerciseIndex ? 'Next Set' : 'Next Exercise'
  const recorded = setActual(step)
  const actual = recorded ?? step.target
  const initiallyEmpty = session.actualsStartEmpty && !recorded
  const skipped = step.outcome?.status === 'skipped'
  function advance(forceRecord = false) {
    try {
      const next = skipped && !fields && !forceRecord ? movePastSkipped(session) : recordSet(session, readActual(actual, fields, initiallyEmpty), true)
      onChange({ session: next })
    } catch (error) { onError((error as Error).message) }
  }

  return <section className="guide-card" aria-labelledby="guided-exercise">
    <div className="guide-progress">
      <span>{session.demo ? 'Demo workout' : 'Workout'} · {session.date}</span>
      <div className="guide-progress-labels"><strong>Exercise {exerciseNumber} of {nonempty}</strong><strong>Set {step.setIndex + 1} of {exerciseSets.length}</strong></div>
      <progress aria-label="Sets recorded or skipped" value={steps.filter(item => item.outcome).length} max={steps.length} />
    </div>
    <h2 id="guided-exercise" ref={heading} tabIndex={-1}>{exercise.name}</h2>
    <dl className="set-target">
      <div><dt>Planned target</dt><dd>{formatSet(step.target)}</dd></div>
    </dl>
    <ExerciseProgression key={step.exerciseIndex} history={history} exercises={session.exercises}
      exerciseIndex={step.exerciseIndex} setIndex={step.setIndex} />
    {step.outcome?.status === 'skipped' && <p className="skip-notice">Skipped{step.outcome.reason && <span className="skip-reason">{step.outcome.reason}</span>}</p>}
    <form onSubmit={event => {
      event.preventDefault()
      advance()
    }}>
      <fieldset disabled={busy}>
        <legend>Actual performance</legend>
        <PerformanceFields performance={actual} label={`${exercise.name} set ${step.setIndex + 1}`} fields={fields} initiallyEmpty={initiallyEmpty}
          onChange={fields => onChange({ session, fields })} />
      </fieldset>
      {error && <p role="alert">{error}</p>}
      <div className="guide-nav">
        <button type="button" disabled={busy || guide.cursor === 0} onClick={goBack}>Previous Set</button>
        <button type="submit" className="primary" disabled={busy}>{nextLabel}</button>
      </div>
      {skipped && !fields && <div className="skip-actions"><button type="button" disabled={busy} onClick={() => advance(true)}>Record This Set</button></div>}
    </form>
    <SkipControls key={`skip-${guide.cursor}`} busy={busy} onSkip={(scope, reason) => onChange({ session: skipSets(session, scope, reason) })} />
    <details key={`feedback-${step.exerciseIndex}`} className="feedback-details">
      <summary>Exercise feedback</summary>
      <ExerciseFeedbackFields feedback={exercise.feedback} disabled={busy}
        onChange={feedback => onChange({ ...draft, session: recordFeedback(session, step.exerciseIndex, feedback) })} />
    </details>
  </section>
}

function SkipControls({ busy, onSkip }: { busy: boolean; onSkip: (scope: 'set' | 'exercise', reason: string) => void }) {
  const [scope, setScope] = useState<'set' | 'exercise'>()
  const reason = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { if (scope) reason.current?.focus() }, [scope])
  if (!scope) return <div className="skip-actions">
    <button type="button" disabled={busy} onClick={() => setScope('set')}>Skip Set</button>
    <button type="button" disabled={busy} onClick={() => setScope('exercise')}>Skip Exercise</button>
  </div>
  return <form className="skip-form" onSubmit={event => {
    event.preventDefault()
    onSkip(scope, reason.current?.value ?? '')
  }}>
    <label>Reason for skipping (optional)<textarea ref={reason} rows={2} maxLength={500} disabled={busy} /></label>
    <div className="skip-actions">
      <button type="button" disabled={busy} onClick={() => setScope(undefined)}>Cancel</button>
      <button type="submit" disabled={busy}>{scope === 'set' ? 'Confirm Skip Set' : 'Confirm Skip Exercise'}</button>
    </div>
  </form>
}
