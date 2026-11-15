import { defineConfig, devices } from '@playwright/test';
import { appConfig } from './config/app.ts';
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:4173${appConfig.basePath}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm preview --port 4173 --strictPort',
    url: `http://127.0.0.1:4173${appConfig.basePath}`,
    reuseExistingServer: !process.env.CI,
  },
});
