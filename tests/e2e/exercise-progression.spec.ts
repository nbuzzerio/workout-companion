import { expect, test } from '@playwright/test'
import { appConfig } from '../../config/app.ts'
import { recordFeedback, recordSet, skipSets, startGuidedWorkout } from '../../src/guided-workout.ts'
import { createSession, type Plan } from '../../src/workouts.ts'

test('planning and guided training show saved progression offline in mobile dark mode', async ({ page, context }) => {
  const plan: Plan = {
    version: 1, id: 'dated-strength', name: 'Strength day', weekday: 1, demo: false, workoutDate: '2026-11-23',
    exercises: [
      { id: 'new-squat', name: 'Front squat', sets: [{ kind: 'weight', pounds: 100, reps: 6 }, { kind: 'weight', pounds: 110, reps: 6 }] },
      { id: 'new-plank', name: 'Side plank', sets: [{ kind: 'hold', seconds: 60, perSide: true }] },
      { id: 'new-curl', name: 'Curl', sets: [{ kind: 'weight', pounds: 22, reps: 10 }] },
    ],
  }
  const earlierPlan: Plan = {
    ...plan, id: 'earlier-import', workoutDate: '2026-11-16', exercises: [
      { id: 'old-squat', name: 'Front Squat', sets: [{ kind: 'weight', pounds: 67, reps: 9 }, { kind: 'weight', pounds: 74, reps: 9 }] },
      { id: 'old-plank', name: 'Side plank', sets: [{ kind: 'hold', seconds: 45, perSide: true }] },
    ],
  }
  const legacy = { ...createSession(earlierPlan, '2026-11-09'), revision: 1, status: 'completed' as const }
  let recent = startGuidedWorkout(earlierPlan, '2026-11-16')
  recent = recordSet(recent, { kind: 'weight', pounds: 72, reps: 8 }, true)
  recent = skipSets(recent, 'set', 'Missed this set')
  recent = recordSet(recent, { kind: 'hold', seconds: 50.5, perSide: true }, true)
  recent = recordFeedback(recent, 0, { rir: '2', mobility: 'Tight', painNotes: 'Left side felt tight', coachNotes: 'Pause at the bottom' })
  recent = { ...recent, revision: 1, status: 'completed' }

  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(appConfig.basePath)
  const start = page.getByRole('button', { name: 'Start Workout' })
  await expect(start).toBeEnabled()
  await page.evaluate(async ({ plans, sessions, databaseName }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(['plans', 'sessions'], 'readwrite')
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(tx.error)
        for (const plan of plans) tx.objectStore('plans').add(plan)
        for (const session of sessions) tx.objectStore('sessions').add(session)
      })
    } finally { db.close() }
  }, { plans: [plan, earlierPlan], sessions: [legacy, recent], databaseName: appConfig.databaseName })
  await page.getByLabel('Appearance').selectOption('dark')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(start).toBeEnabled()
  await page.getByLabel('Workout date').fill(plan.workoutDate!)

  const planRegion = page.getByRole('region', { name: 'Workout plan' })
  await expect(planRegion.getByRole('heading', { name: 'Strength day' })).toBeVisible()
  const progression = (name: string) => page.locator('summary').and(page.getByLabel(`Recent performance for ${name}`, { exact: true }))
  const squat = progression('Front squat')
  await expect(planRegion.getByText('Planned targets').first()).toBeVisible()
  await expect(planRegion.getByText('100 lb × 6 · 110 lb × 6', { exact: true })).toBeVisible()
  await expect(planRegion.getByText('No earlier recorded results.', { exact: true })).toBeVisible()
  await expect(planRegion.getByText(/^72 lb × 8/)).toBeHidden()
  await squat.press('Enter')
  await expect(squat).toBeFocused()
  const history = squat.locator('..').getByRole('list', { name: 'Earlier saved workouts' })
  await expect(history.getByRole('listitem')).toHaveCount(2)
  const latest = history.getByRole('listitem').first()
  await expect(latest.getByText('2026-11-16', { exact: true })).toBeVisible()
  await expect(latest.getByText('Recorded performance')).toBeVisible()
  await expect(latest.getByText(/^72 lb × 8/)).toBeVisible()
  await expect(latest.getByText('Since 2026-11-09 · +5 lb, -1 rep')).toBeVisible()
  await expect(latest.getByText('Set 2', { exact: true })).toHaveCount(0)
  await expect(latest.getByText('67 lb × 9', { exact: true })).toHaveCount(0)
  for (const feedback of ['RIR', 'Tight', 'Left side felt tight', 'Pause at the bottom']) {
    await expect(latest.getByText(feedback, { exact: true })).toBeVisible()
  }
  await expect(squat.locator('..')).toHaveCSS('background-color', 'rgb(40, 61, 49)')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

  await page.getByRole('button', { name: 'Edit this date' }).click()
  await progression('Side plank').press('Enter')
  await expect(page.getByRole('region', { name: 'Workout editor' }).getByText('Since 2026-11-09 · +5.5 sec')).toBeVisible()
  await expect(page.getByLabel('Side plank set 1 seconds per side')).toHaveValue('60')
  await page.getByRole('button', { name: 'Cancel' }).click()

  await start.click()
  const guide = page.getByRole('region', { name: 'Front squat' })
  await expect(guide.getByText('Planned target', { exact: true })).toBeVisible()
  await expect(guide.getByText('100 lb × 6', { exact: true })).toBeVisible()
  await expect(squat).toHaveAccessibleDescription('Last recorded set 1 · 72 lb × 8 · 2026-11-16')
  await expect(guide.getByLabel('Front squat set 1 pounds')).toHaveValue('')
  await squat.press('Space')
  await expect(guide.getByText('Pause at the bottom')).toBeVisible()
  await guide.getByLabel('Front squat set 1 pounds').fill('85')
  await guide.getByLabel('Front squat set 1 reps').fill('8')
  await guide.getByRole('button', { name: 'Next Set' }).click()
  await expect(squat).toHaveAccessibleDescription('Last recorded set 2 · 74 lb × 9 · 2026-11-09')
  await expect(guide.getByText('85 lb × 8', { exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
