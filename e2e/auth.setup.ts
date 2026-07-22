import { test as base } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(__dirname, '.auth');

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required E2E secret: ${name}`);
  }
  return value;
}

const ACCOUNTS = {
  boss: {
    email: () => requiredEnv('E2E_BOSS_EMAIL'),
    password: () => requiredEnv('E2E_BOSS_PASSWORD'),
  },
  sales: {
    email: () => requiredEnv('E2E_SALES_EMAIL'),
    password: () => requiredEnv('E2E_SALES_PASSWORD'),
  },
};

async function loginAndSaveState(page: any, email: string, password: string, role: string) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  await page.fill('input[type="email"], input[placeholder*="email" i]', email);
  await page.fill('input[type="password"]', password);
  await page.click('button[type="submit"]');

  await page.waitForURL(/\/(dashboard|workbench|change-password)/, { timeout: 15000 });

  if (page.url().includes('change-password')) {
    console.warn(`[${role}] E2E account requires a password change`);
  }

  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await page.context().storageState({ path: path.join(AUTH_DIR, `${role}.json`) });
}

base('authenticate', async ({ page }) => {
  await loginAndSaveState(page, ACCOUNTS.boss.email(), ACCOUNTS.boss.password(), 'boss');
});

base('authenticate sales', async ({ page }) => {
  await loginAndSaveState(page, ACCOUNTS.sales.email(), ACCOUNTS.sales.password(), 'sales');
});