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
