import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import { draftKey, startGuidedWorkout } from './guided-workout'
import { openDatabase, SessionStore } from './storage'
import { type Snapshot } from './sync'
import { SyncStore } from './sync-store'
import { reviewWeekReuse } from './weekly-planning'
import { createSession, demoPlan, isStandardPerformance, plannedSets, type Performance, type Plan } from './workouts'

afterEach(() => { cleanup(); vi.useRealTimers(); localStorage.clear() })

const monday = '2026-11-23'
const tuesday = '2026-11-24'
const friday = '2026-11-27'
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const click = (name: string) => fireEvent.click(button(name))
const calendar = () => screen.getByRole('navigation', { name: 'Workout calendar' })
const tile = (date: string) => calendar().querySelector(`time[datetime="${date}"]`)!.closest('button')!
const dateField = () => screen.getByLabelText<HTMLInputElement>('Workout date')
const setField = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } })
const destinationMonday = '2026-11-30'

function storeForWeek() {
  vi.setSystemTime(new Date(2026, 10, 24, 12))
  const name = `weekly-${crypto.randomUUID()}`
  return new SessionStore(() => openDatabase(name))
}

test('shows the selected calendar week, planned progress and off-weekday history on their dates', async () => {
  const store = storeForWeek()
  const recurring: Plan = { ...demoPlan, id: 'tuesday', name: 'Tuesday training', weekday: 2, demo: false }
  const dated: Plan = { ...recurring, id: 'sheets-friday', name: 'Imported bench', weekday: 1, workoutDate: friday }
  await store.ensurePlan(recurring)
  await store.saveImportedPlan(dated)
  await store.schedulePlan({ ...dated, id: 'empty-off-weekday', workoutDate: tuesday, exercises: [] })
  const completed = await store.complete(createSession(dated, friday))
  const active = await store.save(startGuidedWorkout(recurring, tuesday))
  await store.complete(createSession(recurring, '2026-11-26'))
  await store.complete({ ...createSession(demoPlan, monday), demo: false })

  render(<App store={store} />)
  await waitFor(() => expect(tile(friday).textContent).toContain('Completed'))
  expect(tile(monday).textContent).toContain('Outstanding')
  expect(tile(monday).textContent).toContain('1 other completed')
  expect(tile(tuesday).textContent).toContain('In progress')
  expect(tile(tuesday).textContent).not.toContain('Rest day')
  expect(tile('2026-11-25').textContent).toContain('Rest day')
  expect(tile('2026-11-26').textContent).toContain('1 other completed')
  expect(tile(tuesday).getAttribute('aria-current')).toBe('date')

  fireEvent.click(tile(friday))
  expect(dateField().value).toBe(friday)
  expect(screen.getByLabelText<HTMLSelectElement>('Workout weekday').value).toBe('1')
  expect(screen.getByRole('heading', { name: dated.name })).toBeDefined()
  fireEvent.click(screen.getByRole('button', { name: /2026-11-27.*completed/ }))
  expect(screen.getByRole('heading', { name: 'Workout finished' })).toBeDefined()
  click('Back to plan')
  fireEvent.click(tile(tuesday))
  click('Resume Workout')
  expect(localStorage.getItem(draftKey)).toBeNull()
  expect(await store.reopen(active.id)).toEqual(active)
  expect(await store.reopen(completed.id)).toEqual(completed)
  click('Back to plan')
  click('Next week')
  expect(dateField().value).toBe('2026-12-01')
  expect(tile('2026-12-01').textContent).toContain('Outstanding')
  click('Previous week')
  expect(dateField().value).toBe(tuesday)
  click('Previous week')
  click('This week')
  expect(dateField().value).toBe(tuesday)
})

test('edits an occurrence, schedules on a rest day, and saves both through the existing sync outbox', async () => {
  const store = storeForWeek()
  const saved = await store.complete(createSession(demoPlan, '2026-11-17'))
  const first = render(<App store={store} />)
  await waitFor(() => expect(tile(monday).disabled).toBe(false))
  fireEvent.click(tile(monday))
  click('Edit this date')
  setField('Exercise 1 name', 'Monday hinge')
  click('Save workout plan')
  await screen.findByText('Monday hinge')
  expect(await store.list()).toEqual([saved])
  expect((await store.plans()).find(row => row.id === demoPlan.id)).toEqual(demoPlan)

  fireEvent.click(tile(tuesday))
  click('Schedule workout')
  click('Add exercise')
  setField('Exercise 1 name', 'Split squat')
  click('Save workout plan')
  await screen.findByText('Split squat')
  expect(tile(tuesday).textContent).toContain('Outstanding')

  const sync = new SyncStore(store.open)
  const dated = (await store.plans()).filter(plan => plan.workoutDate)
  expect(dated).toHaveLength(2)
  expect(await sync.batch()).toEqual(expect.arrayContaining(dated.map(plan =>
    expect.objectContaining({ type: 'put', kind: 'plan', recordId: plan.id, value: plan }))))

  first.unmount()
  render(<App store={store} />)
  await waitFor(() => expect(tile(tuesday).textContent).toContain('Outstanding'))
  fireEvent.click(tile(tuesday))
  expect(screen.getByText('Split squat')).toBeDefined()
  click('Edit this date')
  click('Remove Split squat')
  click('Save workout plan')
  await waitFor(() => expect(tile(tuesday).textContent).toContain('Rest day'))
  click('Next week')
  fireEvent.click(tile('2026-11-30'))
  expect(screen.getByText('DB Deadlift')).toBeDefined()
  expect(screen.queryByText('Monday hinge')).toBeNull()
})

test('refreshes a dated workout and its completion when sync installs records', async () => {
  const store = storeForWeek()
  const sync = new SyncStore(store.open)
  const scope = 'weekly-planner'
  await sync.patch({ phase: 'ready', spaceId: scope })
  render(<App store={store} />)
  await waitFor(() => expect(tile(tuesday).disabled).toBe(false))

  const plan: Plan = { ...demoPlan, id: 'synced-plan', name: 'Synced training', demo: false, workoutDate: tuesday, weekday: 2 }
  const session = { ...createSession(plan, tuesday), status: 'completed' } as const
  const snapshot = {
    schemaVersion: 1 as const, deleted: false, people: [], createdAt: tuesday, updatedAt: tuesday,
    updatedBy: crypto.randomUUID(), deviceId: crypto.randomUUID(),
  }
  const changes: Snapshot[] = [
    { ...snapshot, kind: 'plan', recordId: plan.id, value: plan, serverVersion: '1' },
    { ...snapshot, kind: 'session', recordId: session.id, value: session, serverVersion: '2' },
  ]
  await act(() => sync.apply({
    protocolVersion: 1, results: [], acceptedOperationIds: [], rejected: [], conflicts: [],
    changes, cursor: 'week-2', hasMore: false,
  }, [], scope))
  await waitFor(() => expect(tile(tuesday).textContent).toContain('Completed'))
  expect(tile(tuesday).textContent).toContain('Synced training')
  fireEvent.click(tile(tuesday))
  expect(screen.getByRole('heading', { name: plan.name })).toBeDefined()
  expect(screen.getByRole('button', { name: /2026-11-24.*completed/ })).toBeDefined()
})

test('date-specific scheduling checks the recurring template and competing writes in the same slot', async () => {
  const store = storeForWeek()
  await store.ensurePlan(demoPlan)
  const dated = { ...demoPlan, id: 'date-override', workoutDate: monday }
  const revised = await store.savePlan(demoPlan, demoPlan.exercises.slice(1))
  await expect(store.schedulePlan(dated, demoPlan)).rejects.toThrow('recurring plan changed')

  const candidate = { ...dated, exercises: revised.exercises }
  const imported = { ...dated, id: 'sheets-2026-11-23-1', demo: false }
  const results = await Promise.allSettled([store.schedulePlan(candidate, revised), store.saveImportedPlan(imported)])
  const stored = (await store.plans()).filter(plan => plan.workoutDate === monday)
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results).toContainEqual({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('date and day changed') }) })
  expect(stored).toHaveLength(1)
  const pending = (await new SyncStore(store.open).view()).pending
  expect(pending.filter(row => row.recordId === candidate.id || row.recordId === imported.id))
    .toEqual([expect.objectContaining({ value: stored[0] })])
  expect(await store.list()).toEqual([])
})

test('previews, copies and adjusts a week\'s targets while keeping occupied dates and recorded history', async () => {
  const store = storeForWeek()
  await store.ensurePlan(demoPlan)
  const targets: Performance[] = [
    { kind: 'weight', pounds: 42.5, reps: 8 },
    { kind: 'hold', seconds: 25, perSide: true },
    { kind: 'bodyweight', reps: 6 },
  ]
  const source = await store.saveImportedPlan({ ...demoPlan, id: 'source-week', name: 'Strength and mobility', demo: false, workoutDate: monday,
    exercises: [{ id: 'source-exercise', name: 'Split squat', sets: targets.filter(isStandardPerformance),
      prescription: targets, coachNotes: 'Pause at the bottom', musclesSource: 'quads' }],
  })
  const recorded = createSession(source, monday)
  recorded.exercises[0].sets = [{ kind: 'weight', pounds: 85, reps: 3 }]
  recorded.exercises[0].feedback = { rir: '1', painNotes: 'Last week felt tight', coachNotes: 'Historical session note' }
  await store.complete(recorded)

  const wednesday = await store.schedulePlan({ ...source, id: 'wed-plan', name: 'Wednesday source', weekday: 3, workoutDate: '2026-11-25' })
  await store.complete(createSession(wednesday, '2026-12-02'))
  await store.schedulePlan({ ...source, id: 'thu-plan', name: 'Thursday source', weekday: 4, workoutDate: '2026-11-26' })
  await store.schedulePlan({ ...source, id: 'protected-plan', name: 'Existing rest override', weekday: 4, workoutDate: '2026-12-03', exercises: [] })
  const fridayPlan = await store.schedulePlan({ ...source, id: 'fri-plan', name: 'Friday workout', weekday: 2, workoutDate: friday })
  const rest = await store.schedulePlan({ ...source, id: 'rest-plan', name: 'Sunday recovery', weekday: 0, workoutDate: '2026-11-29', exercises: [] })
  const sync = new SyncStore(store.open)
  const originalPlans = await store.plans()
  const originalHistory = await store.list()
  const originalOutbox = (await sync.view()).pending

  render(<App store={store} />)
  await waitFor(() => expect(button('Reuse previous week').disabled).toBe(false))
  click('Reuse previous week')
  expect(screen.getByText('2026-11-23 to 2026-11-29')).toBeDefined()
  click('Cancel')
  expect(await store.plans()).toEqual(originalPlans)
  expect((await sync.view()).pending).toEqual(originalOutbox)

  click('Reuse previous week')
  setField('Destination week (choose any date)', '2026-12-02')
  expect(screen.getByText('2026-11-23 to 2026-11-29')).toBeDefined()
  expect(screen.getByText('2026-11-30 to 2026-12-06')).toBeDefined()
  expect(screen.getAllByText('Pause at the bottom')).toHaveLength(2)
  expect(screen.getAllByText(/42\.5 lb.*8.*25 sec per side.*Bodyweight.*6/)).toHaveLength(2)
  expect(screen.queryByText(/85 lb|Last week felt tight|Historical session note/)).toBeNull()
  expect(screen.getByText('Skipped because a saved workout already exists on 2026-12-02.')).toBeDefined()
  expect(screen.getByText('Skipped because a one-time plan already exists on 2026-12-03.')).toBeDefined()
  expect(screen.getByText('Sunday recovery')).toBeDefined()
  expect(await store.plans()).toEqual(originalPlans)

  click('Confirm copy (3 plans)')
  await screen.findByText('Copied 3 plans to the week of 2026-11-30.')
  expect(dateField().value).toBe(destinationMonday)
  expect(tile(destinationMonday).textContent).toContain('Outstanding')
  expect(tile('2026-12-02').textContent).toContain('1 other completed')
  const savedPlans = await store.plans()
  const copies = savedPlans.filter(plan => !originalPlans.some(row => row.id === plan.id))
  expect(savedPlans).toEqual(expect.arrayContaining(originalPlans))
  expect(copies).toHaveLength(3)
  const copy = copies.find(plan => plan.workoutDate === destinationMonday)!
  expect(copy).toEqual({ ...source, id: expect.any(String), workoutDate: destinationMonday,
    exercises: [{ ...source.exercises[0], id: expect.any(String) }],
  })
  expect(copy.exercises[0].id).not.toBe(source.exercises[0].id)
  expect(copies).toContainEqual(expect.objectContaining({ workoutDate: '2026-12-04', weekday: fridayPlan.weekday }))
  expect(copies).toContainEqual({ ...rest, id: expect.any(String), workoutDate: '2026-12-06' })
  expect(await store.list()).toEqual(originalHistory)
  const queued = (await sync.view()).pending
  expect(queued).toHaveLength(originalOutbox.length + 3)
  expect(queued).toEqual(expect.arrayContaining(copies.map(plan =>
    expect.objectContaining({ kind: 'plan', recordId: plan.id, value: plan, operation: expect.objectContaining({ type: 'put', baseServerVersion: null }) }))))

  click('Reuse previous week')
  expect(button('Confirm copy').disabled).toBe(true)
  click('Cancel')
  click('Edit this date')
  setField('Split squat set 1 pounds', '47.5')
  click('Save workout plan')
  await screen.findByText('Workout plan saved.')
  expect((await store.plans()).find(plan => plan.id === source.id)).toEqual(source)
  expect(plannedSets((await store.plans()).find(plan => plan.id === copy.id)!.exercises[0])[0])
    .toEqual({ kind: 'weight', pounds: 47.5, reps: 8 })

  click('Start Workout')
  expect(screen.getByText('47.5 lb × 8')).toBeDefined()
  expect(screen.getByLabelText<HTMLInputElement>('Split squat set 1 pounds').value).toBe('')
  const draft = JSON.parse(localStorage.getItem(draftKey)!)
  expect(draft.session).toMatchObject({ planId: copy.id, date: destinationMonday, exercises: [{ sets: [], feedback: { coachNotes: 'Pause at the bottom' } }] })
  expect(draft.session.id).not.toBe(recorded.id)
  expect(await store.list()).toEqual(originalHistory)
})

test('rejects a stale reuse preview before writing any plans and serializes competing confirmations', async () => {
  const store = storeForWeek()
  await store.ensurePlan(demoPlan)
  const tuesdayPlan = await store.schedulePlan({ ...demoPlan, id: 'tue-plan', weekday: 2, workoutDate: tuesday })
  const review = reviewWeekReuse(destinationMonday, await store.plans(), [])!
  const active = await store.save(startGuidedWorkout(tuesdayPlan, '2026-12-01'))
  const sync = new SyncStore(store.open)
  const initialOutbox = (await sync.view()).pending
  const initialPlans = await store.plans()
  await expect(store.reuseWeek(review)).rejects.toThrow('Review the updated preview')
  expect(await store.plans()).toEqual(initialPlans)
  expect((await sync.view()).pending).toEqual(initialOutbox)

  const revised = reviewWeekReuse(destinationMonday, initialPlans, [active])!
  await store.savePlan(demoPlan, demoPlan.exercises.slice(1))
  const updatedPlans = await store.plans()
  const updatedOutbox = (await sync.view()).pending
  await expect(store.reuseWeek(revised)).rejects.toThrow('Review the updated preview')
  expect(await store.plans()).toEqual(updatedPlans)
  expect((await sync.view()).pending).toEqual(updatedOutbox)

  const current = reviewWeekReuse(destinationMonday, updatedPlans, [active])!
  const results = await Promise.allSettled([store.reuseWeek(current), store.reuseWeek(current)])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results).toContainEqual({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Review the updated preview') }) })
  expect((await store.plans()).filter(plan => plan.workoutDate && plan.workoutDate >= destinationMonday))
    .toEqual([expect.objectContaining({ workoutDate: destinationMonday })])
  expect((await sync.view()).pending).toHaveLength(updatedOutbox.length + 1)
  expect(await store.list()).toEqual([active])
})
