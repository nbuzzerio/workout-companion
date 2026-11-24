import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import { draftKey, skipSets, startGuidedWorkout } from './guided-workout'
import { SessionStore } from './storage'
import { createSession, demoPlan, type Plan, type Session } from './workouts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear() })

function memoryStore(plans = [demoPlan]) {
  const store = new SessionStore()
  const rows: Session[] = []
  vi.spyOn(store, 'ensurePlan').mockResolvedValue(undefined)
  vi.spyOn(store, 'plans').mockResolvedValue(plans)
  vi.spyOn(store, 'list').mockImplementation(async date => structuredClone(rows.filter(row => !date || row.date === date)))
  vi.spyOn(store, 'save').mockImplementation(async session => {
    const saved = { ...structuredClone(session), revision: session.revision + 1 }
    const index = rows.findIndex(row => row.id === session.id)
    if (index < 0) rows.push(saved)
    else rows[index] = saved
    return saved
  })
  return store
}
const button = (name: string | RegExp) => screen.getByRole('button', { name })
const click = (name: string | RegExp) => fireEvent.click(button(name))
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value

async function start() {
  await waitFor(() => expect((button('Start Workout') as HTMLButtonElement).disabled).toBe(false))
  click('Start Workout')
}

test.each([
  { change: 'rescheduled', weekday: 5, legacyDay: 'Fri' },
  { change: 'deleted', weekday: undefined, legacyDay: 'Wed' },
] as const)('re-exports the original scheduled day after a plan is $change', async ({ weekday, legacyDay }) => {
  const plan: Plan = { ...demoPlan, id: 'sample-plan', exercises: demoPlan.exercises.slice(0, 1) }
  const store = memoryStore([demoPlan, plan])
  const session = startGuidedWorkout(plan, '2026-11-18')
  const saved = await store.complete(skipSets(session, 'exercise', ''))
  const legacy = await store.complete(createSession(plan, '2026-11-25'))

  function expectDay(day: string) {
    click('Export to Google Sheets')
    const preview = within(screen.getByRole('region', { name: 'Google Sheets preview' }))
    expect(preview.getAllByRole('cell')[2].textContent).toBe(day)
  }

  const first = render(<App store={store} />)
  await waitFor(() => expect((button('Start Workout') as HTMLButtonElement).disabled).toBe(false))
  change('Workout date', saved.date)
  click(/2026-11-18.*completed/)
  expectDay('Mon')
  first.unmount()

  vi.mocked(store.plans).mockResolvedValue(weekday === undefined ? [demoPlan] : [demoPlan, { ...plan, weekday }])
  render(<App store={store} />)
  await waitFor(() => expect((button('Start Workout') as HTMLButtonElement).disabled).toBe(false))
  change('Workout date', saved.date)
  click(/2026-11-18.*completed/)
  expectDay('Mon')
  click('Back to plan')
  change('Workout date', legacy.date)
  click(/2026-11-25.*completed/)
  expectDay(legacyDay)
  expect(await store.list()).toEqual([saved, legacy])
})

test('a single set guides navigation, reload, skips and a read-only summary without double logging', async () => {
  const store = memoryStore()
  const first = render(<App store={store} />)
  await start()
  expect(screen.getByText('Exercise 1 of 3')).toBeDefined()
  expect(screen.getByText('Set 1 of 4')).toBeDefined()
  expect(within(screen.getByRole('group', { name: 'Actual performance' })).getAllByRole('textbox')).toHaveLength(2)
  expect(valueOf('DB Deadlift set 1 pounds')).toBe('46')
  expect(screen.queryByLabelText('DB Deadlift set 2 pounds')).toBeNull()
  expect(screen.queryByText('Leg Extension')).toBeNull()
  change('DB Deadlift set 1 pounds', '51.5')
  change('DB Deadlift set 1 reps', '9')
  click('Next Set')
  expect(screen.getByText('Set 2 of 4')).toBeDefined()
  click('Previous Set')
  expect(valueOf('DB Deadlift set 1 pounds')).toBe('51.5')
  expect(screen.getByText('46 lb × 10')).toBeDefined()
  change('DB Deadlift set 1 reps', '8')
  click('Next Set')
  click('Skip Set')
  change('Reason for skipping (optional)', 'Short on time')
  click('Confirm Skip Set')
  expect(screen.getByText('Set 3 of 4')).toBeDefined()
  click('Previous Set')
  expect(screen.getByText('Short on time')).toBeDefined()
  click('Next Set')
  expect(screen.getByText('Set 3 of 4')).toBeDefined()
  first.unmount()
  render(<App store={store} />)
  await screen.findByText(/Recovered draft/)
  expect(screen.getByText('Set 3 of 4')).toBeDefined()
  click('Skip Exercise')
  change('Reason for skipping (optional)', 'Training time')
  click('Confirm Skip Exercise')
  expect(screen.getByText('Exercise 2 of 3')).toBeDefined()
  expect(valueOf('Leg Extension set 1 machine position')).toBe('P9')
  change('Leg Extension set 1 machine position', 'P12')
  click('Next Set')
  click('Next Exercise')
  click('Skip Exercise')
  click('Confirm Skip Exercise')
  expect(screen.getByRole('heading', { name: 'Review workout' })).toBeDefined()
  expect(screen.getByText('Short on time')).toBeDefined()
  expect(screen.getAllByText('Training time')).toHaveLength(2)
  expect(screen.getByText('51.5 lb × 8')).toBeDefined()
  click('Finish Workout')
  click('OK')
  await screen.findByText('Saved and completed on this device.')
  expect(screen.getByRole('heading', { name: 'Workout finished' })).toBeDefined()
  expect(screen.queryByRole('textbox', { name: 'Leg Extension set 1 machine position' })).toBeNull()
  const [saved, ...others] = await store.list()
  expect(others).toHaveLength(0)
  expect(saved.demo).toBe(true)
  expect(saved.status).toBe('completed')
  expect(saved.exercises.map(exercise => exercise.sets)).toEqual([
    [{ kind: 'weight', pounds: 51.5, reps: 8 }],
    [{ kind: 'machine', position: 'P12', reps: 12 }, { kind: 'machine', position: 'P10', reps: 10 }],
    [],
  ])
  expect(localStorage.getItem(draftKey)).toBeNull()
})

test('the guided fields support bodyweight and time per side, bands, and multiline freeform values', async () => {
  const plan: Plan = { ...demoPlan, id: 'synthetic-mixed', name: 'Mixed plan', weekday: 2, exercises: [
    { id: 'lunge', name: 'Lunge', sets: [], prescription: [{ kind: 'bodyweight', reps: 8, perSide: true }] },
    { id: 'pull', name: 'Band pull', sets: [], prescription: [{ kind: 'band', resistance: 'medium', reps: 12 }] },
    { id: 'plank', name: 'Side plank', sets: [{ kind: 'hold', seconds: 30, perSide: true }] },
    { id: 'flow', name: 'Cooldown', sets: [], prescription: [{ kind: 'freeform', value: '2 easy rounds' }] },
  ] }
  const store = memoryStore([demoPlan, plan])
  render(<App store={store} />)
  fireEvent.change(await screen.findByLabelText('Saved plan'), { target: { value: plan.id } })
  await start()
  expect(screen.getByText('Bodyweight × 8 per side')).toBeDefined()
  change('Lunge set 1 reps per side', '9')
  click('Next Exercise')
  expect(valueOf('Band pull set 1 resistance')).toBe('medium')
  change('Band pull set 1 resistance', 'light')
  click('Next Exercise')
  expect(valueOf('Side plank set 1 seconds per side')).toBe('30')
  change('Side plank set 1 seconds per side', '42,5')
  click('Next Exercise')
  change('Cooldown set 1 performance', '1 easy round\nwith breathing')
  click('Review Workout')
  expect(screen.getByText('Bodyweight × 9 per side')).toBeDefined()
  expect(screen.getByText('light band × 12')).toBeDefined()
  expect(screen.getByText('42.5 sec per side')).toBeDefined()
  expect(screen.getByText('1 easy round with breathing')).toBeDefined()
})

test('save requires confirmation, reports a denied write, and can reopen the same cursor', async () => {
  const store = memoryStore()
  vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('denied'))
  const first = render(<App store={store} />)
  await start()
  click('Next Set')
  change('DB Deadlift set 2 pounds', '57')
  click('Save session')
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Save this session on this device?' })).getByRole('button', { name: 'Cancel' }))
  expect(store.save).not.toHaveBeenCalled()
  click('Save session')
  click('OK')
  await screen.findByText('Save failed: denied')
  expect(valueOf('DB Deadlift set 2 pounds')).toBe('57')
  click('Save session')
  click('OK')
  await screen.findByText('Saved on this device.')
  first.unmount()
  render(<App store={store} />)
  await waitFor(() => expect((button('Resume Workout') as HTMLButtonElement).disabled).toBe(false))
  click('Resume Workout')
  expect(valueOf('DB Deadlift set 2 pounds')).toBe('57')
  expect(screen.getByText('55 lb × 10')).toBeDefined()
})

test('a partially typed machine position survives reload and blocks recording until valid', async () => {
  const store = memoryStore()
  const first = render(<App store={store} />)
  await start()
  click('Skip Exercise')
  click('Confirm Skip Exercise')
  change('Leg Extension set 1 machine position', 'P')
  first.unmount()
  render(<App store={store} />)
  await waitFor(() => expect((button('Next Set') as HTMLButtonElement).disabled).toBe(false))
  expect(valueOf('Leg Extension set 1 machine position')).toBe('P')
  click('Next Set')
  expect(screen.getByRole('alert').textContent).toContain('Enter a machine position')
  expect(await store.list()).toEqual([])
  change('Leg Extension set 1 machine position', 'P12')
  click('Next Set')
  expect(valueOf('Leg Extension set 2 machine position')).toBe('P10')
})

test('the original recovery format and saved actuals reopen with demo history isolated', async () => {
  const store = memoryStore()
  const prior = createSession(demoPlan, '2026-11-01')
  prior.status = 'completed'
  prior.exercises[0].sets[0] = { kind: 'weight', pounds: 99, reps: 3 }
  await store.save(prior)
  const real = { ...prior, id: 'synthetic-real', demo: false, date: '2026-11-02' }
  await store.save(real)
  const draft = createSession(demoPlan, '2026-11-09')
  draft.exercises[0].sets[0] = { kind: 'weight', pounds: 57, reps: 9 }
  localStorage.setItem(draftKey, JSON.stringify(draft))
  render(<App store={store} />)
  await screen.findByText(/2026-11-01 · 99 lb/)
  expect(valueOf('DB Deadlift set 1 pounds')).toBe('57')
  expect(screen.queryByText(/2026-11-02 · 99 lb/)).toBeNull()
  expect(await store.list(draft.date)).toEqual([])
})

test('a save committed before draft cleanup reopens the same completed workout', async () => {
  const store = memoryStore()
  const first = render(<App store={store} />)
  await start()
  for (let i = 0; i < 3; i++) {
    click('Skip Exercise')
    click('Confirm Skip Exercise')
  }
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => { throw new Error('denied') })
  click('Finish Workout')
  click('OK')
  await screen.findByText('Saved and completed on this device.')
  expect(localStorage.getItem(draftKey)).toBeTruthy()
  remove.mockRestore()
  first.unmount()
  render(<App store={store} />)
  await screen.findByText('Reopened saved workout.')
  expect(screen.getByRole('heading', { name: 'Workout finished' })).toBeDefined()
  expect((await store.list()).length).toBe(1)
  expect(localStorage.getItem(draftKey)).toBeNull()
})

test('discard cancellation keeps edits open when draft storage is denied', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied') })
  render(<App store={memoryStore()} />)
  await start()
  expect(screen.getByRole('alert').textContent).toContain('Draft storage failed')
  expect(screen.getByRole('status').textContent).toBe('Unsaved changes')
  click('Discard unsaved changes')
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
  expect(valueOf('DB Deadlift set 1 pounds')).toBe('46')
})

test('retry rereads a transiently inaccessible draft and retains malformed recovery data', async () => {
  const store = memoryStore()
  const first = render(<App store={store} />)
  await start()
  change('DB Deadlift set 1 pounds', '57')
  first.unmount()
  const raw = localStorage.getItem(draftKey)!
  localStorage.setItem(draftKey, '{broken')
  render(<App store={store} />)
  await screen.findByText(/Draft recovery unavailable/)
  expect((button('Start Workout') as HTMLButtonElement).disabled).toBe(true)
  expect(localStorage.getItem(draftKey)).toBe('{broken')
  localStorage.setItem(draftKey, raw)
  await waitFor(() => expect((button('Retry storage / refresh history') as HTMLButtonElement).disabled).toBe(false))
  click('Retry storage / refresh history')
  await screen.findByText(/Recovered draft/)
  expect(valueOf('DB Deadlift set 1 pounds')).toBe('57')
  expect(localStorage.getItem(draftKey)).toBe(raw)
})
