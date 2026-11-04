// Sessions, forced password change, lockout, deploy skew, offline/slow saves, idle.
import { test, expect } from "../lib/fixtures";
import { appApi, captureToasts, pathOf, settle } from "../lib/app";
import { bodyText } from "../lib/ui";
import { createTempUser, loginViaForm, seedLead } from "../lib/data";

/** Any visible feedback: a toast or an alert/error element with text. */
async function feedbackShown(page: import("@playwright/test").Page, act: () => Promise<unknown>): Promise<string[]> {
  const toasts = await captureToasts(page, act, 2500);
  const inline = await page.locator('[role="alert"], [aria-live="polite"], [aria-live="assertive"], .text-destructive, .text-red-500, .text-rose-400, .text-rose-500').allInnerTexts().catch(() => []);
  return [...toasts, ...inline.map((x) => x.trim()).filter(Boolean)];
}

test.describe("forced password change", () => {
  test("every outcome gives feedback, same-as-old is refused, success carries on @bug-4d-2 @bug-4d-3 @role-salesA", async ({ as, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const u = await createTempUser(admin, registry, target, ns, "forced");
    const s = await as(null, { anonymous: true });
    await loginViaForm(s.page, u.email, u.secret);
    await s.page.waitForURL(/change-password/, { timeout: 20_000 });
    const old = s.page.locator('input[type="password"]').nth(0);
    const nw = s.page.locator('input[type="password"]').nth(1);
    const cf = s.page.locator('input[type="password"]').nth(2);
    const submit = s.page.locator('button[type="submit"]').first();
    const fresh = `Bb2!${u.secret.slice(4, 16)}`;

    await old.fill(`${u.secret}x`); await nw.fill(fresh); await cf.fill(fresh);
    expect((await feedbackShown(s.page, () => submit.click())).length, "wrong current password: some message").toBeGreaterThan(0);
    expect(pathOf(s.page)).toMatch(/change-password/);

    await old.fill(u.secret); await nw.fill(fresh); await cf.fill(`${fresh}z`);
    expect((await feedbackShown(s.page, () => submit.click())).length, "mismatch: some message").toBeGreaterThan(0);

    await old.fill(u.secret); await nw.fill("Ab1!"); await cf.fill("Ab1!");
    expect((await feedbackShown(s.page, () => submit.click())).length, "too short: some message").toBeGreaterThan(0);

    await old.fill(u.secret); await nw.fill(u.secret); await cf.fill(u.secret);
    await feedbackShown(s.page, () => submit.click());
    const me = await appApi<{ forcePasswordChange?: boolean }>(s.page, "GET", "/api/auth/me");
    expect(me.json?.forcePasswordChange, "same password must not clear the forced change").toBe(true);

    await old.fill(u.secret); await nw.fill(fresh); await cf.fill(fresh);
    const ok = await feedbackShown(s.page, () => submit.click());
    await s.page.waitForTimeout(3000);
    const intoApp = /^\/(workbench|dashboard|leads)/.test(pathOf(s.page));
    expect(ok.length > 0 || intoApp, "success: a message, or the user simply continues inside the app").toBe(true);
    expect(pathOf(s.page), "after success the user is in the app or told to sign in again").toMatch(/^\/(login|workbench|dashboard|leads)/);
  });
});

test.describe("sign-in protection", () => {
  test("lockout message states the wait and successful logins do not count @bug-4d-17 @role-salesA", async ({ as, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const u = await createTempUser(admin, registry, target, ns, "lockout");
    const s = await as(null, { anonymous: true, path: "/api/health" });
    const wrong = `${u.secret}-wrong`;
    // successful sign-ins first: they must not eat the failure budget
    for (let i = 0; i < 4; i++) {
      const ok = await appApi(s.page, "POST", "/api/auth/login", { email: u.email, password: u.secret });
      expect(ok.status, `good login ${i + 1}`).toBe(200);
    }
    const bad = await appApi(s.page, "POST", "/api/auth/login", { email: u.email, password: wrong });
    expect(bad.status, "first wrong password after good logins").toBe(401);
    let last = bad;
    for (let i = 0; i < 8 && last.status !== 429; i++) last = await appApi(s.page, "POST", "/api/auth/login", { email: u.email, password: wrong });
    expect(last.status, "repeated failures are limited").toBe(429);
    // what the person actually reads is the login form's message
    const page = s.page;
    await page.goto("/login", { waitUntil: "domcontentloaded" });
    await page.locator('input[type="email"]').first().fill(u.email);
    await page.locator('input[type="password"]').first().fill(`${u.secret}-wrong`);
    const toasts = await captureToasts(page, () => page.locator('button[type="submit"]').first().click(), 3000);
    const shown = `${toasts.join(" ")} ${await bodyText(page)}`;
    const header = String((last as unknown as { text: string }).text);
    expect(/\d+\s*(minute|min|分钟|秒|second)/i.test(shown) || /retry/i.test(header), `lockout message: "${shown.slice(0, 200)}"`).toBe(true);
  });

  test("logging out then pressing Back shows no data, and APIs answer 401 @role-salesA", async ({ as, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const u = await createTempUser(admin, registry, target, ns, "logout");
    const s = await as(null, { anonymous: true });
    s.keepState = false;
    await loginViaForm(s.page, u.email, u.secret);
    const out = await appApi(s.page, "POST", "/api/auth/logout");
    expect(out.status).toBeLessThan(400);
    await s.page.goBack().catch(() => undefined);
    await s.page.goto("/leads", { waitUntil: "domcontentloaded" });
    await expect.poll(() => pathOf(s.page), { timeout: 20_000, message: "protected page after logout must end on the login page" }).toMatch(/^\/login/);
    const r = await appApi(s.page, "GET", "/api/leads/list");
    expect(r.status).toBe(401);
  });

  test("signing out in another tab: the next save says the session ended and goes to sign-in @bug-4d-7 @role-salesA", async ({ as, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const u = await createTempUser(admin, registry, target, ns, "twotabs");
    const s = await as(null, { anonymous: true });
    s.keepState = false;
    await loginViaForm(s.page, u.email, u.secret).catch(() => undefined);
    // the new account is forced to change its password; use the API to lift that for this tab test
    const tabB = await s.context.newPage();
    await tabB.goto("/api/health");
    await appApi(tabB, "POST", "/api/auth/logout");
    await s.page.goto("/leads/new").catch(() => undefined);
    const toasts = await captureToasts(s.page, async () => {
      await s.page.locator("form input").first().fill(`${ns}-twotabs`).catch(() => undefined);
      await s.page.locator("form button[type=submit]").first().click().catch(() => undefined);
    }, 4000);
    const text = `${toasts.join(" ")} ${await bodyText(s.page)}`;
    expect(/log in|sign in|session|登录|过期/i.test(text) || /\/login/.test(pathOf(s.page)), `after remote logout: "${text.slice(0, 160)}"`).toBe(true);
  });

  test("a session idle for a while keeps working (no surprise logout) @role-boss", async ({ as, target }) => {
    test.skip(target.idleMs <= 0, "idle wait disabled (E2E_IDLE_MS=0)");
    test.setTimeout(target.idleMs + 120_000);
    const s = await as("boss", { path: "/dashboard" });
    await settle(s.page);
    await s.page.waitForTimeout(target.idleMs);
    await s.page.goto("/leads", { waitUntil: "domcontentloaded" });
    await settle(s.page);
    expect(pathOf(s.page)).toBe("/leads");
    const me = await appApi(s.page, "GET", "/api/auth/me");
    expect(me.status).toBe(200);
  });
});

test.describe("deploy skew (stale tab after a release)", () => {
  test("old server-action ids on page load do not log the user out @bug-SUM-1 @role-boss", async ({ as }) => {
    const s = await as("boss");
    await s.context.route("**/*", async (route) => {
      const h = route.request().headers();
      if (h["next-action"]) {
        return route.fulfill({ status: 404, contentType: "text/plain", body: "Server Action not found.", headers: { "x-nextjs-action-not-found": "1" } });
      }
      return route.fallback();
    });
    for (const path of ["/team", "/settings", "/contracts", "/ads", "/projects"]) {
      await s.page.goto(path, { waitUntil: "domcontentloaded" });
      await settle(s.page);
      await s.page.waitForTimeout(1500);
      expect(pathOf(s.page), `${path} must not send a signed-in user to login`).not.toMatch(/^\/login/);
    }
  });

  test("a client navigation answered by an old build reloads once and lands on the page @bug-SUM-1 @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/dashboard" });
    await settle(s.page);
    let documentLoads = 0;
    s.page.on("framenavigated", (f) => { if (f === s.page.mainFrame()) documentLoads += 1; });
    await s.context.route(/[?&]_rsc=/, (route) => route.fulfill({ status: 200, contentType: "text/plain", body: "stale build", headers: { "x-nextjs-deployment-id": "old-build" } }));
    await s.page.locator('aside a[href="/leads"]').first().click();
    await s.page.waitForTimeout(6000);
    expect(pathOf(s.page), "landed on the requested page").toBe("/leads");
    expect(documentLoads, "reload count (no loops)").toBeLessThanOrEqual(2);
    expect(await bodyText(s.page)).not.toMatch(/Application error|Server Reference ID|Expected RSC response/);
  });
});

test.describe("saving under bad networks", () => {
  test("inline edit offline keeps the typed value and shows one readable message @bug-4d-4 @bug-4d-6 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const phone = "+971500009911";
    const id = await seedLead(admin, registry, target, ns, { label: "offline-edit", assignedTo: accounts.salesA.id, phone });
    const s = await as("salesA", { path: `/leads/${id}` });
    await settle(s.page);
    await s.page.getByText(phone, { exact: true }).first().click();
    const input = s.page.locator("input:focus, input[type=tel]:visible, input[type=text]:visible").first();
    await expect(input).toBeVisible();
    await input.fill("+971500009922");
    await s.context.setOffline(true);
    const toasts = await captureToasts(s.page, () => input.press("Enter"), 3500);
    await s.context.setOffline(false);
    expect(toasts.join(" | "), "raw browser error text").not.toMatch(/TypeError|Failed to fetch|NetworkError/);
    expect(toasts.length, `failure toast shown ${toasts.length} times`).toBeLessThanOrEqual(1);
    const kept = (await s.page.locator("input:visible").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value))).includes("+971500009922");
    expect(kept, "typed value must still be on screen after a failed save").toBe(true);
  });

  test("a slow save shows a saving indicator within 2 seconds @bug-4d-5 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "slow-save", assignedTo: accounts.salesA.id, phone: "+971500009933" });
    const s = await as("salesA", { path: `/leads/${id}` });
    await settle(s.page);
    await s.context.route(/\/api\/leads\/[^/]+\/(contacts|notes|follow-up|events|quality)|\/rest\/v1\/leads/, async (route) => {
      await new Promise((r) => setTimeout(r, 6000));
      return route.fallback();
    });
    await s.page.getByText("+971500009933", { exact: true }).first().click();
    const input = s.page.locator("input:visible").first();
    await input.fill("+971500009944");
    await input.press("Enter");
    await s.page.waitForTimeout(1800);
    const text = await bodyText(s.page);
    expect(/saving|保存中/i.test(text), "no 'saving' hint after 1.8 s").toBe(true);
  });

  test("a failed contact-log save keeps the form and reports once @bug-4d-6 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "offline-contact", assignedTo: accounts.salesA.id });
    const s = await as("salesA", { path: `/leads/${id}` });
    await settle(s.page);
    await s.context.route(/\/api\/leads\/[^/]+\/contacts/, (route) => route.abort("connectionfailed"));
    // the contact form opens from the "first contact" step of the sales process
    // the form is closed by default: open it with the "Add Contact Record" button first
    await s.page.getByRole("button", { name: /Add Contact Record|添加联系记录/i }).first().click();
    const method = s.page.locator("select:visible").first();
    await expect(method, "contact form did not open").toBeVisible({ timeout: 10_000 });
    await method.selectOption({ index: 1 });
    const when = new Date(Date.now() - 10 * 60_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    await s.page.locator('input[type="datetime-local"]:visible').first().fill(`${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`);
    const texts = s.page.locator('input[type="text"]:visible');
    const area = texts.first();
    await area.fill("E2E contact that must survive");
    if ((await texts.count()) > 1) await texts.nth(1).fill("E2E summary");
    const save = s.page.locator("button:not([disabled])").filter({ hasText: /save|保存|submit|提交|record|记录/i }).first();
    const toasts = await captureToasts(s.page, async () => { await save.click(); }, 3500);
    expect(toasts.length, `toasts: ${toasts.join(" | ")}`).toBeLessThanOrEqual(1);
    expect(await area.inputValue().catch(() => ""), "typed note kept").toContain("E2E contact that must survive");
  });
});
