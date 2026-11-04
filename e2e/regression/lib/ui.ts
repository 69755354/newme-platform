// UI probes shared by several specs.
import type { Page } from "@playwright/test";

/** Visible text of the whole body, whitespace-collapsed. */
export async function bodyText(page: Page): Promise<string> {
  return (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").trim();
}

/** Raw translation keys that leaked into the page: `common.available`, `quotes.won`, ... */
export const RAW_KEY = /\b(common|quotes|leads|team|nav|analytics|dashboard|contracts|payments|pipeline|notifications|settings|workbench|tasks|products|ads)\.[a-zA-Z][a-zA-Z0-9_]*\b/g;
const KEY_ALLOWLIST = /\.(com|ae|net|org|io|png|jpg|svg|pdf|xlsx|csv|js|css)$/i;

export function rawKeysIn(text: string): string[] {
  const hits = text.match(RAW_KEY) ?? [];
  return [...new Set(hits.filter((h) => !KEY_ALLOWLIST.test(h)))];
}

/** Open the notification bell and return the bounding box of the opened panel. */
export async function openBellPanel(page: Page) {
  await page.locator('button[aria-label]').filter({ has: page.locator("svg.lucide-bell") }).first().click();
  await page.waitForTimeout(600);
  return page.evaluate(() => {
    const vw = window.innerWidth;
    let best: { left: number; right: number; width: number; top: number; bottom: number } | null = null;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" || cs.display === "none" || cs.visibility === "hidden") continue;
      const z = Number(cs.zIndex);
      if (!(z >= 1000)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 150 || r.height < 60) continue;
      if (!best || r.width > best.width) best = { left: r.left, right: r.right, width: r.width, top: r.top, bottom: r.bottom };
    }
    return { viewport: vw, panel: best };
  });
}

/** Smallest tappable controls (buttons, links, inputs) under the viewport width. */
export async function smallTapTargets(page: Page, minPx = 40) {
  return page.evaluate((min) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, a[href], input:not([type=hidden]), select, textarea, [role=button]"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      if (r.bottom < 0 || r.top > window.innerHeight) continue; // only what is on screen
      if (r.height < min && r.width < min * 2) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.width)}x${Math.round(r.height)} "${(el.innerText || el.getAttribute("aria-label") || "").trim().slice(0, 20)}"`);
    }
    return out;
  }, minPx);
}

export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}
