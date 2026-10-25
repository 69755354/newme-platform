/** Exact additive suffix only; never weakens the existing strict-prefix gate. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const CRM_EVENT = Object.freeze({
  "version": "20261025180000",
  "file": "20261025180000_meta_crm_lead_stage_events.sql",
  "sha256": "21a3da79167aa95aae254e000feb9b73966fb9a59e5c8db4d7ed1ebeaa13f4f2"
});
export const CRM_PREDICATE_NAME = "meta-crm-lead-stage-schema-present";
// Present: the column exists; the outbox has RLS on, no client table rights and the session boundary.
export const CRM_POSTURE_SQL = "SELECT coalesce((SELECT to_regclass('public.meta_crm_stage_events') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='meta_leadgen_id' AND data_type='text') AND (SELECT c.relrowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AND EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND t.tgname='trg_require_current_session' AND NOT t.tgisinternal) FROM pg_class c WHERE c.oid=to_regclass('public.meta_crm_stage_events'))),false)";
// Prior: neither object exists, so an unrecorded partial application is refused.
export const CRM_PRIOR_SQL = "SELECT to_regclass('public.meta_crm_stage_events') IS NULL AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='meta_leadgen_id')";
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function judgeCrmProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches}) {
  const problems=[];
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.pop();
  if(!same(reducedPosture,live?.posture)||!same(added,{name:CRM_PREDICATE_NAME,expect:true,sql:CRM_POSTURE_SQL}))problems.push("existing posture must be preserved and only the exact CRM schema predicate appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.pop();
  priorManifest.posture?.deferred_contract?.predicates?.pop();
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),[CRM_EVENT]) || prior.some(x=>x.version>=CRM_EVENT.version)) problems.push("only the reviewed additive CRM schema suffix is permitted");
  if (createHash("sha256").update(String(sql??"").replaceAll("\r\n","\n")).digest("hex")!==CRM_EVENT.sha256) problems.push("reviewed SQL hash mismatch");
  if (typeof recorded!=="boolean" || typeof priorMatches!=="boolean" || typeof bodyMatches!=="boolean" || (recorded ? bodyMatches!==true || priorMatches!==false : priorMatches!==true || bodyMatches!==false)) problems.push("unrecorded schema drift or recorded schema mismatch");
  return {problems,alreadyRecorded:recorded===true};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid CRM provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",CRM_EVENT.file),"utf8");
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state=(await client.query(`select
      exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
      (${CRM_PRIOR_SQL}) as "priorMatches",
      (${CRM_POSTURE_SQL}) as "bodyMatches"`,[CRM_EVENT.version])).rows[0];
  } catch(error) {throw Error(`CRM provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeCrmProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({crm_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
