import { useEffect, useRef, useState } from 'react'
import { ExerciseFeedbackSummary } from './ExerciseFeedback'
import { reviewWeekReuse, type WeekReuseReview } from './weekly-planning'
import { formatSet, plannedSets, type Plan, type Session } from './workouts'

interface Props {
  initialDate: string
  plans: Plan[]
  sessions: Session[]
  busy: boolean
  error: string
  onConfirm: (review: WeekReuseReview) => void
  onCancel: () => void
  onChange: () => void
}

export function WeekReusePreview({ initialDate, plans, sessions, busy, error, onConfirm, onCancel, onChange }: Props) {
  const [date, setDate] = useState(initialDate)
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  const review = reviewWeekReuse(date, plans, sessions)
  const count = review?.days.reduce((total, day) => total + (day.blockedBy ? 0 : day.workouts.length), 0) ?? 0

  return <section className="dated-editor week-reuse" aria-labelledby="week-reuse-heading">
    <h2 id="week-reuse-heading" tabIndex={-1} ref={heading}>Reuse previous week</h2>
    <fieldset disabled={busy}>
      <label>Destination week (choose any date)<input type="date" value={date} onChange={event => {
        setDate(event.target.value)
        onChange()
      }} /></label>
      {review ? <>
        <dl className="import-dates week-reuse-dates" aria-live="polite">
          <div><dt>Source week</dt><dd>{review.sourceStart} to {review.sourceEnd}</dd></div>
          <div><dt>Destination week</dt><dd>{review.destinationStart} to {review.destinationEnd}</dd></div>
        </dl>
        <p className="editor-context">Copies become one-time plans and take precedence over matching recurring workouts on those dates. Use Edit this date to adjust each copied plan before starting a workout.</p>
        {review.days.length === 0 && <p>The previous week has no plans to copy.</p>}
        {review.days.map(day => <section className="week-reuse-day" key={day.destinationDate}>
          <h3>{day.sourceDate} to {day.destinationDate}</h3>
          {day.blockedBy ? <p className="import-notice">Skipped because {day.blockedBy} already exists on {day.destinationDate}.</p>
            : day.workouts.map(plan => <div className="week-reuse-workout" key={plan.id}>
              <h4>{plan.demo && !plan.name.startsWith('DEMO') ? 'Demo ' : ''}{plan.name}</h4>
              {plan.exercises.length ? <ul className="plan-preview">{plan.exercises.map(exercise => <li key={exercise.id}>
                <strong>{exercise.name}</strong><span>{plannedSets(exercise).map(formatSet).join(' · ') || 'No targets'}</span>
                {exercise.coachNotes && <ExerciseFeedbackSummary feedback={{ coachNotes: exercise.coachNotes }} />}
              </li>)}</ul> : <p>Rest day</p>}
            </div>)}
        </section>)}
      </> : <p>Choose a date with a full destination week and a previous week.</p>}
      {error && <p role="alert">{error}</p>}
      <div className="actions editor-actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="button" className="primary" disabled={!count} onClick={() => review && onConfirm(review)}>
          Confirm copy{count > 0 && ` (${count} ${count === 1 ? 'plan' : 'plans'})`}
        </button>
      </div>
    </fieldset>
  </section>
}
