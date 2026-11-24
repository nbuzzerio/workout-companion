import { expect, test } from '@playwright/test'
import { appConfig } from '../../config/app.ts'
import { confirmAction } from '../support/confirmation.ts'
import { createSession, demoPlan } from '../../src/workouts.ts'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('production runner saves, reopens, completes and works offline at deep links', async ({ page, context }, testInfo) => {
  const unexpectedRequests: string[] = []
  page.on('request', request => {
    const url = new URL(request.url())
    const sessionCheck = url.pathname === '/api/v1/auth/session' && request.method() === 'GET'
    if (url.origin !== 'http://127.0.0.1:4173' || (url.pathname.startsWith('/api/') && !sessionCheck)) unexpectedRequests.push(request.url())
  })
  await page.goto(appConfig.basePath)
  await expect(page.getByRole('heading', { name: 'One set at a time.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start Workout' })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Start Workout' }).click()
  await expect(page.getByText('Exercise 1 of 3')).toBeVisible()
  await expect(page.getByText('Set 1 of 4')).toBeVisible()
  await expect(page.locator('.actual-fields input')).toHaveCount(2)
  await expect(page.getByRole('heading', { name: 'Leg Extension' })).toHaveCount(0)
  await page.getByLabel('DB Deadlift set 1 pounds').fill('51.5')
  await page.getByLabel('DB Deadlift set 1 reps').fill('9')
  await page.getByRole('button', { name: 'Next Set' }).click()
  await page.getByRole('button', { name: 'Previous Set' }).click()
  await expect(page.getByRole('heading', { name: 'DB Deadlift' })).toBeFocused()
  await expect(page.getByLabel('DB Deadlift set 1 pounds')).toHaveValue('51.5')
  await expect(page.getByText('46 lb × 10')).toBeVisible()
  await page.getByRole('button', { name: 'Next Set' }).click()
  await page.getByRole('button', { name: 'Skip Set', exact: true }).click()
  await page.getByLabel('Reason for skipping (optional)').fill('Rested this set')
  await page.getByRole('button', { name: 'Confirm Skip Set' }).click()
  await page.getByRole('button', { name: 'Skip Exercise', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm Skip Exercise' }).click()
  await page.getByLabel('Leg Extension set 1 machine position').fill('P')
  await page.getByRole('button', { name: 'Next Set' }).click()
  await expect(page.getByRole('alert')).toContainText('Enter a machine position')
  await page.getByLabel('Leg Extension set 1 machine position').fill('P12')
  await page.getByRole('button', { name: 'Tue No plan' }).click()
  await expect(page.getByRole('heading', { name: 'No workout planned' })).toBeVisible()
  await page.getByRole('button', { name: 'Mon Strength' }).click()
  await expect(page.getByLabel('Leg Extension set 1 machine position')).toHaveValue('P12')
  await page.screenshot({ path: testInfo.outputPath('mobile-runner.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.setViewportSize({ width: 320, height: 640 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await expect(page.getByRole('button', { name: 'Next Set' })).toBeVisible()
  await confirmAction(page, 'Save session')
  await expect(page.getByRole('status')).toHaveText('Saved on this device.')
  await page.goto(`${appConfig.basePath}history/nested`)
  await page.reload()
  await page.getByRole('button', { name: /DEMO .*active/ }).click()
  await expect(page.getByLabel('Leg Extension set 1 machine position')).toHaveValue('P12')
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toContain(`${appConfig.basePath}sw.js`)
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(new URL(scope).pathname).toBe(appConfig.basePath)
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration('/apps/other/'))?.scope)).toBeUndefined()
  expect(await page.evaluate(async () => {
    const urls = (await Promise.all((await caches.keys()).map(async name => (await (await caches.open(name)).keys()).map(request => new URL(request.url).pathname)))).flat()
    return urls.every(path => path.startsWith('/apps/workout/'))
  })).toBe(true)
  await context.setOffline(true)
  // Never visited this URL online: exercises the scoped offline navigation fallback.
  await page.goto(`${appConfig.basePath}offline/new/deep-link`)
  await page.getByRole('button', { name: /DEMO .*active/ }).click()
  await page.getByLabel('Leg Extension set 1 reps').fill('8')
  await page.getByRole('button', { name: 'Next Set' }).click()
  await page.getByRole('button', { name: 'Next Exercise' }).click()
  await page.getByRole('button', { name: 'Review Workout' }).click()
  await expect(page.getByRole('heading', { name: 'Review workout' })).toBeVisible()
  await confirmAction(page, 'Finish Workout')
  await expect(page.getByRole('status')).toHaveText('Saved and completed on this device.')
  await page.reload()
  await page.getByRole('button', { name: /DEMO .*completed/ }).click()
  await expect(page.getByText(/Workout finished/)).toBeVisible()
  await expect(page.getByText('51.5 lb × 9')).toBeVisible()
  await expect(page.getByText('P12 × 8')).toBeVisible()
  await expect(page.getByText('Rested this set')).toBeVisible()
  await expect(page.locator('.actual-fields')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /DEMO .*completed/ })).toHaveCount(1)
  expect(unexpectedRequests).toEqual([])
})

test('pre-integration native IndexedDB records and metadata remain byte-for-byte equivalent', async ({ page }) => {
  const plan = structuredClone(demoPlan)
  plan.exercises[0].musclesSource = 'original imported metadata'
  const session = createSession(plan, '2026-11-09')
  session.demo = false
  session.status = 'completed'
  session.revision = 12
  session.exercises[0].sets[0] = { kind: 'weight', pounds: 77.5, reps: 5 }
  session.exercises[1].sets[0] = { kind: 'machine', position: 'P14', reps: 8 }
  session.exercises.push({ id: 'hold', name: 'Plank', sets: [{ kind: 'hold', seconds: 45 }] })
  // Seed the original v1 schema before application code runs, just once per context.
  await page.addInitScript(({ plan, session }) => {
    const request = indexedDB.open('workout-companion', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('plans', { keyPath: 'id' }).add(plan)
      request.result.createObjectStore('sessions', { keyPath: 'id' }).add(session)
    }
    request.onsuccess = () => request.result.close()
  }, { plan, session })
  await page.goto(appConfig.basePath)
  await expect(page.getByRole('button', { name: 'Start Workout' })).toBeEnabled()
  await page.getByLabel('Workout date').fill(session.date)
  await page.getByRole('button', { name: /2026-11-09.*completed/ }).click()
  await expect(page.getByText('77.5 lb × 5')).toBeVisible()
  await expect(page.getByText('P14 × 8')).toBeVisible()
  await expect(page.getByText('45 sec')).toBeVisible()
  await expect(page.locator('.actual-fields')).toHaveCount(0)
  await page.reload()
  const records = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('workout-companion')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const read = (store: string) => new Promise<unknown[]>((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const result = { version: db.version, stores: Array.from(db.objectStoreNames), plans: await read('plans'), sessions: await read('sessions') }
    db.close()
    return result
  })
  expect(records).toEqual({ version: 2, stores: expect.arrayContaining(['plans', 'sessions', 'syncOutbox', 'syncSettings']), plans: [plan], sessions: [session] })
})

test('the existing recovery key survives reload without becoming saved history', async ({ page }) => {
  await page.goto(appConfig.basePath)
  await page.getByRole('button', { name: 'Start Workout' }).click()
  await page.getByRole('button', { name: 'Next Set' }).click()
  await page.getByLabel('DB Deadlift set 2 pounds').fill('64')
  const before = await page.evaluate(() => localStorage.getItem('workout-companion-draft-v1'))
  page.on('dialog', dialog => void dialog.accept())
  await page.reload()
  await expect(page.getByRole('status')).toContainText('Recovered draft')
  await expect(page.getByLabel('DB Deadlift set 2 pounds')).toHaveValue('64')
  await expect(page.getByText('Set 2 of 4')).toBeVisible()
  await expect(page.getByText('No saved sessions for this date.')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('workout-companion-draft-v1'))).toBe(before)
})

test('Question 2: the day editor and guided exercise feedback are separate and persist after reload', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 })
  await page.goto(appConfig.basePath)
  await page.getByRole('button', { name: "Edit Day's Workout" }).click()
  const editor = page.getByRole('region', { name: 'Workout editor' })
  await expect(editor.getByRole('heading', { name: "Edit Day's Workout" })).toBeVisible()
  await expect(editor.getByLabel('Pain/Notes')).toHaveCount(0)
  await expect(editor.getByLabel('Coach Notes')).toHaveCount(0)
  await page.getByLabel('Exercise 1 name').fill('Dumbbell hinge')
  await page.getByLabel('Dumbbell hinge set 1 pounds').fill('47.5')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const editorCapture = testInfo.outputPath('01-day-plan-editor.png')
  await editor.screenshot({ path: editorCapture })
  await testInfo.attach('Day plan editor', { path: editorCapture, contentType: 'image/png' })
  await page.getByRole('button', { name: 'Save workout plan' }).click()
  await expect(page.getByRole('status')).toHaveText('Workout plan saved.')
  await page.reload()
  await page.getByRole('button', { name: 'Start Workout' }).click()
  await expect(page.getByLabel('Exercise 1 name')).toHaveCount(0)
  await expect(page.getByLabel('Dumbbell hinge set 1 pounds')).toHaveValue('47.5')
  await page.getByLabel('Dumbbell hinge set 1 reps').fill('9')
  await page.getByText('Exercise feedback', { exact: true }).click()
  await page.getByRole('group', { name: 'RIR', exact: true }).getByText('2', { exact: true }).click()
  await page.getByRole('group', { name: 'Mobility', exact: true }).getByText('Tight', { exact: true }).click()
  await page.getByLabel('Pain/Notes').fill('Left side felt tight')
  await page.getByLabel('Coach Notes').fill('Pause at the bottom')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const feedbackCapture = testInfo.outputPath('02-guided-exercise-feedback.png')
  await page.getByRole('region', { name: 'Dumbbell hinge' }).screenshot({ path: feedbackCapture })
  await testInfo.attach('Guided exercise feedback', { path: feedbackCapture, contentType: 'image/png' })
  await confirmAction(page, 'Save session')
  await expect(page.getByRole('status')).toHaveText('Saved on this device.')
  await page.reload()
  await page.getByRole('button', { name: 'Resume Workout' }).click()
  await expect(page.getByText('47.5 lb × 10', { exact: true })).toBeVisible()
  await expect(page.getByLabel('Dumbbell hinge set 1 reps')).toHaveValue('9')
  await page.getByText('Exercise feedback', { exact: true }).click()
  await expect(page.getByRole('radio', { name: '2', exact: true })).toBeChecked()
  await expect(page.getByRole('radio', { name: 'Tight', exact: true })).toBeChecked()
  await expect(page.getByLabel('Pain/Notes')).toHaveValue('Left side felt tight')
  await expect(page.getByLabel('Coach Notes')).toHaveValue('Pause at the bottom')
})

test('a real waiting service worker respects unsaved edits and reloads only after saving', async ({ page }) => {
  // Test-only static host: vary worker bytes without changing the built dist/.
  let revision = 1
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    if (!path.startsWith(appConfig.basePath)) { response.writeHead(404).end(); return }
    const relative = path.slice(appConfig.basePath.length)
    if (relative.split('/').some(part => part.startsWith('.'))) { response.writeHead(404).end(); return }
    const filename = !relative || !relative.includes('.') ? 'index.html' : relative
    try {
      let body = await readFile(resolve('dist', filename))
      if (filename === 'sw.js') body = Buffer.from(`${body.toString()}\n// test release ${revision}\n`)
      const extension = filename.split('.').at(-1)!
      const types: Record<string, string> = { html: 'text/html', js: 'application/javascript', css: 'text/css', png: 'image/png', webmanifest: 'application/manifest+json', json: 'application/json' }
      response.writeHead(200, { 'Content-Type': types[extension] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    await page.goto(`http://127.0.0.1:${address.port}${appConfig.basePath}`)
    await page.evaluate(async () => { await navigator.serviceWorker.ready })
    await page.reload()
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
    await page.getByRole('button', { name: 'Start Workout' }).click()
    await page.getByRole('button', { name: 'Skip Exercise', exact: true }).click()
    await page.getByRole('button', { name: 'Confirm Skip Exercise' }).click()
    await page.getByLabel('Leg Extension set 1 machine position').fill('P')
    revision = 2
    await page.evaluate(async () => { await (await navigator.serviceWorker.ready).update() })
    const update = page.getByRole('button', { name: 'Reload to update' })
    await expect(update).toBeVisible()
    await expect(update).toBeDisabled()
    await expect(page.getByLabel('Leg Extension set 1 machine position')).toHaveValue('P')
    await page.getByLabel('Leg Extension set 1 machine position').fill('P12')
    await confirmAction(page, 'Save session')
    await expect(page.getByRole('status')).toHaveText('Saved on this device.')
    await expect(update).toBeEnabled()
    await Promise.all([page.waitForEvent('load'), update.click()])
    await page.getByRole('button', { name: /DEMO .*active/ }).click()
    await expect(page.getByLabel('Leg Extension set 1 machine position')).toHaveValue('P12')
    await expect(update).toHaveCount(0)
  } finally {
    await page.goto('about:blank')
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
