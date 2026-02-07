import { defineConfig, devices } from '@playwright/test'

const headless = process.env.HEADLESS !== '0'

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 15_000 }, // Increased from 10s
  reporter: 'list',
  fullyParallel: false,
  workers: 1,
  // Retry flaky tests in CI
  retries: process.env.CI ? 2 : 0,
  // Capture artifacts on failure for debugging
  use: {
    headless,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
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
