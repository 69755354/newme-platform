/**
 * Exact additive suffix only; never weakens the existing strict-prefix gate.
 * Provisions 20261120200000_tasks_future_only_not_valid.sql (OS fix S32: the time-dependent check constraint
 * public.tasks.tasks_future_only re-created NOT VALID with the same expression, so that pg_dump emits it after the
 * table data and a backup of public.tasks can be restored; found by the first restore drill, 2026-11-20) on a live
 * release that already carries every earlier deferred migration, including S31, the same way
 * check-s31-db-batch-provisioning.mjs did for S31.
 *
 * The switch and the migration ship in one branch here; the judge only ever sees live = the release in production
 * (no S32 entry) and candidate = live plus exactly the pinned entry and predicate.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { loadPg, readUrlFile } from "./db-phase-push.mjs";
import { readLiveMode, readReleaseManifest } from "./check-release-phase.mjs";

export const S32_EVENTS = Object.freeze([
  Object.freeze({
    "version": "20261120200000",
    "file": "20261120200000_tasks_future_only_not_valid.sql",
    "sha256": "6dad7971700c4c195e3d3bbbe6ca811328fbefca351ea84e03f573d39b9987d9"
  }),
]);
export const S32_PREDICATE_NAMES = Object.freeze([
  "s32-tasks-future-only-not-valid",
]);
export const S32_PREDICATE_NAME = S32_PREDICATE_NAMES[0];
// Present: the same predicate the release manifest declares for the S32 migration: exactly one check constraint
// tasks_future_only on public.tasks, NOT VALID, with the expression production has today (30 days). Any other
// expression, a validated constraint or a missing one answers false.
export const S32_POSTURE_SQL = "SELECT coalesce((SELECT count(*)=1 AND bool_and(NOT c.convalidated) AND bool_and(pg_catalog.pg_get_constraintdef(c.oid)='CHECK ((due_at > (now() - ''30 days''::interval))) NOT VALID') FROM pg_catalog.pg_constraint c WHERE c.conrelid=to_regclass('public.tasks') AND c.conname='tasks_future_only' AND c.contype='c'),false)";
// Prior: the state before this migration: the same constraint, same expression, validated. A partial or
// unrecorded application (missing constraint, other expression) is refused.
export const S32_PRIOR_SQL = "SELECT coalesce((SELECT count(*)=1 AND bool_and(c.convalidated) AND bool_and(pg_catalog.pg_get_constraintdef(c.oid)='CHECK ((due_at > (now() - ''30 days''::interval)))') FROM pg_catalog.pg_constraint c WHERE c.conrelid=to_regclass('public.tasks') AND c.conname='tasks_future_only' AND c.contype='c'),false)";
export const S32_POSTURE = Object.freeze([S32_POSTURE_SQL]);
export const S32_PRIOR = Object.freeze([S32_PRIOR_SQL]);
export const S32_PREDICATES = Object.freeze(S32_PREDICATE_NAMES.map((name, i) => ({ name, expect: true, sql: S32_POSTURE[i] })));
const entries = list => Array.isArray(list) ? list.map(({version,file,sha256}) => ({version,file,sha256})) : null;
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
// expectedSha256 (one per migration) exists so tests can judge a stand-in for the reviewed SQL; the
// command line never passes it, so production always compares the pinned hashes.
// sql / recorded / priorMatches / bodyMatches are arrays with one entry per S32 migration.
export function judgeS32DbBatchProvisioning({live,candidate,sql,phase,recorded,priorMatches,bodyMatches,expectedSha256=S32_EVENTS.map(x=>x.sha256)}) {
  const problems=[];
  const n=S32_EVENTS.length;
  if (phase !== "strict" || !live?.runs_under?.database_phases?.includes("strict") || !candidate?.runs_under?.database_phases?.includes("strict")) problems.push("strict compatibility required");
  if (!live?.required_for_app?.length || !same(entries(live.required_for_app),entries(candidate?.required_for_app))) problems.push("required prefix changed");
  const reducedPosture=structuredClone(candidate?.posture??{});
  const added=reducedPosture.deferred_contract?.predicates?.splice(-n)??[];
  if(!same(reducedPosture,live?.posture)||!same(added,S32_PREDICATES))problems.push("existing posture must be preserved and only the exact S32 predicates appended");
  const priorManifest=structuredClone(candidate??{});
  priorManifest.deferred_contract?.splice(-n);
  priorManifest.posture?.deferred_contract?.predicates?.splice(-n);
  if(!same(priorManifest,live))problems.push("all prior manifest declarations must remain identical");
  const prior=entries(live?.deferred_contract),next=entries(candidate?.deferred_contract);
  if (!prior?.length || !next || !same(prior,next.slice(0,prior.length)) ||
      !same(next.slice(prior.length),S32_EVENTS.map(({version,file,sha256})=>({version,file,sha256}))) || prior.some(x=>x.version>=S32_EVENTS[0].version)) problems.push("only the reviewed additive S32 migration suffix is permitted");
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
    if(!["--live-release","--candidate-release","--url-file","--modules-dir"].includes(argv[i])||!argv[i+1]||flags.has(argv[i]))throw Error("invalid S32 provisioning arguments");
    flags.set(argv[i],argv[i+1]);
  }
  if(flags.size!==4)throw Error("four provisioning arguments required");
  const live=readReleaseManifest(flags.get("--live-release")).manifest;
  const candidate=readReleaseManifest(flags.get("--candidate-release")).manifest;
  const sql=S32_EVENTS.map(event=>fs.readFileSync(path.join(flags.get("--candidate-release"),"supabase/migrations",event.file),"utf8"));
  const url=readUrlFile(flags.get("--url-file"));
  const phase=await readLiveMode(url,flags.get("--modules-dir"));
  const {Client}=loadPg(flags.get("--modules-dir"));
  const client=new Client({connectionString:url,connectionTimeoutMillis:15000,statement_timeout:15000});
  let state;
  try {
    await client.connect();await client.query("begin read only");
    state={recorded:[],priorMatches:[],bodyMatches:[]};
    for (let i=0;i<S32_EVENTS.length;i+=1) {
      const row=(await client.query(`select
        exists(select 1 from supabase_migrations.schema_migrations where version=$1) as recorded,
        (${S32_PRIOR[i]}) as "priorMatches",
        (${S32_POSTURE[i]}) as "bodyMatches"`,[S32_EVENTS[i].version])).rows[0];
      state.recorded.push(row.recorded);state.priorMatches.push(row.priorMatches);state.bodyMatches.push(row.bodyMatches);
    }
  } catch(error) {throw Error(`S32 provisioning read refused (${error.code??error.name})`);}
  finally {await client.end().catch(()=>{});}
  const result=judgeS32DbBatchProvisioning({live,candidate,sql,phase,...state});
  if(result.problems.length)throw Error(result.problems.join("; "));
  console.log(JSON.stringify({s32_db_batch_provisioning:"approved",...result}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
}
