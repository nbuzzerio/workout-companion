import { useEffect, useMemo, useRef, useState } from 'react'
import { SyncEngine } from './sync-engine'
import { ApiError } from './sync-api'
import { SyncStore, type Backup, type Conflict } from './sync-store'
import { planSchema, same, sessionSchema, type Association, type Kind, type Person, type Value } from './sync'
import { formatSet, plannedSets } from './workouts'
import { setActual } from './guided-workout'
import type { RequestConfirmation } from './ConfirmationDialog'

function download(value: unknown, name: string) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
}
function differences(c: Conflict) {
  const a = c.local as unknown as Record<string, unknown> | null; const b = c.current?.value as unknown as Record<string, unknown> | null
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].filter(k => !same(a?.[k], b?.[k])).join(', ') || 'Record presence or People associations'
}
function conflictTitle(c: Conflict) {
  const value = c.local ?? c.current?.value
  return value && 'date' in value ? `Workout on ${value.date}` : value && 'name' in value ? value.name : `${c.kind} ${c.recordId}`
}
function ConflictCopy({ title, value, labels, people }: { title: string; value: Value | null; labels: Association[]; people: Person[] }) {
  if (value && !('date' in value ? sessionSchema : planSchema).safeParse(value).success) {
    return <div><h4>{title}</h4><p>Open the detailed comparison to inspect this record.</p></div>
  }
  return <div><h4>{title}</h4>
    {value ? <>
      <p>{'date' in value ? `${value.date} · ${value.status}` : value.name}</p>
      <ul>{value.exercises.map((exercise, index) => {
        const guided = 'date' in value ? value.guidance?.sets[index] : undefined
        const sets = guided ? guided.flatMap(step => {
          const actual = setActual(step)
          if (actual) return [formatSet(actual)]
          if (step.outcome?.status === 'skipped') return [step.outcome.reason ? `Skipped (${step.outcome.reason})` : 'Skipped']
          return []
        }) : ('date' in value ? exercise.sets : plannedSets(exercise)).map(formatSet)
        return <li key={index}>{exercise.name} · {sets.join(' | ') || 'No sets recorded'}</li>
      })}</ul>
      {labels.map(label => <p key={label.personId + label.role}>{people.find(p => p.id === label.personId)?.displayName ?? 'Unknown person'} · {label.role}</p>)}
    </> : <p>No saved record in this copy.</p>}
  </div>
}
async function directory(engine: SyncEngine) {
  const state = await engine.store.settings()
  if (state.principalId && state.principalId !== engine.api.session?.principalId) throw new Error('Sign in as the owner already connected to this browser. Local records and pending edits are retained.')
  const people = await engine.api.directory('people')
  const spaces = await engine.api.directory('spaces')
  await engine.store.cacheDirectory(people, spaces)
}

export function SyncPanel({ store, requestConfirmation }: { store: SyncStore; requestConfirmation: RequestConfirmation }) {
  const engine = useMemo(() => new SyncEngine(store), [store])
  const [summary, setSummary] = useState<Awaited<ReturnType<SyncStore['summary']>> & { details?: Awaited<ReturnType<SyncStore['view']>> }>()
  const view = summary?.details
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [auth, setAuth] = useState(engine.api.authState)
  const signedIn = auth === 'signed-in'
  const [sessionError, setSessionError] = useState('')
  const checkSession = useRef<() => void>(() => {})
  const authChannel = useRef<BroadcastChannel | null>(null)
  const accountBusy = useRef(false)
  const offlineRecovery = Boolean(document.querySelector('meta[name="workout-offline-recovery"]'))
  const [syncing, setSyncing] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [runnerError, setRunnerError] = useState('')
  const advanced = useRef<HTMLDetailsElement>(null)
  const [spaceId, setSpaceId] = useState(''); const [exportId, setExportId] = useState(''); const [verified, setVerified] = useState(false)
  const [selected, setSelected] = useState(''); const [backups, setBackups] = useState<Backup[]>([])
  useEffect(() => {
    let active = true
    let latestRead = 0
    const panel = advanced.current
    const refresh = async () => {
      const read = ++latestRead
      try {
        const state = panel?.open
          ? await store.view().then(details => ({ details, settings: details.settings, pending: details.pending.length, conflicts: details.conflicts.length }))
          : await store.summary()
        if (active && read === latestRead) { setSummary(state); setAuth(engine.api.authState) }
      } catch (e) { if (active && read === latestRead) setRunnerError((e as Error).message) }
    }
    const connectivity = () => setOnline(navigator.onLine)
    refresh(); const stop = engine.start(running => {
      if (running) setRunnerError('')
      setSyncing(running)
      if (!running) refresh()
    }, e => { if (active) setRunnerError(e.message) })
    window.addEventListener('workout-storage', refresh); window.addEventListener('online', connectivity); window.addEventListener('offline', connectivity)
    panel?.addEventListener('toggle', refresh)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workout-storage'); if (channel) channel.onmessage = refresh
    return () => { active = false; stop(); panel?.removeEventListener('toggle', refresh); window.removeEventListener('workout-storage', refresh); window.removeEventListener('online', connectivity); window.removeEventListener('offline', connectivity); channel?.close() }
  }, [store, engine])
  useEffect(() => {
    if (offlineRecovery) return
    let active = true
    let checking = false
    let recheck = false
    let directoryToken: string | undefined
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('household-session')
    authChannel.current = channel
    const check = async () => {
      if (!active || checking || accountBusy.current || !navigator.onLine) return
      checking = true
      try {
        const session = await engine.api.restore()
        if (!active || accountBusy.current) return
        setAuth(engine.api.authState)
        setSessionError('')
        const state = await store.settings()
        if (!active || accountBusy.current) return
        if (state.enabled && state.signInRequired) await engine.run(true)
        if (!state.enabled && directoryToken !== session.csrfToken) {
          await directory(engine)
          directoryToken = session.csrfToken
        }
      } catch (failure) {
        if (!active || accountBusy.current) return
        setAuth(engine.api.authState)
        if (failure instanceof ApiError && failure.code === 'UNAUTHENTICATED') {
          setSessionError('')
          directoryToken = undefined
        } else {
          setSessionError('Could not check the sync service. Local workouts are available.')
        }
      } finally {
        checking = false
        if (recheck) { recheck = false; void check() }
      }
    }
    const foreground = () => { if (document.visibilityState === 'visible') void check() }
    checkSession.current = check
    void check()
    if (channel) channel.onmessage = () => {
      if (checking) recheck = true
      else void check()
    }
    window.addEventListener('online', check)
    window.addEventListener('focus', foreground)
    document.addEventListener('visibilitychange', foreground)
    return () => {
      active = false
      channel?.close()
      authChannel.current = null
      window.removeEventListener('online', check)
      window.removeEventListener('focus', foreground)
      document.removeEventListener('visibilitychange', foreground)
    }
  }, [engine, store, offlineRecovery])
  async function account(work: () => Promise<void>) {
    accountBusy.current = true
    try { await action(work) } finally {
      accountBusy.current = false
      if (engine.api.authState === 'unknown') checkSession.current()
    }
  }
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await work() } catch (e) {
      setError((e as Error).message)
      // Directory actions can discover an expired session before the next poll.
      if (e instanceof ApiError && e.code === 'UNAUTHENTICATED' && summary?.settings.enabled) {
        await store.patch({ signInRequired: true, error: e.message }, summary.settings.controlVersion ?? 0)
          .catch((failure: Error) => setRunnerError(failure.message))
      }
      if (engine.api.authState === 'unknown' && navigator.onLine) checkSession.current()
    }
    finally { setBusy(false); setAuth(engine.api.authState) }
  }
  const s = summary?.settings
  const needsLogin = auth === 'signed-out'
  const hasConflict = Boolean(summary?.conflicts)
  const needsReview = s?.phase === 'initial' || s?.phase === 'recovery'
  const pending = summary?.pending ?? 0
  function headerStatus() {
    if (!online) return 'Offline'
    if (!offlineRecovery && auth === 'unknown' && !sessionError && !runnerError) return 'Checking session'
    if (runnerError || sessionError) return 'Attention needed'
    if (syncing) return 'Syncing'
    if (needsLogin) return 'Sign in required'
    if (!s?.enabled || hasConflict || needsReview || s.error) return 'Attention needed'
    if (pending || !s.lastConfirmed || s.catchUpPending !== false) return 'Changes pending'
    return 'Synced'
  }
  const status = headerStatus()
  const route = !s?.enabled ? (s?.spaceId ? 'Resume sync' : 'Set up sync')
    : needsLogin ? 'Sign in again' : needsReview ? 'Review connection' : hasConflict ? 'Review conflicts'
    : status === 'Attention needed' ? 'View sync details' : ''
  const destination = !s?.enabled || needsLogin ? 'sync-account' : needsReview ? 'sync-review' : hasConflict ? 'sync-conflicts' : 'sync-settings'
  const target = view && [...view.plans.map(value => ({ kind: 'plan' as Kind, value })), ...view.sessions.map(value => ({ kind: 'session' as Kind, value }))].find(x => `${x.kind}:${x.value.id}` === selected)
  const meta = view?.metadata.find(m => m.id === selected)
  const people = meta?.people ?? []
  function tags(next: Association[]) { if (target) void action(() => store.tag(target.kind, target.value.id, next)) }
  return <><div className="sync-header" aria-label="Synchronization">
    <div className="sync-controls">
      <span className="sync-state" aria-live="polite" data-state={status}>{summary || runnerError ? status : 'Checking sync…'}</span>
      <button type="button" disabled={!online || !s?.enabled || busy || syncing || needsLogin || Boolean(s.signInRequired) || Boolean(needsReview && s.stageComplete)}
        onClick={() => void action(() => engine.run(true))}>Sync</button>
    </div>
    {!online && <span>Edits stay on this device.{pending > 0 && ' Saved changes are waiting.'}</span>}
    {s?.lastConfirmed && <span>Last synced <time dateTime={s.lastConfirmed} title={new Date(s.lastConfirmed).toLocaleString()}>{new Date(s.lastConfirmed).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</time></span>}
    {(summary || runnerError) && route && <a href={`#${destination}`} onClick={() => { if (advanced.current) advanced.current.open = true }}>{route}</a>}
  </div>
  <details className="sync-panel" ref={advanced}><summary id="sync-settings">Advanced sync settings</summary>
    <div className="sync-content" aria-label="Synchronization settings">
      <p>Workouts remain usable offline. Connect to reconcile confirmed plans and saved sessions across devices. Recovery drafts are never uploaded. Conflicts may need review. Download and check a backup before connecting. Logout keeps local data and pending edits.</p>
      <p>{view?.plans.length ?? 0} plans · {view?.sessions.length ?? 0} saved sessions · {view?.conflicts.length ?? 0} conflicts</p>
      <p id="sync-account" tabIndex={-1}>Space: {view?.spaces.find(x => x.id === s?.spaceId)?.name ?? 'Not selected'} · {signedIn ? 'Signed in' : needsLogin ? 'Not signed in' : 'Session unavailable'}</p>
      {(error || sessionError || runnerError || s?.error) && <p className="sync-error" aria-live="polite">{error || sessionError || runnerError || s?.error}</p>}
      <fieldset disabled={busy || !view}>
        <div className="actions"><button onClick={() => void action(async () => { const b = await store.export(localStorage.getItem('workout-companion-draft-v1')); download(b, `workout-backup-${b.id}.json`); setExportId(b.id); setVerified(false) })}>Download local backup</button><button onClick={() => void action(async () => setBackups(await store.backups()))}>Show preserved copies</button></div>
        {backups.map(b => <button key={b.id} onClick={() => download(b, `workout-preserved-${b.id}.json`)}>{b.reason} · {new Date(b.createdAt).toLocaleString()}</button>)}
        {sessionError && online && <button type="button" onClick={() => checkSession.current()}>Retry session check</button>}
        {online && needsLogin && <form onSubmit={event => {
          event.preventDefault()
          const form = event.currentTarget
          const password = String(new FormData(form).get('password'))
          form.reset()
          void account(async () => {
            await engine.api.login(password)
            authChannel.current?.postMessage('changed')
            setSessionError('')
            await directory(engine)
            await engine.run(true)
          })
        }}>
          <h3>Household sign in</h3>
          <label>Password<input name="password" type="password" autoComplete="current-password" required /></label>
          <button type="submit">Sign in</button>
        </form>}
        {signedIn && <div className="actions">
          <button onClick={() => void action(() => directory(engine))}>Refresh People and Spaces</button>
          <button disabled={!online} onClick={() => void account(async () => {
            await engine.pause()
            await engine.api.logout()
            authChannel.current?.postMessage('changed')
          })}>Logout and pause sync</button>
        </div>}
        {!s?.enabled && signedIn && <section>
          <label>Personal Space<select aria-label="Personal Space" value={s?.spaceId ?? spaceId} onChange={e => setSpaceId(e.target.value)} disabled={Boolean(s?.spaceId)}><option value="">Choose a personal Space</option>{view?.spaces.filter(x => x.kind === 'personal' && !x.archived).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          {!s?.spaceId && <form onSubmit={e => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name')).trim(); void action(async () => {
            const intent = await store.creation('spaceCreation', name)
            // A lost create response is recovered by its persisted UUID, never by a new create.
            const existing = (await engine.api.directory('spaces')).find(x => x.id === intent.id)
            const created = existing ?? await engine.api.createSpace(intent.id, intent.name); await directory(engine); setSpaceId(created.id)
          }) }}><label>New personal Space name<input name="name" maxLength={100} required placeholder="My workouts" /></label><button>Create personal Space</button></form>}
          <label className="check"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />I downloaded and checked my backup. I consent to reconcile these confirmed records in this personal Space.</label>
          <button className="primary" disabled={!exportId || !verified || !(s?.spaceId ?? spaceId)} onClick={() => void action(async () => { const space = view!.spaces.find(x => x.id === (s?.spaceId ?? spaceId)); if (!space) throw new Error('Refresh and select a Space.'); await store.begin(space, engine.api.session!.principalId, exportId); await engine.run(true) })}>Connect and download for review</button>
        </section>}
        {s?.enabled && <div className="actions"><button onClick={() => void action(() => engine.pause())}>Disconnect / pause</button></div>}
        {s?.enabled && s.phase !== 'ready' && s.phase !== 'local' && <section id="sync-review" tabIndex={-1}><h3>{s.phase === 'recovery' ? 'Server restore recovery' : 'Review first connection'}</h3><p>The server snapshot is downloaded separately. Local history and pending changes remain intact. Reconciliation downloads remote-only records and lists divergent records for individual review. Missing local records are never silently deleted during recovery.</p><p>Downloaded: {view?.staged.filter(x => x.kind === 'plan').length ?? 0} plans, {view?.staged.filter(x => x.kind === 'session').length ?? 0} sessions, including {view?.staged.filter(x => x.deleted).length ?? 0} deletion markers. Compare these with the local counts above before continuing.</p><button disabled={!s.stageComplete} onClick={() => void action(async () => { await store.reconcile(); await engine.run(true) })}>{s.stageComplete ? 'Reconcile downloaded records' : 'Downloading server snapshot…'}</button></section>}
        <div id="sync-conflicts" tabIndex={-1}>{view?.conflicts.map(c => <section className="sync-conflict" key={c.id}>
          <h3>{conflictTitle(c)}</h3>
          <p>Choose which copy to keep. You can leave this decision for later while other records sync.</p>
          <div className="sync-comparison">
            <ConflictCopy title="This device" value={c.local} labels={c.people} people={view.people} />
            <ConflictCopy title="Server" value={c.current?.value ?? null} labels={c.current?.people ?? []} people={view.people} />
          </div>
          <details className="sync-comparison-details"><summary>Detailed comparison</summary>
            <p>{c.code} · Changed fields: {differences(c)}</p>
            <pre>{JSON.stringify({ local: { value: c.local, people: c.people }, server: c.current }, null, 2)}</pre>
          </details>
          <p>The selected copy replaces the other one, including a deletion. Both versions are preserved for download.</p>
          <div className="actions">
            <button onClick={() => requestConfirmation('Replace this local record with the displayed server version? A preserved copy remains exportable.', () => void action(() => store.resolve(c.id, c.generation, 'server')))}>Keep server version</button>
            <button onClick={() => requestConfirmation('Replace the server record with this local version, including restoring it if deleted? A preserved copy remains exportable.', () => void action(() => store.resolve(c.id, c.generation, 'local')))}>Keep local version</button>
          </div>
        </section>)}</div>
        <section><h3>People and record labels</h3><p>A Person is a label, not a login. Creating People requires an online signed-in connection. Existing associations, including multiple roles, are retained.</p>
          {signedIn && <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const name = String(new FormData(form).get('person')).trim(); void action(async () => { const intent = await store.creation('personCreation', name); const existing = (await engine.api.directory('people')).find(x => x.id === intent.id); if (!existing) await engine.api.createPerson(intent.id, intent.name); await directory(engine); await store.finishPersonCreation(intent.id); form.reset() }) }}><label>Person name<input name="person" required maxLength={100} /></label><button disabled={navigator.onLine === false}>Create Person (online)</button></form>}
          <ul>{view?.people.map(p => <li key={p.id}>{p.displayName}{p.archived ? ' (archived)' : ''}</li>)}</ul>
          <label>Saved record<select aria-label="Saved record" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a plan or saved session</option>{view?.plans.map(p => <option key={`plan:${p.id}`} value={`plan:${p.id}`}>Plan · {'name' in p ? p.name : p.id}</option>)}{view?.sessions.map(p => <option key={`session:${p.id}`} value={`session:${p.id}`}>Session · {'date' in p ? p.date : ''} · {p.id.slice(0, 8)}</option>)}</select></label>
          {target && <><ul>{people.map((p, i) => <li key={`${p.personId}:${p.role}`}>{view?.people.find(x => x.id === p.personId)?.displayName ?? p.personId} · {p.role} <button onClick={() => tags(people.filter((_, index) => index !== i))}>Remove association</button></li>)}</ul><label>Add Person as subject<select aria-label="Add Person as subject" value="" onChange={e => { if (!people.some(p => p.personId === e.target.value && p.role === 'subject')) tags([...people, { personId: e.target.value, role: 'subject' }]) }}><option value="">Choose Person</option>{view?.people.filter(p => !p.archived).map(p => <option value={p.id} key={p.id}>{p.displayName}</option>)}</select></label><button onClick={() => requestConfirmation('Delete this saved record locally and queue its deletion for the connected Space? A preserved copy remains exportable.', () => void action(async () => { await store.delete(target.kind, target.value.id); setSelected('') }))}>Delete selected record…</button></>}
        </section>
        {s && <details className="sync-diagnostics"><summary>Diagnostics</summary>
          <dl><dt>Pending edits</dt><dd>{pending}</dd><dt>Connection phase</dt><dd>{s.phase}</dd>
            <dt>Last successful exchange</dt><dd>{s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : 'Never'}</dd>
            <dt>Retry after</dt><dd>{s.nextRetry ? new Date(s.nextRetry).toLocaleString() : 'No delay'}</dd>
          </dl>
        </details>}
      </fieldset>
    </div>
  </details></>
}
