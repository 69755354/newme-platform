import { test as base, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const AUTH_DIR = path.join(__dirname, '.auth');

// Test accounts
const ACCOUNTS = {
  boss: { email: 'tanya@newme.ae', password: 'Newme@2026' },
  sales: { email: 'admin@newme.ae', password: '123456' }, // admin can also test, but we need a sales account
};

const SUPABASE_URL = 'https://vfopmpxlhwzpxqegayew.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZmb3BtcHhsaHd6cHhxZWdheWV3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDg4OTExMTAsImV4cCI6MjA2NDQ2NzExMH0.0UiLli4lUNE_pwhZ13bRfw_xH4TduY_'; // placeholder, will be fetched from page

async function loginAndSaveState(page: any, email: string, password: string, role: string) {
  // Navigate to login
  await page.goto('/login');
  await page.waitForLoadState('networkidle');

  // Fill credentials
  await page.fill('input[type="email"], input[placeholder*="email" i]', email);
  await page.fill('input[type="password"]', password);

  // Click login button
  await page.click('button[type="submit"]');

  // Wait for the role-appropriate post-login destination
  await page.waitForURL(/\/(dashboard|workbench|change-password)/, { timeout: 15000 });

  // If redirected to change-password, handle it
  if (page.url().includes('change-password')) {
    // We need to change password first - but for test we'll just note it
    console.log(`[${role}] Redirected to change-password - force_password_change is set`);
  }

  // Wait for the page to fully load
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);

  // Save storage state
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
  await page.context().storageState({ path: path.join(AUTH_DIR, `${role}.json`) });
  console.log(`[${role}] Auth state saved`);
}

base('authenticate', async ({ page }) => {
  // Login as boss
  await loginAndSaveState(page, ACCOUNTS.boss.email, ACCOUNTS.boss.password, 'boss');
});

base('authenticate sales', async ({ page }) => {
  // Login as sales
  await loginAndSaveState(page, ACCOUNTS.sales.email, ACCOUNTS.sales.password, 'sales');
});
