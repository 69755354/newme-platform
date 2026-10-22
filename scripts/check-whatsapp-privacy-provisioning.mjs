/** A separate exact-hash gate; the existing observer-only gate is unchanged. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";
import { OBSERVER } from "./check-whatsapp-provisioning.mjs";

export const PRIVACY = Object.freeze({
  version: "20261022194620", file: "20261022194620_whatsapp_privacy_lifecycle.sql",
  sha256: "8b0a7d9fde56398884d0274f44cf3091c9664d9d2b64c241c4efb4e87ff608c4",
  objects: ["schema:whatsapp_privacy", "whatsapp_privacy.requests", "whatsapp_privacy.suppressions", "whatsapp_privacy.maintenance",
    "whatsapp_privacy.requests_pkey", "whatsapp_privacy.suppressions_pkey", "whatsapp_privacy.maintenance_pkey",
    "whatsapp_privacy.whatsapp_privacy_requests_pending", "whatsapp_privacy.whatsapp_privacy_requests_expiry",
    "whatsapp_privacy.whatsapp_privacy_suppressions_expiry", "public.whatsapp_pilot_events_expiry", "public.whatsapp_pilot_events_customer_time",
    "whatsapp_privacy.lock_pilot()", "whatsapp_privacy.admit_event()", "whatsapp_privacy.check_commit_age()",
    "whatsapp_privacy.process_requests()", "whatsapp_privacy.reset_after_restore()",
    "trigger:whatsapp_privacy_admission", "trigger:whatsapp_privacy_commit_age", "policy:whatsapp_privacy_maintenance",
    "public.whatsapp_pilot_events.expires_at", "public.request_whatsapp_deletion(uuid,text)",
    "public.maintain_whatsapp_privacy()", "public.whatsapp_privacy_status()", "newme_whatsapp_maintenance"],
});
export const PRIVACY_REPAIR = Object.freeze({
  version: "20261023020000", file: "20261023020000_whatsapp_privacy_rpc_owner.sql",
  sha256: "0cd32f6d1316b391838bcf4ce5742bca577f1db708ae13363302927494cff425",
});
const entries = list => Array.isArray(list) ? list.map(({ version, file, sha256 }) => ({ version, file, sha256 })) : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function judgePrivacyProvisioning({ live, candidate, sql, repairSql, phase, recordedVersions = [], existingObjects = [], ownershipMismatches, enabledChannels }) {
  const problems = [];
  if (phase !== "strict") problems.push("live database must already be strict");
  if (!live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("both releases must declare strict compatibility");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app), entries(candidate?.required_for_app))) problems.push("required migration set or content changed");
  const prior = entries(live?.deferred_contract); const next = entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior, next.slice(0, prior.length))) problems.push("candidate must preserve the entire deferred prefix");
  const original = { version: PRIVACY.version, file: PRIVACY.file, sha256: PRIVACY.sha256 };
  const repairEntry = { version: PRIVACY_REPAIR.version, file: PRIVACY_REPAIR.file, sha256: PRIVACY_REPAIR.sha256 };
  const suffix = next?.slice(prior?.length ?? 0);
  const initial = same(suffix, [original]) && !prior?.some(e => e.version >= PRIVACY.version);
  const repair = recordedVersions.includes(PRIVACY.version) &&
    ((same(suffix, [original, repairEntry]) && !prior?.some(e => e.version >= PRIVACY.version)) ||
     (same(prior?.at(-1), original) && same(suffix, [repairEntry])));
  if (!initial && !repair) problems.push("only the exact reviewed privacy suffix or recorded-privacy repair suffix is permitted; no additional migrations");
  if (recordedVersions.includes(PRIVACY_REPAIR.version) && !repair) problems.push("recorded privacy repair must remain declared");
  if (repair && createHash("sha256").update(String(repairSql ?? "").replaceAll("\r\n", "\n")).digest("hex") !== PRIVACY_REPAIR.sha256) problems.push("repair SQL does not match the reviewed immutable hash");
  if (!prior?.some(e => e.version === OBSERVER.version && e.file === OBSERVER.file && e.sha256 === OBSERVER.sha256) || !recordedVersions.includes(OBSERVER.version)) problems.push("reviewed observer prerequisite is missing");
  if (enabledChannels !== 0) problems.push("all actual capture channels must remain disabled during provisioning");
  if (createHash("sha256").update(String(sql ?? "").replaceAll("\r\n", "\n")).digest("hex") !== PRIVACY.sha256) problems.push("privacy SQL does not match the reviewed immutable hash");
  const recorded = recordedVersions.includes(PRIVACY.version);
  if (!Array.isArray(ownershipMismatches) || ownershipMismatches.length) problems.push("privacy object ownership is missing or differs from the reviewed owners");
  for (const object of PRIVACY.objects) {
    if (existingObjects.includes(object) !== recorded) problems.push(`${object}: object presence and recorded privacy migration disagree`);
  }
  return { problems, version: repair ? PRIVACY_REPAIR.version : PRIVACY.version, alreadyRecorded: repair ? recordedVersions.includes(PRIVACY_REPAIR.version) : recorded };
}

async function main(argv) {
  const flags = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    if (!["--live-release", "--candidate-release", "--url-file", "--modules-dir"].includes(argv[i]) || !argv[i + 1] || flags.has(argv[i])) throw new Error("invalid privacy provisioning arguments");
    flags.set(argv[i], argv[i + 1]);
  }
  for (const name of ["--live-release", "--candidate-release", "--url-file", "--modules-dir"]) if (!flags.has(name)) throw new Error(`${name} is required`);
  const live = readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate = readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql = fs.readFileSync(path.join(flags.get("--candidate-release"), "supabase/migrations", PRIVACY.file), "utf8");
  const repairSql = candidate.deferred_contract.some(e => e.version === PRIVACY_REPAIR.version)
    ? fs.readFileSync(path.join(flags.get("--candidate-release"), "supabase/migrations", PRIVACY_REPAIR.file), "utf8") : undefined;
  const url = readUrlFile(flags.get("--url-file"));
  const phase = await readLiveMode(url, flags.get("--modules-dir"));
  const { Client } = loadPg(flags.get("--modules-dir"));
  const client = new Client({ connectionString: url, application_name: "newme-whatsapp-privacy-gate", connectionTimeoutMillis: 15000, statement_timeout: 15000 });
  let state;
  try {
    await client.connect(); await client.query("begin read only");
    const recordedVersions = (await client.query("select version from supabase_migrations.schema_migrations where version=any($1::text[])", [[OBSERVER.version, PRIVACY.version, PRIVACY_REPAIR.version]])).rows.map(r => r.version);
    const inventory = (await client.query(`select name, owner from (
      select 'schema:whatsapp_privacy' name,pg_get_userbyid(nspowner)::text owner from pg_namespace where nspname='whatsapp_privacy'
      union all select n.nspname||'.'||c.relname,pg_get_userbyid(c.relowner)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='whatsapp_privacy' or (n.nspname='public' and c.relname in ('whatsapp_pilot_events_expiry','whatsapp_pilot_events_customer_time'))
      union all select n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',pg_get_userbyid(p.proowner)::text
        from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='whatsapp_privacy'
          or p.oid=any(array[to_regprocedure('public.request_whatsapp_deletion(uuid,text)'),to_regprocedure('public.maintain_whatsapp_privacy()'),to_regprocedure('public.whatsapp_privacy_status()')])
      union all select 'trigger:'||t.tgname,pg_get_userbyid(c.relowner)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where t.tgrelid='public.whatsapp_pilot_events'::regclass and t.tgname in ('whatsapp_privacy_admission','whatsapp_privacy_commit_age')
      union all select 'policy:'||p.polname,pg_get_userbyid(c.relowner)::text from pg_policy p join pg_class c on c.oid=p.polrelid
        where p.polrelid='public.whatsapp_pilot_events'::regclass and p.polname='whatsapp_privacy_maintenance'
    ) inventory`)).rows;
    // oidvectortypes includes a space after commas; API identities are canonical.
    for (const row of inventory) row.name = row.name.replaceAll(', ', ',');
    const ownershipMismatches = inventory.filter(({ name, owner }) => owner !==
      (!recordedVersions.includes(PRIVACY_REPAIR.version) && ["whatsapp_privacy.process_requests()", "public.maintain_whatsapp_privacy()"].includes(name) ? "newme_whatsapp_maintenance" : "postgres")).map(r => r.name);
    if (inventory.some(r => !PRIVACY.objects.includes(r.name))) ownershipMismatches.push("unexpected private object");
    const objects = inventory.map(r => r.name);
    objects.push(...(await client.query(`select name from (
      select 'public.whatsapp_pilot_events.expires_at' name,exists(select from information_schema.columns where table_schema='public' and table_name='whatsapp_pilot_events' and column_name='expires_at') present
      union all select 'newme_whatsapp_maintenance',exists(select from pg_roles where rolname='newme_whatsapp_maintenance')
    ) inventory where present`)).rows.map(r => r.name));
    const enabledChannels = Number((await client.query("select count(*) n from public.whatsapp_pilot_channels where enabled")).rows[0].n);
    state = { recordedVersions, existingObjects: objects, ownershipMismatches, enabledChannels };
  } catch (error) { throw new Error(`privacy provisioning database read refused (${error.code ?? error.name})`); }
  finally { await client.end().catch(() => {}); }
  const result = judgePrivacyProvisioning({ live, candidate, sql, repairSql, phase, ...state });
  if (result.problems.length) throw new Error(result.problems.join("; "));
  console.log(JSON.stringify({ privacy_provisioning: "approved", ...result }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
