/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261121100000_sync_advance_lead_stage_from_sheet.sql (OS fix S33: the service-role routine
 * public.sync_advance_lead_stage_from_sheet(uuid,text,text), which lets the Drive sync move a lead forward, one audited
 * step at a time, up to quotation_submitted when the sales sheet reports a quotation) on a live release that already
 * carries every earlier deferred migration, including S32, the same way check-s32-db-batch-provisioning.mjs did for S32.
 *
 * The switch ships on its own first (the manifest then has no S33 entry and the tree has no S33
 * migration file); the judge itself only ever sees live = the release in production and candidate =
 * live plus exactly the pinned entry and predicate, i.e. the state after the S33 migration branch is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S33_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261121100000",
    "file": "20261121100000_sync_advance_lead_stage_from_sheet.sql",
    "sha256": "4e19cf64d411cfcbe4e77e8da16c3475ca36244f9947f8ece17f220d754a25b2"
  }),
]);
export const S33_PREDICATE_NAMES = Object.freeze([
  "s33-sync-advance-lead-stage-from-sheet-present",
]);
export const S33_PREDICATE_NAME = S33_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S33 migration: exactly one routine
// public.sync_advance_lead_stage_from_sheet(uuid,text,text), SECURITY DEFINER with the pinned search_path, carrying the system
// actor marker, executable by service_role only (not anon, not authenticated). A missing routine answers false.
export const S33_POSTURE_SQL = "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%system:drive_sync%') AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) AND bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)')),false)";
// Prior: the state before this migration: the routine does not exist. A partial or unrecorded application is refused.
export const S33_PRIOR_SQL = "SELECT to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)') IS NULL";
export const S33_POSTURE = Object.freeze([S33_POSTURE_SQL]);
export const S33_PRIOR = Object.freeze([S33_PRIOR_SQL]);
export const S33_PREDICATES = Object.freeze(S33_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S33_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S33 migration.
export function judgeS33DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S33_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S33_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S33_PREDICATES))problems.push("existing posture must be preserved and only the exact S33 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S33_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S33_EVENTS[0].version)) problems.push("only the reviewed additive S33 migration suffix is permitted");
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
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S33 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S33_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S33_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S33_PRIOR[i]}) as "priorMatches",
        (${S33_POSTURE[i]}) as "bodyMatches"`,[S33_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S33 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS33DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s33_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
