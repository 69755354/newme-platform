// S38: global visual fixes (UX review batch 3): font, type scale, calm colours, no emoji, one format.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { translatedOrRaw } from "../../src/lib/chart-labels.mjs";
import { formatAED, formatDateTime, formatShortDate } from "../../src/lib/display-format.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
function walk(dir, out = []) {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) walk(rel, out);
    else if (/\.(tsx|ts|mjs)$/.test(e.name)) out.push(rel);
  }
  return out;
}
const SRC = walk("src");

test("the sans font is not defined as a reference to itself", () => {
  const css = read("src/app/globals.css");
  assert.doesNotMatch(css, /--font-sans:\s*var\(--font-sans\)/);
  assert.match(css, /--font-sans:\s*var\(--font-geist-sans\)[^;]*"PingFang SC"/);
});

test("no UI text is smaller than 12px", () => {
  const offenders = [];
  for (const f of SRC) {
    const text = read(f);
    if (/text-\[(?:[0-9]|1[01])(?:\.\d+)?px\]/.test(text) || /fontSize:\s*(?:[0-9]|1[01])\b/.test(text)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test("no emoji in the interface (check marks stay)", () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{2612}\u{2614}-\u{2712}\u{2714}-\u{27BF}\u{2B50}\u{23F0}\u{26A0}\u{FE0F}]/u;
  const offenders = SRC.filter((f) => !/device-catalog|\/api\/|cron/.test(f) && emoji.test(read(f)));
  assert.deepEqual(offenders, []);
});

function lum(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("status colours meet WCAG AA (4.5:1) as text on their tint", () => {
  // Tailwind palette values for the classes used in src/lib/status-palette.ts
  const pairs = {
    "stone-700 on stone-100": ["#44403C", "#F5F5F4"],
    "slate-700 on slate-100": ["#334155", "#F1F5F9"],
    "amber-800 on amber-100": ["#92400E", "#FEF3C7"],
    "emerald-800 on emerald-100": ["#065F46", "#D1FAE5"],
  };
  const palette = read("src/lib/status-palette.ts");
  for (const cls of ["bg-stone-100 text-stone-700", "bg-slate-100 text-slate-700", "bg-amber-100 text-amber-800", "bg-emerald-100 text-emerald-800"]) assert.ok(palette.includes(cls), cls);
  for (const [name, [fg, bg]] of Object.entries(pairs)) assert.ok(ratio(fg, bg) >= 4.5, `${name}: ${ratio(fg, bg).toFixed(2)}`);
});

test("stages use one calm palette: grey / one slate / green", async () => {
  const { STAGE_TONE } = await import("../../src/lib/status-palette.ts").catch(() => ({ STAGE_TONE: null }));
  const text = read("src/lib/status-palette.ts");
  const tones = new Set([...text.matchAll(/^\s+\w+: "(neutral|active|attention|won)",$/gm)].map((m) => m[1]));
  assert.deepEqual([...tones].sort(), ["active", "neutral", "won"]);
  void STAGE_TONE;
  const types = read("src/shared/kanban/types.ts");
  assert.doesNotMatch(types, /purple|blue|yellow|#8B5CF6|#3B82F6|#F59E0B/);
});

test("lead card: only a truly overdue follow-up uses the warning colour", () => {
  const card = read("src/app/(dashboard)/leads/_components/LeadCard.tsx");
  assert.equal((card.match(/urgent: true/g) || []).length, 1);
  assert.match(card, /actionOverdue"\), urgent: true/);
});

test("money and dates have one format", () => {
  assert.equal(formatAED(12345.4), "AED 12,345");
  assert.equal(formatAED(1500000), "AED 1,500,000");
  assert.equal(formatShortDate("2026-11-22", "en", new Date("2026-11-23T08:00:00Z")), "22 Nov");
  assert.equal(formatDateTime("2026-11-22", "zh", new Date("2026-11-23T08:00:00Z")), "11月22日");
  assert.equal(formatDateTime("2026-11-22T10:05:00Z", "en", new Date("2026-11-23T08:00:00Z")), "22 Nov 14:05");
  for (const f of ["src/app/(dashboard)/leads/_utils/format.ts", "src/app/(dashboard)/pipeline/_components/LeadCard.tsx", "src/app/(dashboard)/leads/[id]/utils.ts", "src/shared/utils/format.ts"]) {
    assert.doesNotMatch(read(f), /toFixed\(\d\)\}[MK]/, f);
  }
});

test("a stored snake_case code is never shown raw", () => {
  const t = (p) => ({ "sourceLabels.fb": "FB" })[p] ?? p;
  assert.equal(translatedOrRaw(t, "sourceLabels.unknown_import", "unknown_import"), "Unknown import");
  assert.equal(translatedOrRaw(t, "x.pending_ceo", "pending_ceo"), "Pending ceo");
  assert.equal(translatedOrRaw(t, "sourceLabels.fb", "fb"), "FB");
  assert.equal(translatedOrRaw(t, "sourceLabels.Spring Sale", "Spring Sale"), "Spring Sale");
});
