import { useEffect, useMemo, useRef, useState } from 'react'
import { SessionStore } from './storage'
import { demoPlan, formatSet, plannedSets, validateSession, type Exercise, type Session, type Plan } from './workouts'
import { draftKey, getGuide, guideSteps, readActual, recordSet, recoverLegacyDraft, setActual, startGuidedWorkout, type ResultCorrection, type WorkoutDraft } from './guided-workout'
import { GuidedWorkout } from './GuidedWorkout'
import { DayWorkoutEditor } from './DayWorkoutEditor'
import { RecordedResultsEditor } from './RecordedResultsEditor'
import { PwaStatus } from './PwaStatus'
import { SyncPanel } from './SyncPanel'
import { SyncStore } from './sync-store'
import { same } from './sync'
import './App.css'

const defaultStore = new SessionStore()
const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
function dayFor(weekday = 1) {
  return days[(weekday + 6) % 7]
}

function exportDay(session: Session, plan?: Plan) {
  // Legacy sessions have no scheduled-day snapshot. Use the linked plan if available.
  return dayFor(session.planWeekday ?? plan?.weekday ?? new Date(`${session.date}T12:00:00Z`).getUTCDay())
}
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
type Editor = { kind: 'plan'; plan: Plan } | { kind: 'results'; session: Session }

function readRecovery(): { draft?: WorkoutDraft; error: string } {
  try {
    const raw = localStorage.getItem(draftKey)
    if (!raw) return { error: '' }
    const data = JSON.parse(raw)
    const legacy = !('session' in data)
    const draft: WorkoutDraft = legacy ? { session: data } : data
    validateSession(draft.session)
    if (legacy) draft.session = recoverLegacyDraft(draft.session)
    const fields = draft.fields
    if (fields !== undefined && (!fields || typeof fields !== 'object' || Array.isArray(fields)
      || Object.values(fields).some(value => typeof value !== 'string')
      || !guideSteps(getGuide(draft.session))[getGuide(draft.session).cursor])) throw new Error('Invalid set editor.')
    return { draft, error: '' }
  } catch {
    return { error: 'Draft recovery unavailable. Existing draft data was retained.' }
  }
}

function committedDraft(draft: WorkoutDraft, rows: Session[]) {
  // A save may commit immediately before a reload or a failed draft cleanup.
  return rows.find(saved => saved.id === draft.session.id && !draft.fields
    && saved.revision === draft.session.revision + 1
    && same(saved, { ...draft.session, status: saved.status, revision: saved.revision }))
}

function App({ store = defaultStore }: { store?: SessionStore }) {
  const syncStore = useMemo(() => new SyncStore(store.open), [store])
  const [initialRecovery] = useState(readRecovery)
  const [recoveryError, setRecoveryError] = useState(initialRecovery.error)
  const [date, setDate] = useState(() => initialRecovery.draft?.session.date ?? today())
  const [day, setDay] = useState('Mon')
  const [records, setRecords] = useState<Session[]>([])
  const [plans, setPlans] = useState<Plan[]>([demoPlan])
  const [planId, setPlanId] = useState(demoPlan.id)
  const [draft, setDraft] = useState<WorkoutDraft | undefined>(initialRecovery.draft)
  const [message, setMessage] = useState(initialRecovery.draft ? 'Recovered draft on this device.' : '')
  const [error, setError] = useState(initialRecovery.error)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [dirty, setDirty] = useState(Boolean(initialRecovery.draft))
  const [editor, setEditor] = useState<Editor>()
  const [editorDirty, setEditorDirty] = useState(false)
  const saving = useRef(false)
  const session = draft?.session

  function restore(recovered: WorkoutDraft, rows: Session[], savedPlans: Plan[]) {
    const saved = committedDraft(recovered, rows)
    const restored = saved ?? recovered.session
    setDraft(saved ? { session: saved } : recovered)
    setDate(restored.date)
    setPlanId(restored.planId)
    setDay(dayFor(savedPlans.find(plan => plan.id === restored.planId)?.weekday))
    setDirty(!saved)
    setMessage(saved ? 'Reopened saved workout.' : 'Recovered draft on this device.')
    if (saved) {
      try { localStorage.removeItem(draftKey) }
      catch { setError('The saved workout is available. The recovery draft could not be cleared.') }
    }
  }

  useEffect(() => {
    let active = true
    const refreshSaved = () => { void store.list().then(rows => {
      if (!active) return
      setRecords(rows)
      void store.plans().then(p => { if (active) setPlans(p) }).catch(() => {})
      if (!dirty && !busy) setDraft(current => {
        const saved = current && rows.find(row => row.id === current.session.id)
        return saved ? { session: saved } : undefined
      })
    }).catch(() => {}) }
    window.addEventListener('workout-storage', refreshSaved)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workout-storage')
    if (channel) channel.onmessage = refreshSaved
    return () => { active = false; channel?.close(); window.removeEventListener('workout-storage', refreshSaved) }
  }, [store, dirty, busy])

  useEffect(() => {
    if (!dirty && !editorDirty) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty, editorDirty])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        await store.ensurePlan(demoPlan)
        const [rows, savedPlans] = await Promise.all([store.list(), store.plans()])
        if (active) {
          setRecords(rows)
          setPlans(savedPlans)
          const recovered = initialRecovery.draft
          if (recovered) restore(recovered, rows, savedPlans)
        }
      } catch (error) {
        if (active) setError(`Storage unavailable: ${(error as Error).message} Retry when ready.`)
      } finally { if (active) setLoading(false) }
    })()
    return () => { active = false }
  }, [store, initialRecovery])

  function keepDraft(next: WorkoutDraft) {
    setDraft(next)
    setDirty(true)
    setError('')
    try {
      localStorage.setItem(draftKey, JSON.stringify(next))
      setMessage('Progress kept on this device as a draft.')
    } catch {
      setMessage('Unsaved changes')
      setError('Draft storage failed. Keep this page open and save before leaving.')
    }
  }

  async function refresh() {
    setBusy(true)
    try {
      await store.ensurePlan(demoPlan)
      const [rows, savedPlans] = await Promise.all([store.list(), store.plans()])
      setRecords(rows)
      setPlans(savedPlans)
      const next = readRecovery()
      setRecoveryError(next.error)
      setError(next.error)
      if (next.draft && !session) restore(next.draft, rows, savedPlans)
    } catch (error) {
      setError(`Storage unavailable: ${(error as Error).message} Your current edits remain on screen.`)
    } finally { setBusy(false) }
  }

  async function persist(complete: boolean) {
    if (!draft || saving.current) return
    let prepared = draft.session
    try {
      if (draft.fields) {
        const guide = getGuide(prepared)
        const current = guideSteps(guide)[guide.cursor]
        prepared = recordSet(prepared, readActual(setActual(current) ?? current.target, draft.fields), false)
      }
    } catch (error) { setError((error as Error).message); return }
    if (!window.confirm(complete ? 'Finish and save this workout?' : 'Save this session on this device?')) return
    if (prepared !== draft.session) keepDraft({ session: prepared })
    saving.current = true
    setBusy(true)
    setError('')
    setMessage('Saving…')
    try {
      const saved = await (complete ? store.complete(prepared) : store.save(prepared))
      setDraft({ session: saved })
      setDirty(false)
      setRecords(rows => [saved, ...rows.filter(row => row.id !== saved.id)].sort((a, b) => b.date.localeCompare(a.date)))
      setMessage(complete ? 'Saved and completed on this device.' : 'Saved on this device.')
      try { localStorage.removeItem(draftKey) }
      catch { setError('History saved. The recovery draft could not be cleared.') }
    } catch (error) {
      setMessage('Save failed. Your progress is still open.')
      setError(`Save failed: ${(error as Error).message}`)
    } finally { saving.current = false; setBusy(false) }
  }

  function reopen(saved: Session) {
    setDraft({ session: saved })
    setPlanId(saved.planId)
    setDay(dayFor(plans.find(plan => plan.id === saved.planId)?.weekday))
    setMessage('Reopened saved session.')
    setError('')
  }

  function discard() {
    if (!window.confirm('Discard unsaved changes? Saved history will be retained.')) return
    try {
      localStorage.removeItem(draftKey)
      setDraft(undefined)
      setDirty(false)
      setMessage('Unsaved changes discarded.')
      setError('')
    } catch { setError('Could not clear the recovery draft. Your edits remain here.') }
  }

  function openEditor(next: Editor) {
    setEditor(next)
    setError('')
    setMessage('')
  }

  function closeEditor() {
    setEditor(undefined)
    setEditorDirty(false)
    setError('')
  }

  async function saveEditor(write: () => Promise<void>) {
    if (saving.current) return
    saving.current = true
    setBusy(true)
    setError('')
    try {
      await write()
      closeEditor()
    } catch (error) { setError((error as Error).message) }
    finally { saving.current = false; setBusy(false) }
  }

  function savePlan(original: Plan, exercises: Exercise[]) {
    void saveEditor(async () => {
      const saved = await store.savePlan(original, exercises)
      setPlans(plans => plans.map(plan => plan.id === saved.id ? saved : plan))
      setMessage('Workout plan saved.')
    })
  }

  function saveCorrections(original: Session, corrections: ResultCorrection[]) {
    if (!corrections.length) { closeEditor(); return }
    if (!window.confirm('Save corrections to this completed workout?')) return
    void saveEditor(async () => {
      const saved = await store.correctResults(original, corrections)
      setDraft({ session: saved })
      setRecords(rows => rows.map(row => row.id === saved.id ? saved : row))
      setMessage('Recorded results corrected.')
    })
  }

  const editorActions = {
    busy, error, onError: setError,
    onChange: () => { setEditorDirty(true); setError('') },
    onCancel: () => { if (!editorDirty || window.confirm('Discard unsaved editor changes?')) closeEditor() },
  }

  const plan = plans.find(p => p.id === planId) ?? plans[0]
  const sessionPlan = session && plans.find(p => p.id === session.planId)
  const availableDay = dayFor((session ? sessionPlan : plan)?.weekday)
  const showSession = Boolean(!editor && draft && (!loading || dirty) && (day === availableDay || loading))
  const available = plan && day === dayFor(plan.weekday)
  const hasSets = plan?.exercises.some(exercise => plannedSets(exercise).length)
  const active = plan && records.find(row => row.planId === plan.id && row.demo === plan.demo && row.date === date && row.status === 'active')
  const previous = session && records.find(row => row.planId === session.planId && row.demo === session.demo && row.date < session.date && row.status === 'completed')
  const week = <nav className="week" aria-label="Weekly day selector">{days.map(d => <button key={d} disabled={busy} aria-pressed={day === d} onClick={() => setDay(d)}>{d}<small>{d === availableDay ? 'Strength' : 'No plan'}</small></button>)}</nav>
  const status = <p role="status" aria-live="polite">{message || 'Confirm a save to add your workout to local history.'}</p>

  return <main className={showSession ? 'runner runner-active' : 'runner'}>
    <header className="app-header">
      <div><p className="eyebrow">WORKOUT COMPANION / LOCAL TRAINING LOG</p><h1>One set at a time.</h1>{!showSession && <p>Your plan, your last lift, your next set.</p>}</div>
      <SyncPanel store={syncStore} />
    </header>
    <PwaStatus canReload={!dirty && !editorDirty && !busy && !loading && !recoveryError} />
    {!showSession && (session?.demo ?? plan?.demo) && <aside className="demo"><strong>DEMO workspace</strong><span>Practice sessions use sample data. You can choose any workout date.</span></aside>}
    {!showSession && !editor && week}
    <div className="workspace">
      <section aria-label={editor ? 'Workout editor' : showSession ? 'Current session' : 'Workout plan'}>
        {editor?.kind === 'plan' ? <DayWorkoutEditor {...editorActions} plan={editor.plan} weekday={dayFor(editor.plan.weekday)}
          onSave={exercises => savePlan(editor.plan, exercises)} />
          : editor?.kind === 'results' ? <RecordedResultsEditor {...editorActions} session={editor.session}
            onSave={corrections => saveCorrections(editor.session, corrections)} />
          : showSession && draft ? <>
          <GuidedWorkout key={draft.session.id} draft={draft} day={exportDay(draft.session, sessionPlan)} previous={previous} busy={busy || loading} error={error}
            onChange={keepDraft} onError={setError} onFinish={() => void persist(true)} />
          <div className="actions session-actions">
            {draft.session.status === 'active' && <button disabled={busy || loading} onClick={() => void persist(false)}>Save session</button>}
            {draft.session.status === 'completed' && <button disabled={busy || dirty || loading} onClick={() => openEditor({ kind: 'results', session: draft.session })}>Correct recorded results</button>}
            {dirty ? <button disabled={busy || loading} onClick={discard}>Discard unsaved changes</button>
              : <button disabled={busy} onClick={() => { setDraft(undefined); setMessage(''); setError('') }}>Back to plan</button>}
          </div>
          <div className="session-status">{status}</div>
        </> : <>
          <div className="plan-heading">
            <div><p className="eyebrow">{day.toUpperCase()} / {available ? 'WORKOUT PLAN' : 'UNSCHEDULED'}</p>
              <h2>{available ? plan.name : 'No workout planned'}</h2></div>
            <label>Workout date<input type="date" value={date} disabled={dirty || busy} onChange={e => { setDate(e.target.value); setDraft(undefined); setMessage('') }} /></label>
          </div>
          {plans.length > 1 && <label className="plan-picker">Saved plan<select value={plan?.id} disabled={dirty || busy} onChange={e => {
            setPlanId(e.target.value); setDraft(undefined); setDay(dayFor(plans.find(p => p.id === e.target.value)?.weekday)); setMessage('')
          }}>{plans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          {!draft && available && <div className="actions plan-actions">
            {(active || hasSets) && <button className="primary" disabled={!date || busy || loading || Boolean(recoveryError)} onClick={() => {
              if (active) reopen(active)
              else {
                try {
                  const next = startGuidedWorkout(plan, date)
                  validateSession(next)
                  keepDraft({ session: next })
                } catch (error) { setError((error as Error).message) }
              }
            }}>{active ? 'Resume Workout' : 'Start Workout'}</button>}
            <button disabled={busy || loading} onClick={() => openEditor({ kind: 'plan', plan })}>Edit Day's Workout</button>
          </div>}
          {available && (hasSets ? <ul className="plan-preview">{plan.exercises.filter(exercise => plannedSets(exercise).length).map((exercise, index) => <li key={index}>
            <strong>{exercise.name}</strong><span>{plannedSets(exercise).map(formatSet).join(' · ')}</span>
          </li>)}</ul> : <p>This plan has no sets.</p>)}
        </>}
      </section>
      <aside className="history" aria-label="Saved sessions">
        <h2>On this device</h2><p>Saved workouts · {date}</p>
        {records.filter(row => row.date === date).length === 0 && <p>No saved sessions for this date.</p>}
        {records.filter(row => row.date === date).map(row => <button key={row.id} disabled={busy || dirty || loading || Boolean(editor) || (row.status === 'active' && Boolean(recoveryError))} onClick={() => reopen(row)}>
          {row.demo ? 'DEMO ' : ''}{row.date} · {row.status}<small>Open saved workout · {row.id.slice(0, 8)}</small>
        </button>)}
        {dirty && <p>Save your draft before opening another workout.</p>}
        <button disabled={busy || loading || Boolean(editor)} onClick={() => void refresh()}>Retry storage / refresh history</button>
      </aside>
    </div>
    {showSession && week}
    {!showSession && !editor && <footer className="save-status">{status}{error && <p role="alert">{error}</p>}</footer>}
  </main>
}
export default App
