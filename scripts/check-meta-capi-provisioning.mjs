/** Exact additive suffix only; never weakens the existing strict-prefix gate. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const CAPI_EVENT = Object.freeze({
  "version": "20261025151000",
  "file": "20261025151000_website_capi_delivery_event.sql",
  "sha256": "67329b240a724e51a14f632576584a92eed9e59c56c5a8eff1e0e920935d524a"
});
export const CAPI_EVENT_POSTURE_SQL = "SELECT coalesce((SELECT contype='c' AND NOT convalidated AND encode(sha256(convert_to(pg_get_constraintdef(oid),'UTF8')),'hex')='b148b0597bde5c74974176f275ace685d50c888e3885e25cc8fa1408e48a8682' FROM pg_constraint WHERE conrelid='public.business_events'::regclass AND conname='chk_event_type'),false)";
export const CAPI_EVENT_PRIOR_SQL = "SELECT coalesce((SELECT contype='c' AND NOT convalidated AND encode(sha256(convert_to(pg_get_constraintdef(oid),'UTF8')),'hex')='dfd24c8549869aa0dbdd03a919f6e79a623c095d1b5be8664b4ac5d02adc974e' FROM pg_constraint WHERE conrelid='public.business_events'::regclass AND conname='chk_event_type'),false)";
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function judgeCapiProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches}) {
  const problems=[];
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.pop();
  if(!same(reducedPosture,live?.posture)||!same(added,{name:'meta-capi-delivery-event-type-allowed',expect:true,sql:CAPI_EVENT_POSTURE_SQL}))problems.push('existing posture must be preserved and only the exact CAPI event predicate appended');
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.pop();
  priorManifest.posture?.deferred_contract?.predicates?.pop();
  if(!same(priorManifest,live))problems.push('all prior manifest declarations must remain identical');
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),[CAPI_EVENT]) || prior.some(x=>x.version>=CAPI_EVENT.version)) problems.push("only the reviewed additive CAPI event suffix is permitted");
  if (createHash("sha256").update(String(sql??"").replaceAll("\r\n","\n")).digest("hex")!==CAPI_EVENT.sha256) problems.push("reviewed SQL hash mismatch");
  if (typeof recorded!=="boolean" || typeof priorMatches!=="boolean" || typeof bodyMatches!=="boolean" || (recorded ? bodyMatches!==true || priorMatches!==false : priorMatches!==true || bodyMatches!==false)) problems.push("unrecorded constraint drift or recorded body mismatch");
  return {problems,alreadyRecorded:recorded===true};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid CAPI provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",CAPI_EVENT.file),"utf8");
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state=(await client.query(`select
      exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
      (${CAPI_EVENT_PRIOR_SQL}) as "priorMatches",
      (${CAPI_EVENT_POSTURE_SQL}) as "bodyMatches"`,[CAPI_EVENT.version])).rows[0];
  } catch(error) {throw Error(`CAPI provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeCapiProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({capi_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
