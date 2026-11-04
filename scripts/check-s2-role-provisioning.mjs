/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261104110000_role_least_privilege.sql (OS fix S2) on a live release
 * that already carries every earlier deferred migration (review B-2).
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S2_EVENT = Object.freeze({
  "version": "20261104110000",
  "file": "20261104110000_role_least_privilege.sql",
  "sha256": "9c5e44274ae7e9ddab8a7a431c6e91a204242ffcb41b508a0c164e781819730b"
});
export const S2_PREDICATE_NAME = "s2-role-least-privilege-present";
// Present: the stage RPC admits operator and every S2 policy, trigger and function is in place
// (the same predicate the release manifest declares for the S2 version).
export const S2_POSTURE_SQL = "SELECT coalesce((SELECT p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%NOT IN (''admin'', ''boss'', ''operator'', ''sales'', ''user'', ''salesperson'')%' FROM pg_proc p WHERE p.oid=to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)')),false) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname IN ('policy_activities_select_designer','policy_activities_select_finance','policy_activities_insert_designer','policy_business_events_select_designer','policy_business_events_select_finance','policy_lead_milestones_select_designer','policy_products_insert_designer','policy_products_update_designer','policy_products_delete_designer','policy_projects_select_designer','policy_projects_insert_designer','policy_projects_update_designer','policy_lead_workflow_stages_select_designer','policy_leads_select_finance_contracted')) AND (SELECT count(*)=7 FROM pg_policies WHERE schemaname='public' AND policyname IN ('policy_activities_select_designer_involved','policy_activities_insert_designer_involved','policy_leads_select_designer_involved','policy_projects_select_designer_involved','policy_projects_update_designer_involved','policy_lead_workflow_stages_select_designer_involved','policy_business_events_select_designer_involved')) AND (SELECT count(*)=1 FROM pg_policies WHERE schemaname='public' AND tablename='projects' AND policyname='policy_projects_insert_sales' AND with_check LIKE '%''sales''::text%') AND (SELECT count(*)=1 FROM pg_policies WHERE schemaname='public' AND tablename='projects' AND policyname='policy_projects_update_sales' AND qual LIKE '%''sales''::text%' AND with_check LIKE '%''sales''::text%') AND (SELECT count(*)=1 FROM pg_policies WHERE schemaname='public' AND tablename='lead_files' AND policyname='lead_files_insert_staff' AND with_check LIKE '%leads l%') AND (SELECT count(*)=1 FROM pg_policies WHERE schemaname='public' AND tablename='customers' AND policyname='policy_customers_insert_sales' AND with_check LIKE '%''sales''::text%') AND EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='projects' AND t.tgname='trg_guard_projects_lead_binding' AND t.tgenabled = 'O' AND NOT t.tgisinternal AND t.tgfoid=to_regprocedure('public.guard_projects_lead_binding()')) AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.contract_lead_display(uuid)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND has_function_privilege('authenticated',p.oid,'EXECUTE')) AND (SELECT count(*)=9 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('money_write_is_direct','guard_contracts_write','guard_payments_write','guard_installment_plans_write','guard_definer_only_write','require_current_session','contract_transition_is_allowed','guard_contract_transition','guard_quotations_write') AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[]) AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.approve_contract(uuid,uuid,text,text)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%array[''admin'', ''boss''])%' AND p.prosrc LIKE '%array[''admin'', ''operator''])%') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.set_contract_status(uuid,text,text)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%finalize_lead_won%contract_activation%') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.convert_quotation_to_contract(uuid,jsonb)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%advance_lead_to_pending_decision%' AND p.prosrc NOT LIKE '%finalize_lead_won%' AND p.prosrc NOT LIKE '%into public.projects%' AND p.prosrc LIKE '%array[''admin'', ''boss''])%') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.create_contract(jsonb)') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND p.prosrc LIKE '%array[''admin'', ''boss''])%' AND p.prosrc NOT LIKE '%''finance'', ''sales''%') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.advance_lead_to_pending_decision(uuid,uuid,text)') AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='contracts' AND policyname IN ('policy_contracts_insert_finance','policy_contracts_insert_sales')) AND (SELECT count(*)=1 FROM pg_policies WHERE schemaname='public' AND tablename='contracts' AND policyname='policy_contracts_insert_admin' AND qual IS NULL AND with_check LIKE '%''admin''::text%' AND with_check LIKE '%''boss''::text%' AND with_check NOT LIKE '%operator%') AND (SELECT count(*)=1 FROM pg_constraint WHERE conrelid=to_regclass('public.quotations') AND conname='quotations_discount_rate_range' AND contype='c' AND pg_get_constraintdef(oid) LIKE '%discount_rate >= (0)::numeric%' AND pg_get_constraintdef(oid) LIKE '%discount_rate <= (100)::numeric%') AND (SELECT count(*)=2 FROM pg_policies WHERE schemaname='public' AND tablename='activities' AND policyname IN ('policy_activities_insert_sales','policy_activities_insert_designer_involved') AND with_check LIKE '%l.id = activities.lead_id%') AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename<>'profiles' AND ((qual ~ 'session_token_is_current[(][)]' AND qual !~* 'select[[:space:]]+(public[.])?session_token_is_current') OR (with_check ~ 'session_token_is_current[(][)]' AND with_check !~* 'select[[:space:]]+(public[.])?session_token_is_current'))) AND (SELECT count(*)>=1 FROM pg_policies WHERE schemaname='public' AND policyname='restrict_leads_active_session' AND qual ~* 'select[[:space:]]+(public[.])?session_token_is_current') AND (SELECT count(*)=1 FROM pg_proc p WHERE p.oid=to_regprocedure('public.audit_profile_role_change()') AND p.prosecdef AND p.proconfig @> ARRAY['search_path=pg_catalog, public, pg_temp']::text[] AND NOT has_function_privilege('anon',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE')) AND (to_regclass('public.audit_logs') IS NULL OR EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('public.profiles') AND t.tgname='profiles_role_audit' AND t.tgenabled='O' AND NOT t.tgisinternal AND t.tgfoid=to_regprocedure('public.audit_profile_role_change()')))";
// Prior: the stage RPC still has the old whitelist, the old company-wide rules still exist and no
// S2 object does, so an unrecorded partial application is refused.
export const S2_PRIOR_SQL = "SELECT coalesce((SELECT p.prosrc LIKE '%NOT IN (''admin'', ''boss'', ''sales'', ''user'', ''salesperson'')%' AND p.prosrc NOT LIKE '%NOT IN (''admin'', ''boss'', ''operator'', ''sales'', ''user'', ''salesperson'')%' FROM pg_proc p WHERE p.oid=to_regprocedure('public.transition_lead_stage(uuid,text,text,text,uuid)')),false) AND (SELECT count(*)=3 FROM pg_policies WHERE schemaname='public' AND policyname IN ('policy_activities_select_designer','policy_business_events_select_finance','policy_products_insert_designer')) AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND policyname LIKE 'policy\\_%\\_designer\\_involved' ESCAPE '\\') AND to_regprocedure('public.contract_lead_display(uuid)') IS NULL AND to_regprocedure('public.guard_projects_lead_binding()') IS NULL";
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 exists so tests can judge a stand-in for the reviewed SQL before the S2 version
// merges; the command line never passes it, so production always compares the pinned hash.
export function judgeS2RoleProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S2_EVENT.sha256}) {
  const problems=[];
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.pop();
  if(!same(reducedPosture,live?.posture)||!same(added,{name:S2_PREDICATE_NAME,expect:true,sql:S2_POSTURE_SQL}))problems.push("existing posture must be preserved and only the exact S2 role predicate appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.pop();
  priorManifest.posture?.deferred_contract?.predicates?.pop();
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),[S2_EVENT]) || prior.some(x=>x.version>=S2_EVENT.version)) problems.push("only the reviewed additive S2 role migration suffix is permitted");
  if (createHash("sha256").update(String(sql??"").replaceAll("\r\n","\n")).digest("hex")!==expectedSha256) problems.push("reviewed SQL hash mismatch");
  if (typeof recorded!=="boolean" || typeof priorMatches!=="boolean" || typeof bodyMatches!=="boolean" || (recorded ? bodyMatches!==true || priorMatches!==false : priorMatches!==true || bodyMatches!==false)) problems.push("unrecorded role-rule drift or recorded role-rule mismatch");
  return {problems,alreadyRecorded:recorded===true};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S2 role provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",S2_EVENT.file),"utf8");
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state=(await client.query(`select
      exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
      (${S2_PRIOR_SQL}) as "priorMatches",
      (${S2_POSTURE_SQL}) as "bodyMatches"`,[S2_EVENT.version])).rows[0];
  } catch(error) {throw Error(`S2 role provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS2RoleProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s2_role_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
