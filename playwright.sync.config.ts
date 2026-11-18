import { defineConfig, devices } from '@playwright/test'
export default defineConfig({
  testDir: './tests/sync-browser', fullyParallel: false, workers: 1, timeout: 60_000,
  outputDir: './test-results-sync', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:5174/apps/workout/', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  globalSetup: './tests/support/browser-setup.mjs',
})
