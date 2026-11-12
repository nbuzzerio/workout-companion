import { expect, test } from 'vitest'
import { createSession, demoPlan, formatSet, sourceExamples, updateSet, validateSession } from './workouts'
import { openDatabase, SessionStore } from './storage'
test('stable IDs, local calendar dates, ordered independent snapshots and machine positions', () => {
  const a = createSession(demoPlan, '2026-11-09')
  const b = createSession(demoPlan, '2026-11-10')
  const edited = updateSet(a, 'extension', 0, { kind: 'machine', position: 'P12', reps: 8 })
  expect(edited.id).toBe(a.id)
  expect(b.id).not.toBe(a.id)
  expect(edited.date).toBe('2026-11-09')
  expect(a.exercises[1].sets[0]).toEqual({ kind: 'machine', position: 'P9', reps: 12 })
  expect(formatSet(edited.exercises[1].sets[0])).toBe('P12 × 8')
  expect(sourceExamples).toEqual(['46×10 | 55×10 | 63×10 | 72×8', 'P9×12 | P10×10'])
})
test('guards invalid dates, measurements, future versions and completed history; supports holds', () => {
  expect(() => createSession(demoPlan, '2026-02-30')).toThrow()
  const s = createSession(demoPlan, '2026-11-09')
  expect(() => updateSet(s, 'deadlift', 0, { kind: 'weight', pounds: -1, reps: 10 })).toThrow()
  expect(() => updateSet({ ...s, status: 'completed' }, 'deadlift', 0, { kind: 'hold', seconds: 30 })).toThrow()
  expect(() => validateSession({ ...s, version: 2 } as unknown as typeof s)).toThrow('Unsupported')
  expect(updateSet(s, 'deadlift', 0, { kind: 'hold', seconds: 30 }).exercises[0].sets[0]).toEqual({ kind: 'hold', seconds: 30 })
})
test('unavailable storage and denied database open reject writes', async () => {
  await expect(openDatabase()).rejects.toThrow('unavailable')
  const store = new SessionStore(async () => { throw new Error('Denied') })
  await expect(store.save(createSession(demoPlan, '2026-11-09'))).rejects.toThrow('Denied')
})

test('plan weekday, ordered sets, optional raw metadata and previous/current separation stay typed', () => {
  expect(demoPlan.weekday).toBe(1)
  expect(demoPlan.exercises[0].sets).toEqual([
    { kind: 'weight', pounds: 46, reps: 10 },
    { kind: 'weight', pounds: 55, reps: 10 },
    { kind: 'weight', pounds: 63, reps: 10 },
    { kind: 'weight', pounds: 72, reps: 8 },
  ])
  const plan = { ...structuredClone(demoPlan), weekday: 4 as const }
  plan.exercises[0].musclesSource = 'chest:3,front-delts:2,triceps:1'
  plan.exercises.push({ id: 'hold', name: 'Demo hold', sets: [{ kind: 'hold', seconds: 30 }] })
  const prior = { ...createSession(plan, '2026-11-05'), status: 'completed' as const }
  const current = updateSet(createSession(plan, '2026-11-12'), 'deadlift', 1, { kind: 'weight', pounds: 60, reps: 9 })
  expect(prior.exercises[0].sets[1]).toEqual({ kind: 'weight', pounds: 55, reps: 10 })
  expect(current.exercises[0].musclesSource).toBe('chest:3,front-delts:2,triceps:1')
  expect(current.exercises.at(-1)?.sets).toEqual([{ kind: 'hold', seconds: 30 }])
  expect(formatSet({ kind: 'hold', seconds: 30 })).toBe('30 sec')
})
