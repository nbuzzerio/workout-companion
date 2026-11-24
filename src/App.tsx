import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { SessionStore } from './storage'
import { assertDate, demoPlan, formatSet, isStandardPerformance, plannedSets, sessionWeekday, validateSession, type PlanExercise, type Session, type Plan } from './workouts'
import { draftKey, getGuide, guideSteps, readActual, recordSet, recoverLegacyDraft, setActual, startGuidedWorkout, type ResultCorrection, type WorkoutDraft } from './guided-workout'
import { GuidedWorkout } from './GuidedWorkout'
import { DayWorkoutEditor } from './DayWorkoutEditor'
import { GoogleSheetsImport } from './GoogleSheetsImport'
import type { SheetsExercise } from './sheets-import'
import { RecordedResultsEditor } from './RecordedResultsEditor'
import { PwaStatus } from './PwaStatus'
import { SyncPanel } from './SyncPanel'
import { AppearanceSetting } from './AppearanceSetting'
import { ConfirmationDialog, type RequestConfirmation } from './ConfirmationDialog'
import { SyncStore } from './sync-store'
import { same } from './sync'
import './App.css'

const defaultStore = new SessionStore()
const weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const days = weekdays.map(day => day.slice(0, 3))
function dayFor(weekday = 1) {
  return days[(weekday + 6) % 7]
}

const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
type ImportDestination = { date: string; weekday: Plan['weekday']; previous?: Plan }
type Editor = { kind: 'plan'; plan: Plan } | { kind: 'results'; session: Session }
  | ({ kind: 'sheets' } & ImportDestination) | { kind: 'import'; plan: Plan; previous?: Plan }

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
  const [confirmation, setConfirmation] = useState<{ message: string; onConfirm: () => void }>()
  const saving = useRef(false)
  const session = draft?.session

  const requestConfirmation: RequestConfirmation = (message, onConfirm) => setConfirmation({ message, onConfirm })

  function restore(recovered: WorkoutDraft, rows: Session[], savedPlans: Plan[]) {
    const saved = committedDraft(recovered, rows)
    const restored = saved ?? recovered.session
    const linked = savedPlans.find(plan => plan.id === restored.planId)
    setDraft(saved ? { session: saved } : recovered)
    setDate(restored.date)
    if (linked && !linked.workoutDate) setPlanId(linked.id)
    setDay(dayFor(sessionWeekday(restored, linked)))
    setDirty(!saved)
    setMessage(saved ? 'Reopened saved workout.' : 'Recovered draft on this device.')
    if (saved) {
      try { localStorage.removeItem(draftKey) }
      catch { setError('The saved workout is available. The recovery draft could not be cleared.') }
    }
  }

  const refreshOpenSession = useEffectEvent((rows: Session[]) => {
    if (!dirty && !busy) setDraft(current => {
      const saved = current && rows.find(row => row.id === current.session.id)
      return saved ? { session: saved } : undefined
    })
  })

  useEffect(() => {
    let active = true
    const refreshSaved = () => { void store.list().then(rows => {
      if (!active) return
      setRecords(rows)
      void store.plans().then(p => { if (active) setPlans(p) }).catch(() => {})
      refreshOpenSession(rows)
    }).catch(() => {}) }
    window.addEventListener('workout-storage', refreshSaved)
    const channel = typeof BroadcastChannel === 'undefined' ? undefined : new BroadcastChannel('workout-storage')
    if (channel) channel.onmessage = refreshSaved
    return () => { active = false; channel?.close(); window.removeEventListener('workout-storage', refreshSaved) }
  }, [store])

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

  function persist(complete: boolean) {
    if (!draft || saving.current) return
    let prepared = draft.session
    try {
      if (draft.fields) {
        const guide = getGuide(prepared)
        const current = guideSteps(guide)[guide.cursor]
        const actual = setActual(current)
        prepared = recordSet(prepared, readActual(actual ?? current.target, draft.fields, prepared.actualsStartEmpty && !actual), false)
      }
    } catch (error) { setError((error as Error).message); return }
    requestConfirmation(complete ? 'Finish and save this workout?' : 'Save this session on this device?', () => {
      if (saving.current) return
      if (prepared !== draft.session) keepDraft({ session: prepared })
      void saveSession(prepared, complete)
    })
  }

  async function saveSession(prepared: Session, complete: boolean) {
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
    const linked = plans.find(plan => plan.id === saved.planId)
    setDraft({ session: saved })
    if (linked && !linked.workoutDate) setPlanId(linked.id)
    setDay(dayFor(sessionWeekday(saved, linked)))
    setMessage('Reopened saved session.')
    setError('')
  }

  function discard() {
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

  function savePlan(original: Plan, exercises: PlanExercise[]) {
    void saveEditor(async () => {
      const saved = await store.savePlan(original, exercises)
      setPlans(plans => plans.map(plan => plan.id === saved.id ? saved : plan))
      setMessage('Workout plan saved.')
    })
  }

  function reviewImport(destination: ImportDestination, exercises: SheetsExercise[]) {
    const { date, weekday, previous } = destination
    const plan: Plan = {
      version: 1,
      id: previous?.id ?? `sheets-${date}-${weekday}`,
      name: `Imported workout · ${dayFor(weekday)} · ${date}`,
      workoutDate: date,
      weekday,
      demo: false,
      exercises: exercises.map(({ name, targets, coachNotes }) => ({
        id: crypto.randomUUID(), name, sets: targets.filter(isStandardPerformance), prescription: targets,
        ...(coachNotes && { coachNotes }),
      })),
    }
    setEditor({ kind: 'import', plan, previous })
  }

  function confirmImport(plan: Plan, exercises: PlanExercise[], previous?: Plan) {
    void saveEditor(async () => {
      const recovery = readRecovery()
      if (recovery.error) throw new Error(recovery.error)
      if (recovery.draft) throw new Error('A workout draft is open. Save or discard it before importing.')
      const saved = await store.saveImportedPlan({ ...plan, exercises }, previous)
      setPlans(plans => [...plans.filter(plan => plan.id !== saved.id), saved])
      setMessage(`Workout plan imported for ${dayFor(saved.weekday)} · ${saved.workoutDate}.`)
    })
  }

  function saveCorrections(original: Session, corrections: ResultCorrection[]) {
    if (!corrections.length) { closeEditor(); return }
    requestConfirmation('Save corrections to this completed workout?', () => {
      void saveEditor(async () => {
        const saved = await store.correctResults(original, corrections)
        setDraft({ session: saved })
        setRecords(rows => rows.map(row => row.id === saved.id ? saved : row))
        setMessage('Recorded results corrected.')
      })
    })
  }

  const editorActions = {
    busy, error, onError: setError,
    onChange: () => { setEditorDirty(true); setError('') },
    onCancel: () => { if (editorDirty) requestConfirmation('Discard unsaved editor changes?', closeEditor); else closeEditor() },
  }

  const weeklyPlans = plans.filter(plan => !plan.workoutDate)
  const weeklyPlan = weeklyPlans.find(plan => plan.id === planId) ?? weeklyPlans[0]
  const datePlans = plans.filter(plan => plan.workoutDate === date)
  const datePlan = datePlans.find(plan => dayFor(plan.weekday) === day)
  const plan = datePlan ?? weeklyPlan
  const sessionPlan = session && plans.find(p => p.id === session.planId)
  const sessionDay = session && dayFor(sessionWeekday(session, sessionPlan))
  const showSession = Boolean(!editor && draft && (!loading || dirty) && (day === sessionDay || loading))
  const available = plan && day === dayFor(plan.weekday)
  const hasSets = plan?.exercises.some(exercise => plannedSets(exercise).length)
  const activeForDay = records.find(row => row.date === date && row.status === 'active'
    && dayFor(sessionWeekday(row, plans.find(plan => plan.id === row.planId))) === day)
  const active = datePlan ? activeForDay : plan && records.find(row => row.planId === plan.id && row.demo === plan.demo && row.date === date && row.status === 'active')
  const importBlocked = activeForDay ? 'Resume and finish the active workout for this date and day before importing.'
    : draft ? 'Return to the open workout before importing.' : ''
  const importing = editor?.kind === 'sheets' || editor?.kind === 'import'
  const previous = session && records.find(row => row.planId === session.planId && row.demo === session.demo && row.date < session.date && row.status === 'completed')
  const week = <nav className="week" aria-label="Weekly day selector">{days.map(d => <button key={d} disabled={busy} aria-pressed={day === d} onClick={() => setDay(d)}>{d}<small>{
    datePlans.some(plan => dayFor(plan.weekday) === d) ? 'Imported' : d === (sessionDay ?? (weeklyPlan && dayFor(weeklyPlan.weekday))) ? 'Strength' : 'No plan'
  }</small></button>)}</nav>
  const status = <p role="status" aria-live="polite">{message || 'Confirm a save to add your workout to local history.'}</p>

  return <main className={showSession ? 'runner runner-active' : 'runner'}>
    <header className="app-header">
      <div><p className="eyebrow">WORKOUT COMPANION / LOCAL TRAINING LOG</p><h1>One set at a time.</h1>{!showSession && <p>Your plan, your last lift, your next set.</p>}</div>
      <AppearanceSetting />
      <SyncPanel store={syncStore} requestConfirmation={requestConfirmation} />
    </header>
    {confirmation && <ConfirmationDialog {...confirmation} onDismiss={() => setConfirmation(undefined)} />}
    <PwaStatus canReload={!dirty && !editorDirty && !busy && !loading && !recoveryError} />
    {!showSession && !importing && (session?.demo ?? plan?.demo) && <aside className="demo"><strong>DEMO workspace</strong><span>Practice sessions use sample data. You can choose any workout date.</span></aside>}
    {!showSession && !editor && week}
    <div className="workspace">
      <section className={!editor && !showSession && datePlan ? 'dated-plan' : undefined}
        aria-label={editor?.kind === 'sheets' ? 'Google Sheets import' : editor ? 'Workout editor' : showSession ? 'Current session' : 'Workout plan'}>
        {editor?.kind === 'sheets' ? <GoogleSheetsImport date={editor.date} weekday={weekdays[(editor.weekday + 6) % 7]} replacing={Boolean(editor.previous)}
          onChange={editorActions.onChange} onCancel={editorActions.onCancel} onReview={workout => reviewImport(editor, workout)} />
          : editor?.kind === 'import' ? <DayWorkoutEditor {...editorActions} plan={editor.plan} weekday={dayFor(editor.plan.weekday)}
            importing replacing={Boolean(editor.previous)} onSave={exercises => confirmImport(editor.plan, exercises, editor.previous)} />
          : editor?.kind === 'plan' ? <DayWorkoutEditor {...editorActions} plan={editor.plan} weekday={dayFor(editor.plan.weekday)}
          onSave={exercises => savePlan(editor.plan, exercises)} />
          : editor?.kind === 'results' ? <RecordedResultsEditor {...editorActions} session={editor.session}
            onSave={corrections => saveCorrections(editor.session, corrections)} />
          : showSession && draft && sessionDay ? <>
          <GuidedWorkout key={draft.session.id} draft={draft} day={sessionDay} previous={previous} busy={busy || loading} error={error}
            onChange={keepDraft} onError={setError} onFinish={() => persist(true)} />
          <div className="actions session-actions">
            {draft.session.status === 'active' && <button disabled={busy || loading} onClick={() => persist(false)}>Save session</button>}
            {draft.session.status === 'completed' && <button disabled={busy || dirty || loading} onClick={() => openEditor({ kind: 'results', session: draft.session })}>Correct recorded results</button>}
            {dirty ? <button disabled={busy || loading} onClick={() => requestConfirmation('Discard unsaved changes? Saved history will be retained.', discard)}>Discard unsaved changes</button>
              : <button disabled={busy} onClick={() => { setDraft(undefined); setMessage(''); setError('') }}>Back to plan</button>}
          </div>
          <div className="session-status">{status}</div>
        </> : <>
          <div className="plan-heading">
            <div><p className="eyebrow">{day.toUpperCase()} / {datePlan ? 'ONE-TIME PLAN' : available ? 'WORKOUT PLAN' : 'UNSCHEDULED'}</p>
              <h2>{datePlan ? 'Imported workout' : available ? plan.name : 'No workout planned'}</h2></div>
            <label>Workout date<input type="date" value={date} disabled={dirty || busy} onChange={e => { setDate(e.target.value); setDraft(undefined); setMessage('') }} /></label>
          </div>
          {!datePlan && weeklyPlans.length > 1 && <label className="plan-picker">Saved plan<select value={weeklyPlan?.id} disabled={dirty || busy} onChange={e => {
            setPlanId(e.target.value); setDraft(undefined); setDay(dayFor(weeklyPlans.find(p => p.id === e.target.value)?.weekday)); setMessage('')
          }}>{weeklyPlans.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>}
          <div className="actions plan-actions">
            {!draft && available && (active || hasSets) && <button className="primary" disabled={!date || busy || loading || Boolean(recoveryError)} onClick={() => {
              if (active) reopen(active)
              else {
                try {
                  const next = startGuidedWorkout(plan, date)
                  validateSession(next)
                  keepDraft({ session: next })
                } catch (error) { setError((error as Error).message) }
              }
            }}>{active ? 'Resume Workout' : 'Start Workout'}</button>}
            {!draft && available && <button disabled={busy || loading} onClick={() => openEditor({ kind: 'plan', plan })}>Edit Day's Workout</button>}
            <button className={!available || !hasSets ? 'primary' : undefined} disabled={!date || busy || loading || Boolean(importBlocked || recoveryError)}
              aria-describedby={importBlocked ? 'import-blocked' : undefined} onClick={() => {
                try {
                  assertDate(date)
                  const weekday = ((days.indexOf(day) + 1) % 7) as Plan['weekday']
                  openEditor({ kind: 'sheets', date, weekday, previous: datePlan })
                } catch (error) { setError((error as Error).message) }
              }}>Import from Google Sheets</button>
          </div>
          {importBlocked && <p className="editor-context" id="import-blocked">{importBlocked}</p>}
          {available && !hasSets && <p>This plan has no sets.</p>}
          {available && (datePlan || hasSets) && <ul className="plan-preview">{plan.exercises.filter(exercise => datePlan || plannedSets(exercise).length).map(exercise => <li key={exercise.id}>
            <strong>{exercise.name}</strong><span>{plannedSets(exercise).map(formatSet).join(' · ') || 'No targets'}</span>
          </li>)}</ul>}
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
