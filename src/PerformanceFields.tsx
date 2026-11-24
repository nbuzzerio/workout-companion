import { actualFields } from './guided-workout'
import type { Performance } from './workouts'

interface Props {
  performance: Performance
  label: string
  fields?: Record<string, string>
  initiallyEmpty?: boolean
  onChange: (fields: Record<string, string>) => void
}

export function PerformanceFields({ performance, label, fields, initiallyEmpty, onChange }: Props) {
  return <div className="actual-fields">{actualFields(performance).map(({ name, label: fieldLabel, value, inputMode }) => {
    const measure = name === 'position' ? 'machine position' : name === 'value' ? 'performance' : name
    const perSide = (name === 'reps' || name === 'seconds') && performance.perSide ? ' per side' : ''
    const props = {
      'aria-label': `${label} ${measure}${perSide}`,
      value: fields?.[name] ?? (initiallyEmpty ? '' : value),
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
        onChange({ ...fields, [name]: event.target.value }),
    }
    return <label key={name}>{fieldLabel}{name === 'value' ? <textarea {...props} rows={2} />
      : <input {...props} inputMode={inputMode} autoComplete="off"
        autoCapitalize={name === 'position' ? 'characters' : undefined} onFocus={event => event.target.select()} />}</label>
  })}</div>
}
