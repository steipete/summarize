import { defineConfig, devices } from '@playwright/test'

const headless = process.env.HEADLESS !== '0'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  fullyParallel: false,
  workers: 1,
  use: {
    headless,
    viewport: { width: 1280, height: 800 },
  },
  // Multi-browser testing support
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
    },
  ],
})
