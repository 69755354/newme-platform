/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261124300000_s43_leave_cover.sql (OS fix S43, leave cover: three nullable columns on profiles, two check
 * constraints, one partial index, two new SECURITY DEFINER routines set_leave_cover and trg_profiles_cover_admin_only and
 * one BEFORE UPDATE OF trigger; no existing table data, policy or routine is changed) on a live release that already
 * carries every earlier deferred migration, including S39 (20261123100000), the same way check-s39-db-batch-provisioning.mjs
 * did for S39 (one file).
 *
 * The switch ships on its own first (the manifest then has no S43 entry and the tree has no S43 migration file); the
 * judge itself only ever sees live = the release in production and candidate = live plus exactly the pinned entry and
 * predicate, i.e. the state after the S43 branch is merged.
 *
 * Database states: before (none of the S43 objects exists: no cover column, no constraint, no index, neither routine, no
 * trigger), or provisioned and recorded (all of them exist exactly as the migration declares them and the version is
 * recorded). The migration runs in one transaction (db-phase-push.mjs), so a partial apply should not exist; the gate still
 * refuses it explicitly: some objects present and some absent, applied but unrecorded, or recorded without the objects.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S43_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261124300000",
    "file": "20261124300000_s43_leave_cover.sql",
    "sha256": "711f1a261f44d4ac0ed3f5446c752f69eee9616f5cee503b95be8853a4b02358"
  }),
]);
export const S43_PREDICATE_NAMES = Object.freeze([
  "s43-leave-cover",
]);
export const S43_PREDICATE_NAME = S43_PREDICATE_NAMES[0];
// Posture: the same predicate the release manifest declares for the S43 migration, byte for byte (the manifest comparison
// below requires exactly this one to be appended). It reads the three columns, the two constraints, set_leave_cover (definer,
// pinned search_path, marker, authenticated yes / anon no), the trigger routine (definer, pinned search_path, marker) and the
// enabled trigger. It answers false, never fails, on a database that has not applied the migration yet.
export const S43_POSTURE_SQL = "SELECT coalesce((SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name IN ('cover_user_id','cover_start','cover_end')) AND (SELECT count(*)=2 FROM pg_catalog.pg_constraint WHERE conrelid='public.profiles'::regclass AND conname IN ('profiles_cover_not_self','profiles_cover_dates')) AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%leave_cover_not_allowed%') AND bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.set_leave_cover(uuid,uuid,date,date)')) AND (SELECT count(*)=1 AND bool_and(t.tgenabled='O') FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.profiles'::regclass AND t.tgname='profiles_cover_admin_only' AND NOT t.tgisinternal) AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%leave_cover_not_allowed%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.trg_profiles_cover_admin_only()')),false)";
const PINNED_PATH = "bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[])";
const COVER_SQL = "public.set_leave_cover(uuid,uuid,date,date)";
const GUARD_SQL = "public.trg_profiles_cover_admin_only()";
const MARKER = "leave\\_cover\\_not\\_allowed"; // LIKE pattern: underscores escaped (an unescaped one is a wildcard)
const fn = (signature, terms) => `coalesce((SELECT count(*)=1 AND ${terms.join(" AND ")} FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('${signature}')),false)`;
const COLUMNS = ["cover_user_id", "cover_start", "cover_end"];
const CONSTRAINTS = ["profiles_cover_not_self", "profiles_cover_dates"];
const TRIGGER = "profiles_cover_admin_only";
const INDEX = "idx_profiles_cover_user";
const colList = COLUMNS.map(c => `'${c}'`).join(",");
const conList = CONSTRAINTS.map(c => `'${c}'`).join(",");
// Present: what the gate reads to call the migration applied. Stricter than the manifest predicate: also the column types and
// nullability, the check constraints, the partial index, the grants the file pins (set_leave_cover: authenticated and
// service_role yes, anon no; the trigger routine: anon and authenticated no) and the trigger bound to exactly that routine.
export const S43_PRESENT_SQL = "SELECT "
  + `coalesce((SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND is_nullable='YES' AND ((column_name='cover_user_id' AND data_type='uuid') OR (column_name IN ('cover_start','cover_end') AND data_type='date'))),false)`
  + ` AND coalesce((SELECT count(*)=2 FROM pg_catalog.pg_constraint WHERE conrelid='public.profiles'::regclass AND contype='c' AND conname IN (${conList})),false)`
  + ` AND to_regclass('public.${INDEX}') IS NOT NULL`
  + " AND " + fn(COVER_SQL, ["bool_and(p.prosecdef)", PINNED_PATH, `bool_and(p.prosrc LIKE '%${MARKER}%')`,
    "bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE'))", "bool_and(has_function_privilege('service_role',p.oid,'EXECUTE'))", "bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE'))"])
  + " AND " + fn(GUARD_SQL, ["bool_and(p.prosecdef)", PINNED_PATH, `bool_and(p.prosrc LIKE '%${MARKER}%')`,
    "bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE'))", "bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE'))"])
  + ` AND coalesce((SELECT count(*)=1 AND bool_and(t.tgenabled='O') AND bool_and(t.tgfoid=to_regprocedure('${GUARD_SQL}')) AND bool_and(t.tgtype & 2 = 2) AND bool_and(t.tgtype & 16 = 16) FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.profiles'::regclass AND t.tgname='${TRIGGER}' AND NOT t.tgisinternal),false)`;
// Prior: the state before the migration: none of the S43 objects exists.
export const S43_PRIOR_SQL = "SELECT "
  + `coalesce((SELECT count(*)=0 FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' AND column_name IN (${colList})),false)`
  + ` AND coalesce((SELECT count(*)=0 FROM pg_catalog.pg_constraint WHERE conrelid='public.profiles'::regclass AND conname IN (${conList})),false)`
  + ` AND to_regclass('public.${INDEX}') IS NULL`
  + ` AND to_regprocedure('${COVER_SQL}') IS NULL AND to_regprocedure('${GUARD_SQL}') IS NULL`
  + ` AND coalesce((SELECT count(*)=0 FROM pg_catalog.pg_trigger t WHERE t.tgrelid='public.profiles'::regclass AND t.tgname='${TRIGGER}'),false)`;
export const S43_POSTURE = Object.freeze([S43_POSTURE_SQL]);
export const S43_PRESENT = Object.freeze([S43_PRESENT_SQL]);
export const S43_PRIOR = Object.freeze([S43_PRIOR_SQL]);
export const S43_PREDICATES = Object.freeze(S43_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S43_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S43 migration.
export function judgeS43DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S43_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S43_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S43_PREDICATES))problems.push("existing posture must be preserved and only the exact S43 predicate appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S43_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S43_EVENTS[0].version)) problems.push("only the reviewed additive S43 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded history drift or recorded mismatch");
  else {
    // One file, one transaction: either the S43 objects carry the old bodies and nothing is recorded, or all of them are present
    // the new bodies and the version is recorded. Anything else (some routines new and some old, applied but unrecorded,
    // recorded but still old, a routine missing) is refused.
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded history drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.length===n&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S43 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S43_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S43_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S43_PRIOR[i]}) as "priorMatches",
        (${S43_PRESENT[i]}) as "bodyMatches"`,[S43_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S43 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS43DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s43_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
