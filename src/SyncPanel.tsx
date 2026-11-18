import { useEffect, useMemo, useState } from 'react'
import { SyncEngine } from './sync-engine'
import { SyncStore, type Backup, type Conflict } from './sync-store'
import { same, type Association, type Kind } from './sync'

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
export function SyncPanel({ store }: { store: SyncStore }) {
  const engine = useMemo(() => new SyncEngine(store), [store])
  const [view, setView] = useState<Awaited<ReturnType<SyncStore['view']>>>()
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [signedIn, setSignedIn] = useState(false)
  const [spaceId, setSpaceId] = useState(''); const [exportId, setExportId] = useState(''); const [verified, setVerified] = useState(false)
  const [selected, setSelected] = useState(''); const [backups, setBackups] = useState<Backup[]>([])
  useEffect(() => {
    let active = true
    const refresh = () => { void store.view().then(v => { if (active) { setView(v); setSignedIn(Boolean(engine.api.session)) } }).catch(e => { if (active) setError((e as Error).message) }) }
    refresh(); const stop = engine.start()
    window.addEventListener('workout-storage', refresh); window.addEventListener('online', refresh); window.addEventListener('offline', refresh)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workout-storage'); if (channel) channel.onmessage = refresh
    return () => { active = false; stop(); window.removeEventListener('workout-storage', refresh); window.removeEventListener('online', refresh); window.removeEventListener('offline', refresh); channel?.close() }
  }, [store, engine])
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await work() } catch (e) { setError((e as Error).message) }
    finally { setBusy(false); setSignedIn(Boolean(engine.api.session)); try { setView(await store.view()) } catch { /* storage error already visible */ } }
  }
  async function directory() {
    const state = await store.settings()
    if (state.principalId && state.principalId !== engine.api.session?.principalId) throw new Error('Sign in as the owner already connected to this browser. Local records and pending edits are retained.')
    const people = await engine.api.directory('people'); const spaces = await engine.api.directory('spaces'); await store.cacheDirectory(people, spaces)
  }
  const s = view?.settings
  const status = !s?.enabled ? 'Local only' : s.phase === 'recovery' ? 'Recovery required' : s.phase === 'initial' ? 'Initial reconciliation' : view?.conflicts.length ? 'Conflict needs attention' : navigator.onLine === false ? 'Offline' : s.error ? s.error.includes('Authentication') ? 'Authentication expired' : 'Server error' : !signedIn ? 'Not signed in' : view?.pending.length ? 'Pending changes' : 'Synchronized'
  const target = view && [...view.plans.map(value => ({ kind: 'plan' as Kind, value })), ...view.sessions.map(value => ({ kind: 'session' as Kind, value }))].find(x => `${x.kind}:${x.value.id}` === selected)
  const meta = view?.metadata.find(m => m.id === selected)
  const people = meta?.people ?? []
  function tags(next: Association[]) { if (target) void action(() => store.tag(target.kind, target.value.id, next)) }
  return <details className="sync-panel"><summary>Settings / Synchronization · {status}{view?.pending.length ? ` · ${view.pending.length} pending` : ''}</summary>
    <div className="sync-content" aria-label="Synchronization settings">
      <p>Workouts remain usable offline. Connect to reconcile confirmed plans and saved sessions across devices. Recovery drafts are never uploaded. Conflicts may need review. Download and check a backup before connecting. Logout keeps local data and pending edits.</p>
      <p>{view?.plans.length ?? 0} plans · {view?.sessions.length ?? 0} saved sessions · {view?.conflicts.length ?? 0} conflicts</p>
      <p>Space: {view?.spaces.find(x => x.id === s?.spaceId)?.name ?? 'Not selected'} · {signedIn ? 'Signed in' : 'Not signed in'}<br />Last successful exchange: {s?.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : 'Never'}</p>
      {(error || s?.error) && <p className="sync-error" aria-live="polite">{error || s?.error}</p>}
      <fieldset disabled={busy}>
        <div className="actions"><button onClick={() => void action(async () => { const b = await store.export(localStorage.getItem('workout-companion-draft-v1')); download(b, `workout-backup-${b.id}.json`); setExportId(b.id); setVerified(false) })}>Download local backup</button><button onClick={() => void action(async () => setBackups(await store.backups()))}>Show preserved copies</button></div>
        {backups.map(b => <button key={b.id} onClick={() => download(b, `workout-preserved-${b.id}.json`)}>{b.reason} · {new Date(b.createdAt).toLocaleString()}</button>)}
        {!signedIn ? <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const data = new FormData(form); const username = String(data.get('username')); const password = String(data.get('password')); form.reset(); void action(async () => { await engine.api.login(username, password); await directory(); await engine.run(true) }) }}>
          <h3>Owner sign in</h3><label>Username<input name="username" autoComplete="username" required /></label><label>Password<input name="password" type="password" autoComplete="current-password" required /></label><button type="submit">Sign in</button><button type="button" onClick={() => void action(async () => { await engine.api.restore(); await directory(); await engine.run(true) })}>Restore signed-in session</button>
        </form> : <div className="actions"><button onClick={() => void action(directory)}>Refresh People and Spaces</button><button onClick={() => void action(async () => { await store.patch({ enabled: false }); await engine.api.logout() })}>Logout and pause sync</button></div>}
        {!s?.enabled && signedIn && <section>
          <label>Personal Space<select aria-label="Personal Space" value={s?.spaceId ?? spaceId} onChange={e => setSpaceId(e.target.value)} disabled={Boolean(s?.spaceId)}><option value="">Choose a personal Space</option>{view?.spaces.filter(x => x.kind === 'personal' && !x.archived).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
          {!s?.spaceId && <form onSubmit={e => { e.preventDefault(); const name = String(new FormData(e.currentTarget).get('name')).trim(); void action(async () => {
            const intent = await store.creation('spaceCreation', name)
            // A lost create response is recovered by its persisted UUID, never by a new create.
            const existing = (await engine.api.directory('spaces')).find(x => x.id === intent.id)
            const created = existing ?? await engine.api.createSpace(intent.id, intent.name); await directory(); setSpaceId(created.id)
          }) }}><label>New personal Space name<input name="name" maxLength={100} required placeholder="My workouts" /></label><button>Create personal Space</button></form>}
          <label className="check"><input type="checkbox" checked={verified} onChange={e => setVerified(e.target.checked)} />I downloaded and checked my backup. I consent to reconcile these confirmed records in this personal Space.</label>
          <button className="primary" disabled={!exportId || !verified || !(s?.spaceId ?? spaceId)} onClick={() => void action(async () => { const space = view!.spaces.find(x => x.id === (s?.spaceId ?? spaceId)); if (!space) throw new Error('Refresh and select a Space.'); await store.begin(space, engine.api.session!.principalId, exportId); await engine.run(true) })}>Connect and download for review</button>
        </section>}
        {s?.enabled && <div className="actions"><button onClick={() => void action(() => engine.run(true))}>Sync now / retry</button><button onClick={() => void action(() => engine.pause())}>Disconnect / pause</button></div>}
        {s?.enabled && s.phase !== 'ready' && s.phase !== 'local' && <section><h3>{s.phase === 'recovery' ? 'Server restore recovery' : 'Review first connection'}</h3><p>The server snapshot is downloaded separately. Local history and pending changes remain intact. Reconciliation downloads remote-only records and lists divergent records for individual review. Missing local records are never silently deleted during recovery.</p><p>Downloaded: {view?.staged.filter(x => x.kind === 'plan').length ?? 0} plans, {view?.staged.filter(x => x.kind === 'session').length ?? 0} sessions, including {view?.staged.filter(x => x.deleted).length ?? 0} deletion markers. Compare these with the local counts above before continuing.</p><button disabled={!s.stageComplete} onClick={() => void action(async () => { await store.reconcile(); await engine.run(true) })}>{s.stageComplete ? 'Reconcile downloaded records' : 'Downloading server snapshot…'}</button></section>}
        {view?.conflicts.map(c => <section className="sync-conflict" key={c.id}><h3>{conflictTitle(c)}</h3><p>{c.code} · Changed fields: {differences(c)}</p><p>Server device: {c.current?.deviceId ?? 'No server record'}. Your pending edits are retained on this device.</p><div className="sync-comparison"><details><summary>Local version</summary><pre>{JSON.stringify({ value: c.local, people: c.people }, null, 2)}</pre></details><details><summary>Server version</summary><pre>{JSON.stringify(c.current, null, 2)}</pre></details></div><p>Keeping the server version replaces this local record (or removes it if absent/deleted). Keeping local submits a new edit against the displayed server revision, explicitly restoring a server-deleted record. Both versions are preserved in downloadable copies.</p><div className="actions"><button onClick={() => { if (window.confirm('Replace this local record with the displayed server version? A preserved copy remains exportable.')) void action(() => store.resolve(c.id, c.generation, 'server')) }}>Keep server version</button><button onClick={() => { if (window.confirm('Keep your local record and overwrite the displayed server revision, including explicit resurrection if deleted?')) void action(() => store.resolve(c.id, c.generation, 'local')) }}>Keep local version</button></div><p>To revisit later, leave this comparison unresolved. Other records can still sync.</p></section>)}
        <section><h3>People and record labels</h3><p>A Person is a label, not a login. Creating People requires an online signed-in connection. Existing associations, including multiple roles, are retained.</p>
          {signedIn && <form onSubmit={e => { e.preventDefault(); const form = e.currentTarget; const name = String(new FormData(form).get('person')).trim(); void action(async () => { const intent = await store.creation('personCreation', name); const existing = (await engine.api.directory('people')).find(x => x.id === intent.id); if (!existing) await engine.api.createPerson(intent.id, intent.name); await directory(); await store.finishPersonCreation(intent.id); form.reset() }) }}><label>Person name<input name="person" required maxLength={100} /></label><button disabled={navigator.onLine === false}>Create Person (online)</button></form>}
          <ul>{view?.people.map(p => <li key={p.id}>{p.displayName}{p.archived ? ' (archived)' : ''}</li>)}</ul>
          <label>Saved record<select aria-label="Saved record" value={selected} onChange={e => setSelected(e.target.value)}><option value="">Choose a plan or saved session</option>{view?.plans.map(p => <option key={`plan:${p.id}`} value={`plan:${p.id}`}>Plan · {'name' in p ? p.name : p.id}</option>)}{view?.sessions.map(p => <option key={`session:${p.id}`} value={`session:${p.id}`}>Session · {'date' in p ? p.date : ''} · {p.id.slice(0, 8)}</option>)}</select></label>
          {target && <><ul>{people.map((p, i) => <li key={`${p.personId}:${p.role}`}>{view?.people.find(x => x.id === p.personId)?.displayName ?? p.personId} · {p.role} <button onClick={() => tags(people.filter((_, index) => index !== i))}>Remove association</button></li>)}</ul><label>Add Person as subject<select aria-label="Add Person as subject" value="" onChange={e => { if (!people.some(p => p.personId === e.target.value && p.role === 'subject')) tags([...people, { personId: e.target.value, role: 'subject' }]) }}><option value="">Choose Person</option>{view?.people.filter(p => !p.archived).map(p => <option value={p.id} key={p.id}>{p.displayName}</option>)}</select></label><button onClick={() => { if (window.confirm('Delete this saved record locally and queue its deletion for the connected Space? A preserved copy remains exportable.')) void action(async () => { await store.delete(target.kind, target.value.id); setSelected('') }) }}>Delete selected record…</button></>}
        </section>
      </fieldset>
    </div>
  </details>
}
