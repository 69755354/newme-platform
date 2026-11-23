/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261123100000_s39_stage_rules_relaxed.sql (OS fix S39: seven existing routines replaced in place with
 * CREATE OR REPLACE, same signatures, same security modes, pinned search_path, same grants: a stage or milestone may be
 * skipped going forward, leaving 'new' needs one complete contact record and no quality rating) on a live release that
 * already carries every earlier deferred migration, including the S36 + S37 batch, the same way
 * check-s33-db-batch-provisioning.mjs did for S33 (one file) and check-s36-db-batch-provisioning.mjs for S36 + S37.
 *
 * The switch ships on its own first (the manifest then has no S39 entry and the tree has no S39 migration file); the
 * judge itself only ever sees live = the release in production and candidate = live plus exactly the pinned entry and
 * predicate, i.e. the state after the S39 branch is merged.
 *
 * Database states: before (all seven routines exist exactly once and carry their current production bodies: the old
 * marker of each is present, the new one absent), or provisioned and recorded (all seven carry the new bodies, the modes,
 * search_path and grants the migration pins, and the version is recorded). The migration runs in one transaction
 * (db-phase-push.mjs), so a partial apply should not exist; the gate still refuses it explicitly: some routines new and
 * some old, a routine missing or duplicated, applied but unrecorded, or recorded without the new bodies.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S39_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261123100000",
    "file": "20261123100000_s39_stage_rules_relaxed.sql",
    "sha256": "f37603f9e7a0550b3795d6eb7e06a55220eef6c4caccb5b51ba7bf817415f435"
  }),
]);
export const S39_PREDICATE_NAMES = Object.freeze([
  "s39-stage-rules-relaxed",
]);
export const S39_PREDICATE_NAME = S39_PREDICATE_NAMES[0];
// Posture: the same predicate the release manifest declares for the S39 migration, byte for byte (the manifest comparison
// below requires exactly this one to be appended). It reads six of the seven routines: transition_lead_stage (definer,
// pinned, new marker, authenticated yes / anon no), trg_check_stage_sequence (new message), trg_check_first_contact_gate
// (no NEW.quality), check_milestone_order (definer, new marker), sync_advance_lead_stage_from_sheet (definer, no
// v_lead.quality, service_role yes / authenticated no), recomplete_lead_milestone (definer, pinned, new message,
// authenticated yes / anon no). It answers false, never fails, on a database that has not applied the migration yet.
export const S39_POSTURE_SQL = "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%S39: a stage may be skipped%') AND bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)')) AND (SELECT count(*)=1 AND bool_and(p.prosrc LIKE '%Stage can only move forward%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.trg_check_stage_sequence()')) AND (SELECT count(*)=1 AND bool_and(p.prosrc NOT LIKE '%NEW.quality%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.trg_check_first_contact_gate()')) AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.prosrc LIKE '%skipping a milestone going forward%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.check_milestone_order()')) AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.prosrc NOT LIKE '%v_lead.quality%') AND bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.sync_advance_lead_stage_from_sheet(uuid,text,text)')) AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%An earlier milestone must be completed first%') AND bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.recomplete_lead_milestone(uuid,text,text)')),false)";
// The seven routines the migration replaces, each with one marker that only the production body carries (old) and one that
// only the S39 body carries (new), its security mode after the migration (unchanged by it) and the grants the migration
// pins. Trigger routines keep whatever ACL they have (the migration does not touch it), so none is asserted for them.
// Markers are LIKE patterns: an underscore is a one-character wildcard there, so literal underscores are escaped (\_).
//   old markers come from the bodies production runs today (supabase/replay/production-schema-baseline.sql for the five
//   routines, 20261104110000 for transition_lead_stage, 20261121100000 for the sheet routine); new markers from the S39 file.
export const S39_ROUTINES = Object.freeze([
  Object.freeze({ signature: "public.trg_check_stage_sequence()", definer: false, old: "Stage must advance sequentially", neu: "Stage can only move forward" }),
  Object.freeze({ signature: "public.trg_check_first_contact_gate()", definer: false, old: "NEW.quality", neu: "S39: the lead quality rating is optional" }),
  Object.freeze({ signature: "public.trg_enforce_first_contact_milestone()", definer: true, old: "lead\\_quality", neu: "S39: the lead quality rating is optional" }),
  Object.freeze({ signature: "public.recomplete_lead_milestone(uuid,text,text)", definer: true, old: "Previous milestone must be completed first", neu: "An earlier milestone must be completed first", grants: { authenticated: true, anon: false } }),
  Object.freeze({ signature: "public.check_milestone_order()", definer: true, old: "Cannot skip:", neu: "skipping a milestone going forward" }),
  Object.freeze({ signature: "public.sync_advance_lead_stage_from_sheet(uuid,text,text)", definer: true, old: "v\\_lead.quality", neu: "S39: one complete contact record is enough", grants: { service_role: true, authenticated: false, anon: false } }),
  Object.freeze({ signature: "public.transition_lead_stage(uuid,text,text,text,uuid)", definer: true, old: "v\\_allowed\\_next\\_stage", neu: "S39: a stage may be skipped", grants: { authenticated: true, anon: false } }),
]);
const PINNED_PATH = "bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[])";
const one = (r, terms) => `coalesce((SELECT count(*)=1 AND ${terms.join(" AND ")} FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('${r.signature}')),false)`;
// Present: what the gate reads to call the migration applied. Stricter than the manifest predicate: all SEVEN routines
// (trg_enforce_first_contact_milestone too) exist exactly once, carry the new marker and not the old one, have the pinned
// search_path, the security mode the migration declares (definer for five, invoker for the two stage triggers) and, for the
// three routines whose grants the migration pins, exactly those grants.
export const S39_PRESENT_SQL = "SELECT " + S39_ROUTINES.map(r => one(r, [
  `bool_and(${r.definer ? "" : "NOT "}p.prosecdef)`, PINNED_PATH,
  `bool_and(p.prosrc LIKE '%${r.neu}%')`, `bool_and(p.prosrc NOT LIKE '%${r.old}%')`,
  ...Object.entries(r.grants ?? {}).map(([role, ok]) => `bool_and(${ok ? "" : "NOT "}has_function_privilege('${role}',p.oid,'EXECUTE'))`),
])).join(" AND ");
// Prior: the state before the migration: all seven routines exist exactly once with their production bodies (old marker
// present, new marker absent). A missing or duplicated routine is not a prior state.
export const S39_PRIOR_SQL = "SELECT " + S39_ROUTINES.map(r => one(r, [
  `bool_and(p.prosrc LIKE '%${r.old}%')`, `bool_and(p.prosrc NOT LIKE '%${r.neu}%')`,
])).join(" AND ");
export const S39_POSTURE = Object.freeze([S39_POSTURE_SQL]);
export const S39_PRESENT = Object.freeze([S39_PRESENT_SQL]);
export const S39_PRIOR = Object.freeze([S39_PRIOR_SQL]);
export const S39_PREDICATES = Object.freeze(S39_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S39_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S39 migration.
export function judgeS39DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S39_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S39_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S39_PREDICATES))problems.push("existing posture must be preserved and only the exact S39 predicate appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S39_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S39_EVENTS[0].version)) problems.push("only the reviewed additive S39 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded history drift or recorded mismatch");
  else {
    // One file, one transaction: either all seven routines carry the old bodies and nothing is recorded, or all seven carry
    // the new bodies and the version is recorded. Anything else (some routines new and some old, applied but unrecorded,
    // recorded but still old, a routine missing) is refused.
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded history drift or recorded mismatch");
    }
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.length===n&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S39 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S39_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S39_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S39_PRIOR[i]}) as "priorMatches",
        (${S39_PRESENT[i]}) as "bodyMatches"`,[S39_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S39 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS39DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s39_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
