import { allStores, markLocalChange, markSyncControl, openDatabase, request, transaction } from './database'
import { associationsSchema, keyOf, same, type Association, type ExchangeResponse, type Kind, type Operation, type Person, type Snapshot, type Space, type Value } from './sync'
import type { Session } from './workouts'

export interface Settings {
  id: 'settings'; deviceId: string; enabled: boolean; phase: 'local' | 'initial' | 'recovery' | 'ready'
  spaceId?: string; principalId?: string; cursor: string | null; commonCursor: string | null
  stageCursor?: string | null; stageComplete?: boolean; failures: number; nextRetry: number
  lastSuccess?: string; lastConfirmed?: string; catchUpPending?: boolean; signInRequired?: boolean
  error?: string; exportId?: string; consentAt?: string
  controlVersion?: number
  spaceCreation?: { id: string; name: string }; personCreation?: { id: string; name: string }
}
export interface Meta { id: string; version: string | null; people: Association[]; deleted?: boolean; server?: Snapshot }
export interface Pending { id: string; key: string; kind: Kind; recordId: string; value: Value | null; people: Association[]; after?: string; operation?: Operation }
export interface Conflict { id: string; kind: Kind; recordId: string; code: string; current: Snapshot | null; local: Value | null; people: Association[]; generation: string }
export interface Backup { id: string; createdAt: string; reason: string; plans: Value[]; sessions: Value[]; outbox: Pending[]; metadata: Meta[]; conflicts: Conflict[]; settings: Settings; draft?: string | null; formatVersion?: 2; people?: Person[]; spaces?: Space[]; staged?: Snapshot[] }
const storeFor = (kind: Kind) => kind === 'plan' ? 'plans' : 'sessions'
const getSettings = (tx: IDBTransaction) => request(tx.objectStore('syncSettings').get('settings')) as Promise<Settings>
const all = <T>(tx: IDBTransaction, store: string) => request(tx.objectStore(store).getAll()) as Promise<T[]>
function operation(p: Pending, base: string | null, resurrect = false): Operation {
  const common = { operationId: p.id, kind: p.kind, recordId: p.recordId, baseServerVersion: base }
  return p.value === null ? { ...common, type: 'delete' } : { ...common, type: 'put', schemaVersion: 1, value: p.value, people: p.people, resurrect }
}
export async function enqueue(tx: IDBTransaction, kind: Kind, value: Value | null, recordId = value!.id, people?: Association[], resurrect = false) {
  const key = keyOf(kind, recordId)
  const meta = await request(tx.objectStore('syncMeta').get(key)) as Meta | undefined
  const rows = (await all<Pending>(tx, 'syncOutbox')).filter(p => p.key === key)
  const tail = rows.find(p => !rows.some(next => next.after === p.id))
  const p: Pending = { id: crypto.randomUUID(), key, kind, recordId, value: structuredClone(value), people: structuredClone(people ?? meta?.people ?? []) }
  if (tail) p.after = tail.id
  else p.operation = operation(p, meta?.version ?? null, resurrect)
  await request(tx.objectStore('syncOutbox').add(p))
  markLocalChange(tx)
  if (people || !meta) await request(tx.objectStore('syncMeta').put({ ...meta, id: key, version: meta?.version ?? null, people: p.people }))
  // Keep the comparison current when a user saves while a conflict is open.
  const conflict = await request(tx.objectStore('syncConflicts').get(key)) as Conflict | undefined
  if (conflict) await request(tx.objectStore('syncConflicts').put({ ...conflict, local: value, people: p.people, generation: crypto.randomUUID() }))
}
async function backup(tx: IDBTransaction, reason: string, draft?: string | null): Promise<Backup> {
  const b: Backup = { formatVersion: 2, id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason, plans: await all(tx, 'plans'), sessions: await all(tx, 'sessions'), outbox: await all(tx, 'syncOutbox'), metadata: await all(tx, 'syncMeta'), conflicts: await all(tx, 'syncConflicts'), settings: await getSettings(tx), people: await all(tx, 'syncPeople'), spaces: await all(tx, 'syncSpaces'), staged: (await all<{ snapshot: Snapshot }>(tx, 'syncRemote')).map(x => x.snapshot), ...(draft === undefined ? {} : { draft }) }
  await request(tx.objectStore('syncBackups').add(b)); return b
}
async function install(tx: IDBTransaction, s: Snapshot) {
  const object = tx.objectStore(storeFor(s.kind)); const prior = await request(object.get(s.recordId)) as Value | undefined
  if (s.deleted) {
    if (prior) { await backup(tx, `Before accepting server deletion of ${s.recordId}`); await request(object.delete(s.recordId)) }
  } else {
    let value = s.value!
    // Advance only the device-local concurrency counter when replacing an existing
    // payload. The exact server snapshot stays in metadata; it is never a base version.
    if (s.kind === 'session' && prior && !same(prior, value)) value = { ...value, revision: Math.max((prior as Session).revision + 1, (value as Session).revision) } as Session
    await request(object.put(value))
  }
}
async function conflict(tx: IDBTransaction, kind: Kind, recordId: string, code: string, current: Snapshot | null) {
  const id = keyOf(kind, recordId); const meta = await request(tx.objectStore('syncMeta').get(id)) as Meta | undefined
  const local = await request(tx.objectStore(storeFor(kind)).get(recordId)) as Value | undefined
  await request(tx.objectStore('syncConflicts').put({ id, kind, recordId, code, current, local: local ?? null, people: meta?.people ?? [], generation: crypto.randomUUID() } satisfies Conflict))
}
export class SyncStore {
  readonly open: () => Promise<IDBDatabase>
  constructor(open: () => Promise<IDBDatabase> = openDatabase) { this.open = open }
  read<T>(run: (tx: IDBTransaction) => Promise<T>) { return transaction(this.open, allStores, 'readonly', run) }
  write<T>(run: (tx: IDBTransaction) => Promise<T>) { return transaction(this.open, allStores, 'readwrite', run) }
  settings() { return this.read(getSettings) }
  async patch(patch: Partial<Settings>, expectedControlVersion?: number) { return this.write(async tx => {
    const s = await getSettings(tx)
    if (expectedControlVersion !== undefined && (!s.enabled || (s.controlVersion ?? 0) !== expectedControlVersion)) return
    const control = patch.enabled === undefined ? {} : { controlVersion: (s.controlVersion ?? 0) + 1 }
    if (patch.enabled !== undefined) markSyncControl(tx, patch.enabled)
    await request(tx.objectStore('syncSettings').put({ ...s, ...patch, ...control, id: 'settings', deviceId: s.deviceId }))
  }) }
  async creation(type: 'spaceCreation' | 'personCreation', name: string) {
    return this.write(async tx => { const s = await getSettings(tx); const intent = s[type] ?? { id: crypto.randomUUID(), name }; s[type] = intent; await request(tx.objectStore('syncSettings').put(s)); return intent })
  }
  async finishPersonCreation(id: string) {
    return this.write(async tx => { const s = await getSettings(tx); if (s.personCreation?.id === id) { delete s.personCreation; await request(tx.objectStore('syncSettings').put(s)) } })
  }
  summary() {
    return transaction(this.open, ['syncSettings', 'syncOutbox', 'syncConflicts'], 'readonly', async tx => ({
      settings: await getSettings(tx),
      pending: await request(tx.objectStore('syncOutbox').count()),
      conflicts: await request(tx.objectStore('syncConflicts').count()),
    }))
  }
  async view() { return this.read(async tx => ({ settings: await getSettings(tx), pending: await all<Pending>(tx, 'syncOutbox'), conflicts: await all<Conflict>(tx, 'syncConflicts'), people: await all<Person>(tx, 'syncPeople'), spaces: await all<Space>(tx, 'syncSpaces'), plans: await all<Value>(tx, 'plans'), sessions: await all<Value>(tx, 'sessions'), metadata: await all<Meta>(tx, 'syncMeta'), staged: (await all<{ snapshot: Snapshot }>(tx, 'syncRemote')).map(x => x.snapshot) })) }
  async export(draft?: string | null) { return this.write(async tx => { const b = await backup(tx, 'User export', draft); const s = await getSettings(tx); s.exportId = b.id; await request(tx.objectStore('syncSettings').put(s)); return b }) }
  async backups() { return this.read(tx => all<Backup>(tx, 'syncBackups')) }
  async begin(space: Space, principalId: string, exportId: string) {
    return this.write(async tx => {
      const s = await getSettings(tx)
      if (s.spaceId && (s.spaceId !== space.id || s.principalId !== principalId)) throw new Error('This browser is bound to another Space or owner. Export and use a separate browser profile to avoid mixing data.')
      if (space.kind !== 'personal' || space.archived) throw new Error('Choose an active personal Space.')
      const b = await request(tx.objectStore('syncBackups').get(exportId)) as Backup | undefined
      if (!b || s.exportId !== exportId || !same(b.plans, await all(tx, 'plans')) || !same(b.sessions, await all(tx, 'sessions')) || !same(b.outbox, await all(tx, 'syncOutbox'))) throw new Error('Local data changed. Download a fresh export before connecting.')
      Object.assign(s, { enabled: true, spaceId: space.id, principalId, consentAt: new Date().toISOString(), error: undefined, nextRetry: 0 })
      s.controlVersion = (s.controlVersion ?? 0) + 1; markSyncControl(tx, true)
      if (s.phase === 'local') Object.assign(s, { phase: 'initial', stageCursor: null, stageComplete: false })
      await request(tx.objectStore('syncSettings').put(s))
    })
  }
  async batch(): Promise<Operation[]> {
    return this.write(async tx => {
      const blocked = new Set((await all<Conflict>(tx, 'syncConflicts')).map(c => c.id))
      const heads = (await all<Pending>(tx, 'syncOutbox')).filter(p => p.operation && !blocked.has(p.key))
      const ops: Operation[] = []; let bytes = 0
      for (const p of heads) {
        const size = new TextEncoder().encode(JSON.stringify(p.operation)).length
        if (size > 750_000 || (p.value && new TextEncoder().encode(JSON.stringify(p.value)).length > 65536)) {
          const meta = await request(tx.objectStore('syncMeta').get(p.key)) as Meta | undefined
          await conflict(tx, p.kind, p.recordId, 'PAYLOAD_EXCEEDS_SERVER_LIMIT', meta?.server ?? null); continue
        }
        if (ops.length === 16 || bytes + size > 750_000) break; ops.push(p.operation!); bytes += size
      }
      return ops
    })
  }
  async apply(response: ExchangeResponse, sent: Operation[], scope: string, controlVersion?: number, commonPending = false) {
    return this.write(async tx => {
      const s = await getSettings(tx)
      if (controlVersion !== undefined && (!s.enabled || (s.controlVersion ?? 0) !== controlVersion)) return
      if (s.spaceId !== scope || s.phase !== 'ready') throw new Error('Sync scope changed; retry retained operations.')
      if (response.results.length !== sent.length || sent.some((op, i) => response.results[i].operationId !== op.operationId)) throw new Error('Invalid operation acknowledgements')
      for (const r of response.results) {
        const p = await request(tx.objectStore('syncOutbox').get(r.operationId!)) as Pending | undefined
        if (!p || !same(p.operation, sent.find(op => op.operationId === r.operationId))) throw new Error('Operation changed; response not applied')
        const meta = await request(tx.objectStore('syncMeta').get(p.key)) as Meta | undefined
        if (r.status === 'accepted') {
          const newer = !meta?.version || BigInt(r.serverVersion) >= BigInt(meta.version)
          const later = (await all<Pending>(tx, 'syncOutbox')).some(x => x.key === p.key && x.id !== p.id)
          if (newer) await request(tx.objectStore('syncMeta').put({ ...meta, id: p.key, version: r.serverVersion, people: later ? meta?.people ?? p.people : p.people, deleted: p.value === null } satisfies Meta))
          await request(tx.objectStore('syncOutbox').delete(p.id))
          const next = (await all<Pending>(tx, 'syncOutbox')).find(x => x.after === p.id)
          if (next) { delete next.after; next.operation = operation(next, r.serverVersion); await request(tx.objectStore('syncOutbox').put(next)) }
        } else await conflict(tx, p.kind, p.recordId, r.code, r.status === 'conflict' ? r.current as Snapshot | null : meta?.server ?? null)
      }
      for (const raw of response.changes) {
        const change = raw as Snapshot; const key = keyOf(change.kind, change.recordId)
        const meta = await request(tx.objectStore('syncMeta').get(key)) as Meta | undefined
        if (meta?.version && BigInt(change.serverVersion) < BigInt(meta.version)) continue
        const pending = (await all<Pending>(tx, 'syncOutbox')).some(p => p.key === key)
        const existing = await request(tx.objectStore('syncConflicts').get(key)) as Conflict | undefined
        const local = await request(tx.objectStore(storeFor(change.kind)).get(change.recordId)) as Value | undefined
        if (existing) {
          if (!existing.current || BigInt(change.serverVersion) >= BigInt(existing.current.serverVersion)) await conflict(tx, change.kind, change.recordId, existing.code, change)
        } else if (!pending) {
          // Explicit review for all remote deletions of locally present records.
          if (change.deleted && local) await conflict(tx, change.kind, change.recordId, 'SERVER_DELETED', change)
          else if (local && change.kind === 'session' && (local as Session).status === 'completed' && !same({ ...local, revision: 0 }, { ...change.value, revision: 0 })) await conflict(tx, change.kind, change.recordId, 'COMPLETED_HISTORY_CHANGED', change)
          else if (!meta?.server || !same(meta.server, change)) await install(tx, change)
        }
        await request(tx.objectStore('syncMeta').put({ id: key, version: change.serverVersion, people: pending || existing ? meta?.people ?? [] : change.people, deleted: change.deleted, server: change } satisfies Meta))
      }
      s.cursor = response.cursor; s.failures = 0; s.nextRetry = 0; s.error = undefined; s.signInRequired = false
      // Older installations recorded each committed exchange page in lastSuccess.
      s.lastSuccess = new Date().toISOString()
      s.catchUpPending = commonPending || response.hasMore || sent.length > 0
      if (!s.catchUpPending && !await request(tx.objectStore('syncOutbox').count()) && !await request(tx.objectStore('syncConflicts').count())) {
        s.lastConfirmed = s.lastSuccess
      }
      await request(tx.objectStore('syncSettings').put(s))
    })
  }
  async startRecovery(controlVersion?: number) {
    return this.write(async tx => { const s = await getSettings(tx); if (controlVersion !== undefined && (!s.enabled || (s.controlVersion ?? 0) !== controlVersion)) return; await backup(tx, 'Before cursor recovery'); await request(tx.objectStore('syncRemote').clear()); Object.assign(s, { phase: 'recovery', stageCursor: null, stageComplete: false, error: 'Server history changed. Review recovery before uploading.', nextRetry: 0 }); await request(tx.objectStore('syncSettings').put(s)) })
  }
  async stage(response: ExchangeResponse, controlVersion?: number) {
    return this.write(async tx => {
      const s = await getSettings(tx)
      if (controlVersion !== undefined && (!s.enabled || (s.controlVersion ?? 0) !== controlVersion)) return
      if (!['initial', 'recovery'].includes(s.phase)) throw new Error('No reconciliation in progress')
      for (const change of response.changes) await request(tx.objectStore('syncRemote').put({ id: keyOf(change.kind, change.recordId), snapshot: change }))
      s.stageCursor = response.cursor; s.stageComplete = !response.hasMore; s.error = undefined; s.nextRetry = 0; s.failures = 0; s.signInRequired = false
      await request(tx.objectStore('syncSettings').put(s))
    })
  }
  async reconcile() {
    return this.write(async tx => {
      const s = await getSettings(tx); if (!s.stageComplete || !['initial', 'recovery'].includes(s.phase)) throw new Error('Wait for the complete server snapshot.')
      await backup(tx, `Before ${s.phase} reconciliation`)
      const remote = new Map((await all<{ id: string; snapshot: Snapshot }>(tx, 'syncRemote')).map(x => [x.id, x.snapshot]))
      const local = new Map<string, { kind: Kind; value: Value }>()
      for (const kind of ['plan', 'session'] as const) for (const value of await all<Value>(tx, storeFor(kind))) local.set(keyOf(kind, value.id), { kind, value })
      const pending = await all<Pending>(tx, 'syncOutbox')
      const metadata = await all<Meta>(tx, 'syncMeta')
      const keys = new Set([...remote.keys(), ...local.keys(), ...pending.map(p => p.key), ...metadata.map(m => m.id)])
      for (const key of keys) {
        const server = remote.get(key) ?? null; const row = local.get(key)
        const kind = (key.startsWith('plan:') ? 'plan' : 'session') as Kind; const recordId = key.slice(kind.length + 1)
        const old = metadata.find(m => m.id === key); const queue = pending.filter(p => p.key === key)
        const equal = server && !server.deleted && row && same(row.value, server.value) && same(old?.people ?? [], server.people)
        // Only first connection may create unmatched local records automatically,
        // and only after the explicit export + consent + review workflow.
        if (s.phase === 'initial' && row && !server && !queue.length) await enqueue(tx, kind, row.value)
        else if ((row || queue.length || old?.version) && !(s.phase === 'initial' && !server) && (!equal || queue.length > 0)) await conflict(tx, kind, recordId, s.phase === 'recovery' ? 'RESTORE_RECONCILIATION' : 'INITIAL_COLLISION', server)
        else if (!row && !queue.length && server && !server.deleted) await install(tx, server)
        await request(tx.objectStore('syncMeta').put({ id: key, version: server?.serverVersion ?? null, people: row ? old?.people ?? [] : server?.people ?? [], deleted: server?.deleted ?? false, ...(server ? { server } : {}) } satisfies Meta))
      }
      s.phase = 'ready'; s.cursor = s.stageCursor ?? null; s.stageComplete = false; s.error = undefined; s.catchUpPending = true
      await request(tx.objectStore('syncSettings').put(s)); await request(tx.objectStore('syncRemote').clear())
    })
  }
  async resolve(id: string, generation: string, choice: 'local' | 'server') {
    return this.write(async tx => {
      const s = await getSettings(tx); if (s.phase !== 'ready') throw new Error('Finish server recovery first.')
      const c = await request(tx.objectStore('syncConflicts').get(id)) as Conflict | undefined
      if (!c || c.generation !== generation) throw new Error('This comparison changed. Review the latest versions again.')
      await backup(tx, `Conflict resolution: keep ${choice} for ${id}`)
      for (const p of await all<Pending>(tx, 'syncOutbox')) if (p.key === id) await request(tx.objectStore('syncOutbox').delete(p.id))
      const local = await request(tx.objectStore(storeFor(c.kind)).get(c.recordId)) as Value | undefined
      const m: Meta = { id, version: c.current?.serverVersion ?? null, people: choice === 'local' ? c.people : c.current?.people ?? [], deleted: c.current?.deleted ?? false, ...(c.current ? { server: c.current } : {}) }
      await request(tx.objectStore('syncMeta').put(m)); await request(tx.objectStore('syncConflicts').delete(id))
      s.catchUpPending = true
      await request(tx.objectStore('syncSettings').put(s))
      markLocalChange(tx)
      if (choice === 'local') {
        if (local) await enqueue(tx, c.kind, local, c.recordId, c.people, c.current?.deleted ?? false)
        else if (c.current && !c.current.deleted) await enqueue(tx, c.kind, null, c.recordId)
      } else if (c.current) await install(tx, c.current)
      else await request(tx.objectStore(storeFor(c.kind)).delete(c.recordId))
    })
  }
  async tag(kind: Kind, recordId: string, people: Association[]) {
    associationsSchema.parse(people)
    return this.write(async tx => {
      const value = await request(tx.objectStore(storeFor(kind)).get(recordId)) as Value | undefined
      if (!value) throw new Error('Save the record before adding People.')
      await enqueue(tx, kind, value, recordId, people)
    })
  }
  async delete(kind: Kind, recordId: string) {
    return this.write(async tx => {
      const value = await request(tx.objectStore(storeFor(kind)).get(recordId)) as Value | undefined
      if (!value) return
      await backup(tx, `Before local deletion of ${recordId}`)
      await enqueue(tx, kind, null, recordId); await request(tx.objectStore(storeFor(kind)).delete(recordId))
    })
  }
  async cacheDirectory(people: Person[], spaces: Space[]) { return this.write(async tx => { for (const p of people) await request(tx.objectStore('syncPeople').put(p)); for (const s of spaces) await request(tx.objectStore('syncSpaces').put(s)) }) }
  async common(page: { cursor: string; changes: { entityType: string; value: unknown }[] }, controlVersion?: number) {
    return this.write(async tx => { const s = await getSettings(tx); if (controlVersion !== undefined && (!s.enabled || (s.controlVersion ?? 0) !== controlVersion)) return; for (const c of page.changes) if (c.entityType === 'person' || c.entityType === 'space') await request(tx.objectStore(c.entityType === 'person' ? 'syncPeople' : 'syncSpaces').put(c.value)); s.commonCursor = page.cursor; await request(tx.objectStore('syncSettings').put(s)) })
  }
}
