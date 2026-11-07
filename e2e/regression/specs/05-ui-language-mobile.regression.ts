// Language (Chinese UI), mobile ergonomics, desktop layout and small UI contracts.
import { test, expect, type RoleKey } from "../lib/fixtures";
import { appApi, settle } from "../lib/app";
import { bodyText, horizontalOverflow, openBellPanel, rawKeysIn, smallTapTargets } from "../lib/ui";
import { seedLead } from "../lib/data";

const ZH_PAGES: Record<string, string[]> = {
  boss: ["/dashboard", "/leads", "/analytics", "/quotes", "/contracts", "/payments", "/team", "/ads", "/settings/ads", "/tasks", "/products"],
  salesA: ["/workbench", "/leads", "/leads/new", "/tasks"],
  operator: ["/dashboard", "/leads", "/analytics"],
  finance: ["/workbench", "/contracts", "/payments"],
};
// Words that must not be left in English on a Chinese page (UI chrome, not customer data).
// "Show room", FB and ins stay English on purpose (owner decision), so they are not listed.
const ENGLISH_CHROME = [/Lead Health/, /Total Leads/, /Quality Distribution/, /Zero Follow-up/, /Overdue follow-up/, /Back to Leads/, /\bDormant\b/, /Basic_info/];

for (const [role, pages] of Object.entries(ZH_PAGES)) {
  for (const path of pages) {
    test(`Chinese UI on ${path}: no raw keys, typos or English leftovers @bug-4a-12 @bug-4a-13 @bug-4b-12 @bug-4c-16 @bug-4c-17 @role-${role}`, async ({ as }) => {
      const s = await as(role as RoleKey, { lang: "zh", path });
      await settle(s.page);
      await s.page.waitForTimeout(1500);
      const text = await bodyText(s.page);
      expect(rawKeysIn(text), "raw translation keys").toEqual([]);
      expect(text).not.toContain("首长国");
      const leftovers = ENGLISH_CHROME.filter((re) => re.test(text)).map(String);
      expect(leftovers, "English interface text on a Chinese page").toEqual([]);
    });
  }
}

test.describe("Chinese refresh and login", () => {
  test("a Chinese user does not see an English flash on reload @bug-4d-21 @role-salesA", async ({ as }) => {
    const s = await as("salesA", { lang: "zh", path: "/workbench" });
    await settle(s.page);
    const seenEnglish: string[] = [];
    await s.page.exposeFunction("__e2eEn", (t: string) => seenEnglish.push(t));
    await s.page.addInitScript(() => {
      const obs = new MutationObserver(() => {
        const t = document.body?.innerText ?? "";
        if (/Loading\.\.\.|My Leads|Sign Out/.test(t)) (window as unknown as { __e2eEn: (t: string) => void }).__e2eEn(t.slice(0, 80));
      });
      document.addEventListener("DOMContentLoaded", () => obs.observe(document.body, { childList: true, subtree: true, characterData: true }));
    });
    await s.page.reload({ waitUntil: "load" });
    await settle(s.page);
    expect(seenEnglish, "English text rendered before the Chinese UI").toEqual([]);
  });

  test("the login page has a language switch @bug-4d-21", async ({ as }) => {
    const s = await as(null, { anonymous: true, path: "/login" });
    await expect(s.page.locator("button, a").filter({ hasText: /^(中文|EN|English)$/ }).first()).toBeVisible();
  });
});

// S13: the production release check failed on exactly this state (Chinese in the browser's
// storage, no `newme-lang` cookie) with React error #418, and nothing here caught it first:
// the fixtures only ever opened /login in English, the authenticated pages have no Suspense
// boundary that hydrates late, and the smoke script only curls /login. These cases open the
// public login page in every language/cookie combination and fail on any uncaught page error.
test.describe("login page hydrates cleanly in every language state @smoke", () => {
  const states: Array<{ lang: "zh" | "en"; cookie: "none" | "same" | "other" }> = [
    { lang: "zh", cookie: "none" },
    { lang: "zh", cookie: "same" },
    { lang: "zh", cookie: "other" },
    { lang: "en", cookie: "none" },
    { lang: "en", cookie: "same" },
    { lang: "en", cookie: "other" },
  ];
  for (const { lang, cookie } of states) {
    test(`${lang} session, ${cookie === "none" ? "no cookie" : cookie === "same" ? "matching cookie" : "stale cookie"}: no page errors, ends in ${lang}`, async ({ as, target }) => {
      const s = await as(null, { anonymous: true, lang });
      if (cookie !== "none") {
        const value = cookie === "same" ? lang : lang === "zh" ? "en" : "zh";
        await s.context.addCookies([{ name: "newme-lang", value, url: target.baseURL }]);
      }
      await s.page.goto("/login", { waitUntil: "domcontentloaded" });
      await settle(s.page);
      await s.page.waitForTimeout(3000); // late-hydrating boundaries report their errors after load
      expect(s.pageErrors, "uncaught browser errors on /login").toEqual([]);
      await expect(s.page.getByRole("button", { name: lang === "zh" ? "登录" : "Sign In", exact: true })).toHaveCount(1);
      expect(await s.page.evaluate(() => document.documentElement.lang)).toBe(lang);
    });
  }
});

test.describe("phone screens", () => {
  for (const device of ["mobile390", "mobile360"] as const) {
    test(`${device}: lead detail has no sideways scroll and tap targets are at least 40 px @bug-4d-12 @bug-4d-11 @role-salesA`, async ({ as, accounts, target, ns, registry }) => {
      const admin = await as("admin", { path: "/api/health" });
      const id = await seedLead(admin, registry, target, ns, { label: `mobile-${device}`, assignedTo: accounts.salesA.id });
      const s = await as("salesA", { device, lang: "zh", path: `/leads/${id}` });
      await settle(s.page);
      expect(await horizontalOverflow(s.page), "sideways scroll").toBeLessThanOrEqual(1);
      const small = await smallTapTargets(s.page, 40);
      expect(small.slice(0, 8), `${small.length} controls under 40 px`).toEqual([]);
    });
  }

  test("phone: sticky header on lead detail takes less than 15% of the screen @bug-4d-11 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "mobile-header", assignedTo: accounts.salesA.id });
    const s = await as("salesA", { device: "mobile390", path: `/leads/${id}` });
    await settle(s.page);
    const h = await s.page.evaluate(() => {
      let max = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
        const cs = getComputedStyle(el);
        if (cs.position === "sticky" || cs.position === "fixed") {
          const r = el.getBoundingClientRect();
          if (r.top <= 5 && r.width > window.innerWidth * 0.8 && r.height < window.innerHeight * 0.6) max = Math.max(max, r.height);
        }
      }
      return max / window.innerHeight;
    });
    expect(h, "sticky header share of screen height").toBeLessThan(0.15);
  });

  test("phone notification panel stays on screen at 320 px too @bug-4d-1 @role-boss", async ({ as }) => {
    const s = await as("boss", { device: { width: 320, height: 700 }, path: "/dashboard" });
    await settle(s.page);
    const { viewport, panel } = await openBellPanel(s.page);
    expect(panel).not.toBeNull();
    expect(panel!.left).toBeGreaterThanOrEqual(-1);
    expect(panel!.right).toBeLessThanOrEqual(viewport + 1);
  });
});

test.describe("desktop layout", () => {
  test("1366 px lead detail shows the whole right-hand timeline @bug-4b-11 @bug-4c-23 @role-admin", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: "layout-1366", assignedTo: accounts.salesA.id });
    await admin.page.setViewportSize({ width: 1366, height: 900 });
    await admin.page.goto(`/leads/${id}`);
    await settle(admin.page);
    const clipped = await admin.page.evaluate(() => {
      const vw = window.innerWidth;
      let worst = 0;
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("main *, [class*=card], section"))) {
        const r = el.getBoundingClientRect();
        if (r.width > 40 && r.height > 20) worst = Math.max(worst, r.right - vw);
      }
      return Math.round(worst);
    });
    expect(clipped, "px of content cut off at the right edge").toBeLessThanOrEqual(1);
  });

  test("a very long customer name does not break the detail layout @bug-4d-10 @role-salesA", async ({ as, accounts, target, ns, registry }) => {
    const admin = await as("admin", { path: "/api/health" });
    const id = await seedLead(admin, registry, target, ns, { label: `long-${"x".repeat(180)}`, assignedTo: accounts.salesA.id });
    const s = await as("salesA", { path: `/leads/${id}` });
    await settle(s.page);
    expect(await horizontalOverflow(s.page)).toBeLessThanOrEqual(1);
  });
});

test.describe("team page", () => {
  test("deactivating a member asks first and does not act on one click @bug-4a-9 @bug-4d-14 @role-admin", async ({ as }) => {
    const s = await as("admin", { path: "/team" });
    await settle(s.page);
    const before = await appApi<unknown[] | { users: unknown[] }>(s.page, "GET", "/api/users");
    const trash = s.page.locator("button[aria-label]").filter({ has: s.page.locator("svg.lucide-trash-2") }).first();
    await expect(trash, "a deactivate button for another member").toBeVisible({ timeout: 20_000 });
    await trash.click();
    await s.page.waitForTimeout(1200);
    await expect(s.page.getByRole("dialog"), "confirmation / handover dialog").toBeVisible();
    const after = await appApi<unknown[] | { users: unknown[] }>(s.page, "GET", "/api/users");
    expect(JSON.stringify(after.json)).toBe(JSON.stringify(before.json));
    await s.page.keyboard.press("Escape");
  });

  test("the add-member dialog labels the phone field as phone, not role @bug-4d-15 @role-admin", async ({ as }) => {
    const s = await as("admin", { path: "/team" });
    await settle(s.page);
    await s.page.getByRole("button", { name: /add member|添加成员|新增成员|Add/i }).first().click();
    const dlg = s.page.getByRole("dialog");
    await expect(dlg).toBeVisible();
    const labels = (await dlg.locator("label").allInnerTexts()).map((x) => x.toLowerCase());
    const roleLabels = labels.filter((l) => /role|角色/.test(l));
    expect(roleLabels.length, `labels: ${labels.join(" | ")}`).toBe(1);
    expect(labels.some((l) => /phone|手机|电话/.test(l))).toBe(true);
  });

  test("team page shows last-active times with a number, not a bare 'm ago' @bug-4c-18 @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/team" });
    await settle(s.page);
    const text = await bodyText(s.page);
    expect(text).not.toMatch(/(^|[\s>])m ago/);
    expect(text).not.toMatch(/(^|[\s>])h ago/);
  });
});

test.describe("charts", () => {
  test("analytics chart tooltips never print 'undefined' @bug-4d-19 @role-boss", async ({ as }) => {
    const s = await as("boss", { path: "/analytics" });
    await settle(s.page);
    await s.page.waitForTimeout(1500);
    const hovered: string[] = [];
    const targets = s.page.locator(".recharts-bar-rectangle, .recharts-sector, .recharts-pie-sector, .recharts-dot");
    const n = Math.min(await targets.count(), 14);
    for (let i = 0; i < n; i++) {
      await targets.nth(i).hover({ force: true }).catch(() => undefined);
      const tip = await s.page.locator(".recharts-tooltip-wrapper").first().innerText().catch(() => "");
      if (tip) hovered.push(tip.replace(/\s+/g, " "));
    }
    expect(hovered.filter((t) => /undefined|NaN/.test(t)), "tooltips with undefined").toEqual([]);
  });
});
