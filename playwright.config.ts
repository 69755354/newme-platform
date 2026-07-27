import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const parsedBaseURL = new URL(baseURL);

if (parsedBaseURL.hostname === 'app.newme.ae' && process.env.E2E_ALLOW_PRODUCTION !== '1') {
  throw new Error('Refusing to run E2E against production without E2E_ALLOW_PRODUCTION=1');
}

if (process.env.E2E_STAGING_ONLY === '1') {
  if (parsedBaseURL.hostname !== 'staging.newme.ae') {
    throw new Error('Staging authenticated E2E requires https://staging.newme.ae');
  }
  if (!/^[0-9a-f]{40}$/i.test(process.env.E2E_EXPECTED_SHA ?? '')) {
    throw new Error('Staging authenticated E2E requires E2E_EXPECTED_SHA');
  }
}

if (process.env.CI && !process.env.E2E_BASE_URL) {
  throw new Error('CI E2E requires an explicit E2E_BASE_URL');
}

export default defineConfig({
  testDir: './e2e',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 1,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'auth-setup',
      testMatch: /.*\.setup\.ts/,
    },
    {
      name: 'boss',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: { storageState: 'e2e/.auth/boss.json' },
    },
    {
      name: 'sales',
      testMatch: /.*\.spec\.ts/,
      dependencies: ['auth-setup'],
      use: { storageState: 'e2e/.auth/sales.json' },
    },
  ],
});
