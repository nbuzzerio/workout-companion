import { expect, test, vi } from 'vitest'
import { openDatabase, SessionStore } from './storage'
import { createSession, demoPlan, updateSet } from './workouts'
// Native IndexedDB integration contract. jsdom has no IndexedDB; do not fake a pass.
test.skipIf(!globalThis.indexedDB)('native IndexedDB fresh/repeat open, restart persistence, conflicts and history retention', async () => {
  const name = `w01-test-${crypto.randomUUID()}`
  const open = () => openDatabase(name)
  const first = new SessionStore(open)
  expect(await first.list()).toEqual([])
  await first.ensurePlan(demoPlan)
  await first.ensurePlan(demoPlan)
  const db = await open()
  const count = await new Promise<number>((resolve, reject) => { const r = db.transaction('plans').objectStore('plans').count(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  db.close()
  expect(count).toBe(1)
  const a = await first.save(updateSet(createSession(demoPlan, '2026-11-09'), 'deadlift', 0, { kind: 'weight', pounds: 49, reps: 7 }))
  const b = await first.complete(createSession(demoPlan, '2026-11-10'))
  const restarted = new SessionStore(open)
  expect(await restarted.reopen(a.id)).toEqual(a)
  expect((await restarted.reopen(a.id))?.exercises[0].sets[0]).toEqual({ kind: 'weight', pounds: 49, reps: 7 })
  expect((await restarted.list('2026-11-09')).map(s => s.id)).toEqual([a.id])
  const changed = await restarted.save(updateSet(a, 'extension', 0, { kind: 'machine', position: 'P11', reps: 8 }))
  await expect(first.save(a)).rejects.toThrow('changed')
  await expect(first.save(b)).rejects.toThrow('completed')
  expect((await restarted.reopen(changed.id))?.exercises[1].sets[0]).toEqual({ kind: 'machine', position: 'P11', reps: 8 })
  expect(await restarted.reopen(b.id)).toEqual(b)
  expect(await restarted.list()).toHaveLength(2)
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore) {
    this.transaction.abort()
    throw new Error('Injected transaction failure')
  })
  try {
    await expect(restarted.save(updateSet(changed, 'extension', 0, { kind: 'machine', position: 'P20', reps: 1 }))).rejects.toThrow('Injected transaction failure')
  } finally { put.mockRestore() }
  expect(await new SessionStore(open).reopen(changed.id)).toEqual(changed)
  const recovered = await restarted.save(updateSet(changed, 'extension', 0, { kind: 'machine', position: 'P13', reps: 6 }))
  expect(await new SessionStore(open).reopen(recovered.id)).toEqual(recovered)
  expect(await restarted.reopen(b.id)).toEqual(b)
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error) })
})
