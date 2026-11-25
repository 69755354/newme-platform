import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { S43_EVENTS, S43_POSTURE, S43_PRESENT, S43_PRIOR, S43_PREDICATES, S43_PREDICATE_NAMES, judgeS43DbBatchProvisioning } from '../../scripts/check-s43-db-batch-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const urls=S43_EVENTS.map(event=>new URL(`../../supabase/migrations/${event.file}`,import.meta.url));
const inTree=urls.every(url=>fs.existsSync(url));
const noneInTree=urls.every(url=>!fs.existsSync(url));
const at=manifest.deferred_contract.findIndex(x=>x.version===S43_EVENTS[0].version);
const N=S43_EVENTS.length;
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const pinned=S43_EVENTS.map(({version,file,sha256})=>({version,file,sha256}));

// The live release is the one before S43: the manifest minus the S43 entry and its predicate.
// Two states of the repository must both work:
//  (1) switch only: the manifest has no S43 entry yet (this branch on its own);
//  (2) after the S43 branch is merged: the manifest already ends with the S43 entry.
const live=structuredClone(manifest);
const predAt=manifest.posture.deferred_contract.predicates.findIndex(x=>S43_PREDICATE_NAMES.includes(x.name));
if(at>=0){
  live.deferred_contract.splice(at);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.slice(0,predAt);
}
const sqls=inTree?urls.map(url=>fs.readFileSync(url,'utf8')):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(...S43_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
candidate.posture.deferred_contract.predicates.push(...S43_PREDICATES.map(x=>({...x})));
const reviewed=S43_EVENTS.map((_,i)=>`-- the reviewed S43 SQL ${i}`);
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:[...reviewed],phase:'strict',recorded:[false],priorMatches:[true],bodyMatches:[false]});
const judge=state=>judgeS43DbBatchProvisioning({...state,expectedSha256:state.expectedSha256??state.sql.map(hashed)});

// The S43 branch itself, read from git when that ref is available (never written into the tree).
function fromGit(spec){
  for(const ref of ['origin/fix/os-s43-roles']){
    try{return execFileSync('git',['show',`${ref}:${spec}`],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024});}catch{/* ref not available here */}
  }
  return null;
}
const readOnly=text=>{
  assert.match(text,/^SELECT /);
  // read-only: no statement separator and no write verb outside quoted literals
  assert.doesNotMatch(text.replace(/'[^']*'/g,"''"),/;|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT)\b/i);
  // runs on a database that has not applied the migration yet: it must answer, not fail
  assert.doesNotMatch(text,/FROM public\./);
  // profiles exists before and after the migration, so the one regclass cast the predicates need is safe
  assert.doesNotMatch(text.replaceAll("'public.profiles'::regclass",''),/::regclass/);
};
test('the S43 provisioning gate pins exactly one reviewed migration and its posture predicate',()=>{
  assert.deepEqual(S43_EVENTS.map(x=>x.version),['20261124300000']);
  assert.deepEqual(S43_EVENTS.map(x=>x.file),['20261124300000_s43_leave_cover.sql']);
  assert.match(S43_EVENTS[0].sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(S43_PREDICATE_NAMES,['s43-leave-cover']);
  assert.equal(S43_POSTURE.length,N);assert.equal(S43_PRESENT.length,N);assert.equal(S43_PRIOR.length,N);
  // the posture (the manifest predicate): the three columns, the two constraints, set_leave_cover and the trigger routine
  // (definer, pinned search_path, marker), the grants of set_leave_cover and the enabled trigger
  assert.match(S43_POSTURE[0],/column_name IN \('cover_user_id','cover_start','cover_end'\)/);
  assert.match(S43_POSTURE[0],/conname IN \('profiles_cover_not_self','profiles_cover_dates'\)/);
  assert.match(S43_POSTURE[0],/to_regprocedure\('public\.set_leave_cover\(uuid,uuid,date,date\)'\)/);
  assert.match(S43_POSTURE[0],/to_regprocedure\('public\.trg_profiles_cover_admin_only\(\)'\)/);
  assert.match(S43_POSTURE[0],/t\.tgname='profiles_cover_admin_only'/);
  assert.match(S43_POSTURE[0],/search_path=pg_catalog, public, pg_temp/);
  assert.match(S43_POSTURE[0],/NOT has_function_privilege\('anon'/);
  // present: stricter than the posture (types, nullability, partial index, grants, trigger bound to the routine, BEFORE UPDATE ROW)
  const present=S43_PRESENT[0];
  assert.match(present,/data_type='uuid'/);assert.match(present,/data_type='date'/);assert.match(present,/is_nullable='YES'/);
  assert.match(present,/to_regclass\('public\.idx_profiles_cover_user'\) IS NOT NULL/);
  assert.match(present,/has_function_privilege\('service_role',p\.oid,'EXECUTE'\)/);
  assert.match(present,/NOT has_function_privilege\('authenticated',p\.oid,'EXECUTE'\)/);
  assert.match(present,/t\.tgfoid=to_regprocedure\('public\.trg_profiles_cover_admin_only\(\)'\)/);
  assert.match(present,/t\.tgenabled='O'/);
  assert.equal((present.match(/bool_and\(p\.prosecdef\)/g)??[]).length,2);
  // prior: nothing of S43 exists yet
  const prior=S43_PRIOR[0];
  assert.match(prior,/count\(\*\)=0 FROM information_schema\.columns/);
  assert.match(prior,/to_regclass\('public\.idx_profiles_cover_user'\) IS NULL/);
  assert.match(prior,/to_regprocedure\('public\.set_leave_cover\(uuid,uuid,date,date\)'\) IS NULL AND to_regprocedure\('public\.trg_profiles_cover_admin_only\(\)'\) IS NULL/);
  // the marker is a LIKE pattern with escaped underscores
  assert.match(present,/LIKE '%leave\\_cover\\_not\\_allowed%'/);
  for(const text of [...S43_POSTURE,...S43_PRESENT,...S43_PRIOR])readOnly(text);
  for(const text of [...S43_POSTURE,...S43_PRESENT])assert.match(text,/^SELECT coalesce\(/);
  assert.match(S43_PRIOR[0],/^SELECT coalesce\(/);
});

// The marker really is in the migration (read from the S43 branch in git, or from the tree once it is merged).
test('the marker and every object the gate reads are in the S43 migration',()=>{
  const text=fromGit('supabase/migrations/'+S43_EVENTS[0].file)??(inTree?sqls[0]:null);
  if(!text)return;
  for(const needle of ['leave_cover_not_allowed','profiles_cover_not_self','profiles_cover_dates','idx_profiles_cover_user','public.set_leave_cover','trg_profiles_cover_admin_only','profiles_cover_admin_only','cover_user_id uuid','cover_start date','cover_end date'])
    assert.ok(text.includes(needle),needle);
});

// Always runs (the repository forbids new skipped tests). The switch is released on its own
// before the migration: then the file is not in the tree and the manifest must not name it yet.
test('the S43 migration, when present in the tree, matches the pinned hash, keeps its entry and carries the exact predicate',()=>{
  if(noneInTree){
    assert.equal(at,-1,'the manifest lists the S43 migration but its file is not in the tree');
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>S43_PREDICATE_NAMES.includes(x.name)),false);
    return;
  }
  assert.ok(inTree,'the S43 migration file is part of the tree');
  S43_EVENTS.forEach((event,i)=>assert.equal(hashed(sqls[i]),event.sha256));
  assert.deepEqual(manifest.deferred_contract.slice(at,at+N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(manifest.posture.deferred_contract.predicates.slice(predAt,predAt+N),S43_PREDICATES.map(x=>({...x})));
});

test('state 1 (switch only): the live manifest is untouched by S43 and the derived candidate passes',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:[true],priorMatches:[false],bodyMatches:[true]}),{problems:[],alreadyRecorded:true});
  // the live side never names S43, whichever state the repository is in
  assert.equal(live.deferred_contract.some(x=>x.version>=S43_EVENTS[0].version),false);
  assert.equal(live.posture.deferred_contract.predicates.some(x=>S43_PREDICATE_NAMES.includes(x.name)),false);
  // the S37 entry and rule check (the end of the S36 + S37 batch) are the last of the prefix the gate pins
  // the S39 entry and rule check (the end of the live prefix) are the last of the prefix the gate pins
  assert.equal(live.deferred_contract.at(-1).version,'20261123100000');
  assert.equal(live.posture.deferred_contract.predicates.at(-1).name,'s39-stage-rules-relaxed');
  // the S37 and S36 entries precede it
  assert.ok(live.deferred_contract.some(x=>x.version==='20261122300000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s37-new-lead-not-dormant'));
  // the S36, S33, S32 and S31 entries and rule checks are part of the prefix the gate pins
  assert.ok(live.deferred_contract.some(x=>x.version==='20261122200000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s36-quotation-value-follows-quotations-present'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261121100000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s33-sync-advance-lead-stage-from-sheet-present'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261120200000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s32-tasks-future-only-not-valid'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261120100000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s31-dispatch-and-history-corrections-present'));
  // the S24, S25, S18 and S16 entries and rule checks are part of the prefix the gate pins
  assert.ok(live.deferred_contract.some(x=>x.version==='20261119300000')&&live.deferred_contract.some(x=>x.version==='20261119400000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s24-lead-dispatch-review-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s25-whatsapp-history-backfill-present'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261118200000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s18-whatsapp-ctwa-leads-present'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261112100000')&&live.deferred_contract.some(x=>x.version==='20261112100100'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s16-notification-constraints-and-lead-owner-present'));
});

test('state 2 (after the S43 branch is merged): its real manifest is accepted against the live prefix',()=>{
  // The S43 branch's own manifest and migration, read from git when available. Without the ref
  // the synthetic candidate above (live + the pinned entry and predicate) stands in for it.
  const text=fromGit('infra/release/release-manifest.json');
  const brManifest=text?JSON.parse(text):structuredClone(candidate);
  const brSql=S43_EVENTS.map((event,i)=>fromGit('supabase/migrations/'+event.file)??(inTree?sqls[i]:null));
  const synthetic=brSql.some(x=>x===null);
  const state={...input(),live:structuredClone(live),candidate:brManifest,sql:synthetic?[...reviewed]:brSql};
  const expectedSha256=synthetic?reviewed.map(hashed):undefined;
  const result=judgeS43DbBatchProvisioning({...state,expectedSha256});
  assert.deepEqual(result.problems,[]);
  // the S43 branch's manifest differs from the live one by exactly the pinned entry and predicate
  const stripped=structuredClone(brManifest);
  stripped.deferred_contract.splice(-N);
  stripped.posture.deferred_contract.predicates.splice(-N);
  assert.deepEqual(stripped,live);
  assert.deepEqual(brManifest.deferred_contract.slice(-N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(brManifest.posture.deferred_contract.predicates.slice(-N),S43_PREDICATES.map(x=>({...x})));
  // a manifest where the S43 entry is NOT last is refused
  const reordered=structuredClone(brManifest);
  const moved=reordered.deferred_contract.splice(-N);
  reordered.deferred_contract.splice(-1,0,...moved);
  assert.ok(judgeS43DbBatchProvisioning({...state,candidate:reordered,expectedSha256}).problems.length>0);
});

test('the reviewed SQL hash is what the gate compares, not the file name',()=>{
  const state=input();
  state.sql=[reviewed[0]+'\nGRANT SELECT ON public.leads TO anon;'];
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS43DbBatchProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
  if(inTree)assert.deepEqual(judgeS43DbBatchProvisioning({...input(),sql:sqls}).problems,[]);
  const real=S43_EVENTS.map(event=>fromGit('supabase/migrations/'+event.file));
  if(real.every(x=>x!==null)){
    assert.deepEqual(judgeS43DbBatchProvisioning({...input(),sql:real}).problems,[]);
    assert.ok(judgeS43DbBatchProvisioning({...input(),sql:[real[0]+'\n-- edited']}).problems.includes('reviewed SQL hash mismatch'));
    assert.ok(judgeS43DbBatchProvisioning({...input(),sql:[real[0].replaceAll('\n','\r\n')]}).problems.length===0,'CRLF normalised');
  }
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  // half states: one transaction should never leave these, the gate still refuses them explicitly
  ['a half-applied database (some routines new, some old: neither prior nor present)',x=>{x.priorMatches=[false];x.bodyMatches=[false];}],
  ['a half-applied database that also looks present',x=>{x.priorMatches=[true];x.bodyMatches=[true];}],
  ['complete but unrecorded',x=>{x.priorMatches=[false];x.bodyMatches=[true];}],
  ['recorded but absent (all routines still old)',x=>{x.recorded=[true];}],
  ['recorded drift (routines missing or mismatched)',x=>{x.recorded=[true];x.bodyMatches=[false];x.priorMatches=[false];}],
  ['recorded and present but still looking prior',x=>{x.recorded=[true];x.bodyMatches=[true];x.priorMatches=[true];}],
  ['missing history result',x=>x.recorded=undefined],
  ['missing posture result',x=>x.bodyMatches=[null]],
  ['too few results',x=>x.recorded=[]],
  ['too many results',x=>x.recorded=[false,false]],
  ['SQL alteration',x=>{x.sql[0]+='\nGRANT SELECT ON public.leads TO anon;';}],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one',x=>x.candidate.deferred_contract.at(-1).sha256='0'.repeat(64)],
  ['a candidate with another file name',x=>x.candidate.deferred_contract.at(-1).file='20261124300000_other.sql'],
  ['a second new migration',x=>x.candidate.deferred_contract.push({...S43_EVENTS[0],version:'20261124300100',file:'x.sql'})],
  ['the S43 entry not last',x=>{const m=x.candidate.deferred_contract.splice(-1);x.candidate.deferred_contract.splice(-1,0,...m);}],
  ['a candidate without the S43 entry',x=>{x.candidate.deferred_contract.pop();}],
  ['a candidate without the S43 predicate',x=>{x.candidate.posture.deferred_contract.predicates.pop();}],
  ['a candidate one migration ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['an S43 migration already in the live release',x=>x.live.deferred_contract.push({...S43_EVENTS[0]})],
  ['an S39 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261123100000');e.sha256='0'.repeat(64);}],
  ['an S39 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s39-stage-rules-relaxed');p.sql='SELECT true';}],
  ['an S37 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261122300000');e.sha256='0'.repeat(64);}],
  ['an S37 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s37-new-lead-not-dormant');p.sql='SELECT true';}],
  ['an S36 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261122200000');e.sha256='0'.repeat(64);}],
  ['an S36 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s36-quotation-value-follows-quotations-present'),1);}],
  ['an S33 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261121100000');e.sha256='0'.repeat(64);}],
  ['an S33 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s33-sync-advance-lead-stage-from-sheet-present');p.sql='SELECT true';}],
  ['an S32 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s32-tasks-future-only-not-valid');p.sql='SELECT true';}],
  ['an S31 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261120100000');e.sha256='0'.repeat(64);}],
  ['an S16 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s16-notification-warning-type-present');p.sql='SELECT true';}],
  ['an S18 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s18-whatsapp-ctwa-leads-present');p.sql='SELECT true';}],
  ['an S24 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261119300000');e.sha256='0'.repeat(64);}],
  ['an S25 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s25-whatsapp-history-backfill-present'),1);}],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['a weakened S43 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['a renamed S43 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).name='s43-other'],
  ['an S43 predicate expecting false',x=>x.candidate.posture.deferred_contract.predicates.at(-1).expect=false],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
  ['a live release without strict support',x=>{x.live.runs_under.database_phases=x.live.runs_under.database_phases.filter(p=>p!=='strict');}],
  ['a candidate without strict support',x=>{x.candidate.runs_under.database_phases=x.candidate.runs_under.database_phases.filter(p=>p!=='strict');}],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.length>0);
});

test('a half state is named as history drift, not approved',()=>{
  for(const state of [
    {recorded:[false],priorMatches:[false],bodyMatches:[false]},
    {recorded:[false],priorMatches:[false],bodyMatches:[true]},
    {recorded:[true],priorMatches:[true],bodyMatches:[false]},
    {recorded:[true],priorMatches:[false],bodyMatches:[false]},
  ]) assert.deepEqual(judge({...input(),...state,expectedSha256:reviewed.map(hashed)}).problems,['unrecorded history drift or recorded mismatch'],JSON.stringify(state));
});

test('the deploy wrapper gates S43 provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s43-db-plan\|s43-db-provision\) ;;/);
  assert.match(wrapper,/\|s21-db-plan\|s21-db-provision(?:\|[a-z0-9-]+)*\|s36-db-plan\|s36-db-provision\|s39-db-plan\|s39-db-provision\|s43-db-plan\|s43-db-provision(?:\|[a-z0-9-]+)*>" >&2/);
  const start=wrapper.indexOf('= s43-db-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s43-db-batch-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(wrapper,/s43-db-plan\|s43-db-provision\)\s+s43_db_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s43-db-provision \] \|\| s43_db_mode=--apply[\s\S]*?--phase deferred_contract "\$s43_db_mode"/);
  // the earlier switches are still there,
  assert.match(wrapper,/s39-db-plan\|s39-db-provision\) ;;/);
  assert.match(wrapper,/s36-db-plan\|s36-db-provision\) ;;/);
  assert.match(wrapper,/s33-db-plan\|s33-db-provision\) ;;/);
  assert.match(wrapper,/s32-db-plan\|s32-db-provision\) ;;/);
  assert.match(wrapper,/s31-db-plan\|s31-db-provision\) ;;/);
  assert.match(wrapper,/s25-db-plan\|s25-db-provision\) ;;/);
  assert.match(wrapper,/s24-db-plan\|s24-db-provision\) ;;/);
  assert.match(wrapper,/s21-db-plan\|s21-db-provision\) ;;/);
  assert.match(wrapper,/s18-db-plan\|s18-db-provision\) ;;/);
  assert.match(wrapper,/s16-db-plan\|s16-db-provision\) ;;/);
  // and the generic contract operations still require the live release as the candidate
  assert.match(wrapper,/1:contract-apply\|1:contract-verify\|1:contract-rollback\|1:contract-reenter\)/);
});
