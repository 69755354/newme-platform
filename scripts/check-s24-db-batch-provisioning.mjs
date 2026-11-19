/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261119300000_lead_dispatch_and_review.sql (OS fix S24, lead dispatch states, phone review and duplicate review:
 * three new tables with row-level security and no client or service-role writes, plus the evaluation and decision routines) on a live
 * release that already carries every earlier deferred migration, the same way check-s21-db-batch-provisioning.mjs
 * did for S21.
 *
 * The switch ships on its own first (the manifest then has no S24 entry and the tree has no S24
 * migration file); the judge itself only ever sees live = the release in production and candidate =
 * live plus exactly the pinned entry and predicate, i.e. the state after the S24 branch is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S24_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261119300000",
    "file": "20261119300000_lead_dispatch_and_review.sql",
    "sha256": "69b1a4250f23fd013ee716ca50a017e41258cc714955ef11de68814bc2cfdd7c"
  }),
]);
export const S24_PREDICATE_NAMES = Object.freeze([
  "s24-lead-dispatch-review-present",
]);
export const S24_PREDICATE_NAME = S24_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S24 migration (the three tables with
// row-level security and no client or service-role writes, the six service-role routines with a pinned search path,
// and no dispatch column on the leads table).
export const S24_POSTURE_SQL = "SELECT (SELECT count(*)=3 AND bool_and(c.relrowsecurity) AND bool_and(NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')) AND bool_and(NOT has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE')) AND bool_and(NOT has_table_privilege('service_role',c.oid,'INSERT,UPDATE,DELETE')) AND bool_and(has_table_privilege('service_role',c.oid,'SELECT')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('lead_dispatch_state','duplicate_reviews','lead_dispatch_events') AND c.relkind='r') AND (SELECT count(*)=6 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.proname IN ('evaluate_lead_dispatch','dispatch_decide','resolve_duplicate_review','reopen_duplicate_review','sweep_lead_dispatch','dispatch_record_event') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')) AND (SELECT count(*)=0 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name IN ('dispatch_status','routing_note'))";
// Prior: the state before this migration: none of the three tables and none of the routines exist. A partial or
// unrecorded application is refused.
export const S24_PRIOR_SQL = "SELECT to_regclass('public.lead_dispatch_state') IS NULL AND to_regclass('public.duplicate_reviews') IS NULL AND to_regclass('public.lead_dispatch_events') IS NULL AND to_regprocedure('public.dispatch_phone_norm(text)') IS NULL AND to_regprocedure('public.dispatch_phone_flag(text)') IS NULL AND to_regprocedure('public.dispatch_is_test_pattern(text,text)') IS NULL AND to_regprocedure('public.evaluate_lead_dispatch(uuid,uuid)') IS NULL AND to_regprocedure('public.dispatch_decide(uuid,uuid,text,text)') IS NULL AND to_regprocedure('public.resolve_duplicate_review(uuid,uuid,text,text)') IS NULL AND to_regprocedure('public.reopen_duplicate_review(uuid,uuid,text)') IS NULL AND to_regprocedure('public.sweep_lead_dispatch(timestamptz,integer)') IS NULL AND to_regprocedure('public.dispatch_record_event(uuid,text,text,text,uuid,text)') IS NULL";
export const S24_POSTURE = Object.freeze([S24_POSTURE_SQL]);
export const S24_PRIOR = Object.freeze([S24_PRIOR_SQL]);
export const S24_PREDICATES = Object.freeze(S24_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S24_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S24 migration.
export function judgeS24DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S24_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S24_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S24_PREDICATES))problems.push("existing posture must be preserved and only the exact S24 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S24_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S24_EVENTS[0].version)) problems.push("only the reviewed additive S24 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded dispatch drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded dispatch drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S24 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S24_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S24_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S24_PRIOR[i]}) as "priorMatches",
        (${S24_POSTURE[i]}) as "bodyMatches"`,[S24_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S24 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS24DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s24_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
