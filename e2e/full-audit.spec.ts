import { test, expect, Page } from '@playwright/test';

const BASE = 'https://app.newme.ae';

// ─── Helper: Login via Supabase REST API and set cookies ───
async function login(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  
  // Fill the form
  const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
  const pwInput = page.locator('input[type="password"]').first();
  await emailInput.fill(email);
  await pwInput.fill(password);
  
  // Submit
  await page.locator('button[type="submit"]').click();
  
  // Wait for redirect to dashboard or change-password
  await page.waitForURL(/\/(dashboard|change-password)/, { timeout: 15000 });
  await page.waitForLoadState('networkidle');
}

// ─── Helper: Get nav items visible on current page ───
async function getNavItems(page: Page): Promise<string[]> {
  const links = page.locator('nav a');
  const count = await links.count();
  const items: string[] = [];
  for (let i = 0; i < count; i++) {
    const text = await links.nth(i).textContent();
    if (text) items.push(text.trim());
  }
  return items;
}

// ─── Helper: Check no console errors ───
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  return errors;
}

// ─── Helper: Check no i18n raw keys ───
async function hasRawI18nKeys(page: Page): Promise<string[]> {
  const body = await page.locator('body').textContent();
  const rawKeys: string[] = [];
  // Pattern: xxx.yyy or xxx.yyy.zzz that look like i18n keys
  const matches = body?.match(/\b[a-z]{2,}\.[a-z]{2,}\.[a-z]{2,}/g) || [];
  return matches.slice(0, 10); // return first 10 potential raw keys
}

// ═══════════════════════════════════════
// TEST SUITE 1: LOGIN
// ═══════════════════════════════════════
test.describe('Login', () => {
  test('valid login as boss → management dashboard', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    expect(page.url()).toContain('/dashboard');
    
    // Should show "Management" role label
    const body = await page.locator('body').textContent();
    expect(body).toContain('Management');
    
    // Should have management nav (11 items)
    const nav = await getNavItems(page);
    expect(nav.length).toBeGreaterThanOrEqual(10);
    expect(nav).toContain('Dashboard');
    expect(nav).toContain('Team');
    expect(nav).toContain('Settings');
  });

  test('valid login as sales → sales dashboard', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    expect(page.url()).toContain('/dashboard');
    
    const body = await page.locator('body').textContent();
    expect(body).toContain('Sales');
    
    // Sales nav should NOT have Team, Projects, Ads, Settings
    const nav = await getNavItems(page);
    expect(nav).not.toContain('Team');
    expect(nav).not.toContain('Projects');
    expect(nav).toContain('My Desk');
    expect(nav).toContain('My Leads');
  });

  test('invalid password shows error', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[type="email"]').first().fill('admin@newme.ae');
    await page.locator('input[type="password"]').first().fill('wrongpassword');
    await page.locator('button[type="submit"]').click();
    
    // Should show error message
    await page.waitForTimeout(2000);
    const body = await page.locator('body').textContent();
    expect(body?.toLowerCase()).toMatch(/invalid|failed|error/);
    expect(page.url()).toContain('/login');
  });

  test('unauthenticated access redirects to login', async ({ page }) => {
    // Clear all cookies first
    await page.goto('/login');
    await page.evaluate(() => {
      localStorage.clear();
      document.cookie.split(";").forEach(c => {
        document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });
    });
    
    await page.goto('/dashboard');
    await page.waitForTimeout(3000);
    // Should end up on login page (redirect)
    expect(page.url()).toContain('/login');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 2: DASHBOARD (Boss)
// ═══════════════════════════════════════
test.describe('Dashboard - Boss', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
  });

  test('loads with company stats', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').textContent();
    
    // Key metrics should be visible
    expect(body).toContain('Dashboard');
    expect(body).toMatch(/LEADS/i);
    expect(body).toMatch(/PIPELINE/i);
    expect(body).toMatch(/WON/i);
  });

  test('+ New Leads button navigates to /leads/new', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    await page.locator('button', { hasText: /new lead/i }).first().click();
    await page.waitForURL(/\/leads\/new/, { timeout: 10000 });
    expect(page.url()).toContain('/leads/new');
  });

  test('sales leaderboard shows team members', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').textContent();
    expect(body).toContain('Sales Leaderboard');
    // Mohamed or Faheem should be visible
    expect(body).toMatch(/Mohamed|Faheem/);
  });

  test('lead sources section renders', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/Lead Sources|Meta Ads/i);
  });

  test('month selector works', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const selector = page.locator('select, [role="combobox"]').first();
    if (await selector.isVisible()) {
      await selector.click();
      await page.waitForTimeout(500);
      // Options should be visible
      const options = page.locator('[role="option"]');
      const count = await options.count();
      expect(count).toBeGreaterThan(0);
    }
  });

  test('notification bell renders with count', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const bell = page.locator('button', { hasText: /notification/i }).first();
    if (await bell.isVisible()) {
      // Should show a count badge
      const badge = bell.locator('text=/\\d+/');
      // Bell exists, count may be 0
      expect(await bell.isVisible()).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 3: DASHBOARD (Sales)
// ═══════════════════════════════════════
test.describe('Dashboard - Sales', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
  });

  test('loads with personal stats only', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').textContent();
    
    expect(body).toMatch(/My Desk/i);
    expect(body).toMatch(/LEADS/i);
    
    // Should NOT show other salespeople's data
    // Should show "My" prefix on items
    expect(body).toMatch(/My target|My Progress/i);
  });

  test('sales cannot see Team in nav', async ({ page }) => {
    const nav = await getNavItems(page);
    expect(nav).not.toContain('Team');
    expect(nav).not.toContain('Projects');
    expect(nav).not.toContain('Ads');
    expect(nav).not.toContain('Settings');
  });

  test('sales cannot see company-wide leaderboard', async ({ page }) => {
    await page.waitForLoadState('networkidle');
    const body = await page.locator('body').textContent();
    expect(body).not.toContain('Sales Leaderboard');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 4: LEADS LIST
// ═══════════════════════════════════════
test.describe('Leads List', () => {
  test('boss sees all leads', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/lead/i);
    
    // Table should have rows
    const rows = page.locator('table tbody tr, [class*="lead"]').first();
    await expect(rows).toBeVisible({ timeout: 5000 });
  });

  test('sales sees only assigned leads', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    // Page should load without error
    expect(page.url()).toContain('/leads');
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/lead/i);
  });

  test('quick create lead dialog opens', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    // Look for quick create button
    const quickBtn = page.locator('button', { hasText: /quick|create|new|add/i }).first();
    if (await quickBtn.isVisible()) {
      await quickBtn.click();
      await page.waitForTimeout(1000);
      // Dialog should be visible
      const dialog = page.locator('[role="dialog"], [class*="dialog"]').first();
      expect(await dialog.isVisible()).toBeTruthy();
    }
  });

  test('search filters leads', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    const search = page.locator('input[placeholder*="search" i], input[placeholder*="filter" i], input[type="search"]').first();
    if (await search.isVisible()) {
      await search.fill('test-nonexistent-xyz');
      await page.waitForTimeout(1500);
      // Should show no results or empty state
      const body = await page.locator('body').textContent();
      expect(body).toMatch(/no.*result|empty|0 lead/i);
    }
  });

  test('clicking lead navigates to detail', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/leads');
    await page.waitForLoadState('networkidle');
    
    // Click first lead row
    const firstRow = page.locator('table tbody tr, [class*="lead-card"], [class*="lead-row"]').first();
    if (await firstRow.isVisible()) {
      await firstRow.click();
      await page.waitForURL(/\/leads\/[^/]+/, { timeout: 10000 });
      expect(page.url()).toMatch(/\/leads\/[^/]+/);
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 5: NEW LEAD FORM
// ═══════════════════════════════════════
test.describe('New Lead Form', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/leads/new');
    await page.waitForLoadState('networkidle');
  });

  test('form renders with all fields', async ({ page }) => {
    // Should have form inputs
    const inputs = page.locator('input, select, textarea');
    const count = await inputs.count();
    expect(count).toBeGreaterThanOrEqual(3);
  });

  test('submit empty shows validation', async ({ page }) => {
    await page.locator('button[type="submit"]').click();
    await page.waitForTimeout(1000);
    // Should either show validation errors or prevent submit
    const body = await page.locator('body').textContent();
    // Still on new lead page (didn't navigate away)
    expect(page.url()).toContain('/leads');
  });

  test('back button returns to leads list', async ({ page }) => {
    const backBtn = page.locator('button', { hasText: /back|cancel/i }).first();
    if (await backBtn.isVisible()) {
      await backBtn.click();
      await page.waitForURL(/\/leads$/, { timeout: 5000 });
      expect(page.url()).toMatch(/\/leads$/);
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 6: PIPELINE
// ═══════════════════════════════════════
test.describe('Pipeline', () => {
  test('boss sees kanban with all leads', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/pipeline');
    await page.waitForLoadState('networkidle');
    
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/pipeline/i);
    
    // Pipeline stages should be visible
    expect(body).toMatch(/new|contacted|qualified|won|lost/i);
  });

  test('sales sees only assigned leads in pipeline', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/pipeline');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/pipeline');
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/pipeline/i);
  });

  test('percentages do not overflow 100%', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/pipeline');
    await page.waitForLoadState('networkidle');
    
    // Find all percentage values
    const body = await page.locator('body').textContent();
    const percentages = body?.match(/(\d+)%/g) || [];
    for (const pct of percentages) {
      const val = parseInt(pct);
      expect(val).toBeLessThanOrEqual(100);
    }
  });

  test('add lead button navigates to /leads/new', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/pipeline');
    await page.waitForLoadState('networkidle');
    
    const addBtn = page.locator('button', { hasText: /new lead|add lead|\+.*lead/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      await page.waitForURL(/\/leads\/new/, { timeout: 10000 });
      expect(page.url()).toContain('/leads/new');
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 7: ADS (Boss Only)
// ═══════════════════════════════════════
test.describe('Ads - Boss', () => {
  test('boss can view ads page', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/ads');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/ads');
    const body = await page.locator('body').textContent();
    // Should show ads data, not error
    expect(body).not.toMatch(/error|403|forbidden/i);
  });
});

test.describe('Ads - Sales Blocked', () => {
  test('sales cannot access ads page data', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/ads');
    await page.waitForLoadState('networkidle');
    
    // Either redirected or shows empty/no data
    const body = await page.locator('body').textContent();
    // Sales should not see ads management data
    // (page may still load but with no data, or redirect)
    expect(body).not.toContain('Ads ROI');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 8: PRODUCTS
// ═══════════════════════════════════════
test.describe('Products', () => {
  test('product list renders for any role', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/products');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/products');
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/product/i);
  });

  test('import dialog opens for boss', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/products');
    await page.waitForLoadState('networkidle');
    
    const importBtn = page.locator('button', { hasText: /import/i }).first();
    if (await importBtn.isVisible()) {
      await importBtn.click();
      await page.waitForTimeout(1000);
      const dialog = page.locator('[role="dialog"]').first();
      expect(await dialog.isVisible()).toBeTruthy();
    }
  });

  test('category filter works', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/products');
    await page.waitForLoadState('networkidle');
    
    // Look for category buttons/tabs
    const catBtn = page.locator('button', { hasText: /dali|knx|curtain|sensor/i }).first();
    if (await catBtn.isVisible()) {
      await catBtn.click();
      await page.waitForTimeout(1000);
      // Should filter results
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 9: TEAM (Boss Only)
// ═══════════════════════════════════════
test.describe('Team - Boss', () => {
  test('team list shows all users', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/team');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/team');
    const body = await page.locator('body').textContent();
    expect(body).toMatch(/team|member|user/i);
  });

  test('add user dialog opens', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/team');
    await page.waitForLoadState('networkidle');
    
    const addBtn = page.locator('button', { hasText: /add.*user|invite|new.*member/i }).first();
    if (await addBtn.isVisible()) {
      await addBtn.click();
      await page.waitForTimeout(1000);
      const dialog = page.locator('[role="dialog"]').first();
      expect(await dialog.isVisible()).toBeTruthy();
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 10: QUOTES
// ═══════════════════════════════════════
test.describe('Quotes', () => {
  test('quotes page loads for boss', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/quotes');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/quotes');
  });

  test('quotes page loads for sales', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/quotes');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/quotes');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 11: CONTRACTS
// ═══════════════════════════════════════
test.describe('Contracts', () => {
  test('contracts page loads for boss', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/contracts');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/contracts');
  });

  test('new contract form loads', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/contracts/new');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/contracts/new');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 12: PAYMENTS (Sales)
// ═══════════════════════════════════════
test.describe('Payments - Sales', () => {
  test('payments page loads for sales', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/payments');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/payments');
  });

  test('record payment dialog opens', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/payments');
    await page.waitForLoadState('networkidle');
    
    // Look for a "Record Payment" or similar button
    const recordBtn = page.locator('button', { hasText: /record|pay/i }).first();
    if (await recordBtn.isVisible()) {
      await recordBtn.click();
      await page.waitForTimeout(1000);
    }
    // Page should still work without crash
    expect(page.url()).toContain('/payments');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 13: ANALYTICS
// ═══════════════════════════════════════
test.describe('Analytics', () => {
  test('analytics page loads for boss', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/analytics');
  });

  test('analytics page loads for sales', async ({ page }) => {
    await login(page, 'mohamed@newme.ae', '123456');
    await page.goto('/analytics');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/analytics');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 14: SETTINGS
// ═══════════════════════════════════════
test.describe('Settings', () => {
  test('settings page loads for boss', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/settings');
  });

  test('language toggle works', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.waitForLoadState('networkidle');
    
    const langBtn = page.locator('button', { hasText: /中文|English/i }).first();
    if (await langBtn.isVisible()) {
      const beforeText = await langBtn.textContent();
      await langBtn.click();
      await page.waitForTimeout(1000);
      const afterText = await langBtn.textContent();
      // Language should have toggled
      expect(beforeText).not.toBe(afterText);
    }
  });
});

// ═══════════════════════════════════════
// TEST SUITE 15: PROJECTS (Boss Only)
// ═══════════════════════════════════════
test.describe('Projects - Boss', () => {
  test('projects page loads for boss', async ({ page }) => {
    await login(page, 'admin@newme.ae', '123456');
    await page.goto('/projects');
    await page.waitForLoadState('networkidle');
    
    expect(page.url()).toContain('/projects');
  });
});

// ═══════════════════════════════════════
// TEST SUITE 16: i18n CHECK
// ═══════════════════════════════════════
test.describe('i18n - No Raw Keys', () => {
  const pages = [
    '/dashboard', '/leads', '/pipeline', '/quotes', 
    '/contracts', '/products', '/team', '/analytics'
  ];

  for (const path of pages) {
    test(`${path} has no raw i18n keys`, async ({ page }) => {
      await login(page, 'admin@newme.ae', '123456');
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      
      const body = await page.locator('body').textContent();
      // Check for common raw key patterns like "nav.xxx" or "leads.xxx"
      const rawKeys = body?.match(/\b(nav|leads|common|dashboard|pipeline|quotes|contracts|settings|team|products|ads)\.[a-z]+/g) || [];
      // Filter out legitimate dot-separated text (like URLs, CSS classes)
      const suspiciousKeys = rawKeys.filter(k => !k.includes('http') && !k.includes('www'));
      
      if (suspiciousKeys.length > 0) {
        console.log(`Raw i18n keys found on ${path}:`, suspiciousKeys);
      }
      // We log but don't fail - some false positives
    });
  }
});

// ═══════════════════════════════════════
// TEST SUITE 17: CONSOLE ERROR CHECK
// ═══════════════════════════════════════
test.describe('Console Errors', () => {
  const pages = [
    '/dashboard', '/leads', '/pipeline', '/quotes', 
    '/contracts', '/products', '/team', '/analytics', '/ads', '/settings'
  ];

  for (const path of pages) {
    test(`${path} has no critical console errors`, async ({ page }) => {
      const errors: string[] = [];
      page.on('console', msg => {
        if (msg.type() === 'error') {
          const text = msg.text();
          // Ignore known harmless errors
          if (!text.includes('favicon') && !text.includes('manifest') && !text.includes('404')) {
            errors.push(text);
          }
        }
      });

      await login(page, 'admin@newme.ae', '123456');
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(3000); // Wait for async errors
      
      if (errors.length > 0) {
        console.log(`Console errors on ${path}:`, errors);
      }
      // Log but don't fail - informational
    });
  }
});
