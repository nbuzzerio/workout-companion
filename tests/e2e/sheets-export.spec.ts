import { expect, test } from '@playwright/test'
import { appConfig } from '../../config/app.ts'

const headers = '.\tDate\tDay\tExercise\tTarget\tActual\tRIR\tMobility\tPain/Notes\tCoach Notes'
const date = '2026-11-18'
const rows = [
  `CURRENT WEEK\t${date}\tMon\tDB Deadlift\t46 lb×10 | 55 lb×10 | 63 lb×10 | 72 lb×8\t46 lb×9 | Skipped | Skipped | Skipped\t4+\t🟡 Tight\tLeft side tired No pain\t'=1+1`,
  `CURRENT WEEK\t${date}\tMon\tLeg Extension\tP9×12 | P10×10\tP9×12 | Skipped\t\t🟢 Great\t\t`,
  `CURRENT WEEK\t${date}\tMon\tSeated Military Press\t20 lb×10\tSkipped (Time limit)\t\t🔴 Very tight\t\t`,
].join('\n')

test('previews and copies a completed workout, then re-exports it unchanged after reload', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  page.on('dialog', dialog => void dialog.accept())
  await page.setViewportSize({ width: 320, height: 640 })
  await page.goto(appConfig.basePath)
  await page.getByLabel('Workout date').fill(date)
  await page.getByRole('button', { name: 'Start Workout' }).click()
  const exportWorkout = page.getByRole('button', { name: 'Export to Google Sheets' })
  await expect(exportWorkout).toHaveCount(0)

  await page.getByText('Exercise feedback', { exact: true }).click()
  await page.getByText('4+', { exact: true }).click()
  await page.getByText('Tight', { exact: true }).click()
  await page.getByLabel('Pain/Notes').fill('Left side tired\nNo pain')
  await page.getByLabel('Coach Notes').fill('=1+1')
  await page.getByLabel('DB Deadlift set 1 reps').fill('9')
  await page.getByRole('button', { name: 'Next Set' }).click()
  await page.getByRole('button', { name: 'Skip Exercise', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm Skip Exercise' }).click()
  await page.getByText('Exercise feedback', { exact: true }).click()
  await page.getByText('Great', { exact: true }).click()
  await page.getByRole('button', { name: 'Next Set' }).click()
  await page.getByRole('button', { name: 'Skip Set', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm Skip Set' }).click()
  await page.getByText('Exercise feedback', { exact: true }).click()
  await page.getByText('Very tight', { exact: true }).click()
  await page.getByRole('button', { name: 'Skip Exercise', exact: true }).click()
  await page.getByLabel('Reason for skipping (optional)').fill('Time limit')
  await page.getByRole('button', { name: 'Confirm Skip Exercise' }).click()
  await expect(exportWorkout).toHaveCount(0)
  await page.getByRole('button', { name: 'Finish Workout' }).click()
  await expect(exportWorkout).toBeVisible()
  const readHistory = () => page.evaluate(name => new Promise<string>((resolve, reject) => {
    const open = indexedDB.open(name)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const read = db.transaction('sessions').objectStore('sessions').getAll()
      read.onsuccess = () => { db.close(); resolve(JSON.stringify(read.result)) }
      read.onerror = () => { db.close(); reject(read.error) }
    }
  }), appConfig.databaseName)
  const history = await readHistory()
  expect(JSON.parse(history)).toMatchObject([{ planWeekday: 1 }])
  await exportWorkout.click()

  const preview = page.getByRole('region', { name: 'Google Sheets preview' })
  await expect(preview.getByRole('columnheader')).toHaveText(headers.split('\t'))
  const renderedRows = preview.getByRole('row')
  await expect(renderedRows).toHaveCount(4)
  for (const [index, row] of rows.split('\n').entries()) {
    await expect(renderedRows.nth(index + 1).getByRole('cell')).toHaveText(row.split('\t'))
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await preview.getByRole('region', { name: 'Export columns and rows' }).evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true)

  const readClipboard = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, '\n'))
  await preview.getByRole('button', { name: 'Copy Rows', exact: true }).click()
  await expect(preview.getByRole('status')).toHaveText('Rows copied.')
  expect(await readClipboard()).toBe(rows)
  await preview.getByRole('button', { name: 'Copy With Headers' }).click()
  await expect(preview.getByRole('status')).toHaveText('Rows and headers copied.')
  expect(await readClipboard()).toBe(`${headers}\n${rows}`)

  const savedWorkout = page.getByRole('button', { name: /2026-11-18.*completed/ })
  await page.reload()
  await page.getByLabel('Workout date').fill(date)
  await savedWorkout.click()
  await exportWorkout.click()
  await expect(preview.getByRole('status')).toBeEmpty()

  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async () => { throw new DOMException('Denied for this test', 'NotAllowedError') },
    })
  })
  await preview.getByRole('button', { name: 'Copy With Headers' }).click()
  await expect(preview.getByRole('alert')).toHaveText('Could not copy to the clipboard. Select and copy the TSV below.')
  await expect(preview.getByLabel('TSV to copy manually')).toHaveValue(`${headers}\n${rows}`)
  expect(await readClipboard()).toBe(`${headers}\n${rows}`)
  await page.evaluate(() => { Reflect.deleteProperty(navigator.clipboard, 'writeText') })
  await preview.getByRole('button', { name: 'Copy Rows', exact: true }).click()
  await expect(preview.getByRole('alert')).toHaveCount(0)
  await expect(preview.getByRole('status')).toHaveText('Rows copied.')
  expect(await readClipboard()).toBe(rows)
  expect(await readHistory()).toBe(history)
})
