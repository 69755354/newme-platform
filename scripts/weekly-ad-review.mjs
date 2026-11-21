#!/usr/bin/env node
// Weekly ad review (Mondays 09:10 Dubai). READ-ONLY on OS data and on Meta: it never changes a campaign, ad or budget.
//   node scripts/weekly-ad-review.mjs             dry run: prints the report, sends and uploads nothing
//   node scripts/weekly-ad-review.mjs --execute   needs WEEKLY_AD_REVIEW_ENABLED=true (switch default OFF); saves the
//                                                 CSV + text, uploads them to the NAS exports folder, sends the WhatsApp summary
// Credentials come only from the server environment (same files as the other senders).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fetchAllRows } from "../src/lib/fetch-all-rows.mjs";
import { EXCLUDE_SYNTHETIC_QA_FILTER } from "../src/lib/lead-metrics.mjs";
import { buildWeeklyAdReview, reviewCsv, reviewMessage, reviewText, reviewWindow } from "../src/lib/weekly-ad-review.mjs";

const LEAD_COLUMNS = "id, campaign_name, ad_id, ad_name, ctwa_clid, created_at, source, source_platform, utm_source, utm_campaign, meta_campaign, fbclid, meta_click_id, quality, ai_quality, quotation_value, archived";
const AD_LEAD_FILTER = "source.in.(ins,fb),source_platform.in.(meta,facebook,instagram,fb,ins),utm_source.in.(meta,facebook,instagram,fb,ins),fbclid.not.is.null,meta_click_id.not.is.null,ctwa_clid.not.is.null,ad_id.not.is.null";

export async function collectReview(db, now = new Date()) {
  const window = reviewWindow(now);
  const spend = await fetchAllRows((from, to, withCount) => db.from("ad_spend")
    .select("id, spend_date, ad_name, amount", withCount ? { count: "exact" } : undefined)
    .gte("spend_date", window.since).lte("spend_date", window.until).order("id", { ascending: true }).range(from, to));
  if (spend.error || spend.truncated) throw new Error("ad_spend unreadable");
  const leads = await fetchAllRows((from, to, withCount) => db.from("leads").select(LEAD_COLUMNS, withCount ? { count: "exact" } : undefined)
    .or(AD_LEAD_FILTER).eq("archived", false).or(EXCLUDE_SYNTHETIC_QA_FILTER)
    .gte("created_at", window.startInstant.toISOString()).lt("created_at", window.endInstant.toISOString())
    .order("id", { ascending: true }).range(from, to));
  if (leads.error || leads.truncated) throw new Error("leads unreadable");
  const quotations = [];
  const ids = (leads.data ?? []).map((l) => l.id);
  for (let i = 0; i < ids.length; i += 200) {
    const q = await fetchAllRows((from, to, withCount) => db.from("quotations")
      .select("id, lead_id, total_amount, currency, status, created_at", withCount ? { count: "exact" } : undefined)
      .in("lead_id", ids.slice(i, i + 200)).order("id", { ascending: true }).range(from, to));
    if (q.error || q.truncated) throw new Error("quotations unreadable");
    quotations.push(...(q.data ?? []));
  }
  return buildWeeklyAdReview({ window, spendRows: spend.data ?? [], leads: leads.data ?? [], quotations });
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: ["ignore", "inherit", "inherit"], timeout: 650_000 });
}

export async function main(argv, env = process.env) {
  const execute = argv.includes("--execute");
  if (argv.some((a) => a !== "--execute")) { console.error("Usage: node scripts/weekly-ad-review.mjs [--execute]"); return 2; }
  if (execute && env.WEEKLY_AD_REVIEW_ENABLED !== "true") { console.log("weekly ad review is switched off (WEEKLY_AD_REVIEW_ENABLED is not true); nothing done"); return 0; }
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) { console.error("database configuration unavailable"); return 1; }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const review = await collectReview(db);
  const text = reviewText(review);
  if (!execute) { console.log(text); console.log(reviewMessage(review)); return 0; }
  const outDir = env.WEEKLY_AD_REVIEW_OUT_DIR || "/var/lib/newme-ad-review";
  const nasDir = env.WEEKLY_AD_REVIEW_NAS_DIR || "/newme-os-backup/exports";
  const nasUpload = env.NAS_UPLOAD_SCRIPT || "/usr/local/libexec/newme/newme-nas-upload.sh";
  const alert = env.ALERT_SCRIPT || "/usr/local/libexec/newme/newme-whatsapp-alert.sh";
  mkdirSync(outDir, { recursive: true });
  const stamp = review.window.until.replaceAll("-", "");
  const csvFile = join(outDir, `ad-review-${stamp}.csv`);
  const txtFile = join(outDir, `ad-review-${stamp}.txt`);
  writeFileSync(csvFile, reviewCsv(review), { mode: 0o600 });
  writeFileSync(txtFile, text, { mode: 0o600 });
  // Same-day reruns overwrite the NAS copy. A NAS failure still lets the WhatsApp summary go out, then fails the unit.
  let failed = false;
  for (const file of [csvFile, txtFile]) {
    try { run(nasUpload, ["--overwrite", file, nasDir]); } catch { failed = true; console.error("NAS upload failed"); }
  }
  try { run(alert, [`weekly-ad-review-${stamp}`, "info", reviewMessage(review, { nasNote: failed ? "" : "详表在NAS的exports文件夹" })]); }
  catch { failed = true; console.error("WhatsApp send failed"); }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, () => { console.error("weekly ad review did not complete"); process.exitCode = 1; });
}
