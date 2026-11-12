import { useEffect, useState } from 'react'
import { SessionStore } from './storage'
import { createSession, demoPlan, formatSet, updateSet, validateSession, type Session, type Performance } from './workouts'
import './App.css'

const defaultStore = new SessionStore()
const draftKey = 'workout-companion-draft-v1'
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function App({ store = defaultStore }: { store?: SessionStore }) {
  const [recovery] = useState(() => {
    try {
      const raw = localStorage.getItem(draftKey)
      if (!raw) return { draft: undefined, error: '' }
      const draft = JSON.parse(raw) as Session
      validateSession(draft)
      return { draft, error: '' }
    } catch { return { draft: undefined, error: 'Draft recovery unavailable. Existing draft data was retained; keep this page open until you save.' } }
  })
  const [date, setDate] = useState(() => recovery.draft?.date ?? today())
  const [day, setDay] = useState('Mon')
  const [records, setRecords] = useState<Session[]>([])
  const [session, setSession] = useState<Session | undefined>(recovery.draft)
  const [message, setMessage] = useState(recovery.draft ? 'Recovered draft — save to confirm it in workout history.' : '')
  const [error, setError] = useState(recovery.error)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(Boolean(recovery.draft))
  useEffect(() => {
    if (!dirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
  useEffect(() => {
    let active = true
    void (async () => {
      try { await store.ensurePlan(demoPlan); const rows = await store.list(); if (active) setRecords(rows) }
      catch (e) { if (active) setError(`Storage unavailable: ${(e as Error).message} Nothing was saved to history. Retry when ready.`) }
      finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [store])

  function keepDraft(next: Session) {
    setSession(next); setDirty(true); setError('')
    try { localStorage.setItem(draftKey, JSON.stringify(next)); setMessage('Draft retained on this device — not yet saved to history.') }
    catch { setMessage('Unsaved changes'); setError('Draft storage failed. Keep this page open and save to history before leaving.') }
  }
  function edit(id: string, index: number, value: Performance) {
    try { keepDraft(updateSet(session!, id, index, value)) }
    catch (e) { setError((e as Error).message) }
  }
  async function refresh() {
    setBusy(true)
    try { await store.ensurePlan(demoPlan); setRecords(await store.list()); setError('') }
    catch (e) { setError(`Storage unavailable: ${(e as Error).message} Your current edits remain on screen.`) }
    finally { setBusy(false) }
  }
  async function persist(complete: boolean) {
    if (!session || !window.confirm(complete ? 'Save and complete this session? Completed history is read-only.' : 'Save this session on this device?')) return
    setBusy(true); setError(''); setMessage('Saving…')
    try {
      const saved = await (complete ? store.complete(session) : store.save(session))
      setSession(saved); setDirty(false)
      setRecords(rows => [saved, ...rows.filter(row => row.id !== saved.id)].sort((a, b) => b.date.localeCompare(a.date)))
      setMessage(complete ? 'Saved and completed on this device.' : 'Saved on this device.')
      try { localStorage.removeItem(draftKey) }
      catch { setError('History saved, but the recovery draft could not be cleared. A reload may recover an older draft; reopen saved history instead.') }
    } catch (e) { setMessage('Unsaved changes'); setError(`Save failed: ${(e as Error).message} Your edits remain here. Retry saving before closing.`) }
    finally { setBusy(false) }
  }
  const previous = session && records.filter(row => row.planId === session.planId && row.demo === session.demo && row.date < session.date && row.status === 'completed').sort((a, b) => b.date.localeCompare(a.date))[0]
  const active = records.find(row => row.planId === demoPlan.id && row.date === date && row.status === 'active')
  const exercises = session?.exercises ?? demoPlan.exercises
  const finished = session?.status === 'completed'

  return <main className="runner">
    <header><p className="eyebrow">WORKOUT COMPANION / LOCAL TRAINING LOG</p><h1>One set at a time.</h1><p>Your plan, your last lift, your next set.</p></header>
    <aside className="demo"><strong>DEMO workspace</strong><span>Sample plan only. These practice sessions are not imported workout history. Monday is the only available plan; you can practice it on any date.</span></aside>
    <nav className="week" aria-label="Weekly day selector">{days.map(d => <button key={d} aria-pressed={day === d} onClick={() => setDay(d)}>{d}<small>{d === 'Mon' ? 'Strength' : 'No plan'}</small></button>)}</nav>
    <div className="workspace">
      <section aria-label="Workout plan">
        <div className="plan-heading"><div><p className="eyebrow">{day === 'Mon' ? 'MONDAY / DEMO PLAN' : `${day.toUpperCase()} / UNSCHEDULED`}</p><h2>{day === 'Mon' ? 'Strength, steadily.' : 'No workout planned'}</h2></div><label>Workout date<input type="date" value={date} disabled={dirty || busy} onChange={e => { setDate(e.target.value); setSession(undefined); setMessage('') }} /></label></div>
        {day !== 'Mon' ? <p className="empty">There’s no plan for this day yet. Your Monday session stays intact when you switch days.</p> : <>
          {!session && <button className="primary" disabled={!date || busy || loading || Boolean(recovery.error)} onClick={() => { if (active) { setSession(structuredClone(active)); setMessage('Reopened saved session.') } else { try { keepDraft(createSession(demoPlan, date)) } catch (e) { setError((e as Error).message) } } }}>{active ? 'Resume Workout' : 'Start Workout'}</button>}
          <p className="measurement-note">Dumbbell loads are pounds as logged. The sample source does not specify per-hand or combined weight. Machine settings (P9, P10…) are positions, not pounds.</p>
          {session && <section className="session-heading" aria-label="Current session"><h3>{finished ? 'Workout finished' : 'Current workout'} · {session.date}</h3><p>{finished ? `${exercises.length} exercises · ${exercises.reduce((sum, e) => sum + e.sets.length, 0)} sets recorded. Saved on this device. Completed history is read-only.` : 'Edit each set to record what you actually did. Save when you’re ready.'}</p></section>}
          {exercises.map((exercise, number) => <article className="exercise" key={exercise.id}>
            <div className="exercise-title"><span className="number">{String(number + 1).padStart(2, '0')}</span><h3>{exercise.name}</h3><span>{exercise.sets.length} sets</span></div>
            <div className="previous"><strong>Previous completed {session?.demo ? 'DEMO ' : ''}</strong><span>{previous ? `${previous.date}: ${previous.exercises.find(e => e.id === exercise.id)?.sets.map(formatSet).join(' | ') ?? 'Exercise not recorded'}` : 'No earlier completed workout. Plan values below are samples.'}</span></div>
            <p className="notation"><strong>{session ? 'Current' : 'Plan'}</strong> {exercise.sets.map(formatSet).join(' | ')}</p>
            {session && <fieldset disabled={busy || finished} onFocusCapture={event => { if (event.target instanceof HTMLInputElement) event.target.select() }}><legend className="sr-only">{exercise.name} current sets</legend>{exercise.sets.map((set, i) => <div className="set" key={i}><span className="set-number">Set {i + 1}</span>
              {set.kind === 'weight' && <label>Dumbbell weight (lb)<input aria-label={`${exercise.name} set ${i + 1} pounds`} type="number" inputMode="decimal" min="0" step="any" value={set.pounds} onChange={e => edit(exercise.id, i, { ...set, pounds: e.target.valueAsNumber })} /></label>}
              {set.kind === 'machine' && <label>Machine setting<input aria-label={`${exercise.name} set ${i + 1} machine position`} value={set.position} onChange={e => edit(exercise.id, i, { ...set, position: e.target.value })} /></label>}
              {set.kind === 'hold' ? <label>Duration (seconds)<input aria-label={`${exercise.name} set ${i + 1} seconds`} type="number" min="0" step="any" value={set.seconds} onChange={e => edit(exercise.id, i, { ...set, seconds: e.target.valueAsNumber })} /></label> : <label>Repetitions<input aria-label={`${exercise.name} set ${i + 1} reps`} type="number" inputMode="numeric" min="0" step="1" value={set.reps} onChange={e => edit(exercise.id, i, { ...set, reps: e.target.valueAsNumber })} /></label>}
            </div>)}</fieldset>}
          </article>)}
          {session && !finished && <div className="actions"><button disabled={busy} onClick={() => void persist(false)}>Save session</button><button className="primary" disabled={busy} onClick={() => void persist(true)}>Save and complete</button>{dirty && <button disabled={busy} onClick={() => {
            if (!window.confirm('Discard unsaved changes? Saved history will be retained.')) return
            try { localStorage.removeItem(draftKey); setSession(undefined); setDirty(false); setMessage('Unsaved changes discarded.'); setError('') }
            catch { setError('Could not clear the recovery draft. Your edits remain here.') }
          }}>Discard unsaved changes</button>}</div>}
        </>}
      </section>
      <aside className="history" aria-label="Saved sessions"><h2>On this device</h2><p>Saved workouts · {date}</p>{records.filter(s => s.date === date).length === 0 && <p>No saved sessions for this date.</p>}{records.filter(s => s.date === date).map(row => <button key={row.id} disabled={busy || dirty} onClick={() => { setSession(structuredClone(row)); setDay('Mon'); setMessage('Reopened saved session.'); setError('') }}>{row.demo ? 'DEMO ' : ''}{row.date} · {row.status}<small>Open saved workout · {row.id.slice(0, 8)}</small></button>)}<p>Save your draft before changing dates or opening another workout.</p><button disabled={busy} onClick={() => void refresh()}>Retry storage / refresh history</button></aside>
    </div>
    <footer className="save-status"><p role="status" aria-live="polite">{message || 'Ready when you are. Workouts are stored only in this browser.'}</p>{error && <p role="alert">{error}</p>}</footer>
  </main>
}
export default App
