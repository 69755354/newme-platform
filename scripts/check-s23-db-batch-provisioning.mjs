/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261119200000_opportunities_and_visit_reports.sql (OS fix S23, opportunities and visit reports:
 * three new tables with row-level security and no client writes, plus the visit workflow routines) on a live
 * release that already carries every earlier deferred migration, the same way check-s21-db-batch-provisioning.mjs
 * did for S21.
 *
 * The switch ships on its own first (the manifest then has no S23 entry and the tree has no S23
 * migration file); the judge itself only ever sees live = the release in production and candidate =
 * live plus exactly the pinned entry and predicate, i.e. the state after the S23 branch is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S23_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261119200000",
    "file": "20261119200000_opportunities_and_visit_reports.sql",
    "sha256": "ec1d74ac099997aa0f214b922f6f7c835df77cfa64a18e93b311e9b2eae1bd07"
  }),
]);
export const S23_PREDICATE_NAMES = Object.freeze([
  "s23-opportunities-visit-reports-present",
]);
export const S23_PREDICATE_NAME = S23_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S23 migration (the three tables with
// row-level security and no client writes, the four service-role workflow routines with a pinned search path, the
// stage seed, and no direct update right on the approval and review columns).
export const S23_POSTURE_SQL = "SELECT (SELECT count(*)=3 AND bool_and(c.relrowsecurity) AND bool_and(NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')) AND bool_and(NOT has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE')) AND bool_and(has_table_privilege('service_role',c.oid,'SELECT')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('opportunity_stages','opportunities','visit_reports') AND c.relkind='r') AND (SELECT count(*)=4 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('visit_report_set_plan_approval','visit_report_submit','visit_report_review','flag_overdue_visit_reports') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')) AND EXISTS (SELECT 1 FROM public.opportunity_stages WHERE key='won') AND has_column_privilege('service_role','public.visit_reports','result','UPDATE') AND NOT has_column_privilege('service_role','public.visit_reports','plan_approval','UPDATE') AND NOT has_column_privilege('service_role','public.visit_reports','review_status','UPDATE')";
// Prior: the state before this migration: none of the three tables and none of the routines exist. A partial or
// unrecorded application is refused.
export const S23_PRIOR_SQL = "SELECT to_regclass('public.opportunity_stages') IS NULL AND to_regclass('public.opportunities') IS NULL AND to_regclass('public.visit_reports') IS NULL AND to_regprocedure('public.visit_report_status(text,timestamptz,text,timestamptz,timestamptz)') IS NULL AND to_regprocedure('public.next_working_day_0930(timestamptz)') IS NULL AND to_regprocedure('public.visit_report_set_plan_approval(uuid,uuid,text,text)') IS NULL AND to_regprocedure('public.visit_report_submit(uuid,uuid)') IS NULL AND to_regprocedure('public.visit_report_review(uuid,uuid,text,text,boolean)') IS NULL AND to_regprocedure('public.flag_overdue_visit_reports(timestamptz)') IS NULL";
export const S23_POSTURE = Object.freeze([S23_POSTURE_SQL]);
export const S23_PRIOR = Object.freeze([S23_PRIOR_SQL]);
export const S23_PREDICATES = Object.freeze(S23_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S23_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S23 migration.
export function judgeS23DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S23_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S23_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S23_PREDICATES))problems.push("existing posture must be preserved and only the exact S23 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S23_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S23_EVENTS[0].version)) problems.push("only the reviewed additive S23 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded opportunities drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded opportunities drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S23 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S23_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S23_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S23_PRIOR[i]}) as "priorMatches",
        (${S23_POSTURE[i]}) as "bodyMatches"`,[S23_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S23 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS23DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s23_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
