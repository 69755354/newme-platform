#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const migrationDir = path.join(root, "supabase", "migrations");
const rollbackDir = path.join(root, "supabase", "rollback");
const failures = [];
function fail(message) { failures.push(message); console.error(`FAIL ${message}`); }
function pass(message) { console.log(`PASS ${message}`); }

if (!fs.existsSync(migrationDir)) fail('missing supabase/migrations');
else {
  const files = fs.readdirSync(migrationDir).filter((file) => file.endsWith(".sql")).sort();
  const timestamps = new Set();
  const ordered = [];
  for (const file of files) {
    if (file.startsWith('rollback_')) { fail(`rollback SQL must not be in migration directory: ${file}`); continue; }
    const match = file.match(/^\d{14}_[a-z0-9_]+\.sql$/);
    if (!match) { fail(`migration filename is not timestamped: ${file}`); continue; }
    const [, timestamp] = match;
    if (timestamps.has(timestamp)) fail(`duplicate migration timestamp: ${timestamp}`);
    timestamps.add(timestamp); ordered.push(file);
    const sql = fs.readFileSync(path.join(migrationDir, file), 'utf8');
    const executableSql = sql.replace(/--[^\r\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (/ALTER\s+TABLE\s+TABLE\b/i.test(executableSql)) fail(`duplicate TABLE keyword in migration: ${file}`);
  }
  const required = ['20260723130000_lock_definer_boundaries.sql', '20260723140000_atomic_lead_reassignment.sql', '20260724100000_fix_transition_lead_stage_definer_search_path.sql'];
  const positions = required.map((file) => ordered.indexOf(file));
  if (positions.some((position) => position < 0)) fail(`required SAM-61/SAM-62 migration missing: ${required.join(', ')}`);
  else if (!(positions[0] < positions[1] && positions[1] < positions[2])) fail('SAM-61/SAM-62 migrations are out of order');
  else pass('SAM-61/SAM-62 migrations are present in dependency order');
  const definerPath = path.join(migrationDir, required[0]);
  const definer = fs.existsSync(definerPath) ? fs.readFileSync(definerPath, 'utf8') : '';
  if (!definer.includes("to_regprocedure('public.transition_lead_stage(uuid,text,text,text)'") || !definer.includes("to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)'") ) fail('SAM-61 transition RPC dependency guards are incomplete');
  else pass('SAM-61 transition RPC dependency guards are present');
  const atomicPath = path.join(migrationDir, required[1]);
  const atomic = fs.existsSync(atomicPath) ? fs.readFileSync(atomicPath, 'utf8') : '';
  const drop = atomic.indexOf('DROP FUNCTION IF EXISTS public.transition_lead_stage');
  const create = atomic.indexOf('CREATE FUNCTION public.transition_lead_stage');
  if (drop < 0 || create < 0 || drop > create) fail('SAM-62 does not replace the legacy RPC before creating the active RPC');
  else pass('SAM-62 legacy-to-active RPC replacement is ordered');
  const mvpPath = path.join(migrationDir, '20260602010000_crm_mvp_final.sql');
  const mvp = fs.existsSync(mvpPath) ? fs.readFileSync(mvpPath, 'utf8') : '';
  const repNameDefinition = mvp.indexOf('ADD COLUMN IF NOT EXISTS rep_name');
  const repNameReference = mvp.indexOf('l.rep_name');
  if (repNameDefinition < 0 || repNameReference < 0 || repNameDefinition > repNameReference) fail('crm_mvp_final references leads.rep_name before defining it');
  else pass('crm_mvp_final defines leads.rep_name before the alert view reference');
  const rollbackFiles = fs.existsSync(rollbackDir) ? fs.readdirSync(rollbackDir).filter((file) => file.endsWith('.sql')).sort() : [];
  if (rollbackFiles.length === 0) fail('no manual rollback SQL exists under supabase/rollback');
  else pass(`manual rollback SQL is outside the forward chain: ${rollbackFiles.length} file(s)`);
}
if (process.argv.includes('--apply')) {
  const urlIndex = process.argv.indexOf('--database-url');
  const databaseUrl = urlIndex >= 0 ? process.argv[urlIndex + 1] : '';
  if (!databaseUrl || !process.argv.includes('--allow-nonproduction')) fail('--apply requires --database-url <staging-url> and --allow-nonproduction');
  else if (/newme\.ae|vfopmpxlhwzpxqegayew|production/i.test(databaseUrl)) fail('refusing a URL that looks like production');
  else { console.log('MANUAL APPLY: run supabase db push --db-url <staging-url> --include-all after reviewing the URL.'); pass('clean-room apply gate accepted a non-production URL'); }
}
if (failures.length) { console.error(`Clean-room migration verification failed with ${failures.length} failure(s).`); process.exit(1); }
console.log('Clean-room migration verification passed. No database was contacted.');
