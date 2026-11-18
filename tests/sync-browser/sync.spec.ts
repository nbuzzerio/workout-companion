import { chromium, expect, test, type Page } from '@playwright/test'
import { startRecoveryServer } from '../../scripts/recover-workout.mjs'
import { mkdir, mkdtemp } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { demoPlan } from '../../src/workouts.ts'
const password = 'synthetic-workout-passphrase-only'
async function panel(page: Page) { const details = page.locator('.sync-panel'); if ((await details.getAttribute('open')) === null) await details.locator('summary').first().click() }
async function login(page: Page) { await panel(page); await page.getByLabel('Username', { exact: true }).fill('synthetic-owner'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('button', { name: 'Logout and pause sync' })).toBeVisible() }
async function connect(page: Page, name: string, create = false) {
  await login(page)
  if (create) { await page.getByLabel('New personal Space name').fill(name); await page.getByRole('button', { name: 'Create personal Space', exact: true }).click() }
  else await page.getByLabel('Personal Space', { exact: true }).selectOption({ label: name })
  const downloaded = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download local backup', exact: true }).click(); expect((await downloaded).suggestedFilename()).toMatch(/^workout-backup-/)
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Connect and download for review' }).click()
  await page.getByRole('button', { name: 'Reconcile downloaded records' }).click()
}
function syncButton(page: Page) { return page.locator('header').getByRole('button', { name: 'Sync', exact: true }) }
async function retry(page: Page) {
  await syncButton(page).click()
  await expect(syncButton(page)).toBeEnabled()
}
async function pending(page: Page) { return page.evaluate(async () => { const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('workout-companion'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }); const rows = await new Promise<unknown[]>((resolve, reject) => { const r = db.transaction('syncOutbox').objectStore('syncOutbox').getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) }); db.close(); return rows.length }) }
async function localState(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open('workout-companion'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const names = ['plans', 'sessions', 'syncSettings', 'syncOutbox', 'syncMeta', 'syncPeople', 'syncBackups']
    const tx = db.transaction(names)
    const result = Object.fromEntries(await Promise.all(names.map(async name => [name, await new Promise<unknown[]>((resolve, reject) => { const r = tx.objectStore(name).getAll(); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })])))
    db.close(); return result
  })
}

test('two browsers: consent, online login, offline saves, refresh, conflict and mobile People UI', async ({ browser }, info) => {
  const ca = await browser.newContext(), cb = await browser.newContext(); const a = await ca.newPage(), b = await cb.newPage()
  const origin = 'http://127.0.0.1:5174'; let beforeConsent = 0
  a.on('request', r => { const url = new URL(r.url()); expect(url.origin).toBe(origin); if (url.pathname.endsWith('/exchange')) beforeConsent++ })
  a.on('dialog', d => void d.accept()); b.on('dialog', d => void d.accept())
  await a.goto('/apps/workout/'); await a.getByRole('button', { name: 'Start Workout' }).click(); await a.getByRole('button', { name: 'Save session', exact: true }).click(); await expect(a.getByRole('status')).toHaveText('Saved on this device.')
  expect(beforeConsent).toBe(0)
  const name = `Synthetic ${Date.now()}`; await connect(a, name, true); await expect.poll(() => pending(a)).toBe(0)
  await b.goto('/apps/workout/'); await connect(b, name)
  // The independently created demo plan is reviewed rather than silently overwritten.
  await b.getByRole('button', { name: 'Keep server version' }).click(); await retry(b)
  await expect.poll(() => pending(b)).toBe(0)
  await b.getByRole('button', { name: /DEMO .*active/ }).click()
  await a.evaluate(async () => { await navigator.serviceWorker.ready })
  await a.reload(); await a.getByRole('button', { name: /DEMO .*active/ }).click()
  await expect.poll(() => a.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await ca.setOffline(true); await cb.setOffline(true)
  await a.getByLabel('DB Deadlift set 1 pounds').fill('111'); await a.getByRole('button', { name: 'Save session', exact: true }).click()
  await b.getByLabel('DB Deadlift set 1 pounds').fill('222'); await b.getByRole('button', { name: 'Save session', exact: true }).click()
  await expect.poll(() => pending(a)).toBeGreaterThan(0); await expect.poll(() => pending(b)).toBeGreaterThan(0)
  await a.reload(); await expect.poll(() => pending(a)).toBeGreaterThan(0)
  await expect(a.locator('.sync-state')).toHaveText('Offline')
  await expect(a.locator('.sync-header')).toContainText('Edits stay on this device. Saved changes are waiting.')
  await expect(syncButton(a)).toBeDisabled()
  await ca.setOffline(false); await expect.poll(() => pending(a)).toBe(0)
  await cb.setOffline(false); await b.reload()
  await expect(b.locator('.sync-state')).toHaveText('Attention needed')
  await expect(b.getByText(/VERSION_CONFLICT/)).toBeHidden()
  await b.getByRole('link', { name: 'Review conflicts' }).click()
  await expect(b.locator('.sync-comparison')).toContainText('222 lb');
  await expect(b.locator('.sync-comparison')).toContainText('111 lb');
  await expect(b.getByText(/VERSION_CONFLICT/)).toBeHidden(); await b.getByRole('button', { name: 'Keep local version' }).click(); await retry(b); await retry(a)
  await a.getByRole('button', { name: /DEMO .*active/ }).click(); await expect(a.getByLabel('DB Deadlift set 1 pounds')).toHaveValue('222')
  await b.getByLabel('Person name', { exact: true }).fill('Synthetic athlete'); await b.getByRole('button', { name: 'Create Person (online)' }).click()
  await b.getByLabel('Saved record', { exact: true }).selectOption({ label: 'Plan · DEMO Monday' }); await b.getByLabel('Add Person as subject').selectOption({ label: 'Synthetic athlete' }); await retry(b); await retry(a)
  await panel(a); await expect(a.getByText('Synthetic athlete', { exact: true })).toBeVisible()
  await b.setViewportSize({ width: 390, height: 844 }); await b.screenshot({ path: info.outputPath('sync-mobile.png'), fullPage: true }); expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  const stored = await b.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } })); expect(stored).not.toContain(password)
  expect(await a.evaluate(async () => (await Promise.all((await caches.keys()).map(async key => (await (await caches.open(key)).keys()).map(r => new URL(r.url).pathname)))).flat().every(path => !path.startsWith('/api/')))).toBe(true)
  await b.getByRole('button', { name: 'Logout and pause sync' }).click(); await expect(b.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await ca.close(); await cb.close()
})

test('one mobile header button uploads and downloads, then foreground and periodic checks fetch new plans', async ({ page }, info) => {
  await page.setViewportSize({ width: 320, height: 640 })
  // Hold the automatic timers so only the chosen trigger can deliver each edit.
  await page.clock.install({ time: new Date('2026-10-01T12:00:00Z') })
  await page.clock.pauseAt(new Date('2026-10-01T12:01:00Z'))
  page.on('dialog', dialog => void dialog.accept())
  await page.goto('/apps/workout/')
  await connect(page, 'Header ' + Date.now(), true)
  await expect(page.locator('.sync-state')).toHaveText('Synced')
  await page.getByText('Advanced sync settings', { exact: true }).click()
  const { csrfToken } = await (await page.request.get('/api/v1/auth/session')).json()
  const [{ spaceId }] = (await localState(page)).syncSettings as { spaceId: string }[]
  async function remotePlan(name: string) {
    const id = crypto.randomUUID()
    const response = await page.request.post('/api/v1/apps/workout/exchange', {
      headers: { Origin: 'http://127.0.0.1:5174', 'X-CSRF-Token': csrfToken },
      data: { protocolVersion: 1, appId: 'workout', deviceId: crypto.randomUUID(), spaceId, cursor: null,
        changes: [{ type: 'put', kind: 'plan', recordId: id, baseServerVersion: null, operationId: crypto.randomUUID(),
          schemaVersion: 1, people: [], resurrect: false, value: { ...demoPlan, id, name } }] },
    })
    expect(response.ok()).toBe(true)
    expect((await response.json()).acceptedOperationIds).toHaveLength(1)
  }
  const button = syncButton(page)
  await expect(button).toBeInViewport()
  const size = await button.boundingBox()
  expect(size!.height).toBeGreaterThanOrEqual(44)
  expect(size!.width).toBeGreaterThanOrEqual(44)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: info.outputPath('mobile-header.png') })
  await remotePlan('Manual download')
  await page.getByRole('button', { name: 'Start Workout' }).click()
  await page.getByRole('button', { name: 'Save session', exact: true }).click()
  await expect(page.locator('.sync-state')).toHaveText('Changes pending')
  const write = page.waitForRequest(r => r.url().endsWith('/exchange') && r.postDataJSON().changes.some((c: { kind: string }) => c.kind === 'session'))
  await button.click()
  await write
  await expect(page.locator('.sync-state')).toHaveText('Synced')
  await expect(page.getByRole('combobox', { name: 'Saved plan', exact: true }).locator('option')).toContainText(['Manual download'])
  expect(await pending(page)).toBe(0)
  await remotePlan('Foreground download')
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.clock.fastForward(1600)
  await expect(page.getByRole('combobox', { name: 'Saved plan', exact: true }).locator('option')).toContainText(['Foreground download'])
  await expect(page.locator('.sync-state')).toHaveText('Synced')
  await remotePlan('Periodic download')
  await page.clock.fastForward(61_000)
  await expect(page.getByRole('combobox', { name: 'Saved plan', exact: true }).locator('option')).toContainText(['Periodic download'])
  await expect(page.locator('.sync-panel')).not.toHaveAttribute('open', '')
  await test.step('a held Web Lock times out and the same saved edit retries safely', async () => {
    await expect(page.locator('.sync-state')).toHaveText('Synced')
    await page.evaluate(() => new Promise<void>(acquired => {
      void navigator.locks.request('workout-sync-v1', () => new Promise<void>(release => {
        window.addEventListener('release-test-lock', () => release(), { once: true })
        acquired()
      }))
    }))
    await page.getByLabel('DB Deadlift set 1 pounds').fill('98')
    await page.getByRole('button', { name: 'Save session', exact: true }).click()
    await expect(page.locator('.sync-state')).toHaveText('Changes pending')
    const before = (await localState(page)).syncOutbox
    await syncButton(page).click()
    await expect.poll(() => page.evaluate(async () => (await navigator.locks.query()).pending?.some(lock => lock.name === 'workout-sync-v1'))).toBe(true)
    await page.clock.fastForward(20_001)
    await expect(page.locator('.sync-state')).toHaveText('Attention needed')
    expect((await localState(page)).syncOutbox).toEqual(before)
    await page.evaluate(() => window.dispatchEvent(new Event('release-test-lock')))
    await retry(page)
    await expect(page.locator('.sync-state')).toHaveText('Synced')
    expect(await pending(page)).toBe(0)
  })
})

test('multiple tabs serialize exchanges and retain saves when coordinator closes', async ({ browser }) => {
  const context = await browser.newContext(); const a = await context.newPage(); a.on('dialog', d => void d.accept())
  await a.goto('/apps/workout/'); await connect(a, `Tabs ${Date.now()}`, true); await expect.poll(() => pending(a)).toBe(0)
  const b = await context.newPage(); b.on('dialog', d => void d.accept()); await b.goto('/apps/workout/'); await panel(b)
  let inFlight = 0, maximum = 0
  const tracked = new Set<object>()
  context.on('request', r => { if (new URL(r.url()).pathname.endsWith('/exchange')) { tracked.add(r); inFlight++; maximum = Math.max(maximum, inFlight) } })
  context.on('requestfinished', r => { if (tracked.delete(r)) inFlight-- }); context.on('requestfailed', r => { if (tracked.delete(r)) inFlight-- })
  await Promise.all([retry(a), retry(b)])
  await b.getByRole('button', { name: 'Start Workout' }).click(); await b.getByRole('button', { name: 'Save session', exact: true }).click(); await a.close(); await retry(b)
  await expect.poll(() => pending(b)).toBe(0); expect(maximum).toBeLessThanOrEqual(1)
  await context.close()
})

test('idle tabs do not trigger sync traffic in each other, but a confirmed save wakes sync', async ({ browser }, info) => {
  const context = await browser.newContext()
  try {
    const a = await context.newPage(); a.on('dialog', d => void d.accept())
    await a.goto('/apps/workout/'); await connect(a, `Idle ${Date.now()}`, true)
    await expect.poll(() => pending(a)).toBe(0)
    const b = await context.newPage(); await b.goto('/apps/workout/')
    // Let the startup/foreground catch-up complete; observation is shorter than
    // the intended minute poll and deliberately contains no user actions.
    await b.waitForTimeout(4500)
    const traffic: { path: string; elapsedMs: number }[] = []; const start = Date.now()
    context.on('request', r => { const path = new URL(r.url()).pathname; if (path.startsWith('/api/v1/')) traffic.push({ path, elapsedMs: Date.now() - start }) })
    await b.waitForTimeout(12_000)
    await info.attach('idle-http-requests', { body: JSON.stringify(traffic, null, 2), contentType: 'application/json' })
    expect(traffic).toEqual([])
    await a.getByRole('button', { name: 'Start Workout' }).click()
    await a.getByRole('button', { name: 'Save session', exact: true }).click()
    await expect.poll(() => pending(a), { timeout: 5000 }).toBe(0)
    expect(traffic.some(r => r.path.endsWith('/exchange'))).toBe(true)
    await expect(b.getByRole('button', { name: /DEMO .*active/ })).toBeVisible()
    await b.waitForTimeout(2500); traffic.length = 0
    await b.waitForTimeout(6000)
    await info.attach('post-save-idle-http-requests', { body: JSON.stringify(traffic), contentType: 'application/json' })
    expect(traffic).toEqual([])
  } finally { await context.close() }
})

test('login and restored authentication without consent never exchange workouts', async ({ browser }) => {
  const context = await browser.newContext()
  try {
    const page = await context.newPage(); page.on('dialog', d => void d.accept())
    const exchanges: string[] = []; context.on('request', r => { if (/\/(exchange|common\/changes)$/.test(new URL(r.url()).pathname)) exchanges.push(r.url()) })
    await page.goto('/apps/workout/'); await page.getByRole('button', { name: 'Start Workout' }).click(); await page.getByRole('button', { name: 'Save session', exact: true }).click()
    await expect.poll(() => pending(page)).toBe(2)
    const before = (await localState(page)).syncOutbox
    await login(page); await page.waitForTimeout(3500)
    await page.reload(); await panel(page); await page.getByRole('button', { name: 'Restore signed-in session' }).click(); await page.waitForTimeout(3500)
    expect(exchanges).toEqual([]); expect((await localState(page)).syncOutbox).toEqual(before)
  } finally { await context.close() }
})

test('pause in another tab retains a server-accepted in-flight write, survives restart, and resumes idempotently', async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve })
  try {
    const a = await context.newPage(); a.on('dialog', d => void d.accept())
    await a.goto('/apps/workout/'); await connect(a, `Pause ${Date.now()}`, true); await expect.poll(() => pending(a)).toBe(0)
    const b = await context.newPage(); await b.goto('/apps/workout/'); await panel(b)
    await b.waitForTimeout(2000)
    let accepted = false
    await context.route('**/api/v1/apps/workout/exchange', async route => {
      if (!accepted && route.request().postDataJSON().changes.length) {
        expect(route.request().frame().page()).toBe(a)
        const response = await route.fetch(); expect(response.ok()).toBe(true); accepted = true
        await held; await route.fulfill({ response }).catch(() => {})
      } else await route.continue()
    })
    await a.getByRole('button', { name: 'Start Workout' }).click(); await a.getByRole('button', { name: 'Save session', exact: true }).click()
    await syncButton(a).click()
    await expect.poll(() => accepted).toBe(true)
    await expect(a.locator('.sync-state')).toHaveText('Syncing')
    const before = (await localState(a)).syncOutbox; expect(before).toHaveLength(1)
    await b.getByRole('button', { name: 'Disconnect / pause' }).click()
    await expect(a.getByRole('link', { name: 'Resume sync' })).toBeVisible()
    let laterRequests = 0; context.on('request', r => { if (/\/(exchange|common\/changes)$/.test(new URL(r.url()).pathname)) laterRequests++ })
    release(); await b.waitForTimeout(3000)
    await a.reload(); await b.reload(); await b.waitForTimeout(3000)
    expect(laterRequests).toBe(0); expect((await localState(a)).syncOutbox).toEqual(before)
    await panel(b); await b.getByRole('button', { name: 'Restore signed-in session' }).click()
    const download = b.waitForEvent('download'); await b.getByRole('button', { name: 'Download local backup', exact: true }).click(); await download
    await b.getByRole('checkbox').check(); await b.getByRole('button', { name: 'Connect and download for review' }).click()
    await expect.poll(() => pending(b)).toBe(0)
    expect((await localState(b)).syncMeta).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^session:/), version: '1' })]))
  } finally { release(); await context.close() }
})

test('a full browser-process restart preserves offline pending data through authentication expiry', async () => {
  const root = resolve('.dev', 'browser-restart'); await mkdir(root, { recursive: true }); const profile = await mkdtemp(join(root, 'isolated-'))
  const options = { headless: true, baseURL: 'http://127.0.0.1:5174/apps/workout/' }
  let context = await chromium.launchPersistentContext(profile, options)
  try {
    let page = context.pages()[0]; page.on('dialog', d => void d.accept())
    await page.goto('/apps/workout/'); await connect(page, `Restart ${Date.now()}`, true); await expect.poll(() => pending(page)).toBe(0)
    await page.evaluate(async () => { await navigator.serviceWorker.ready }); await page.reload()
    const auth = await (await context.request.get('/api/v1/auth/session')).json()
    expect((await context.request.post('/api/v1/auth/logout', { data: {}, headers: { Origin: 'http://127.0.0.1:5174', 'X-CSRF-Token': auth.csrfToken } })).status()).toBe(204)
    await context.setOffline(true)
    await page.getByRole('button', { name: 'Start Workout' }).click(); await page.getByRole('button', { name: 'Save session', exact: true }).click()
    await expect.poll(() => pending(page)).toBe(1); const before = (await localState(page)).syncOutbox
    await context.close()
    context = await chromium.launchPersistentContext(profile, options); await context.setOffline(true)
    page = context.pages()[0]; await page.goto('/apps/workout/')
    expect((await localState(page)).syncOutbox).toEqual(before)
    await context.setOffline(false)
    await expect(page.locator('.sync-state')).toHaveText('Sign in required')
    await page.getByRole('link', { name: 'Sign in again' }).click()
    await expect(page.locator('.sync-error')).toContainText('Authentication expired')
    expect((await localState(page)).syncOutbox).toEqual(before)
    await page.getByLabel('Username', { exact: true }).fill('synthetic-owner'); await page.getByLabel('Password', { exact: true }).fill(password); await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect.poll(() => pending(page)).toBe(0)
  } finally { await context.close() }
})

test('supervised export recovery preserves records and labels, refuses an existing database, and cannot upload', async ({ browser }) => {
  // Use an actual downloaded export, including completed history and People.
  const source = await browser.newContext(); const recovered = await browser.newContext(); let service: Awaited<ReturnType<typeof startRecoveryServer>> | undefined
  try {
    const page = await source.newPage(); page.on('dialog', d => void d.accept())
    await page.goto('/apps/workout/'); await page.getByRole('button', { name: 'Start Workout' }).click(); await page.getByRole('button', { name: 'Save and complete' }).click()
    await connect(page, `Recovery ${Date.now()}`, true); await expect.poll(() => pending(page)).toBe(0)
    await page.getByLabel('Person name', { exact: true }).fill('Recovery label'); await page.getByRole('button', { name: 'Create Person (online)' }).click()
    await page.getByLabel('Saved record', { exact: true }).selectOption({ index: 2 }); await page.getByLabel('Add Person as subject').selectOption({ label: 'Recovery label' })
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download local backup', exact: true }).click()
    const stream = await (await download).createReadStream(); const parts: Buffer[] = []; for await (const part of stream!) parts.push(Buffer.from(part))
    const data = JSON.parse(Buffer.concat(parts).toString('utf8'))
    expect(data.people).toEqual(expect.arrayContaining([expect.objectContaining({ displayName: 'Recovery label' })]))
    const original = await localState(page)
    service = await startRecoveryServer(data)
    const copy = await recovered.newPage(); copy.on('dialog', d => void d.accept())
    const api: string[] = []; recovered.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()) })
    await copy.goto(service.url); await expect(copy.getByRole('link', { name: 'Inspect recovered workouts', includeHidden: true })).toBeHidden()
    await copy.getByRole('button', { name: 'Recover into new local database' }).click()
    await expect(copy.locator('#result')).toContainText('"syncEnabled": false')
    const state = await localState(copy)
    expect(state.plans).toEqual(data.plans); expect(state.sessions).toEqual(data.sessions); expect(state.syncPeople).toEqual(data.people)
    expect(state.syncOutbox).toEqual([]); expect(state.syncSettings).toEqual([expect.objectContaining({ enabled: false, phase: 'local', cursor: null, deviceId: expect.not.stringMatching(data.settings.deviceId) })])
    expect(state.syncBackups).toEqual([expect.objectContaining({ source: data })])
    await copy.getByRole('button', { name: 'Recover into new local database' }).click(); await expect(copy.locator('#result')).toContainText('Recovery refused')
    expect(await localState(copy)).toEqual(state)
    await copy.getByRole('link', { name: 'Inspect recovered workouts' }).click()
    await copy.getByRole('button', { name: /DEMO .*completed/ }).click(); await expect(copy.getByLabel('DB Deadlift set 1 pounds')).toBeDisabled()
    await copy.waitForTimeout(2500); expect(api).toEqual([])
    // Source history is never read/written by the recovery server itself.
    expect((await localState(page)).sessions).toEqual(original.sessions)
  } finally { await source.close(); await recovered.close(); await service?.close() }
})
