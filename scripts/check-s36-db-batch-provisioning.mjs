/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions the S36 + S37 batch, two reviewed files appended last in this order, on a live release that already carries
 * every earlier deferred migration, including S33, the same way check-s33-db-batch-provisioning.mjs did for S33:
 *   20261122200000_quotation_value_follows_quotations.sql  (OS fix S36: leads.quotation_value follows the quotations: three
 *       SECURITY DEFINER routines and three row triggers on quotations / contracts / leads, plus a backfill of empty values)
 *   20261122300000_s37_new_lead_not_dormant.sql            (OS fix S37: trigger routine public.derive_lead_status() replaced
 *       in place so a never-contacted lead created in the last 48 hours is 'hot', not 'dormant')
 *
 * The switch ships on its own first (the manifest then has no S36 / S37 entries and the tree has no S36 / S37 migration
 * file); the judge itself only ever sees live = the release in production and candidate = live plus exactly the two pinned
 * entries and two predicates, i.e. the state after the S37 branch (which carries S36) is merged.
 *
 * Database states: both migrations absent (the S36 objects do not exist and derive_lead_status still carries the old
 * body), both provisioned and recorded, or the one resumable prefix (S36 provisioned and recorded, S37 absent and
 * unrecorded: a provision that failed after S36 committed; plan / provision then apply only S37). An application that is
 * not recorded, a record without the objects, a mismatched object, or S37 recorded before S36 is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S36_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261122200000",
    "file": "20261122200000_quotation_value_follows_quotations.sql",
    "sha256": "56782b7a0e47d907085c8020574b36f1dd5a5ce9dbda22fdaa66615acbc36e0e"
  }),
  Object.freeze({
    "version": "20261122300000",
    "file": "20261122300000_s37_new_lead_not_dormant.sql",
    "sha256": "f0235899c6c9b84ccf30a80808dc85bdf03efc65ab6d61fec8d2745638fe828b"
  }),
]);
export const S36_PREDICATE_NAMES = Object.freeze([
  "s36-quotation-value-follows-quotations-present",
  "s37-new-lead-not-dormant",
]);
export const S36_PREDICATE_NAME = S36_PREDICATE_NAMES[0];
// Posture: the same predicates the release manifest declares for the two migrations, byte for byte (the manifest
// comparison below requires exactly these to be appended).
//   S36: the three row triggers exist, are not internal and are enabled ('O'), and exactly one routine
//        public.sync_lead_quotation_value(uuid,numeric), SECURITY DEFINER with the pinned search_path, not executable by
//        anon / authenticated.
//   S37: exactly one routine public.derive_lead_status(), SECURITY DEFINER with the pinned search_path, carrying the
//        48-hour marker of the new rule in its body.
// Both answer false, never fail, on a database that has not applied the migration yet.
export const S36_POSTURE_SQL = "SELECT coalesce((SELECT count(*)=3 AND bool_and(NOT t.tgisinternal) FROM pg_catalog.pg_trigger t WHERE t.tgname IN ('trg_quotation_sync_lead_value','trg_contract_sync_lead_value','trg_lead_won_sync_value') AND t.tgenabled='O') AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)')),false)";
export const S37_POSTURE_SQL = "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%48 hours%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.derive_lead_status()')),false)";
// Present: what the gate reads from the live database to call a migration applied. For S36 it is stricter than the manifest
// predicate: all three routines (sync_lead_quotation_value(uuid,numeric), trg_sync_lead_quotation_value(),
// trg_lead_won_sync_quotation_value()) SECURITY DEFINER with the pinned search_path and closed to anon / authenticated, and
// the three triggers on their exact tables, calling their exact routines, not internal, enabled 'O'. For S37 it is the
// manifest predicate.
export const S36_PRESENT_SQL = "SELECT coalesce((SELECT count(*)=3 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid IN (to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)'),to_regprocedure('public.trg_sync_lead_quotation_value()'),to_regprocedure('public.trg_lead_won_sync_quotation_value()'))),false) AND coalesce((SELECT count(*)=3 AND bool_and(NOT t.tgisinternal) AND bool_and(t.tgenabled='O') FROM pg_catalog.pg_trigger t WHERE (t.tgrelid,t.tgname,t.tgfoid) IN ((to_regclass('public.quotations'),'trg_quotation_sync_lead_value',to_regprocedure('public.trg_sync_lead_quotation_value()')),(to_regclass('public.contracts'),'trg_contract_sync_lead_value',to_regprocedure('public.trg_sync_lead_quotation_value()')),(to_regclass('public.leads'),'trg_lead_won_sync_value',to_regprocedure('public.trg_lead_won_sync_quotation_value()')))),false)";
export const S37_PRESENT_SQL = S37_POSTURE_SQL;
// Prior: the state before each migration.
//   S36: none of the three routines and none of the three triggers exist.
//   S37: exactly one public.derive_lead_status() exists and its body does not carry the 48-hour marker (the production
//        body: never contacted -> 'dormant'). A missing routine is not a prior state either.
export const S36_PRIOR_SQL = "SELECT to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)') IS NULL AND to_regprocedure('public.trg_sync_lead_quotation_value()') IS NULL AND to_regprocedure('public.trg_lead_won_sync_quotation_value()') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgname IN ('trg_quotation_sync_lead_value','trg_contract_sync_lead_value','trg_lead_won_sync_value') AND NOT t.tgisinternal)";
export const S37_PRIOR_SQL = "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosrc NOT LIKE '%48 hours%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.derive_lead_status()')),false)";
export const S36_POSTURE = Object.freeze([S36_POSTURE_SQL, S37_POSTURE_SQL]);
export const S36_PRESENT = Object.freeze([S36_PRESENT_SQL, S37_PRESENT_SQL]);
export const S36_PRIOR = Object.freeze([S36_PRIOR_SQL, S37_PRIOR_SQL]);
export const S36_PREDICATES = Object.freeze(S36_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S36_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per migration, S36 first, S37 second.
export function judgeS36DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S36_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S36_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S36_PREDICATES))problems.push("existing posture must be preserved and only the exact S36 and S37 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S36_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S36_EVENTS[0].version)) problems.push("only the reviewed additive S36 and S37 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded history drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded history drift or recorded mismatch");
    }
    // The batch is applied in order, each file in its own transaction (db-phase-push.mjs), so a failure after S36 committed
    // leaves S36 recorded and present with S37 unrecorded and still in its before-state. That exact prefix is resumable:
    // plan / provision then apply only S37. Any other partial record (S37 recorded before S36) is refused; the per-file
    // rule above already refuses an unrecorded application, a record without the objects, or a mismatched object.
    const firstGap=recorded.indexOf(false);
    if (firstGap>=0 && recorded.slice(firstGap).some(Boolean)) problems.push("the S36 and S37 batch is recorded out of order");
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.length===n&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S36 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S36_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S36_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S36_PRIOR[i]}) as "priorMatches",
        (${S36_PRESENT[i]}) as "bodyMatches"`,[S36_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S36 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS36DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s36_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
