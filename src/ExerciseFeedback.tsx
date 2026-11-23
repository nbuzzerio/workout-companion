import { useId } from 'react'
import { mobilityChoices, rirChoices, type ExerciseFeedback } from './workouts'

const mobilityTone = { Great: 'green', Tight: 'yellow', 'Very tight': 'red' } as const

export function ExerciseFeedbackFields({ feedback = {}, disabled, onChange }: {
  feedback?: ExerciseFeedback
  disabled: boolean
  onChange: (feedback: ExerciseFeedback) => void
}) {
  const id = useId()
  return <fieldset disabled={disabled} className="exercise-feedback">
    <fieldset>
      <legend>RIR</legend>
      <div className="feedback-choices">{rirChoices.map(rir => <label key={rir}>
        <input type="radio" name={`${id}-rir`} value={rir} checked={feedback.rir === rir} onChange={() => onChange({ ...feedback, rir })} />
        <span>{rir}</span>
      </label>)}</div>
    </fieldset>
    <fieldset>
      <legend>Mobility</legend>
      <div className="feedback-choices">{mobilityChoices.map(mobility => <label key={mobility}>
        <input type="radio" name={`${id}-mobility`} value={mobility} checked={feedback.mobility === mobility}
          onChange={() => onChange({ ...feedback, mobility })} />
        <span data-tone={mobilityTone[mobility]}>{mobility}</span>
      </label>)}</div>
    </fieldset>
    <div className="feedback-notes">
      <label>Pain/Notes<textarea rows={2} value={feedback.painNotes ?? ''} onChange={event => onChange({ ...feedback, painNotes: event.target.value })} /></label>
      <label>Coach Notes<textarea rows={2} value={feedback.coachNotes ?? ''} onChange={event => onChange({ ...feedback, coachNotes: event.target.value })} /></label>
    </div>
  </fieldset>
}

export function ExerciseFeedbackSummary({ feedback }: { feedback?: ExerciseFeedback }) {
  if (!feedback) return null
  const { rir, mobility, painNotes, coachNotes } = feedback
  if (!rir && !mobility && !painNotes && !coachNotes) return null
  return <dl className="feedback-summary">
    {rir && <div><dt>RIR</dt><dd>{rir}</dd></div>}
    {mobility && <div><dt>Mobility</dt><dd data-tone={mobilityTone[mobility]}>{mobility}</dd></div>}
    {painNotes && <div><dt>Pain/Notes</dt><dd>{painNotes}</dd></div>}
    {coachNotes && <div><dt>Coach Notes</dt><dd>{coachNotes}</dd></div>}
  </dl>
}
