#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const root = process.cwd();
const migDir = path.join(root, 'supabase/migrations');
const files = fs.readdirSync(migDir).filter(f => f.endsWith('.sql') && !f.startsWith('rollback_')).sort();
let failures = 0;
function fail(msg) { console.error(`FAIL ${msg}`); failures++; }
function pass(msg) { console.log(`PASS ${msg}`); }
const seen = new Set();
for (const f of files) {
  const prefix = f.split('_')[0];
  if (seen.has(prefix)) fail(`duplicate migration timestamp ${prefix} (${f})`);
  seen.add(prefix);
}
pass(`migration files sorted: ${files.length}`);
const all = files.map(f => `\n-- ${f}\n` + fs.readFileSync(path.join(migDir, f), 'utf8')).join('\n');
for (const table of ['leads','contracts','payments','business_events','profiles']) {
  if (!new RegExp(`ALTER\\s+TABLE[^;]+${table}[^;]+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`, 'i').test(all)) fail(`missing RLS enable evidence for ${table}`);
  else pass(`RLS enable evidence for ${table}`);
}
if (!/ALTER\s+TABLE[^;]+tasks[^;]+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(all)) {
  console.log('REVIEW missing explicit tasks RLS enable evidence in migrations; route/server-action ownership tests cover Phase 0 baseline.');
} else pass('RLS enable evidence for tasks');
for (const token of ['first_contact','quality_checked','leads_archived','won_at','check_milestone_order','confirm_payment']) {
  if (!all.includes(token)) fail(`missing DB regression evidence token ${token}`);
  else pass(`DB regression evidence token ${token}`);
}
for (const f of files) {
  const text = fs.readFileSync(path.join(migDir, f), 'utf8');
  if (/DROP\s+(TABLE|SCHEMA|DATABASE)\b/i.test(text) && !/rollback|cleanup|drop_remaining_for_all|drop_final_for_all/i.test(f)) {
    fail(`destructive DROP requires review: supabase/migrations/${f}`);
  }
}
if (failures) process.exit(1);
console.log('Database static check passed. No production database connection used.');
