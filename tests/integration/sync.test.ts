import 'fake-indexeddb/auto'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { fixture, password, type Fixture } from '../support/local-service.mjs'
import { SessionStore, openDatabase } from '../../src/storage'
import { SyncStore } from '../../src/sync-store'
import { SyncEngine } from '../../src/sync-engine'
import { SyncApi } from '../../src/sync-api'
import { exchangeSchema, type Operation, type Space } from '../../src/sync'
import { createSession, demoPlan } from '../../src/workouts'
let f: Fixture, space: Space
beforeEach(async () => { f = await fixture(); space = f.space() })
afterEach(async () => { await f.close() })
async function device() {
  const name = crypto.randomUUID(); const open = () => openDatabase(name); const store = new SyncStore(open); const local = new SessionStore(open)
  const api = new SyncApi(f.clientFetch()); await api.login(password)
  const engine = new SyncEngine(store, api, async work => work())
  return { store, local, api, engine, open }
}
async function connect(d: Awaited<ReturnType<typeof device>>) {
  const b = await d.store.export(); await d.store.begin(space, f.owner, b.id); await d.engine.run(true)
  expect((await d.store.settings()).stageComplete).toBe(true)
  await d.store.reconcile(); await d.engine.run(true)
  expect((await d.store.settings()).error).toBeUndefined()
}
function put(value = demoPlan, baseServerVersion: string | null = null): Operation { return { operationId: crypto.randomUUID(), kind: 'plan', recordId: value.id, type: 'put', schemaVersion: 1, baseServerVersion, value, people: [], resurrect: false } }

test('real HTTP auth rejects invalid credentials, protects exchange, restores CSRF, expires and logs out', async () => {
  const api = new SyncApi(f.clientFetch())
  await expect(api.restore()).rejects.toThrow('Authentication expired')
  await expect(api.login('bad')).rejects.toThrow('Incorrect')
  await api.login(password); const csrf = api.session!.csrfToken; api.session = null
  await api.restore(); expect(api.session!.csrfToken).toBe(csrf)
  api.session!.csrfToken = 'wrong'; await expect(api.createPerson(crypto.randomUUID(), 'Test')).rejects.toThrow('CSRF_REQUIRED')
  await api.restore(); await api.logout(); await expect(api.restore()).rejects.toThrow('Authentication expired')
})

test('a stale tab token restores the valid cookie on automatic retry', async () => {
  const d = await device()
  await connect(d)
  await d.local.ensurePlan(demoPlan)
  const original = await d.store.batch()
  d.api.session!.csrfToken = 'stale-token'
  await d.engine.run()
  const state = await d.store.settings()
  expect(state.error).toContain('CSRF_REQUIRED')
  expect(state.signInRequired).toBe(false)
  expect(await d.store.batch()).toEqual(original)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(state.nextRetry + 1)
  try { await d.engine.run(false, true) } finally { clock.mockRestore() }
  expect((await d.store.summary()).pending).toBe(0)
  expect((await d.store.settings()).error).toBeUndefined()
})

test('two independent databases sync confirmed history, offline edits, People associations and conflicts', async () => {
  const a = await device(), b = await device()
  await a.local.ensurePlan(demoPlan); const saved = await a.local.save(createSession(demoPlan, '2026-11-09')); await connect(a); await connect(b)
  expect(await b.local.list()).toEqual([saved])
  const person1 = f.person('A'), person2 = f.person('B')
  await a.store.tag('session', saved.id, [{ personId: person1.id, role: 'subject' }, { personId: person2.id, role: 'participant' }]); await a.engine.run(true); await b.engine.run(true)
  expect((await b.store.view()).metadata.find(m => m.id === `session:${saved.id}`)?.people).toHaveLength(2)
  expect((await b.store.view()).people).toHaveLength(2)
  const sa = (await a.local.list())[0], sb = (await b.local.list())[0]
  await a.local.save({ ...sa, exercises: [{ ...sa.exercises[0], sets: [{ kind: 'weight', pounds: 101, reps: 5 }] }] })
  await b.local.save({ ...sb, exercises: [{ ...sb.exercises[0], sets: [{ kind: 'weight', pounds: 202, reps: 6 }] }] })
  await a.engine.run(true); await b.engine.run(true)
  const c = (await b.store.view()).conflicts[0]; expect(c.code).toBe('VERSION_CONFLICT'); expect((await b.store.view()).pending.length).toBeGreaterThan(0)
  await b.store.resolve(c.id, c.generation, 'local'); await b.engine.run(true); await a.engine.run(true)
  expect((await a.local.list())[0].exercises[0].sets[0]).toMatchObject({ pounds: 202 })
  expect((await b.store.view()).pending).toEqual([])
})

test('lost HTTP response replays identical immutable operation and server applies only once', async () => {
  const d = await device(); await connect(d); await d.local.ensurePlan(demoPlan)
  const original = f.clientFetch(); const api = new SyncApi(original); await api.login(password)
  let drop = true; const requests: string[] = []
  const flaky = new SyncApi(async (url, init) => { const r = await original(url, init); if (String(url).endsWith('/exchange')) { requests.push(String(init?.body)); if (drop) { drop = false; throw new Error('Lost response') } } return r }); flaky.session = api.session
  const engine = new SyncEngine(d.store, flaky, async work => work())
  const before = await d.store.batch(); await engine.run(true); expect(await d.store.batch()).toEqual(before)
  await engine.run(true); expect((await d.store.view()).pending).toEqual([])
  expect(JSON.parse(requests[0]).changes).toEqual(JSON.parse(requests[1]).changes)
  expect(f.db.prepare('SELECT * FROM records').all()).toHaveLength(1)
  expect(f.db.prepare('SELECT * FROM sync_operations').all()).toHaveLength(1)
})

test('actual fixed ceiling accepts a write outside its page and client never downgrades acknowledgement', async () => {
  const d = await device(); await connect(d)
  for (let i = 0; i < 4; i++) f.exchange(space.id, [put({ ...demoPlan, id: `remote-${i}` })])
  const settings = await d.store.settings()
  const request = { protocolVersion: 1 as const, appId: 'workout' as const, deviceId: settings.deviceId, spaceId: space.id, cursor: settings.cursor, limit: 1, changes: [] as Operation[] }
  const first = await d.api.exchange(request); expect(first.hasMore).toBe(true); await d.store.apply(first, [], space.id)
  await d.local.ensurePlan(demoPlan); const ops = await d.store.batch()
  const second = await d.api.exchange({ ...request, cursor: first.cursor, changes: ops }); expect(second.acceptedOperationIds).toContain(ops[0].operationId); expect(second.changes.some(c => c.recordId === demoPlan.id)).toBe(false)
  await d.store.apply(second, ops, space.id)
  const restarted = new SyncEngine(new SyncStore(d.open), d.api, async work => work()); await restarted.run(true)
  expect((await d.store.view()).plans).toHaveLength(5); expect((await d.store.view()).metadata.find(m => m.id === `plan:${demoPlan.id}`)?.version).toBe('1')
})

test('real SQLite restore preserves acknowledged missing records and pending edits for explicit recovery', async () => {
  const d = await device(); await connect(d); const backup = await f.backup()
  await d.local.ensurePlan(demoPlan); await d.engine.run(true)
  const s = await d.local.complete(createSession(demoPlan, '2026-11-09'))
  const pending = await d.store.batch(); await f.restore(backup)
  await d.engine.run(true); expect((await d.store.settings()).error).toContain('Authentication expired')
  await d.api.login(password); await d.engine.run(true)
  expect((await d.store.settings()).phase).toBe('recovery'); expect(await d.store.batch()).toEqual(pending); expect(await d.local.reopen(s.id)).toEqual(s)
  await d.store.reconcile(); const conflicts = (await d.store.view()).conflicts; expect(conflicts).toHaveLength(2)
  for (const c of conflicts) await d.store.resolve(c.id, c.generation, 'local')
  await d.engine.run(true); expect((await d.store.view()).pending).toEqual([]); expect(f.db.prepare('SELECT * FROM records').all()).toHaveLength(2)
})

test('real delete, explicit resurrection and rejection preserve data until resolution', async () => {
  const a = await device(), b = await device(); await a.local.ensurePlan(demoPlan); await connect(a); await connect(b)
  await a.store.delete('plan', demoPlan.id); await a.engine.run(true); await b.engine.run(true)
  const conflict = (await b.store.view()).conflicts[0]; expect(conflict.current?.deleted).toBe(true)
  expect((await b.store.view()).plans).toHaveLength(1)
  await b.store.resolve(conflict.id, conflict.generation, 'local'); expect((await b.store.batch())[0]).toMatchObject({ resurrect: true, baseServerVersion: '2' })
  await b.engine.run(true); await a.engine.run(true); expect((await a.store.view()).plans).toHaveLength(1)
  const result = exchangeSchema.parse(f.exchange(space.id, [put({ ...demoPlan, id: 'rejected', name: '' })])); expect(result.rejected).toHaveLength(1)
})

test('independent records from two devices survive downtime and authentication expiry', async () => {
  const a = await device(), b = await device(); await connect(a); await connect(b)
  const x = await a.local.complete(createSession(demoPlan, '2026-11-08')), y = await b.local.complete(createSession(demoPlan, '2026-11-09'))
  f.db.prepare('DELETE FROM sessions').run(); await a.engine.run(true); expect((await a.store.view()).pending).toHaveLength(1)
  const down = new SyncEngine(b.store, new SyncApi(async () => { throw Error('Backend unavailable') }), async work => work()); await down.run(true)
  expect((await b.store.view()).pending).toHaveLength(1); expect((await b.store.settings()).nextRetry).toBeGreaterThan(Date.now())
  await a.api.login(password); await b.api.login(password)
  await a.engine.run(true); await b.engine.run(true); await a.engine.run(true)
  expect((await a.local.list()).map(s => s.id).sort()).toEqual([x.id, y.id].sort()); expect((await b.local.list()).map(s => s.id).sort()).toEqual([x.id, y.id].sort())
})

test('real migration fixture uploads existing completed history without rewriting IDs or metadata', async () => {
  const d = await device(); const value = { ...createSession(demoPlan, '2020-03-12'), status: 'completed' as const, revision: 73, futureMetadata: { preserved: true } }
  // Insert a legacy confirmed record without an outbox, as the additive migration does.
  const db = await d.open(); await new Promise<void>((resolve, reject) => { const tx = db.transaction(['plans', 'sessions'], 'readwrite'); tx.objectStore('plans').put(demoPlan); tx.objectStore('sessions').put(value); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) }); db.close()
  await connect(d)
  const fresh = await device(); await connect(fresh)
  expect(await fresh.local.reopen(value.id)).toEqual(value)
  expect((await d.store.view()).pending).toEqual([])
})

test('replayed directory create UUIDs recover lost responses without creating duplicates', async () => {
  const d = await device(); const intent = await d.store.creation('spaceCreation', 'Retry-safe')
  const first = await d.api.createSpace(intent.id, intent.name); const retry = await d.api.createSpace(intent.id, intent.name)
  expect(retry).toEqual(first); expect((await d.api.directory('spaces')).filter(x => x.id === intent.id)).toHaveLength(1)
  const person = await d.store.creation('personCreation', 'Retry-safe Person')
  await d.api.createPerson(person.id, person.name); await d.api.createPerson(person.id, person.name)
  expect(await d.api.directory('people')).toHaveLength(1)
})

test('initial staging and common-directory pagination resume across restart before installing server-only records', async () => {
  const d = await device()
  for (let i = 0; i < 30; i++) f.exchange(space.id, [put({ ...demoPlan, id: `paged-${i}` })])
  for (let i = 0; i < 55; i++) f.person(`Person ${i}`)
  const exported = await d.store.export(); await d.store.begin(space, f.owner, exported.id)
  const s = await d.store.settings()
  const first = await d.api.exchange({ protocolVersion: 1, appId: 'workout', deviceId: s.deviceId, spaceId: space.id, cursor: null, limit: 1, changes: [] })
  expect(first.hasMore).toBe(true); await d.store.stage(first)
  expect((await d.store.view()).plans).toEqual([]); expect((await d.store.settings()).stageCursor).toBe(first.cursor)
  const restarted = new SyncEngine(new SyncStore(d.open), d.api, async work => work()); await restarted.run(true)
  expect((await d.store.settings()).stageComplete).toBe(true); expect((await d.store.view()).plans).toEqual([])
  expect((await d.store.view()).people).toHaveLength(55)
  await d.store.reconcile(); expect((await d.store.view()).plans).toHaveLength(30)
})

test('pause retains a server-accepted delayed response even if the other tab misses the abort notification', async () => {
  const d = await device(); await connect(d); await d.local.ensurePlan(demoPlan)
  const original = await d.store.batch(); const transport = f.clientFetch()
  let release!: () => void, notifyAccepted!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const accepted = new Promise<void>(resolve => { notifyAccepted = resolve })
  let delay = true
  const api = new SyncApi(async (url, init) => {
    const response = await transport(url, init)
    if (String(url).endsWith('/exchange') && delay) { delay = false; expect(response.ok).toBe(true); notifyAccepted(); await held }
    return response
  })
  await api.login(password)
  const engine = new SyncEngine(d.store, api, async work => work()); const running = engine.run(true)
  try {
    await accepted
    // Separate tab, deliberately without a BroadcastChannel listener in this
    // Node test. The transactional generation check must be sufficient alone.
    await new SyncEngine(new SyncStore(d.open)).pause()
    const paused = await d.store.view(); release(); await running
    expect(await d.store.view()).toEqual(paused); expect(await d.store.batch()).toEqual(original)
    await d.store.begin(space, f.owner, (await d.store.export()).id); await engine.run(true)
    expect((await d.store.view()).pending).toEqual([])
    expect((await d.store.view()).metadata[0].version).toBe('1')
    expect(f.db.prepare('SELECT * FROM sync_operations').all()).toHaveLength(1)
  } finally { release(); await running }
})
