import { expect, test } from 'vitest'
import { earlierWorkouts, performanceChange, previousSetChange, recentExerciseResults } from './exercise-progression'
import { type Performance, type Session, type SessionExercise } from './workouts'

const weight = (pounds: number, reps = 8): Performance => ({ kind: 'weight', pounds, reps })
const exercise = (id: string, name: string, pounds = 40): SessionExercise => ({ id, name, sets: [{ kind: 'weight', pounds, reps: 8 }] })

function session(id: string, date: string, exercises: SessionExercise[], changes: Partial<Session> = {}): Session {
  return { id, date, exercises, planId: `plan-${id}`, version: 1, demo: false, revision: 1, status: 'completed', ...changes }
}

test('uses saved outcomes and original set numbers, with legacy actuals and stable exercise identity', () => {
  const current = [exercise('current', 'Front squat')]
  const feedback = { rir: '2', mobility: 'Tight', painNotes: 'Left hip', coachNotes: 'Pause' } as const
  const earlier = session('legacy', '2026-11-01', [{ ...exercise('current', 'Old exercise name'),
    sets: [{ kind: 'weight', pounds: 30, reps: 8 }, { kind: 'weight', pounds: 32, reps: 8 }] }])
  const guided = session('guided', '2026-11-08', [{ ...exercise('different', '  FRONT   SQUAT '), feedback }], {
    guidance: { cursor: 3, sets: [[
      { target: weight(100), outcome: { status: 'skipped' } },
      { target: weight(110), outcome: { status: 'recorded', actual: weight(42.5, 6) } },
      { target: weight(120), outcome: { status: 'recorded', actual: { kind: 'freeform', value: 'Slow negatives' } } },
    ]] },
  })
  const active = session('active', '2026-11-10', [exercise('current', 'Front squat')], {
    status: 'active', guidance: { cursor: 1, sets: [[
      { target: weight(100), outcome: { status: 'recorded', actual: weight(37.5) } }, { target: weight(110) },
    ]] },
  })
  const skipped = session('skipped', '2026-11-11', current, {
    guidance: { cursor: 1, sets: [[{ target: weight(100), outcome: { status: 'skipped' } }]] },
  })
  const saved = [earlier, guided, active, skipped,
    session('same-date', '2026-11-15', current), session('future', '2026-11-18', current),
    session('demo', '2026-11-14', current, { demo: true }), session('older', '2026-10-25', current),
    session('legacy-active', '2026-11-12', current, { status: 'active' })]
  const before = structuredClone(saved)
  const results = recentExerciseResults(earlierWorkouts(saved, '2026-11-15', false), current, 0)

  expect(results.map(result => result.sessionId)).toEqual(['active', 'guided', 'legacy'])
  expect(results[0]).toMatchObject({ status: 'active', sets: [{ index: 0, actual: weight(37.5) }] })
  expect(results[1]).toMatchObject({ feedback, sets: [
    { index: 1, actual: weight(42.5, 6) }, { index: 2, actual: { kind: 'freeform', value: 'Slow negatives' } },
  ] })
  expect(results[2].sets).toEqual([{ index: 0, actual: weight(30) }, { index: 1, actual: weight(32) }])
  expect(previousSetChange(results, results[0], results[0].sets[0])).toEqual({ date: '2026-11-01', change: '+7.5 lb' })
  expect(previousSetChange(results, results[1], results[1].sets[0])).toEqual({ date: '2026-11-01', change: '+10.5 lb, -2 reps' })
  expect(saved).toEqual(before)
})

test('matches unique names across plans and keeps same-name exercise rows distinct', () => {
  const current = [exercise('a', 'Squat'), exercise('b', 'Squat')]
  const duplicate = session('duplicate', '2026-11-03', [exercise('x', 'Squat'), exercise('y', 'Squat')])
  const byName = session('name', '2026-11-04', [exercise('x', 'squat')])
  const byId = session('id', '2026-11-05', [exercise('b', 'Renamed squat', 55), exercise('x', 'Squat', 75)])
  expect(recentExerciseResults([byId, byName, duplicate], current, 0)).toEqual([])
  expect(recentExerciseResults([byId, byName, duplicate], current, 1).map(result => result.sets[0].actual)).toEqual([weight(55)])
  expect(recentExerciseResults([byName, duplicate], current.slice(0, 1), 0).map(result => result.sessionId)).toEqual(['name'])
})

test('retains saved feedback when there are no sets and skips empty feedback', () => {
  const current = [exercise('a', 'Squat')]
  const note = session('note', '2026-11-05', [{ ...current[0], sets: [], feedback: { rir: '0', painNotes: 'Stopped early' } }])
  const blank = session('blank', '2026-11-06', [{ ...current[0], sets: [], feedback: { painNotes: ' ' } }])
  expect(recentExerciseResults([blank, note], current, 0)).toEqual([{
    sessionId: 'note', date: note.date, status: 'completed', sets: [], feedback: note.exercises[0].feedback,
  }])
})

test('compares only compatible measurements and keeps load and reps independent', () => {
  const machine = (position: string, reps: number): Performance => ({ kind: 'machine', position, reps })
  const band = (resistance: string, reps: number): Performance => ({ kind: 'band', resistance, reps })
  const hold = (seconds: number, perSide = true): Performance => ({ kind: 'hold', seconds, perSide })
  const text: Performance = { kind: 'freeform', value: '25 sec' }

  expect(performanceChange(weight(50, 6), weight(42.5))).toBe('+7.5 lb, -2 reps')
  expect(performanceChange(weight(40), weight(40))).toBe('No change')
  expect(performanceChange(hold(30.2), hold(30.1))).toBe('+0.1 sec')
  expect(performanceChange(hold(35), hold(30, false))).toBeUndefined()
  expect(performanceChange(machine('P9', 12), machine('P9', 10))).toBe('+2 reps')
  expect(performanceChange(machine('P9', 12), machine('P8', 10))).toBeUndefined()
  expect(performanceChange(band('Light', 10), band(' light ', 12))).toBe('-2 reps')
  expect(performanceChange(band('Heavy', 10), band('Light', 12))).toBeUndefined()
  expect(performanceChange({ kind: 'bodyweight', reps: 10 }, { kind: 'bodyweight', reps: 8 })).toBe('+2 reps')
  expect(performanceChange(weight(40), machine('P9', 12))).toBeUndefined()
  expect(performanceChange(text, text)).toBeUndefined()
})
