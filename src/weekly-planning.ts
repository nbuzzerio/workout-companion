import { assertDate, plannedSets, type Plan, type Session } from './workouts'

export const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
export const dayFor = (weekday: number) => weekdays[weekday].slice(0, 3)

export function calendarWeekday(date: string): Plan['weekday'] {
  return new Date(`${date}T12:00:00Z`).getUTCDay() as Plan['weekday']
}

export function moveDate(date: string, days: number) {
  const next = new Date(`${date}T12:00:00Z`)
  if (!Number.isFinite(next.getTime())) return undefined
  next.setUTCDate(next.getUTCDate() + days)
  const value = next.toISOString().split('T')[0]
  try { assertDate(value); return value } catch { return undefined }
}

export const hasTargets = (plan: Plan) => plan.exercises.some(exercise => plannedSets(exercise).length > 0)

export function matchesWorkout(session: Session, plan: Plan, date: string) {
  return session.planId === plan.id && session.demo === plan.demo && session.date === date
}

export function workoutStatus(plan: Plan, date: string, sessions: Session[]) {
  if (!hasTargets(plan)) return 'Rest day'
  const saved = sessions.filter(row => matchesWorkout(row, plan, date))
  if (saved.some(row => row.status === 'completed')) return 'Completed'
  if (saved.some(row => row.status === 'active')) return 'In progress'
  return 'Outstanding'
}

export function buildWeek(anchor: string, plans: Plan[], sessions: Session[]) {
  const offset = (calendarWeekday(anchor) + 6) % 7
  return Array.from({ length: 7 }, (_, index) => moveDate(anchor, index - offset)).flatMap(date => {
    if (!date) return []
    const weekday = calendarWeekday(date)
    const dated = plans.filter(plan => plan.workoutDate === date)
    const recurring = plans.filter(plan => !plan.workoutDate && plan.weekday === weekday
      && !dated.some(override => override.weekday === weekday))
    const scheduled = [...dated, ...recurring]
    const saved = sessions.filter(row => row.date === date)
    const workouts = scheduled.map(plan => ({ plan, status: workoutStatus(plan, date, saved) }))
    return [{
      date, weekday,
      workouts,
      otherSessions: saved.filter(row => !workouts.some(({ plan, status }) => status !== 'Rest day' && matchesWorkout(row, plan, date))),
    }]
  })
}

export type WeekDay = ReturnType<typeof buildWeek>[number]

function weekStart(date: string) {
  if (moveDate(date, 0) !== date) return undefined
  return moveDate(date, -((calendarWeekday(date) + 6) % 7))
}

export function reviewWeekReuse(date: string, plans: Plan[], sessions: Session[]) {
  const destinationStart = weekStart(date)
  const sourceStart = destinationStart && moveDate(destinationStart, -7)
  const sourceEnd = destinationStart && moveDate(destinationStart, -1)
  const destinationEnd = destinationStart && moveDate(destinationStart, 6)
  if (!sourceStart || !sourceEnd || !destinationStart || !destinationEnd) return undefined

  const days = buildWeek(sourceStart, plans, []).flatMap(day => {
    const workouts = day.workouts.map(({ plan }) => plan).filter(plan => plan.workoutDate || hasTargets(plan))
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    if (!workouts.length) return []
    const destinationDate = moveDate(destinationStart, (day.weekday + 6) % 7)!
    const blockedBy = plans.some(plan => plan.workoutDate === destinationDate) ? 'a one-time plan'
      : sessions.some(session => session.date === destinationDate) ? 'a saved workout' : undefined
    return [{ sourceDate: day.date, destinationDate, workouts, blockedBy }]
  })
  return { sourceStart, sourceEnd, destinationStart, destinationEnd, days }
}

export type WeekReuseReview = NonNullable<ReturnType<typeof reviewWeekReuse>>
