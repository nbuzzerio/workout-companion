import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import { draftKey, startGuidedWorkout, type WorkoutDraft } from './guided-workout'
import { sheetsHeaders, sheetsTsv } from './sheets-export'
import { openDatabase, SessionStore } from './storage'
import { planSchema, sessionSchema } from './sync'
import { SyncStore } from './sync-store'
import { createSession, demoPlan, formatCompactSet, formatSet, plannedSets } from './workouts'

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks() })

const date = '2026-11-26'
const otherDate = '2026-11-27'
const importAction = 'Import from Google Sheets'
const target = { kind: 'weight', pounds: 46, reps: 10, perSide: true } as const
const actual = { ...target, pounds: 99, reps: 2 }
const sheet = sheetsTsv([
  sheetsHeaders,
  ['CURRENT WEEK', '2026-11-09', 'Mon', 'DB Split Squat', formatCompactSet(target), formatCompactSet(actual), '4+', 'Tight', 'Sore knee', 'Slow down'],
  ['CURRENT WEEK', '2026-11-09', 'Mon', 'Side Plank', '35 sec per side | Easy cooldown', '44 sec', '', '', '', ''],
  ['CURRENT WEEK', '2026-11-09', 'Mon', 'Optional cooldown', '', '', '', '', '', ''],
])

function workoutStore() {
  const name = `import-${crypto.randomUUID()}`
  return new SessionStore(() => openDatabase(name))
}

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name })
const click = (name: string | RegExp) => fireEvent.click(button(name))
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const valueOf = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value

async function selectDateAndDay(day: '1' | '2', value = date) {
  await waitFor(() => expect(button(importAction).disabled).toBe(false))
  change('Workout date', value)
  change('Workout weekday', day)
}

function reviewSheet(carryNotes = false) {
  click(importAction)
  change('Paste Google Sheets cells', sheet)
  click('Preview import')
  if (carryNotes) fireEvent.click(screen.getByRole('checkbox', { name: 'Carry forward Coach Notes' }))
  click('Review and edit exercises')
}

test('validates paste, previews the destination and targets, and saves edits only on confirmation', async () => {
  const store = workoutStore()
  const completed = await store.complete(createSession(demoPlan, date))
  const first = render(<App store={store} />)
  await selectDateAndDay('2')
  click(importAction)
  change('Paste Google Sheets cells', 'Incomplete row')
  click('Preview import')
  expect(screen.getByRole('alert').textContent).toContain('Line 1 has 1 columns')
  expect(screen.queryByRole('button', { name: 'Review and edit exercises' })).toBeNull()
  change('Paste Google Sheets cells', sheet)
  click('Preview import')
  expect(screen.getByRole<HTMLInputElement>('radio', { name: 'Use Target values' }).checked).toBe(true)
  expect(screen.getByRole<HTMLInputElement>('checkbox', { name: 'Carry forward Coach Notes' }).checked).toBe(false)
  expect(screen.getByRole('status').textContent).toBe('3 exercises ready to review.')
  expect(screen.getByText('Mon · 2026-11-09')).toBeDefined()
  expect(screen.getByText(`Tue · ${date}`)).toBeDefined()
  expect(screen.getByText(/spreadsheet date and day differ/)).toBeDefined()
  expect(screen.getByText(formatSet(target))).toBeDefined()
  expect(screen.getByText('Easy cooldown')).toBeDefined()
  expect(screen.getByText('No targets')).toBeDefined()
  expect(within(screen.getByRole('region', { name: 'Exercises and targets' })).queryByText(/99 lb|Sore knee|Slow down/)).toBeNull()
  change('Paste Google Sheets cells', `${sheet}\n`)
  expect(screen.queryByRole('button', { name: 'Review and edit exercises' })).toBeNull()
  click('Preview import')
  click('Review and edit exercises')
  expect(screen.getByText(/Confirming will save a one-time plan/).textContent).toContain(`Tue · ${date}`)
  change('Exercise 1 name', 'Rear-foot elevated split squat')
  change('Rear-foot elevated split squat set 1 pounds', '48.5')
  expect(await store.plans()).toEqual([demoPlan])
  expect(await store.list()).toEqual([completed])
  expect(localStorage.getItem(draftKey)).toBeNull()
  click('Confirm import')
  await screen.findByText(`Workout plan imported for Tue · ${date}.`)

  const [imported] = (await store.plans()).filter(plan => plan.workoutDate)
  expect(imported).toMatchObject({ workoutDate: date, weekday: 2, demo: false })
  expect(imported.exercises.map(exercise => exercise.name)).toEqual(['Rear-foot elevated split squat', 'Side Plank', 'Optional cooldown'])
  expect(plannedSets(imported.exercises[0])).toEqual([{ kind: 'weight', pounds: 48.5, reps: 10, perSide: true }])
  expect((await store.plans()).find(plan => plan.demo)).toEqual(demoPlan)
  expect(await store.list()).toEqual([completed])
  const operation = (await new SyncStore(store.open).batch()).find(operation => operation.recordId === imported.id)
  expect(operation?.type).toBe('put')
  expect(planSchema.parse(operation && 'value' in operation && operation.value)).toEqual(imported)

  first.unmount()
  render(<App store={store} />)
  await selectDateAndDay('2')
  expect(screen.getByRole('heading', { name: /Imported workout/ })).toBeDefined()
  expect(screen.getByText(formatSet({ ...target, pounds: 48.5 }))).toBeDefined()
  change('Workout date', otherDate)
  expect(screen.getByRole('heading', { name: 'No workout planned' })).toBeDefined()
  change('Workout date', date)
  change('Workout weekday', '1')
  expect(screen.getByRole('heading', { name: 'DEMO Monday' })).toBeDefined()
  change('Workout weekday', '2')
  click('Edit this date')
  expect(valueOf('Exercise 1 name')).toBe('Rear-foot elevated split squat')
  click('Cancel')
  click('Start Workout')
  expect(screen.getByRole('heading', { name: 'Rear-foot elevated split squat' })).toBeDefined()
  expect(valueOf('Rear-foot elevated split squat set 1 pounds')).toBe('')
  expect(valueOf('Rear-foot elevated split squat set 1 reps per side')).toBe('')
  fireEvent.click(screen.getByText('Exercise feedback'))
  expect(screen.getAllByRole<HTMLInputElement>('radio').every(input => !input.checked)).toBe(true)
  expect(valueOf('Pain/Notes')).toBe('')
  click('Next Exercise')
  expect(screen.getByRole('alert').textContent).toContain('Enter nonnegative measurements')
  const draft: WorkoutDraft = JSON.parse(localStorage.getItem(draftKey)!)
  expect(draft.session).toMatchObject({ date, planWeekday: 2, planId: imported.id, demo: false })
  expect(draft.session.exercises.every(exercise => !exercise.sets.length && !exercise.feedback)).toBe(true)
  expect(draft.session.guidance?.sets.flat().every(set => !set.outcome)).toBe(true)
  expect(sessionSchema.parse(draft.session)).toEqual(draft.session)
  expect(await store.list()).toEqual([completed])
})

test.each([false, true])('Actual values start a fresh draft with carry notes=%s after reload', async carryNotes => {
  const store = workoutStore()
  const completed = await store.complete(createSession(demoPlan, date))
  const first = render(<App store={store} />)
  await selectDateAndDay('1')
  click(importAction)
  change('Paste Google Sheets cells', sheet)
  click('Preview import')
  const preview = within(screen.getByRole('region', { name: 'Exercises and targets' }))
  fireEvent.click(preview.getByRole('radio', { name: 'Use Actual values' }))
  expect(preview.getByText(formatSet(actual))).toBeDefined()
  expect(preview.queryByText(formatSet(target))).toBeNull()
  const carry = preview.getByRole('checkbox', { name: 'Carry forward Coach Notes' })
  fireEvent.click(carry)
  expect(preview.getByText('Slow down')).toBeDefined()
  if (!carryNotes) fireEvent.click(carry)
  expect(preview.queryByText('Slow down') !== null).toBe(carryNotes)
  click('Review and edit exercises')
  expect(valueOf('DB Split Squat set 1 pounds')).toBe('99')
  expect(screen.queryByText('Slow down') !== null).toBe(carryNotes)
  click('Confirm import')
  await screen.findByRole('heading', { name: /Imported workout/ })
  first.unmount()

  render(<App store={store} />)
  await selectDateAndDay('1')
  click('Start Workout')
  expect(valueOf('DB Split Squat set 1 pounds')).toBe('')
  fireEvent.click(screen.getByText('Exercise feedback'))
  expect(valueOf('Coach Notes')).toBe(carryNotes ? 'Slow down' : '')
  expect(valueOf('Pain/Notes')).toBe('')
  const { session }: WorkoutDraft = JSON.parse(localStorage.getItem(draftKey)!)
  expect(session.id).not.toBe(completed.id)
  expect(session.exercises.map(exercise => exercise.feedback)).toEqual([
    carryNotes ? { coachNotes: 'Slow down' } : undefined, undefined, undefined,
  ])
  expect(session.guidance).toEqual({ cursor: 0, sets: [
    [{ target: actual }], [{ target: { kind: 'hold', seconds: 44 } }], [],
  ] })
  expect(await store.list()).toEqual([completed])
})

test('cancels reviewed imports, protects recovered drafts, and rechecks active sessions at confirmation', async () => {
  const store = workoutStore()
  const first = render(<App store={store} />)
  await selectDateAndDay('1')
  reviewSheet(true)
  click('Cancel')
  expect(screen.getByRole('dialog', { name: 'Discard unsaved editor changes?' })).toBeDefined()
  click('OK')
  expect(await store.plans()).toEqual([demoPlan])

  click('Start Workout')
  change('DB Deadlift set 1 pounds', '52')
  const draft = localStorage.getItem(draftKey)
  first.unmount()
  render(<App store={store} />)
  await waitFor(() => expect(button('Discard unsaved changes').disabled).toBe(false))
  click(/Tue\s*No plan/)
  await waitFor(() => expect(button(importAction).disabled).toBe(true))
  expect(localStorage.getItem(draftKey)).toBe(draft)
  click(/Mon\s*Strength/)
  expect(valueOf('DB Deadlift set 1 pounds')).toBe('52')
  click('Discard unsaved changes')
  click('OK')

  reviewSheet()
  const active = await act(() => store.save(startGuidedWorkout(demoPlan, date)))
  click('Confirm import')
  await screen.findByText(/An active workout exists for this date and day/)
  click('Cancel')
  click('OK')
  expect(button(importAction).disabled).toBe(true)
  expect(await store.list()).toEqual([active])
  expect(await store.plans()).toEqual([demoPlan])
  change('Workout weekday', '2')
  expect(button(importAction).disabled).toBe(false)
  reviewSheet()
  click('Confirm import')
  await screen.findByText(`Workout plan imported for Tue · ${date}.`)
  expect(await store.list()).toEqual([active])
})

test('a reviewed reimport replaces only its one-time plan and rejects a stale confirmation', async () => {
  const store = workoutStore()
  render(<App store={store} />)
  await selectDateAndDay('1')
  reviewSheet(true)
  click('Confirm import')
  await screen.findByText(`Workout plan imported for Mon · ${date}.`)
  const [original] = (await store.plans()).filter(plan => plan.workoutDate)
  expect(original.exercises[0].coachNotes).toBe('Slow down')
  click(importAction)
  expect(screen.getByText(/Confirming will replace the one-time plan/).textContent).toContain(date)
  change('Paste Google Sheets cells', sheet)
  click('Preview import')
  click('Review and edit exercises')
  change('Exercise 1 name', 'Reimported squat')
  expect((await store.plans()).find(plan => plan.id === original.id)).toEqual(original)
  click('Confirm import')
  await screen.findByText('Reimported squat')
  const [replacement] = (await store.plans()).filter(plan => plan.workoutDate)
  expect(replacement.id).toBe(original.id)
  expect(replacement.exercises[0].coachNotes).toBeUndefined()
  expect((await store.plans()).find(plan => plan.demo)).toEqual(demoPlan)
  await expect(store.saveImportedPlan(original, original)).rejects.toThrow('plan for this date and day changed')
})
