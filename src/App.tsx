import { useEffect, useState } from 'react'
import { SessionStore } from './storage'
import { createSession, demoPlan, formatSet, updateSet, type Session, type Performance } from './workouts'
import './App.css'
const defaultStore = new SessionStore()
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
function App({ store = defaultStore }: { store?: SessionStore }) {
  const [date, setDate] = useState(today)
  const [records, setRecords] = useState<Session[]>([])
  const [session, setSession] = useState<Session>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  async function load() {
    setError('')
    try { await store.ensurePlan(demoPlan); setRecords(await store.list()) }
    catch (e) { setError(`Storage unavailable: ${(e as Error).message} Your edits remain on screen. Retry storage when ready.`) }
  }
  useEffect(() => { let active = true; void (async () => { try { await store.ensurePlan(demoPlan); const rows = await store.list(); if (active) setRecords(rows) } catch (e) { if (active) setError(`Storage unavailable: ${(e as Error).message} Nothing was saved.`) } })(); return () => { active = false } }, [store])
  function edit(id: string, index: number, value: Performance) {
    try { setSession(updateSet(session!, id, index, value)); setDirty(true); setMessage('Unsaved changes'); setError('') } catch (e) { setError((e as Error).message) }
  }
  async function persist(complete: boolean) {
    if (!session || !window.confirm(complete ? 'Save and complete this session? Completed history is read-only.' : 'Save this session on this device?')) return
    setBusy(true); setError('')
    try { const saved = await (complete ? store.complete(session) : store.save(session)); setSession(saved); setDirty(false); setMessage(complete ? 'Saved and completed on this device.' : 'Saved on this device.'); await load() }
    catch (e) { setError(`Save failed: ${(e as Error).message} Do not close this page; your changes have not been confirmed saved.`) }
    finally { setBusy(false) }
  }
  const previous = session && records.find(row => row.planId === session.planId && row.date < session.date && row.status === 'completed')
  return <main className="welcome">
    <h1>Workout Companion</h1><p>Your personal workout tracker.</p>
    <h2>DEMO Monday</h2><p>Sample training data only — not imported workout history. Practice on any date. Weights are pounds; P9 is a machine position.</p>
    <label>Workout date <input type="date" value={date} disabled={dirty || busy} onChange={e => setDate(e.target.value)} /></label>
    <button disabled={!date || dirty || busy} onClick={() => { try { setSession(createSession(demoPlan, date)); setDirty(true); setMessage('New DEMO session — unsaved'); setError('') } catch (e) { setError((e as Error).message) } }}>Start DEMO session</button>
    {error && <p role="alert">{error}</p>}<button disabled={busy} onClick={() => void load()}>Retry storage / refresh history</button>
    <p role="status">{message}</p>
    {session && <section aria-label="Current session"><h2>{session.demo ? 'DEMO ' : ''}{session.date} · {session.status}</h2>
      {session.exercises.map(exercise => <fieldset key={exercise.id} disabled={busy || session.status === 'completed'}><legend>{exercise.name}</legend>
        <p>Previous completed: {previous?.exercises.find(e => e.id === exercise.id)?.sets.map(formatSet).join(' | ') ?? 'No earlier completed session'}</p>
        {exercise.sets.map((set, i) => <div className="set" key={i}><span>Set {i + 1}</span>
          {set.kind === 'weight' && <label>Pounds<input aria-label={`${exercise.name} set ${i + 1} pounds`} type="number" min="0" step="any" value={set.pounds} onChange={e => edit(exercise.id, i, { ...set, pounds: e.target.valueAsNumber })} /></label>}
          {set.kind === 'machine' && <label>Machine position<input aria-label={`${exercise.name} set ${i + 1} machine position`} value={set.position} onChange={e => edit(exercise.id, i, { ...set, position: e.target.value })} /></label>}
          {set.kind === 'hold' ? <label>Seconds<input type="number" min="0" value={set.seconds} onChange={e => edit(exercise.id, i, { ...set, seconds: e.target.valueAsNumber })} /></label> : <label>Reps<input aria-label={`${exercise.name} set ${i + 1} reps`} type="number" min="0" step="1" value={set.reps} onChange={e => edit(exercise.id, i, { ...set, reps: e.target.valueAsNumber })} /></label>}
        </div>)}
      </fieldset>)}
      <button disabled={busy || session.status === 'completed'} onClick={() => void persist(false)}>Save session</button><button disabled={busy || session.status === 'completed'} onClick={() => void persist(true)}>Save and complete</button>
      {dirty && <button disabled={busy} onClick={() => { if (window.confirm('Discard unsaved changes?')) { setSession(undefined); setDirty(false); setMessage('Unsaved changes discarded.') } }}>Discard unsaved changes</button>}
    </section>}
    <section aria-label="Saved sessions"><h2>Saved sessions for {date}</h2>{records.filter(s => s.date === date).length === 0 && <p>No saved sessions for this date.</p>}{records.filter(s => s.date === date).map(row => <p key={row.id}><button disabled={busy || dirty} onClick={() => { setSession(structuredClone(row)); setMessage('Reopened saved session.'); setError('') }}>{row.demo ? 'DEMO ' : ''}{row.date} · {row.status} · {row.id.slice(0, 8)}</button></p>)}</section>
  </main>
}
export default App
