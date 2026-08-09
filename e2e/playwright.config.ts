import { defineConfig } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const parsedBaseURL = new URL(baseURL);

if (parsedBaseURL.hostname === 'app.newme.ae' && process.env.E2E_ALLOW_PRODUCTION !== '1') {
  throw new Error('Refusing to run E2E against production without E2E_ALLOW_PRODUCTION=1');
}

if (process.env.CI && !process.env.E2E_BASE_URL) {
  throw new Error('CI E2E requires an explicit E2E_BASE_URL');
}

export default defineConfig({
  testDir: '.',
  testIgnore: /production-anonymous\.spec\.ts/,
  timeout: 45000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: 'e2e-results.json' }]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10000,
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
  },
});
