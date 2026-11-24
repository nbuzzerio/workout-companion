import { useEffect, useRef, useState } from 'react'
import { ExerciseFeedbackSummary } from './ExerciseFeedback'
import { parseSheetsWorkout, type SheetsExercise, type SheetsWorkout } from './sheets-import'
import { formatSet } from './workouts'

interface Props {
  date: string
  weekday: string
  replacing: boolean
  onChange: () => void
  onCancel: () => void
  onReview: (exercises: SheetsExercise[]) => void
}

export function GoogleSheetsImport({ date, weekday, replacing, onChange, onCancel, onReview }: Props) {
  const [text, setText] = useState('')
  const [preview, setPreview] = useState<SheetsWorkout>()
  const [error, setError] = useState('')
  const [source, setSource] = useState<'targets' | 'actuals'>('targets')
  const [carryNotes, setCarryNotes] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const previewHeading = useRef<HTMLHeadingElement>(null)
  useEffect(() => { heading.current?.focus() }, [])
  useEffect(() => { if (preview) previewHeading.current?.focus() }, [preview])
  const day = weekday.slice(0, 3)
  const dateDiffers = preview && preview.date !== date
  const dayDiffers = preview && ![day.toLowerCase(), weekday.toLowerCase()].includes(preview.day.trim().toLowerCase())
  const exercises = preview?.exercises.map(({ name, coachNotes, ...prescriptions }) => ({
    name, targets: prescriptions[source], ...(carryNotes && coachNotes && { coachNotes }),
  }))
  const tooManySets = exercises?.find(exercise => exercise.targets.length > 100)

  return <form className="sheets-import" onSubmit={event => {
    event.preventDefault()
    try {
      const workout = parseSheetsWorkout(text)
      if (workout.exercises.length > 200) throw new Error('Copy at most 200 exercises for one workout.')
      setPreview(workout)
      setError('')
    } catch (error) {
      setPreview(undefined)
      setError((error as Error).message)
    }
  }}>
    <h2 ref={heading} tabIndex={-1}>Import from Google Sheets</h2>
    {!preview && <p className="editor-context">Import to {day} · {date}</p>}
    {replacing && <p className="import-notice">Confirming will replace the one-time plan for {day} · {date}.</p>}
    <p id="sheets-import-help">In Google Sheets, copy one workout’s rows from CURRENT WEEK through Coach Notes. Include all columns.</p>
    <label>Paste Google Sheets cells<textarea rows={5} value={text} spellCheck={false} autoCapitalize="off" autoCorrect="off"
      aria-describedby="sheets-import-help" aria-invalid={Boolean(error)} onChange={event => {
        setText(event.target.value)
        setPreview(undefined)
        setError('')
        onChange()
      }} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="actions editor-actions">
      <button type="button" onClick={onCancel}>Cancel</button>
      <button type="submit" className="primary">Preview import</button>
    </div>
    {preview && exercises && <section className="import-preview" aria-labelledby="import-preview-heading">
      <h3 id="import-preview-heading" ref={previewHeading} tabIndex={-1}>Exercises and targets</h3>
      <dl className="import-dates">
        <div><dt>Spreadsheet workout</dt><dd>{preview.day} · {preview.date}</dd></div>
        <div><dt>Selected destination</dt><dd>{day} · {date}</dd></div>
      </dl>
      {(dateDiffers || dayDiffers) && <p className="import-notice">
        {dateDiffers && dayDiffers ? 'The spreadsheet date and day differ' : dateDiffers ? 'The spreadsheet date differs' : 'The spreadsheet day differs'} from the selected workout. The import will use {day} · {date}.
      </p>}
      <fieldset className="import-options">
        <legend>Prescription source</legend>
        <label><input type="radio" name="prescription-source" checked={source === 'targets'}
          onChange={() => setSource('targets')} />Use Target values</label>
        <label><input type="radio" name="prescription-source" checked={source === 'actuals'}
          onChange={() => setSource('actuals')} />Use Actual values</label>
      </fieldset>
      {source === 'actuals' && <p>Blank Actual cells and skipped sets add no targets.</p>}
      <label className="import-note-option"><input type="checkbox" checked={carryNotes}
        onChange={event => setCarryNotes(event.target.checked)} />Carry forward Coach Notes</label>
      <p>{carryNotes ? 'Coach Notes will carry forward. RIR, Mobility, and Pain/Notes will start blank.' : 'Exercise feedback will start blank.'}</p>
      {!exercises.some(exercise => exercise.targets.length) && <p className="import-notice">Add at least one target during review to start this workout.</p>}
      <p role="status">{preview.exercises.length} {preview.exercises.length === 1 ? 'exercise' : 'exercises'} ready to review.</p>
      <ul className="plan-preview">{exercises.map(({ name, targets, coachNotes }, index) => <li key={index}>
        <strong>{name}</strong>
        {targets.length ? <ol>{targets.map((target, index) => <li key={index}>{formatSet(target)}</li>)}</ol> : <span>No targets</span>}
        {coachNotes && <ExerciseFeedbackSummary feedback={{ coachNotes }} />}
      </li>)}</ul>
      {tooManySets && <p role="alert">{tooManySets.name} has more than 100 targets. Reduce its targets in Sheets and copy the rows again.</p>}
      <div className="actions editor-actions"><button type="button" className="primary" disabled={Boolean(tooManySets)}
        onClick={() => onReview(exercises)}>Review and edit exercises</button></div>
    </section>}
  </form>
}
