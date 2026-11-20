/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261120100000_dispatch_and_history_corrections.sql (OS fix S31: four existing service-role routines
 * replaced in place with the same signatures, evaluate_lead_dispatch, dispatch_decide, sweep_lead_dispatch and
 * record_whatsapp_ad_event, plus one new service-role helper, dispatch_reevaluate_dependents) on a live release that
 * already carries every earlier deferred migration, including S24 and S25, the same way
 * check-s25-db-batch-provisioning.mjs did for S25.
 *
 * The switch ships on its own first (the manifest then has no S31 entry and the tree has no S31
 * migration file); the judge itself only ever sees live = the release in production and candidate =
 * live plus exactly the pinned entry and predicate, i.e. the state after the S31 branch is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S31_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261120100000",
    "file": "20261120100000_dispatch_and_history_corrections.sql",
    "sha256": "a51a5dba59b562e0149e60d8b711caa10f3ce2ecbbc8c542ecb8589306e556d6"
  }),
]);
export const S31_PREDICATE_NAMES = Object.freeze([
  "s31-dispatch-and-history-corrections-present",
]);
export const S31_PREDICATE_NAME = S31_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S31 migration (the four replaced routines and the
// new helper carry the S31 marker, stay security definer with a pinned search path and are executable by the service
// role only).
export const S31_POSTURE_SQL = "SELECT (SELECT count(*)=5 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.evaluate_lead_dispatch(uuid,uuid)'),to_regprocedure('public.dispatch_decide(uuid,uuid,text,text)'),to_regprocedure('public.sweep_lead_dispatch(timestamptz,integer)'),to_regprocedure('public.dispatch_reevaluate_dependents(uuid,uuid)'),to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)')) AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%S31 corrective v1%' AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE'))";
// Prior: the state before this migration: the helper does not exist and the four S24/S21 routines exist without the
// S31 marker. A partial or unrecorded application is refused.
export const S31_PRIOR_SQL = "SELECT to_regprocedure('public.dispatch_reevaluate_dependents(uuid,uuid)') IS NULL AND (SELECT count(*)=4 FROM pg_proc p WHERE p.oid IN (to_regprocedure('public.evaluate_lead_dispatch(uuid,uuid)'),to_regprocedure('public.dispatch_decide(uuid,uuid,text,text)'),to_regprocedure('public.sweep_lead_dispatch(timestamptz,integer)'),to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)')) AND p.prosrc NOT LIKE '%S31 corrective v1%')";
export const S31_POSTURE = Object.freeze([S31_POSTURE_SQL]);
export const S31_PRIOR = Object.freeze([S31_PRIOR_SQL]);
export const S31_PREDICATES = Object.freeze(S31_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S31_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S31 migration.
export function judgeS31DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S31_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S31_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S31_PREDICATES))problems.push("existing posture must be preserved and only the exact S31 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S31_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S31_EVENTS[0].version)) problems.push("only the reviewed additive S31 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded history drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded history drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S31 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S31_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S31_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S31_PRIOR[i]}) as "priorMatches",
        (${S31_POSTURE[i]}) as "bodyMatches"`,[S31_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S31 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS31DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s31_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
