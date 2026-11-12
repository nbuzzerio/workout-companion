import { expect, test } from 'vitest'
import { SessionStore } from './storage'
import { createSession, demoPlan, updateSet } from './workouts'
// Native IndexedDB integration contract. jsdom has no IndexedDB; do not fake a pass.
test.skipIf(!globalThis.indexedDB)('native IndexedDB fresh/repeat open, restart persistence, conflicts and history retention', async () => {
  const name = `w01-test-${crypto.randomUUID()}`
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open(name, 1)
    r.onupgradeneeded = () => { r.result.createObjectStore('plans', { keyPath: 'id' }); r.result.createObjectStore('sessions', { keyPath: 'id' }) }
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  const first = new SessionStore(open)
  expect(await first.list()).toEqual([])
  await first.ensurePlan(demoPlan)
  await first.ensurePlan(demoPlan)
  const db = await open()
  const count = await new Promise<number>((resolve, reject) => { const r = db.transaction('plans').objectStore('plans').count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  db.close()
  expect(count).toBe(1)
  const a = await first.save(createSession(demoPlan, '2026-11-09'))
  const b = await first.complete(createSession(demoPlan, '2026-11-10'))
  const restarted = new SessionStore(open)
  expect(await restarted.reopen(a.id)).toEqual(a)
  expect((await restarted.list('2026-11-09')).map(s => s.id)).toEqual([a.id])
  const changed = await restarted.save(updateSet(a, 'extension', 0, { kind: 'machine', position: 'P11', reps: 8 }))
  await expect(first.save(a)).rejects.toThrow('changed')
  await expect(first.save(b)).rejects.toThrow('completed')
  expect((await restarted.reopen(changed.id))?.exercises[1].sets[0]).toEqual({ kind: 'machine', position: 'P11', reps: 8 })
  expect(await restarted.reopen(b.id)).toEqual(b)
  expect(await restarted.list()).toHaveLength(2)
})
