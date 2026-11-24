import type { Page } from '@playwright/test'

export async function confirmAction(page: Page, action: string) {
  await page.getByRole('button', { name: action, exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK', exact: true }).click()
}
