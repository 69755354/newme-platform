/** Exact additive suffix only; never weakens the existing strict-prefix gate. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const ADS_WRITER = Object.freeze({
  version: "20261023123323", file: "20261023123323_meta_ads_atomic_window.sql",
  sha256: "76a530de097e9b7cfea8099daa642e6bbadfbc257c46fc4867af219652779487",
});
export const ADS_WRITER_POSTURE_SQL = "SELECT coalesce((SELECT (p.proowner='postgres'::regrole AND p.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND p.prokind='f' AND p.provolatile='v' AND p.proparallel='u' AND NOT p.prosecdef AND NOT p.proisstrict AND NOT p.proleakproof AND NOT p.proretset AND p.prorettype='jsonb'::regtype AND p.pronargdefaults=0 AND p.provariadic=0 AND p.prosupport=0 AND p.proallargtypes IS NULL AND p.proargmodes IS NULL AND p.protrftypes IS NULL AND p.probin IS NULL AND p.procost=100 AND p.prorows=0 AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='b3a825023573cb6248a6bb1d5a3ccd60131a9bc77250c37e4130593618d78749' AND cardinality(p.proconfig)=3 AND p.proconfig @> ARRAY['search_path=\"\"','lock_timeout=5s','statement_timeout=20s']::text[] AND p.proargnames =ARRAY['p_account_id','p_since','p_until','p_rows']::text[] AND (SELECT count(*)=2 AND bool_and(x.privilege_type='EXECUTE' AND x.grantor=p.proowner AND (x.grantee=p.proowner OR (x.grantee='service_role'::regrole AND NOT x.is_grantable))) FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) x)) AND (SELECT count(*)=3 AND bool_and(tgenabled='O' AND NOT tgisinternal AND NOT tgdeferrable AND NOT tginitdeferred AND tgconstraint=0 AND tgparentid=0 AND tgconstrrelid=0 AND tgconstrindid=0 AND tgattr::text='' AND octet_length(tgargs)=0 AND tgqual IS NULL AND tgnargs=0 AND tgoldtable IS NULL AND CASE tgname WHEN 'ad_spend_coordinate_writers' THEN tgtype=30 AND tgnewtable IS NULL WHEN 'ad_spend_insert_source_guard' THEN tgtype=4 AND tgnewtable='new_ad_spend_rows' WHEN 'ad_spend_update_source_guard' THEN tgtype=16 AND tgnewtable='new_ad_spend_rows' ELSE false END) FROM pg_trigger WHERE tgrelid='public.ad_spend'::regclass AND tgfoid=to_regprocedure('public.coordinate_ad_spend_writes()')) AND (SELECT (g.proowner='postgres'::regrole AND g.prolang=(SELECT oid FROM pg_language WHERE lanname='plpgsql') AND g.prokind='f' AND g.provolatile='v' AND g.proparallel='u' AND NOT g.prosecdef AND NOT g.proisstrict AND NOT g.proleakproof AND NOT g.proretset AND g.prorettype='trigger'::regtype AND g.pronargdefaults=0 AND g.provariadic=0 AND g.prosupport=0 AND g.proallargtypes IS NULL AND g.proargmodes IS NULL AND g.protrftypes IS NULL AND g.probin IS NULL AND g.procost=100 AND g.prorows=0 AND encode(sha256(convert_to(g.prosrc,'UTF8')),'hex')='c3f138ccc8b32e3b5d36c9445af0c092b11d5d71bb152cd1b54a8c731372b8ea' AND cardinality(g.proconfig)=2 AND g.proconfig @> ARRAY['search_path=\"\"','lock_timeout=5s']::text[] AND g.proargnames IS NULL AND (SELECT count(*)=1 AND bool_and(x.privilege_type='EXECUTE' AND x.grantor=g.proowner AND (x.grantee=g.proowner)) FROM aclexplode(coalesce(g.proacl,acldefault('f',g.proowner))) x)) FROM pg_proc g WHERE g.oid=to_regprocedure('public.coordinate_ad_spend_writes()')) FROM pg_proc p WHERE p.oid=to_regprocedure('public.replace_meta_ad_spend_window(text,date,date,jsonb)')),false)";
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
export function judgeAdsProvisioning({live,candidate,sql,phase,recorded,objectExists,bodyMatches}) {
  const problems=[];
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.pop();
  if(!same(reducedPosture,live?.posture)||!same(added,{name:'meta-ads-atomic-writer-is-reviewed-and-server-only',expect:true,sql:ADS_WRITER_POSTURE_SQL}))problems.push('existing posture must be preserved and only the exact ads predicate appended');
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.pop();
  priorManifest.posture?.deferred_contract?.predicates?.pop();
  if(!same(priorManifest,live))problems.push('all prior manifest declarations must remain identical');
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),[ADS_WRITER]) || prior.some(x=>x.version>=ADS_WRITER.version)) problems.push("only the reviewed additive ads suffix is permitted");
  if (createHash("sha256").update(String(sql??"").replaceAll("\r\n","\n")).digest("hex")!==ADS_WRITER.sha256) problems.push("reviewed SQL hash mismatch");
  if (typeof recorded!=="boolean" || typeof objectExists!=="boolean" || objectExists!==recorded || (recorded && bodyMatches!==true)) problems.push("unrecorded object collision or recorded body drift");
  return {problems,alreadyRecorded:recorded===true};
}
async function main(argv) {
  const flags=new Map();
  for(let i=0;i<argv.length;i+=2) {
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid ads provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",ADS_WRITER.file),"utf8");
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state=(await client.query(`select
      exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
      (to_regprocedure('public.replace_meta_ad_spend_window(text,date,date,jsonb)') is not null OR to_regprocedure('public.coordinate_ad_spend_writes()') is not null OR EXISTS(SELECT FROM pg_trigger WHERE tgrelid=to_regclass('public.ad_spend') AND tgname IN ('ad_spend_coordinate_writers','ad_spend_insert_source_guard','ad_spend_update_source_guard'))) as "objectExists",
      (${ADS_WRITER_POSTURE_SQL}) as "bodyMatches"`,[ADS_WRITER.version])).rows[0];
  } catch(error) {throw Error(`ads provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeAdsProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({ads_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
