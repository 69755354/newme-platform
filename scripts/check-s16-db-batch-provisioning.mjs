/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261112100000_notification_constraints_and_lead_owner_contracts.sql and
 * 20261112100100_notification_warning_type.sql
 * (OS fix S16) on a live release that already carries every earlier deferred
 * migration, the same way check-s2-role-provisioning.mjs did for S2.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S16_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261112100000",
    "file": "20261112100000_notification_constraints_and_lead_owner_contracts.sql",
    "sha256": "29a9292957038b081b5265ae4f1afc95dc6c4b78df65365a1db51a2ab4dd9e59"
  }),
  Object.freeze({
    "version": "20261112100100",
    "file": "20261112100100_notification_warning_type.sql",
    "sha256": "dc3f19f12811f4682f1570c406162582dd5547d61d6c00e5672e47ab7375d5be"
  }),
]);
export const S16_PREDICATE_NAMES = Object.freeze([
  "s16-notification-constraints-and-lead-owner-present",
  "s16-notification-warning-type-present",
]);
export const S16_PREDICATE_NAME = S16_PREDICATE_NAMES[0];
// Present: both notification checks list the new values (and still the old ones), and the
// conversion routine takes the contract owner from the lead (the same predicate the release
// manifest declares for the first S16 migration).
export const S16_POSTURE_SQL = `SELECT (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.notifications') AND conname='notifications_type_check' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%''contract_created''::%' AND pg_get_constraintdef(oid) LIKE '%''reminder''::%' AND pg_get_constraintdef(oid) LIKE '%''team_member_added''::%' AND pg_get_constraintdef(oid) LIKE '%''followup_reminder''::%') AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.notifications') AND conname='notifications_related_type_check' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%''task''::%' AND pg_get_constraintdef(oid) LIKE '%''digest''::%' AND pg_get_constraintdef(oid) LIKE '%''quote''::%') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.convert_quotation_to_contract(uuid,jsonb)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%coalesce(v_lead.assigned_to, v_quote.created_by, v_actor)%')`;
// Prior: neither notification check lists a new value, and the routine still takes the owner
// from the quotation, so an unrecorded partial application is refused.
export const S16_PRIOR_SQL = `SELECT (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.notifications') AND conname='notifications_type_check' AND contype='c' AND pg_get_constraintdef(oid) NOT LIKE '%''contract_created''::%' AND pg_get_constraintdef(oid) NOT LIKE '%''reminder''::%' AND pg_get_constraintdef(oid) LIKE '%''team_member_added''::%') AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.notifications') AND conname='notifications_related_type_check' AND contype='c' AND pg_get_constraintdef(oid) NOT LIKE '%''task''::%' AND pg_get_constraintdef(oid) NOT LIKE '%''digest''::%' AND pg_get_constraintdef(oid) LIKE '%''quote''::%') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.convert_quotation_to_contract(uuid,jsonb)') AND p.prosecdef AND p.prosrc LIKE '%coalesce(v_quote.created_by, v_actor), v_actor%' AND p.prosrc NOT LIKE '%v_lead.assigned_to, v_quote.created_by%')`;
// Second migration: the type check also lists 'warning' (the no-answer alert).
export const S16_WARNING_POSTURE_SQL = `SELECT (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.notifications') AND conname='notifications_type_check' AND contype='c' AND convalidated AND pg_get_constraintdef(oid) LIKE '%''warning''::%' AND pg_get_constraintdef(oid) LIKE '%''contract_created''::%' AND pg_get_constraintdef(oid) LIKE '%''team_member_added''::%')`;
export const S16_WARNING_PRIOR_SQL = `SELECT (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.notifications') AND conname='notifications_type_check' AND contype='c' AND pg_get_constraintdef(oid) NOT LIKE '%''warning''::%' AND pg_get_constraintdef(oid) LIKE '%''team_member_added''::%')`;
export const S16_POSTURE = Object.freeze([S16_POSTURE_SQL, S16_WARNING_POSTURE_SQL]);
export const S16_PRIOR = Object.freeze([S16_PRIOR_SQL, S16_WARNING_PRIOR_SQL]);
export const S16_PREDICATES = Object.freeze(S16_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S16_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S16 migration.
export function judgeS16DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S16_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S16_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S16_PREDICATES))problems.push("existing posture must be preserved and only the exact S16 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S16_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S16_EVENTS[0].version)) problems.push("only the reviewed additive S16 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded notification/contract-owner drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      // The follow-up file re-states what the first one already did, so once the first is
      // recorded an unrecorded follow-up finds its change in place already.
      const satisfiedByFirst=i===1&&recorded[0]===true&&!recorded[1]&&bodyMatches[1]===true&&priorMatches[1]===false;
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : !satisfiedByFirst && (priorMatches[i]!==true || bodyMatches[i]!==false)) problems.push("unrecorded notification/contract-owner drift or recorded mismatch");
    }
    if (recorded[1] && !recorded[0]) problems.push("the follow-up migration is recorded without the first one");
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S16 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S16_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S16_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S16_PRIOR[i]}) as "priorMatches",
        (${S16_POSTURE[i]}) as "bodyMatches"`,[S16_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S16 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS16DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s16_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
