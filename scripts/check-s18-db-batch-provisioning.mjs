/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261118200000_whatsapp_ctwa_leads.sql (OS fix S18, Click-to-WhatsApp ad
 * leads) on a live release that already carries every earlier deferred migration
 * (including both S16 files), the same way check-s16-db-batch-provisioning.mjs did for S16.
 *
 * The switch ships on its own first (the manifest then has no S18 entry and the tree has no
 * S18 migration file); the judge itself only ever sees live = the release in production and
 * candidate = live plus exactly the pinned entry and predicate, i.e. the state after the S18
 * branch is merged.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S18_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261118200000",
    "file": "20261118200000_whatsapp_ctwa_leads.sql",
    "sha256": "ec95ce21ec6ddbb938b250287893dcc5eeef8c95dda29359ca6a15ab9352100d"
  }),
]);
export const S18_PREDICATE_NAMES = Object.freeze([
  "s18-whatsapp-ctwa-leads-present",
]);
export const S18_PREDICATE_NAME = S18_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S18 migration (three
// server-only tables with row security and no client privileges, the service-role writer with a
// pinned search path, and the five lead columns).
export const S18_POSTURE_SQL = "SELECT (SELECT count(*)=3 AND bool_and(c.relrowsecurity) AND bool_and(NOT has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')) AND bool_and(NOT has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')) FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relname IN ('whatsapp_conversations','whatsapp_message_events','whatsapp_capi_events') AND c.relkind='r') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND has_function_privilege('service_role',p.oid,'EXECUTE')) AND (SELECT count(*)=5 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name IN ('ctwa_clid','wa_first_inbound_at','wa_first_reply_at','wa_ad_headline','wa_ad_source_url'))";
// Prior: nothing of the migration exists yet (none of the five lead columns, none of the three
// tables, no writer routine), so an unrecorded partial application is refused.
export const S18_PRIOR_SQL = "SELECT (SELECT count(*)=0 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name IN ('ctwa_clid','wa_first_inbound_at','wa_first_reply_at','wa_ad_headline','wa_ad_source_url')) AND to_regclass('public.whatsapp_conversations') IS NULL AND to_regclass('public.whatsapp_message_events') IS NULL AND to_regclass('public.whatsapp_capi_events') IS NULL AND to_regprocedure('public.record_whatsapp_ad_event(jsonb,boolean)') IS NULL";
export const S18_POSTURE = Object.freeze([S18_POSTURE_SQL]);
export const S18_PRIOR = Object.freeze([S18_PRIOR_SQL]);
export const S18_PREDICATES = Object.freeze(S18_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S18_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S18 migration.
export function judgeS18DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S18_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S18_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S18_PREDICATES))problems.push("existing posture must be preserved and only the exact S18 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S18_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S18_EVENTS[0].version)) problems.push("only the reviewed additive S18 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded WhatsApp lead drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded WhatsApp lead drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S18 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S18_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S18_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S18_PRIOR[i]}) as "priorMatches",
        (${S18_POSTURE[i]}) as "bodyMatches"`,[S18_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S18 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS18DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s18_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
