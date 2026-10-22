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
  sha256: "b9b608b7a66b9b684bbd99a408ebee37c7d5f9a7edf8691d0494aeef13190748",
  objects: ["whatsapp_privacy.requests", "whatsapp_privacy.suppressions", "whatsapp_privacy.maintenance",
    "public.whatsapp_pilot_events.expires_at", "public.request_whatsapp_deletion(uuid,text)",
    "public.maintain_whatsapp_privacy()", "public.whatsapp_privacy_status()", "newme_whatsapp_maintenance"],
});
const entries = list => Array.isArray(list) ? list.map(({ version, file, sha256 }) => ({ version, file, sha256 })) : null;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function judgePrivacyProvisioning({ live, candidate, sql, phase, recordedVersions = [], existingObjects = [], enabledChannels }) {
  const problems = [];
  if (phase !== "strict") problems.push("live database must already be strict");
  if (!live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("both releases must declare strict compatibility");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app), entries(candidate?.required_for_app))) problems.push("required migration set or content changed");
  const prior = entries(live?.deferred_contract); const next = entries(candidate?.deferred_contract);
  if (!prior?.length || !next || next.length !== prior.length + 1 || !same(prior, next.slice(0, prior.length))) problems.push("candidate must preserve the entire deferred prefix and add exactly one migration");
  if (!same(next?.at(-1), { version: PRIVACY.version, file: PRIVACY.file, sha256: PRIVACY.sha256 }) || prior?.some(e => e.version >= PRIVACY.version)) problems.push("only the exact reviewed privacy suffix is permitted");
  if (!prior?.some(e => e.version === OBSERVER.version && e.file === OBSERVER.file && e.sha256 === OBSERVER.sha256) || !recordedVersions.includes(OBSERVER.version)) problems.push("reviewed observer prerequisite is missing");
  if (enabledChannels !== 0) problems.push("all actual capture channels must remain disabled during provisioning");
  if (createHash("sha256").update(String(sql ?? "").replaceAll("\r\n", "\n")).digest("hex") !== PRIVACY.sha256) problems.push("privacy SQL does not match the reviewed immutable hash");
  const recorded = recordedVersions.includes(PRIVACY.version);
  for (const object of PRIVACY.objects) {
    if (existingObjects.includes(object) !== recorded) problems.push(`${object}: object presence and recorded privacy migration disagree`);
  }
  return { problems, version: PRIVACY.version, alreadyRecorded: recorded };
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
  const url = readUrlFile(flags.get("--url-file"));
  const phase = await readLiveMode(url, flags.get("--modules-dir"));
  const { Client } = loadPg(flags.get("--modules-dir"));
  const client = new Client({ connectionString: url, application_name: "newme-whatsapp-privacy-gate", connectionTimeoutMillis: 15000, statement_timeout: 15000 });
  let state;
  try {
    await client.connect(); await client.query("begin read only");
    const recordedVersions = (await client.query("select version from supabase_migrations.schema_migrations where version=any($1::text[])", [[OBSERVER.version, PRIVACY.version]])).rows.map(r => r.version);
    const objects = (await client.query(`select name, present from (
      select unnest(array['whatsapp_privacy.requests','whatsapp_privacy.suppressions','whatsapp_privacy.maintenance']) name,
        unnest(array[to_regclass('whatsapp_privacy.requests') is not null,to_regclass('whatsapp_privacy.suppressions') is not null,to_regclass('whatsapp_privacy.maintenance') is not null]) present
      union all select 'public.whatsapp_pilot_events.expires_at',exists(select from information_schema.columns where table_schema='public' and table_name='whatsapp_pilot_events' and column_name='expires_at')
      union all select name,to_regprocedure(name) is not null from unnest(array['public.request_whatsapp_deletion(uuid,text)','public.maintain_whatsapp_privacy()','public.whatsapp_privacy_status()']) name
      union all select 'newme_whatsapp_maintenance',exists(select from pg_roles where rolname='newme_whatsapp_maintenance')
    ) inventory where present`)).rows.map(r => r.name);
    const enabledChannels = Number((await client.query("select count(*) n from public.whatsapp_pilot_channels where enabled")).rows[0].n);
    state = { recordedVersions, existingObjects: objects, enabledChannels };
  } catch (error) { throw new Error(`privacy provisioning database read refused (${error.code ?? error.name})`); }
  finally { await client.end().catch(() => {}); }
  const result = judgePrivacyProvisioning({ live, candidate, sql, phase, ...state });
  if (result.problems.length) throw new Error(result.problems.join("; "));
  console.log(JSON.stringify({ privacy_provisioning: "approved", ...result }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
