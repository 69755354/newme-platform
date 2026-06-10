/**
 * NewMe CRM Automated Test Matrix
 * Runs real browser tests against each role × page × operation
 * Usage: node test-matrix-runner.mjs
 */
import puppeteer from 'puppeteer';

const BASE = 'https://app.newme.ae';
const ROLES = {
  admin: { email: 'admin@newme.ae', password: '123456' },
  boss: { email: 'tanya@newme.ae', password: 'Newme@2026' },
  sales: { email: 'faheem@newme.ae', password: 'Faheem@2026' },
};

const results = { pass: [], fail: [], warn: [] };
const wait = ms => new Promise(r => setTimeout(r, ms));

function log(role, page, action, status, detail = '') {
  const entry = { role, page, action, status, detail, time: new Date().toISOString() };
  results[status].push(entry);
  const icon = status === 'pass' ? '✅' : status === 'fail' ? '❌' : '⚠️';
  console.log(`${icon} [${role}] ${page} → ${action}${detail ? ': ' + detail : ''}`);
}

async function login(page, role) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 15000 });
  await page.waitForSelector('input[type="email"]', { timeout: 5000 });
  await page.type('input[type="email"]', ROLES[role].email);
  await page.type('input[type="password"]', ROLES[role].password);
  await page.click('button[type="submit"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
  await wait(2000);
  const url = page.url();
  const onDashboard = url.includes('dashboard') || url.includes('leads') || url !== `${BASE}/login`;
  return onDashboard;
}

async function logout(page) {
  await page.evaluate(() => {
    localStorage.removeItem('sb-vfopmpxlhwzpxqegayew-auth-token');
    document.cookie.split(';').forEach(c => {
      document.cookie = `${c.trim().split('=')[0]}=; path=/; max-age=0`;
    });
  });
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 10000 });
}

async function checkNoRawI18n(page, role, pageName) {
  const rawKeys = await page.evaluate(() => {
    const text = document.body.innerText;
    return (text.match(/[a-z]+\.[a-z]+\.[a-zA-Z]+/g) || [])
      .filter(k => k.startsWith('leads.') || k.startsWith('common.') || k.startsWith('settings.') || k.startsWith('contracts.') || k.startsWith('quotes.'));
  });
  if (rawKeys.length > 0) {
    log(role, pageName, 'i18n', 'fail', `${rawKeys.length} raw keys: ${rawKeys.slice(0, 3).join(', ')}`);
  } else {
    log(role, pageName, 'i18n', 'pass', 'no raw keys');
  }
}

async function testPageLoads(page, role, path, pageName, expectBlocked = false) {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 15000 });
  await wait(5000); // wait for hydration
  
  const url = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);
  const hasError = bodyText.includes("couldn't load") || bodyText.includes('error') && bodyText.length < 200;
  
  if (expectBlocked) {
    // For blocked pages, main content area should be empty or redirected
    const sidebarText = await page.evaluate(() => {
      const nav = document.querySelector('nav');
      return nav ? nav.innerText : '';
    });
    const mainContent = await page.evaluate(() => {
      const main = document.querySelector('main');
      return main ? main.innerText.length : 0;
    });
    if (mainContent < 100) {
      log(role, pageName, 'access', 'pass', 'page blocked (empty main)');
    } else {
      log(role, pageName, 'access', 'fail', `page NOT blocked, main content: ${mainContent} chars`);
    }
  } else {
    if (hasError) {
      log(role, pageName, 'load', 'fail', 'page error');
    } else {
      log(role, pageName, 'load', 'pass', `loaded (${bodyText.length} chars)`);
    }
  }
  return bodyText;
}

async function testLeadsDataCount(page, role, expectedMin, expectedMax) {
  await wait(8000); // wait for circuit breaker + fetch
  const count = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/(\d+) results/);
    return match ? parseInt(match[1]) : -1;
  });
  if (count >= expectedMin && count <= expectedMax) {
    log(role, '/leads', 'data count', 'pass', `${count} results (expected ${expectedMin}-${expectedMax})`);
  } else {
    log(role, '/leads', 'data count', 'fail', `${count} results (expected ${expectedMin}-${expectedMax})`);
  }
  return count;
}

async function testSidebarNavigation(page, role, expectedLinks) {
  const links = await page.evaluate(() => {
    const navLinks = document.querySelectorAll('nav a');
    return Array.from(navLinks).map(a => a.textContent.trim());
  });
  const missing = expectedLinks.filter(l => !links.some(link => link.includes(l)));
  const extra = expectedLinks.length > 0 ? [] : [];
  if (missing.length === 0) {
    log(role, 'sidebar', 'nav links', 'pass', `has: ${links.join(', ')}`);
  } else {
    log(role, 'sidebar', 'nav links', 'fail', `missing: ${missing.join(', ')}`);
  }
}

async function testButtonClick(page, role, pageName, buttonLabel, expectAction) {
  const button = await page.evaluateHandle((label) => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(b => b.textContent.trim().includes(label));
  }, buttonLabel);
  
  if (!button || !(button.asElement())) {
    log(role, pageName, `click "${buttonLabel}"`, 'fail', 'button not found');
    return;
  }
  
  await button.asElement().click();
  await wait(2000);
  
  const result = await page.evaluate(() => ({
    url: window.location.href,
    bodyLen: document.body.innerText.length,
    hasModal: !!document.querySelector('[role="dialog"]'),
    hasForm: !!document.querySelector('form'),
  }));
  
  let pass = false;
  let detail = '';
  switch (expectAction) {
    case 'modal':
      pass = result.hasModal;
      detail = pass ? 'modal opened' : 'no modal found';
      break;
    case 'navigate':
      pass = result.url !== `${BASE}${pageName}`;
      detail = `navigated to ${result.url}`;
      break;
    case 'form':
      pass = result.hasForm;
      detail = pass ? 'form shown' : 'no form found';
      break;
    default:
      pass = true;
      detail = `body: ${result.bodyLen} chars`;
  }
  
  log(role, pageName, `click "${buttonLabel}"`, pass ? 'pass' : 'warn', detail);
}

async function testLanguageToggle(page, role, pageName) {
  // Find and click 中文 button
  const zhButton = await page.evaluateHandle(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(b => b.textContent.includes('中文'));
  });
  
  if (!zhButton || !zhButton.asElement()) {
    log(role, pageName, 'lang toggle', 'warn', '中文 button not found');
    return;
  }
  
  await zhButton.asElement().click();
  await wait(2000);
  
  const hasChinese = await page.evaluate(() => /线索|电话|合同|报价|设置|团队/.test(document.body.innerText));
  log(role, pageName, 'lang toggle', hasChinese ? 'pass' : 'fail', hasChinese ? 'Chinese text visible' : 'no Chinese text found');
  
  // Toggle back
  const enButton = await page.evaluateHandle(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    return buttons.find(b => b.textContent.includes('EN'));
  });
  if (enButton && enButton.asElement()) {
    await enButton.asElement().click();
    await wait(1000);
  }
}

// ===== MAIN TEST RUNNER =====
async function runTests() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  for (const [role, creds] of Object.entries(ROLES)) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`TESTING ROLE: ${role} (${creds.email})`);
    console.log('='.repeat(60));
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    
    // Login
    const loggedIn = await login(page, role);
    if (!loggedIn) {
      log(role, 'login', 'auth', 'fail', 'login failed');
      continue;
    }
    log(role, 'login', 'auth', 'pass', 'logged in');

    // Sidebar check
    const adminLinks = ['Dashboard', 'Leads', 'Quotes', 'Pipeline', 'Settings', 'Team', 'Products', 'Ads'];
    const salesLinks = ['My Desk', 'My Leads', 'Products', 'My Contracts'];
    const expectedNav = role === 'sales' ? salesLinks : adminLinks;
    await testSidebarNavigation(page, role, expectedNav);

    // Language toggle
    await testLanguageToggle(page, role, 'dashboard');

    // --- LEADS PAGE ---
    await testPageLoads(page, role, '/leads', '/leads');
    const expectedCounts = { admin: [200, 400], boss: [200, 400], sales: [1, 50] };
    await testLeadsDataCount(page, role, expectedCounts[role]?.[0] || 0, expectedCounts[role]?.[1] || 999);
    await checkNoRawI18n(page, role, '/leads');

    // Buttons
    await testButtonClick(page, role, '/leads', 'Create', 'modal');
    await testButtonClick(page, role, '/leads', 'Quick Note', 'modal');

    // --- LEADS/NEW ---
    if (role !== 'sales') {
      await testPageLoads(page, role, '/leads/new', '/leads/new');
    }

    // --- QUOTES ---
    await testPageLoads(page, role, '/quotes', '/quotes');

    // --- CONTRACTS ---
    await testPageLoads(page, role, '/contracts', '/contracts');

    // --- PIPELINE ---
    if (role === 'sales') {
      // Sales shouldn't have pipeline in nav, but URL might work
      await testPageLoads(page, role, '/pipeline', '/pipeline');
    } else {
      await testPageLoads(page, role, '/pipeline', '/pipeline');
    }

    // --- SETTINGS (blocked for sales) ---
    await testPageLoads(page, role, '/settings', '/settings', role === 'sales');

    // --- TEAM (blocked for sales) ---
    await testPageLoads(page, role, '/team', '/team', role === 'sales');

    // --- PRODUCTS ---
    await testPageLoads(page, role, '/products', '/products');
    await checkNoRawI18n(page, role, '/products');

    // --- ADS ---
    if (role === 'sales') {
      await testPageLoads(page, role, '/settings/ads', '/settings/ads', true);
    } else {
      await testPageLoads(page, role, '/settings/ads', '/settings/ads');
    }

    await logout(page);
    await page.close();
  }

  // ===== SUMMARY =====
  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`✅ PASS: ${results.pass.length}`);
  console.log(`❌ FAIL: ${results.fail.length}`);
  console.log(`⚠️  WARN: ${results.warn.length}`);
  console.log(`Total: ${results.pass.length + results.fail.length + results.warn.length}`);
  
  if (results.fail.length > 0) {
    console.log('\nFAILURES:');
    results.fail.forEach(f => console.log(`  ❌ [${f.role}] ${f.page} → ${f.action}: ${f.detail}`));
  }

  await browser.close();
  return results;
}

runTests().then(r => {
  process.exit(r.fail.length > 0 ? 1 : 0);
}).catch(e => {
  console.error('Test runner crashed:', e);
  process.exit(2);
});
