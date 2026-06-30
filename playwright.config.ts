import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false, // sequential to avoid auth conflicts
  retries: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL: 'https://app.newme.ae',
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'boss',
      testMatch: /.*\.spec\.ts/,
      use: { storageState: 'e2e/.auth/boss.json' },
    },
    {
      name: 'sales',
      testMatch: /.*\.spec\.ts/,
      use: { storageState: 'e2e/.auth/sales.json' },
    },
  ],
});
