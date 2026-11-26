/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions the S46 batch, three reviewed files appended last in this order, on a live release that already carries
 * every earlier deferred migration, including S43, the same way check-s36-db-batch-provisioning.mjs did for S36 / S37:
 *   20261126000100_s46_leads_delete_admin_boss_only.sql        (OS fix S46: policy policy_leads_delete_sales dropped and
 *       public.delete_lead_atomic replaced so only admin and boss can delete a lead)
 *   20261126000200_s46_milestone_order_ignores_reopened.sql    (OS fix S46: check_milestone_order ignores reopened milestones)
 *   20261126000300_s46_quotation_value_currency_and_lock.sql   (OS fix S46: quotation value: old quotation currency checked,
 *       foreign-currency contracts kept out of the AED value, lead row locked before recomputing; contract trigger recreated)
 *
 * The switch ships on its own first (the manifest then has no S46 entries and the tree has no S46 migration file); the judge
 * itself only ever sees live = the release in production and candidate = live plus exactly the three pinned entries and
 * three predicates, i.e. the state after the S46 branch is merged.
 *
 * Database states: all three absent (before-state), all three provisioned and recorded, or a resumable prefix (files are
 * applied in order, one transaction each: the first one or two provisioned and recorded, the rest absent and unrecorded; plan /
 * provision then apply only the rest). An application that is not recorded, a record without the objects, a mismatched
 * object, or a later file recorded before an earlier one is refused.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S46_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261126000100",
    "file": "20261126000100_s46_leads_delete_admin_boss_only.sql",
    "sha256": "10f49938f8be9cfc55b126dc3949b1590dce231f83ccceb68bfc159740254d2b"
  }),
  Object.freeze({
    "version": "20261126000200",
    "file": "20261126000200_s46_milestone_order_ignores_reopened.sql",
    "sha256": "7b0acdce349ac897b7292df7045186b7c9f6795ba155920db076c6df88bfd2b9"
  }),
  Object.freeze({
    "version": "20261126000300",
    "file": "20261126000300_s46_quotation_value_currency_and_lock.sql",
    "sha256": "58daac00240afd9e666431755d0abc277ecc744b0f62e8995aff6753de15aebc"
  }),
]);
export const S46_PREDICATE_NAMES = Object.freeze([
  "s46-leads-delete-admin-boss-only",
  "s46-milestone-order-ignores-reopened",
  "s46-quotation-value-currency-and-lock",
]);
export const S46_PREDICATE_NAME = S46_PREDICATE_NAMES[0];
// Posture: the same predicates the release manifest declares for the three migrations, byte for byte (the manifest
// comparison below requires exactly these to be appended).
//   1: the sales delete policy is gone, the admin / boss one stays, and delete_lead_atomic is definer / pinned / closed to anon
//      and no longer names the sales role.
//   2: check_milestone_order is definer / pinned and counts only completed milestones.
//   3: sync_lead_quotation_value locks the lead row and stays closed to clients; the contract trigger watches currency.
// All answer false, never fail, on a database that has not applied the migration yet.
export const S46_POSTURE = Object.freeze([
  "SELECT coalesce((SELECT count(*)=0 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='policy_leads_delete_sales') AND (SELECT count(*)=1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='policy_leads_delete_admin' AND cmd='DELETE') AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc NOT LIKE '%''sales''%') AND bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.delete_lead_atomic(uuid,uuid)')),false)",
  "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%completed_at IS NOT NULL%') AND bool_and(p.prosrc LIKE '%skipping a milestone going forward%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.check_milestone_order()')),false)",
  "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%for update%') AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)')) AND (SELECT count(*)=1 AND bool_and(pg_catalog.pg_get_triggerdef(t.oid) LIKE '%currency%') FROM pg_catalog.pg_trigger t WHERE t.tgname='trg_contract_sync_lead_value' AND t.tgenabled='O' AND NOT t.tgisinternal),false)",
]);
// Present: what the gate reads from the live database to call a migration applied. The manifest predicate for 1 and 2; for 3
// it also requires the lock-error handler in the routine body.
export const S46_PRESENT = Object.freeze([
  "SELECT coalesce((SELECT count(*)=0 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='policy_leads_delete_sales') AND (SELECT count(*)=1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='policy_leads_delete_admin' AND cmd='DELETE') AND (SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc NOT LIKE '%''sales''%') AND bool_and(has_function_privilege('authenticated',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.delete_lead_atomic(uuid,uuid)')),false)",
  "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%completed_at IS NOT NULL%') AND bool_and(p.prosrc LIKE '%skipping a milestone going forward%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.check_milestone_order()')),false)",
  "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosecdef) AND bool_and(p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND bool_and(p.prosrc LIKE '%for update%') AND bool_and(p.prosrc LIKE '%deadlock_detected%') AND bool_and(NOT has_function_privilege('anon',p.oid,'EXECUTE')) AND bool_and(NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)')) AND (SELECT count(*)=1 AND bool_and(pg_catalog.pg_get_triggerdef(t.oid) LIKE '%currency%') FROM pg_catalog.pg_trigger t WHERE t.tgname='trg_contract_sync_lead_value' AND t.tgenabled='O' AND NOT t.tgisinternal),false)",
]);
// Prior: the state before each migration (the production bodies; a missing routine is not a prior state).
export const S46_PRIOR = Object.freeze([
  "SELECT coalesce((SELECT count(*)=1 FROM pg_catalog.pg_policies WHERE schemaname='public' AND tablename='leads' AND policyname='policy_leads_delete_sales') AND (SELECT count(*)=1 AND bool_and(p.prosrc LIKE '%''sales''%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.delete_lead_atomic(uuid,uuid)')),false)",
  "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosrc NOT LIKE '%completed_at IS NOT NULL%') AND bool_and(p.prosrc LIKE '%skipping a milestone going forward%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.check_milestone_order()')),false)",
  "SELECT coalesce((SELECT count(*)=1 AND bool_and(p.prosrc NOT LIKE '%for update%') FROM pg_catalog.pg_proc p WHERE p.oid=to_regprocedure('public.sync_lead_quotation_value(uuid,numeric)')) AND (SELECT count(*)=1 AND bool_and(pg_catalog.pg_get_triggerdef(t.oid) NOT LIKE '%currency%') FROM pg_catalog.pg_trigger t WHERE t.tgname='trg_contract_sync_lead_value' AND t.tgenabled='O' AND NOT t.tgisinternal),false)",
]);
export const S46_PREDICATES = Object.freeze(S46_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S46_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per migration, in migration order.
export function judgeS46DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S46_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S46_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S46_PREDICATES))problems.push("existing posture must be preserved and only the exact S46 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S46_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S46_EVENTS[0].version)) problems.push("only the reviewed additive S46 migration suffix is permitted");
  const texts=Array.isArray(sql)?sql:[];
  if (texts.length!==n || texts.some((text,i)=>createHash("sha256").update(String(text??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256[i])) problems.push("reviewed SQL hash mismatch");
  const flags=[recorded,priorMatches,bodyMatches];
  if (!flags.every(list=>Array.isArray(list)&&list.length===n&&list.every(v=>typeof v==="boolean"))) problems.push("unrecorded history drift or recorded mismatch");
  else {
    for (let i=0;i<n;i+=1) {
      if (recorded[i] ? bodyMatches[i]!==true || priorMatches[i]!==false : priorMatches[i]!==true || bodyMatches[i]!==false) problems.push("unrecorded history drift or recorded mismatch");
    }
    // The batch is applied in order, each file in its own transaction (db-phase-push.mjs), so a failure after an earlier file committed
    // leaves an earlier file recorded and present with a later one unrecorded and still in its before-state. That exact prefix is resumable:
    // plan / provision then apply only the rest. Any other partial record (a later file recorded before an earlier one) is refused; the per-file
    // rule above already refuses an unrecorded application, a record without the objects, or a mismatched object.
    const firstGap=recorded.indexOf(false);
    if (firstGap>=0 && recorded.slice(firstGap).some(Boolean)) problems.push("the S46 batch is recorded out of order");
  }
  return {problems:[...new Set(problems)],alreadyRecorded:Array.isArray(recorded)&&recorded.length===n&&recorded.every(Boolean)};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S46 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S46_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S46_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S46_PRIOR[i]}) as "priorMatches",
        (${S46_PRESENT[i]}) as "bodyMatches"`,[S46_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S46 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS46DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s46_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&fs.realpathSync(process.argv[1])===fs.realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
