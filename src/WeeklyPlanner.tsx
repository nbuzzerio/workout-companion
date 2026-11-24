import { weekdays, dayFor, moveDate, type WeekDay } from './weekly-planning'

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
const rangeDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
const format = (date: string, formatter: Intl.DateTimeFormat) => formatter.format(new Date(`${date}T12:00:00Z`))

interface Props {
  week: WeekDay[]
  selectedDate: string
  today: string
  disabled: boolean
  onSelect: (day: WeekDay) => void
  onNavigate: (date: string) => void
  onReuse: () => void
}

export function WeeklyPlanner({ week, selectedDate, today, disabled, onSelect, onNavigate, onReuse }: Props) {
  const first = week[0].date
  const last = week[week.length - 1].date
  const previous = moveDate(first, -1) && (moveDate(selectedDate, -7) ?? moveDate(first, -1))
  const next = moveDate(last, 1) && (moveDate(selectedDate, 7) ?? moveDate(last, 1))
  const range = rangeDate.formatRange(new Date(`${first}T12:00:00Z`), new Date(`${last}T12:00:00Z`))
  return <section className="weekly-planner" aria-labelledby="weekly-planner-heading">
    <header className="weekly-heading">
      <div>
        <h2 id="weekly-planner-heading">Weekly plan</h2>
        <p aria-live="polite">{range}</p>
      </div>
      <div className="actions">
        <button type="button" disabled={disabled || !previous} onClick={() => previous && onNavigate(previous)}>Previous week</button>
        <button type="button" disabled={disabled || (today >= first && today <= last)} onClick={() => onNavigate(today)}>This week</button>
        <button type="button" disabled={disabled || !next} onClick={() => next && onNavigate(next)}>Next week</button>
        <button type="button" disabled={disabled} onClick={onReuse}>Reuse previous week</button>
      </div>
    </header>
    <nav className="week week-calendar" aria-label="Workout calendar">
      {week.map(day => {
        const training = day.workouts.filter(workout => workout.status !== 'Rest day')
        const completed = day.otherSessions.filter(row => row.status === 'completed').length
        const active = day.otherSessions.length - completed
        return <button key={day.date} type="button" aria-pressed={selectedDate === day.date}
          aria-current={today === day.date ? 'date' : undefined} disabled={disabled} onClick={() => onSelect(day)}>
          <span className="calendar-date"><span aria-label={weekdays[day.weekday]}>{dayFor(day.weekday)}</span>
            <time dateTime={day.date}>{format(day.date, shortDate)}</time></span>
          {training.length === 0 && <span className="calendar-entry">Rest day</span>}
          {training.map(({ plan, status }) => <span className="calendar-entry" key={plan.id}>
            <strong>{plan.demo && !plan.name.startsWith('DEMO') ? 'Demo ' : ''}{plan.name}</strong>
            <span data-workout-status={status}>{status}</span>
          </span>)}
          {completed > 0 && <span className="calendar-entry">{completed} other completed</span>}
          {active > 0 && <span className="calendar-entry">{active} other in progress</span>}
        </button>
      })}
    </nav>
  </section>
}
