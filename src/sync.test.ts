import 'fake-indexeddb/auto'
import { expect, test, vi } from 'vitest'
import { openDatabase, SessionStore } from './storage'
import { request } from './database'
import { SyncStore } from './sync-store'
import { createSession, demoPlan } from './workouts'
import { exchangeSchema, type Operation, type Snapshot } from './sync'
import { SyncApi, ApiError } from './sync-api'
import { SyncEngine } from './sync-engine'
import { IDBFactory } from 'fake-indexeddb'
import { restoreNewDatabase, validateRecoveryExport } from '../scripts/recover-workout.mjs'
const principal = crypto.randomUUID(), space = { id: crypto.randomUUID(), name: 'Test', kind: 'personal' as const, archived: false, serverVersion: '1' }
function device() { const name = crypto.randomUUID(); const open = () => openDatabase(name); return { name, open, local: new SessionStore(open), sync: new SyncStore(open) } }
async function ready(d: ReturnType<typeof device>) { const b = await d.sync.export(); await d.sync.begin(space, principal, b.id); await d.sync.stage(page([])); await d.sync.reconcile() }
function snapshot(value = demoPlan, serverVersion = '1'): Snapshot { return { kind: 'plan', recordId: value.id, schemaVersion: 1, value, people: [], deleted: false, serverVersion, createdAt: '', updatedAt: '', updatedBy: principal, deviceId: crypto.randomUUID() } }
function page(changes: Snapshot[], ops: Operation[] = [], version = '1', cursor = 'cursor') { return exchangeSchema.parse({ protocolVersion: 1, changes, cursor, hasMore: false, results: ops.map(op => ({ operationId: op.operationId, status: 'accepted', serverVersion: version })), acceptedOperationIds: ops.map(op => op.operationId), rejected: [], conflicts: [] }) }

test('real V1 upgrade abort rolls back DDL, retries preserve history, metadata and draft', async () => {
  const d = device(); const saved = { ...createSession(demoPlan, '2026-11-09'), revision: 17, status: 'completed', unknown: { preserve: [1, 2] } }
  const raw = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open(d.name, 1); r.onupgradeneeded = () => { r.result.createObjectStore('plans', { keyPath: 'id' }); r.result.createObjectStore('sessions', { keyPath: 'id' }) }; r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
  await new Promise<void>((resolve, reject) => { const tx = raw.transaction(['plans', 'sessions'], 'readwrite'); tx.objectStore('plans').put(demoPlan); tx.objectStore('sessions').put(saved); tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error) }); raw.close()
  localStorage.setItem('workout-companion-draft-v1', 'draft stays separate')
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(function (this: IDBObjectStore) { const r = this.get('interrupted'); this.transaction.abort(); return r })
  await expect(d.open()).rejects.toBeDefined(); put.mockRestore()
  expect(await d.local.list()).toEqual([saved]); expect((await d.sync.view()).plans).toEqual([demoPlan]); expect((await d.sync.view()).pending).toEqual([])
  const id = (await d.sync.settings()).deviceId; expect((await d.sync.settings()).deviceId).toBe(id)
  expect(localStorage.getItem('workout-companion-draft-v1')).toBe('draft stays separate'); localStorage.clear()
})

test('atomic rollback of outbox insertion leaves neither a session nor an operation', async () => {
  const d = device(); await d.open().then(db => db.close())
  const original = IDBObjectStore.prototype.add
  const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) { if (this.name === 'syncOutbox') throw new Error('Synthetic quota'); return original.apply(this, args) })
  await expect(d.local.save(createSession(demoPlan, '2026-11-09'))).rejects.toThrow('Synthetic quota'); add.mockRestore()
  expect(await d.local.list()).toEqual([]); expect((await d.sync.view()).pending).toEqual([])
})

test('successive offline edits survive restart; retry identity is immutable; ACK outside ceiling cannot downgrade', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); await ready(d)
  const first = await d.sync.batch(); expect(first).toHaveLength(1)
  await d.sync.tag('plan', demoPlan.id, [{ personId: principal, role: 'subject' }])
  expect(await new SyncStore(d.open).batch()).toEqual(first)
  await d.sync.apply(page([], first, '4'), first, space.id)
  const next = await d.sync.batch(); expect(next[0].baseServerVersion).toBe('4'); expect(next[0].operationId).not.toBe(first[0].operationId)
  await d.sync.apply(page([snapshot({ ...demoPlan, name: 'Old snapshot' }, '2')]), [], space.id)
  expect((await d.sync.view()).plans[0]).toEqual(demoPlan); expect((await d.sync.view()).metadata[0].version).toBe('4')
  expect(next[0].type === 'put' && next[0].people).toEqual([{ personId: principal, role: 'subject' }])
})

test('concurrent tabs cannot lose local saves and confirmed drafts alone enter outbox', async () => {
  const d = device(); const s = await d.local.save(createSession(demoPlan, '2026-11-09'))
  const results = await Promise.allSettled([d.local.save({ ...s, demo: false }), new SessionStore(d.open).save({ ...s, demo: true })])
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
  expect((await d.sync.view()).pending).toHaveLength(2)
  expect((await d.local.list())[0].revision).toBe(2)
})

test('page application rolls back ACK and cursor together on storage failure', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); await ready(d); const ops = await d.sync.batch()
  const before = await d.sync.view(); const original = IDBObjectStore.prototype.put
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) { if (this.name === 'syncSettings') throw Error('Disk full'); return original.apply(this, args) })
  await expect(d.sync.apply(page([snapshot()], ops, '1', 'advanced'), ops, space.id)).rejects.toThrow('Disk full'); put.mockRestore()
  expect(await d.sync.view()).toEqual(before)
})

test('only a fully caught-up exchange confirms the sync time, including after an upgrade', async () => {
  const d = device()
  await ready(d)
  const previous = '2026-01-01T00:00:00Z'
  await d.sync.patch({ lastSuccess: previous, catchUpPending: undefined })
  await d.local.ensurePlan(demoPlan)
  const sent = await d.sync.batch()
  await d.sync.apply(page([], sent), sent, space.id)
  expect((await d.sync.settings()).lastConfirmed).toBeUndefined()
  expect((await d.sync.settings()).catchUpPending).toBe(true)
  await d.sync.apply({ ...page([]), hasMore: true }, [], space.id)
  expect((await d.sync.settings()).lastConfirmed).toBeUndefined()
  expect((await d.sync.settings()).catchUpPending).toBe(true)
  await d.sync.apply(page([]), [], space.id, undefined, true)
  expect((await d.sync.settings()).lastConfirmed).toBeUndefined()
  expect((await d.sync.settings()).catchUpPending).toBe(true)
  await d.sync.apply(page([]), [], space.id)
  expect(await d.sync.settings()).toMatchObject({ lastConfirmed: expect.any(String), catchUpPending: false })
})

test('initial empty server retains existing data and requires export matching latest saves', async () => {
  const d = device(); const exported = await d.sync.export(); const saved = await d.local.complete(createSession(demoPlan, '2026-11-09'))
  await expect(d.sync.begin(space, principal, exported.id)).rejects.toThrow('fresh export')
  await ready(d); expect(await d.local.reopen(saved.id)).toEqual(saved); expect(await d.sync.batch()).toHaveLength(1)
})

test('conflicts survive reload; stale UI decisions cannot discard newer local edits', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); await ready(d); const ops = await d.sync.batch()
  const current = snapshot({ ...demoPlan, name: 'Phone version' }, '2')
  const response = page([]); response.results = [{ operationId: ops[0].operationId, status: 'conflict', code: 'VERSION_CONFLICT', current, serverVersion: '2' }]
  await d.sync.apply(response, ops, space.id)
  const c = (await new SyncStore(d.open).view()).conflicts[0]; expect(await d.sync.batch()).toEqual([])
  await d.sync.tag('plan', demoPlan.id, [{ personId: principal, role: 'subject' }])
  await expect(d.sync.resolve(c.id, c.generation, 'server')).rejects.toThrow('comparison changed')
  const latest = (await d.sync.view()).conflicts[0]; await d.sync.resolve(latest.id, latest.generation, 'local')
  const next = await d.sync.batch(); expect(next[0].baseServerVersion).toBe('2'); expect(next[0].operationId).not.toBe(ops[0].operationId)
  expect((await d.sync.backups()).some(b => b.reason.startsWith('Conflict resolution'))).toBe(true)
})

test('unknown schema is rejected before cursor or local state can change', () => { expect(() => exchangeSchema.parse({ ...page([snapshot()]), changes: [{ ...snapshot(), schemaVersion: 2 }] })).toThrow() })

test('API uses same-origin no-store and in-memory CSRF; login/logout clear secrets', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ principalId: principal, csrfToken: 'csrf', expiresAt: 123 }))).mockResolvedValueOnce(new Response(null, { status: 204 }))
  const api = new SyncApi(fetcher); await api.login('synthetic', 'never-persist'); await api.logout()
  expect(fetcher.mock.calls[0][0]).toBe('/api/v1/auth/login')
  expect(fetcher.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' }); expect(api.session).toBeNull()
})

test('server deletion retains local history until explicit choice, resurrection uses new UUID', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); await ready(d); const ops = await d.sync.batch(); await d.sync.apply(page([snapshot()], ops), ops, space.id)
  await d.sync.apply(page([{ ...snapshot(), value: null, deleted: true, serverVersion: '2' }]), [], space.id)
  expect((await d.sync.view()).plans).toHaveLength(1)
  const c = (await d.sync.view()).conflicts[0]; await d.sync.resolve(c.id, c.generation, 'local')
  expect((await d.sync.batch())[0]).toMatchObject({ baseServerVersion: '2', resurrect: true })
})

test('failed migration can be reopened at V1 without side stores', async () => {
  const name = crypto.randomUUID(); const r = indexedDB.open(name, 1)
  r.onupgradeneeded = () => { r.result.createObjectStore('plans', { keyPath: 'id' }); r.result.createObjectStore('sessions', { keyPath: 'id' }) }
  const db = await request(r); db.close()
  const r2 = indexedDB.open(name, 2); r2.onupgradeneeded = () => { r2.result.createObjectStore('partial'); r2.transaction!.abort() }
  await expect(request(r2)).rejects.toBeDefined()
  const old = await request(indexedDB.open(name, 1)); expect([...old.objectStoreNames]).toEqual(['plans', 'sessions']); old.close()
})

test('server snapshots cannot overwrite pending edits, stale local editors fail after a remote update', async () => {
  const d = device(); const saved = await d.local.save(createSession(demoPlan, '2026-11-09')); await ready(d)
  const ops = await d.sync.batch(); await d.sync.apply(page([], ops), ops, space.id)
  const remote: Snapshot = { ...snapshot(), kind: 'session', recordId: saved.id, value: { ...saved, demo: false }, serverVersion: '2' }
  await d.sync.apply(page([remote]), [], space.id)
  await expect(d.local.save(saved)).rejects.toThrow('changed')
  const current = (await d.local.list())[0]; await d.local.save({ ...current, demo: true })
  await d.sync.apply(page([{ ...remote, serverVersion: '3' }]), [], space.id)
  expect((await d.local.list())[0].demo).toBe(true); expect((await d.sync.batch())[0].baseServerVersion).toBe('2')
})

test('completed payload changes require review, and deletion is not undone by initialization', async () => {
  const d = device(); const completed = await d.local.complete(createSession(demoPlan, '2026-11-09')); await ready(d)
  const ops = await d.sync.batch(); await d.sync.apply(page([], ops), ops, space.id)
  await d.sync.apply(page([{ ...snapshot(), kind: 'session', recordId: completed.id, value: { ...completed, status: 'active' }, serverVersion: '2' }]), [], space.id)
  expect(await d.local.reopen(completed.id)).toEqual(completed); expect((await d.sync.view()).conflicts[0].code).toBe('COMPLETED_HISTORY_CHANGED')
  await d.local.ensurePlan(demoPlan); await d.sync.delete('plan', demoPlan.id); await d.local.ensurePlan(demoPlan)
  expect((await d.sync.view()).plans).toEqual([])
})

test('space creation intents are atomic across tabs and survive restarts', async () => {
  const d = device(); const [a, b] = await Promise.all([d.sync.creation('spaceCreation', 'Mine'), new SyncStore(d.open).creation('spaceCreation', 'Mine')])
  expect(a).toEqual(b); expect(await new SyncStore(d.open).creation('spaceCreation', 'Mine')).toEqual(a)
})

test('oversized legacy records remain local and do not prevent unrelated valid uploads', async () => {
  const d = device(); await d.local.ensurePlan({ ...demoPlan, metadata: 'x'.repeat(70_000) } as typeof demoPlan)
  await d.local.save(createSession(demoPlan, '2026-11-09')); await ready(d)
  const batch = await d.sync.batch(); expect(batch).toHaveLength(1); expect(batch[0].kind).toBe('session')
  expect((await d.sync.view()).conflicts[0].code).toBe('PAYLOAD_EXCEEDS_SERVER_LIMIT'); expect((await d.sync.view()).plans).toHaveLength(1)
})

test('network timeout aborts a request and clears timers without persisting authentication', async () => {
  vi.useFakeTimers()
  try {
    const api = new SyncApi((_url, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Timed out', 'AbortError'))) }))
    const failed = expect(api.restore()).rejects.toThrow('Timed out')
    await vi.advanceTimersByTimeAsync(20_000); await failed
    expect(api.session).toBeNull(); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})

test('disabled sync makes no auth requests; rate limits honor persisted retry delay without losing pending saves', async () => {
  const d = device(); const api = new SyncApi(); const restore = vi.spyOn(api, 'restore').mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 600_000))
  const engine = new SyncEngine(d.sync, api, async work => work())
  await engine.run(true); expect(restore).not.toHaveBeenCalled()
  await d.local.ensurePlan(demoPlan); await ready(d); const ops = await d.sync.batch(); await engine.run(true)
  const s = await d.sync.settings(); expect(s.nextRetry).toBeGreaterThan(Date.now() + 590_000)
  await engine.run(); expect(restore).toHaveBeenCalledTimes(1); expect(await d.sync.batch()).toEqual(ops)
})

test('only committed local edits announce upload work; bookkeeping and no-op initialization only refresh views', async () => {
  const d = device(); await d.open().then(db => db.close())
  const notices: string[] = []; const listener = (event: Event) => notices.push((event as CustomEvent).detail.type)
  window.addEventListener('workout-storage', listener)
  try {
    await d.local.ensurePlan(demoPlan); expect(notices.splice(0)).toEqual(['local'])
    await d.local.ensurePlan(demoPlan); await d.sync.batch(); await d.sync.common({ cursor: 'directory', changes: [] }); await d.sync.patch({ error: 'Example' })
    expect(notices.splice(0)).toEqual(['refresh', 'refresh', 'refresh', 'refresh'])
    await d.local.save(createSession(demoPlan, '2026-11-09')); expect(notices.splice(0)).toEqual(['local'])
    await d.sync.patch({ enabled: false }); expect(notices.splice(0)).toEqual(['control'])
    const original = IDBObjectStore.prototype.add
    const add = vi.spyOn(IDBObjectStore.prototype, 'add').mockImplementation(function (this: IDBObjectStore, ...args) { if (this.name === 'syncOutbox') throw Error('Quota'); return original.apply(this, args) })
    try { await expect(d.local.save(createSession(demoPlan, '2026-11-10'))).rejects.toThrow('Quota') } finally { add.mockRestore() }
    expect(notices).toEqual([])
  } finally { window.removeEventListener('workout-storage', listener) }
})

test('late acknowledgements cannot change pending data or cursors after pause, even after immediate re-enable', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); await ready(d)
  const ops = await d.sync.batch(); const generation = (await d.sync.settings()).controlVersion!
  await d.sync.patch({ enabled: false }); const paused = await d.sync.view()
  await d.sync.apply(page([snapshot()], ops), ops, space.id, generation)
  await d.sync.common({ cursor: 'late-directory', changes: [] }, generation)
  await d.sync.startRecovery(generation)
  expect(await d.sync.view()).toEqual(paused)
  await d.sync.patch({ enabled: true }); const resumed = await d.sync.view()
  await d.sync.apply(page([snapshot()], ops), ops, space.id, generation)
  expect(await d.sync.view()).toEqual(resumed)
})

test('export contains directory labels, staged state and raw draft; supervised recovery preserves payloads but resets live sync', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan)
  const saved = await d.local.complete({ ...createSession(demoPlan, '2026-11-09'), future: { nested: ['kept'] } } as ReturnType<typeof createSession>)
  const people = [{ id: principal, displayName: 'Original label', archived: false, serverVersion: '3', future: { preserved: true } }]
  await d.sync.cacheDirectory(people, [space]); await d.sync.tag('session', saved.id, [{ personId: principal, role: 'subject' }])
  const first = await d.sync.export(); await d.sync.begin(space, principal, first.id); await d.sync.stage(page([snapshot()]))
  const raw = JSON.parse(JSON.stringify(await d.sync.export('unconfirmed draft')))
  expect(raw.people).toEqual(people); expect(raw.spaces).toEqual([space]); expect(raw.staged).toHaveLength(1); expect(raw.draft).toBe('unconfirmed draft')
  expect(validateRecoveryExport(raw)).toMatchObject({ plans: 1, sessions: 1, missingPeople: [] })
  const factory = new IDBFactory(); await restoreNewDatabase(raw, factory)
  const db = await request(factory.open('workout-companion', 2))
  const tx = db.transaction(['sessions', 'syncSettings', 'syncOutbox', 'syncBackups', 'syncMeta'])
  const [rows, settings, pending, backups, metadata] = await Promise.all(['sessions', 'syncSettings', 'syncOutbox', 'syncBackups', 'syncMeta'].map(name => request(tx.objectStore(name).getAll())))
  expect(rows).toEqual([saved]); expect(pending).toEqual([])
  expect(settings[0]).toMatchObject({ enabled: false, phase: 'local', cursor: null }); expect(settings[0].deviceId).not.toBe(raw.settings.deviceId)
  expect(backups[0].source).toEqual(raw); expect(metadata.find(m => m.id === `session:${saved.id}`).people).toEqual(raw.metadata.find((m: { id: string }) => m.id === `session:${saved.id}`).people)
  db.close(); await expect(restoreNewDatabase(raw, factory)).rejects.toThrow('Recovery refused')
  expect((await d.sync.view()).sessions).toEqual([saved])
})

test('legacy export missing People labels warns; invalid/duplicate records are refused without changing the source', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); await d.sync.tag('plan', demoPlan.id, [{ personId: principal, role: 'subject' }])
  const raw = await d.sync.export(); delete raw.people; delete raw.formatVersion
  expect(validateRecoveryExport(raw).missingPeople).toEqual([principal])
  expect(() => validateRecoveryExport({ ...raw, plans: [...raw.plans, ...raw.plans] })).toThrow('Duplicate identities')
  expect(() => validateRecoveryExport({ ...raw, sessions: [{ id: 'bad' }] })).toThrow()
  expect((await d.sync.view()).plans).toEqual([demoPlan])
})

test('supervised recovery refuses V1 databases without upgrading, and interrupted creation rolls back completely', async () => {
  const d = device(); await d.local.ensurePlan(demoPlan); const raw = await d.sync.export()
  const existing = new IDBFactory(); const create = existing.open('workout-companion', 1)
  create.onupgradeneeded = () => { create.result.createObjectStore('plans', { keyPath: 'id' }).add({ ...demoPlan, name: 'Keep original' }) }
  const old = await request(create); old.close()
  await expect(restoreNewDatabase(raw, existing)).rejects.toThrow('Recovery refused')
  const unchanged = await request(existing.open('workout-companion', 1)); expect(unchanged.version).toBe(1)
  expect(await request(unchanged.transaction('plans').objectStore('plans').get(demoPlan.id))).toMatchObject({ name: 'Keep original' }); unchanged.close()
  const fresh = new IDBFactory()
  // Even if corruption bypasses the CLI's validation, the creation transaction
  // cannot leave a partially restored database behind.
  await expect(restoreNewDatabase({ ...raw, plans: [...raw.plans, ...raw.plans] }, fresh)).rejects.toBeDefined()
  expect(await fresh.databases()).toEqual([])
  await expect(restoreNewDatabase(raw, fresh)).resolves.toMatchObject({ plans: 1, syncEnabled: false })
})
