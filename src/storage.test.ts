import { expect, test, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { openDatabase, SessionStore } from './storage'
import { createSession, demoPlan, updateSet } from './workouts'
// Deterministic transaction tests; real browser IndexedDB is covered in e2e.
test('IndexedDB fresh/repeat open, restart persistence, conflicts and history retention', async () => {
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
    const request = this.get('abort-probe')
    this.transaction.abort()
    return request
  })
  try {
    await expect(restarted.save(updateSet(changed, 'extension', 0, { kind: 'machine', position: 'P20', reps: 1 }))).rejects.toThrow('Storage failed; nothing was saved.')
  } finally { put.mockRestore() }
  expect(await new SessionStore(open).reopen(changed.id)).toEqual(changed)
  const recovered = await restarted.save(updateSet(changed, 'extension', 0, { kind: 'machine', position: 'P13', reps: 6 }))
  expect(await new SessionStore(open).reopen(recovered.id)).toEqual(recovered)
  expect(await restarted.reopen(b.id)).toEqual(b)
  await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error) })
})

test('pre-integration v1 stores and complete records reopen without a migration or rewrite', async () => {
  const name = `w01-compat-${crypto.randomUUID()}`
  const plan = structuredClone(demoPlan)
  plan.exercises[0].musclesSource = 'raw legacy metadata'
  const session = createSession(plan, '2026-11-09')
  session.demo = false
  session.status = 'completed'
  session.revision = 7
  session.exercises.push({ id: 'plank', name: 'Plank', sets: [{ kind: 'hold', seconds: 42.5 }] })
  // Construct the old schema directly, without using the integrated opener.
  const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('plans', { keyPath: 'id' })
      request.result.createObjectStore('sessions', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  await new Promise<void>((resolve, reject) => {
    const tx = legacy.transaction(['plans', 'sessions'], 'readwrite')
    tx.objectStore('plans').put(plan)
    tx.objectStore('sessions').put(session)
    tx.oncomplete = () => resolve()
    tx.onabort = () => reject(tx.error)
  })
  legacy.close()
  const store = new SessionStore(() => openDatabase(name))
  await store.ensurePlan(demoPlan)
  expect(await store.reopen(session.id)).toEqual(session)
  const db = await openDatabase(name)
  expect(db.version).toBe(1)
  expect(Array.from(db.objectStoreNames)).toEqual(['plans', 'sessions'])
  const retained = await new Promise((resolve, reject) => {
    const request = db.transaction('plans').objectStore('plans').get(plan.id)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  expect(retained).toEqual(plan)
  db.close()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
  })
})
