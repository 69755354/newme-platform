/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261119100000_whatsapp_followup_monitor.sql (OS fix S21, WhatsApp conversation text and
 * follow-up monitor) on a live release that already carries every earlier deferred migration (including
 * the S16 and S18 ones), the same way check-s18-db-batch-provisioning.mjs did for S18.
 *
 * The switch ships on its own first (the manifest then has no S21 entry and the tree has no S21
 * migration file); the judge itself only ever sees live = the release in production and candidate =
 * live plus exactly the pinned entry and predicate, i.e. the state after the S21 branch is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S21_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261119100000",
    "file": "20261119100000_whatsapp_followup_monitor.sql",
    "sha256": "afa2212f9f3cf1a08ab384adebea9b316146a0fce5bd5f547bb3f97cb1576d8a"
  }),
]);
export const S21_PREDICATE_NAMES = Object.freeze([
  "s21-whatsapp-followup-monitor-present",
]);
export const S21_PREDICATE_NAME = S21_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S21 migration (the two message
// columns, the server-only follow-up state table, the service-role state writer and the replaced
// WhatsApp writer carrying the S21 marker).
export const S21_POSTURE_SQL = "SELECT (SELECT count(*)=2 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_message_events' AND column_name IN ('body','body_kind')) AND (SELECT c.relrowsecurity AND NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE') AND NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE') AND has_table_privilege('service_role',c.oid,'SELECT') FROM pg_class c WHERE c.oid=to_regclass('public.lead_followup_state')) AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.upsert_lead_followup_state(uuid,timestamptz,timestamptz,integer,integer,timestamptz,text,boolean,text,uuid[],text,text)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')) AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)') AND p.prosecdef AND p.prosrc LIKE '%body_kind%' AND p.prosrc LIKE '%S21 (S18 review, item 1)%' AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE'))";
// Prior: the S18 state before this migration: no message text columns, no follow-up state table, no
// state writer, and the WhatsApp writer is still the S18 version. A partial or unrecorded application is refused.
export const S21_PRIOR_SQL = "SELECT (SELECT count(*)=0 FROM information_schema.columns WHERE table_schema='public' AND table_name='whatsapp_message_events' AND column_name IN ('body','body_kind')) AND to_regclass('public.lead_followup_state') IS NULL AND to_regprocedure('public.upsert_lead_followup_state(uuid,timestamptz,timestamptz,integer,integer,timestamptz,text,boolean,text,uuid[],text,text)') IS NULL AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)') AND p.prosrc NOT LIKE '%body_kind%')";
export const S21_POSTURE = Object.freeze([S21_POSTURE_SQL]);
export const S21_PRIOR = Object.freeze([S21_PRIOR_SQL]);
export const S21_PREDICATES = Object.freeze(S21_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S21_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S21 migration.
export function judgeS21DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S21_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S21_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S21_PREDICATES))problems.push("existing posture must be preserved and only the exact S21 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S21_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S21_EVENTS[0].version)) problems.push("only the reviewed additive S21 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded WhatsApp follow-up drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded WhatsApp follow-up drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S21 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S21_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S21_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S21_PRIOR[i]}) as "priorMatches",
        (${S21_POSTURE[i]}) as "bodyMatches"`,[S21_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S21 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS21DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s21_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
