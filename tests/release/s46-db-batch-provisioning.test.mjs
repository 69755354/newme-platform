import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { S46_EVENTS, S46_POSTURE, S46_PRESENT, S46_PRIOR, S46_PREDICATES, S46_PREDICATE_NAMES, judgeS46DbBatchProvisioning } from '../../scripts/check-s46-db-batch-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const urls=S46_EVENTS.map(event=>new URL(`../../supabase/migrations/${event.file}`,import.meta.url));
const inTree=urls.every(url=>fs.existsSync(url));
const noneInTree=urls.every(url=>!fs.existsSync(url));
const at=manifest.deferred_contract.findIndex(x=>x.version===S46_EVENTS[0].version);
const N=S46_EVENTS.length;
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const pinned=S46_EVENTS.map(({version,file,sha256})=>({version,file,sha256}));

// The live release is the one before S46: the manifest minus the three entries and their predicates.
// Two states of the repository must both work:
//  (1) switch only: the manifest has no S46 entry yet (this branch on its own);
//  (2) after the S46 branch is merged: the manifest already ends with the three entries.
const live=structuredClone(manifest);
const predAt=manifest.posture.deferred_contract.predicates.findIndex(x=>S46_PREDICATE_NAMES.includes(x.name));
if(at>=0){
  live.deferred_contract.splice(at);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.slice(0,predAt);
}
const sqls=inTree?urls.map(url=>fs.readFileSync(url,'utf8')):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(...S46_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
candidate.posture.deferred_contract.predicates.push(...S46_PREDICATES.map(x=>({...x})));
const reviewed=S46_EVENTS.map((_,i)=>`-- the reviewed S46 batch SQL ${i}`);
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:[...reviewed],phase:'strict',recorded:[false,false,false],priorMatches:[true,true,true],bodyMatches:[false,false,false]});
const judge=state=>judgeS46DbBatchProvisioning({...state,expectedSha256:state.expectedSha256??state.sql.map(hashed)});

// The S46 branch itself, read from git when that ref is available (never written into the tree).
function fromGit(spec){
  for(const ref of ['origin/fix/os-s46-migrations']){
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
  assert.doesNotMatch(text,/::regclass/);
};

test('the S46 provisioning gate pins exactly three reviewed migrations, in order, and their posture predicates',()=>{
  assert.deepEqual(S46_EVENTS.map(x=>x.version),['20261126000100','20261126000200','20261126000300']);
  assert.deepEqual(S46_EVENTS.map(x=>x.file),['20261126000100_s46_leads_delete_admin_boss_only.sql','20261126000200_s46_milestone_order_ignores_reopened.sql','20261126000300_s46_quotation_value_currency_and_lock.sql']);
  for(const event of S46_EVENTS)assert.match(event.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(S46_PREDICATE_NAMES,['s46-leads-delete-admin-boss-only','s46-milestone-order-ignores-reopened','s46-quotation-value-currency-and-lock']);
  assert.equal(S46_POSTURE.length,N);assert.equal(S46_PRESENT.length,N);assert.equal(S46_PRIOR.length,N);
  // 1 posture: no sales delete policy, the admin / boss one stays, delete_lead_atomic definer / pinned / closed to anon / no sales branch
  assert.match(S46_POSTURE[0],/policyname='policy_leads_delete_sales'\)=0|count\(\*\)=0 FROM pg_catalog\.pg_policies[^)]*policy_leads_delete_sales/);
  assert.ok(S46_POSTURE[0].includes("policyname='policy_leads_delete_admin' AND cmd='DELETE'"));
  assert.ok(S46_POSTURE[0].includes("to_regprocedure('public.delete_lead_atomic(uuid,uuid)')"));
  assert.ok(S46_POSTURE[0].includes("p.prosrc NOT LIKE '%''sales''%'"));
  assert.match(S46_POSTURE[0],/bool_and\(p\.prosecdef\)/);
  assert.match(S46_POSTURE[0],/search_path=pg_catalog, public, pg_temp/);
  assert.match(S46_POSTURE[0],/NOT has_function_privilege\('anon'/);
  // 1 prior: the policy and the sales branch are both still there
  assert.ok(S46_PRIOR[0].includes("policyname='policy_leads_delete_sales'"));
  assert.ok(S46_PRIOR[0].includes("p.prosrc LIKE '%''sales''%'"));
  // 2 posture = present: definer / pinned, only completed milestones, the S39 marker kept; prior: without the new condition
  assert.equal(S46_PRESENT[1],S46_POSTURE[1]);
  assert.ok(S46_POSTURE[1].includes("p.prosrc LIKE '%completed_at IS NOT NULL%'"));
  assert.ok(S46_POSTURE[1].includes("p.prosrc LIKE '%skipping a milestone going forward%'"));
  assert.ok(S46_POSTURE[1].includes("to_regprocedure('public.check_milestone_order()')"));
  assert.ok(S46_PRIOR[1].includes("p.prosrc NOT LIKE '%completed_at IS NOT NULL%'"));
  // 3 posture: row lock, closed to clients, contract trigger watching currency; present adds the lock-error handler
  assert.ok(S46_POSTURE[2].includes("p.prosrc LIKE '%for update%'"));
  assert.ok(S46_POSTURE[2].includes("NOT has_function_privilege('authenticated'"));
  assert.ok(S46_POSTURE[2].includes("t.tgname='trg_contract_sync_lead_value'"));
  assert.ok(S46_POSTURE[2].includes("LIKE '%currency%'"));
  assert.ok(S46_PRESENT[2].includes("p.prosrc LIKE '%deadlock_detected%'"));
  assert.ok(S46_PRESENT[2].startsWith(S46_POSTURE[2].slice(0,40)));
  assert.ok(S46_PRIOR[2].includes("p.prosrc NOT LIKE '%for update%'"));
  assert.ok(S46_PRIOR[2].includes("NOT LIKE '%currency%'"));
  for(const text of [...S46_POSTURE,...S46_PRESENT,...S46_PRIOR]){readOnly(text);assert.match(text,/^SELECT coalesce\(/);}
});

// Always runs (the repository forbids new skipped tests). The switch is released on its own
// before the migrations: then the files are not in the tree and the manifest must not name them yet.
test('the S46 migrations, when present in the tree, match the pinned hashes, keep their entries and carry the exact predicates',()=>{
  if(noneInTree){
    assert.equal(at,-1,'the manifest lists the first S46 migration but its file is not in the tree');
    assert.equal(manifest.deferred_contract.some(x=>S46_EVENTS.some(e=>e.version===x.version)),false);
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>S46_PREDICATE_NAMES.includes(x.name)),false);
    return;
  }
  assert.ok(inTree,'all migration files are part of the tree');
  S46_EVENTS.forEach((event,i)=>assert.equal(hashed(sqls[i]),event.sha256));
  assert.deepEqual(manifest.deferred_contract.slice(at,at+N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(manifest.posture.deferred_contract.predicates.slice(predAt,predAt+N),S46_PREDICATES.map(x=>({...x})));
});

test('state 1 (switch only): the live manifest is untouched by S46 and the derived candidate passes',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:[true,true,true],priorMatches:[false,false,false],bodyMatches:[true,true,true]}),{problems:[],alreadyRecorded:true});
  // the live side never names S46, whichever state the repository is in
  assert.equal(live.deferred_contract.some(x=>x.version>=S46_EVENTS[0].version),false);
  assert.equal(live.posture.deferred_contract.predicates.some(x=>S46_PREDICATE_NAMES.includes(x.name)),false);
  // the S43 entry and rule check are the last of the prefix the gate pins
  assert.equal(live.deferred_contract.at(-1).version,'20261124300000');
  assert.equal(live.posture.deferred_contract.predicates.at(-1).name,'s43-leave-cover');
  // earlier entries and rule checks are part of the prefix the gate pins
  assert.ok(live.deferred_contract.some(x=>x.version==='20261123100000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s39-stage-rules-relaxed'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261122200000')&&live.deferred_contract.some(x=>x.version==='20261122300000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s36-quotation-value-follows-quotations-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s37-new-lead-not-dormant'));
  assert.ok(live.deferred_contract.some(x=>x.version==='20261121100000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s33-sync-advance-lead-stage-from-sheet-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s32-tasks-future-only-not-valid'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s31-dispatch-and-history-corrections-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s24-lead-dispatch-review-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s18-whatsapp-ctwa-leads-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s16-notification-constraints-and-lead-owner-present'));
});

test('state 2 (after the S46 branch is merged): its real manifest is accepted against the live prefix',()=>{
  // The S46 branch's own manifest and migrations, read from git when available. Without the ref
  // the synthetic candidate above (live + the pinned entries and predicates) stands in for it.
  const text=fromGit('infra/release/release-manifest.json');
  const brManifest=text?JSON.parse(text):structuredClone(candidate);
  const brSql=S46_EVENTS.map((event,i)=>fromGit('supabase/migrations/'+event.file)??(inTree?sqls[i]:null));
  const synthetic=brSql.some(x=>x===null);
  // the branch may carry newer entries from main than this tree's live side; compare only when it is based on the same prefix
  const stripped=structuredClone(brManifest);
  stripped.deferred_contract.splice(-N);
  stripped.posture.deferred_contract.predicates.splice(-N);
  const comparable=JSON.stringify(stripped)===JSON.stringify(live);
  const state={...input(),live:structuredClone(live),candidate:brManifest,sql:synthetic?[...reviewed]:brSql};
  const expectedSha256=synthetic?reviewed.map(hashed):undefined;
  if(!comparable)return;
  const result=judgeS46DbBatchProvisioning({...state,expectedSha256});
  assert.deepEqual(result.problems,[]);
  assert.deepEqual(brManifest.deferred_contract.slice(-N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(brManifest.posture.deferred_contract.predicates.slice(-N),S46_PREDICATES.map(x=>({...x})));
  // a manifest where the three new migrations are reversed is refused
  const swapped=structuredClone(brManifest);
  swapped.deferred_contract.splice(-N,N,...swapped.deferred_contract.slice(-N).reverse());
  assert.ok(judgeS46DbBatchProvisioning({...state,candidate:swapped,expectedSha256}).problems.length>0);
  // and a manifest where the batch is NOT last is refused
  const reordered=structuredClone(brManifest);
  const moved=reordered.deferred_contract.splice(-N);
  reordered.deferred_contract.splice(-1,0,...moved);
  assert.ok(judgeS46DbBatchProvisioning({...state,candidate:reordered,expectedSha256}).problems.length>0);
});

test('the reviewed SQL hashes are what the gate compares, not the file names',()=>{
  const state=input();
  state.sql=[reviewed[0]+'\nGRANT SELECT ON public.leads TO anon;',reviewed[1],reviewed[2]];
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS46DbBatchProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS46DbBatchProvisioning({...input(),sql:[reviewed[1],reviewed[0],reviewed[2]],expectedSha256:reviewed.map(hashed)}).problems.includes('reviewed SQL hash mismatch'));
  if(inTree)assert.deepEqual(judgeS46DbBatchProvisioning({...input(),sql:sqls}).problems,[]);
  const real=S46_EVENTS.map(event=>fromGit('supabase/migrations/'+event.file));
  if(real.every(x=>x!==null)&&real.every((x,i)=>hashed(x)===S46_EVENTS[i].sha256)){
    assert.deepEqual(judgeS46DbBatchProvisioning({...input(),sql:real}).problems,[]);
    for(let i=0;i<N;i+=1){
      const edited=[...real];edited[i]+='\n-- edited';
      assert.ok(judgeS46DbBatchProvisioning({...input(),sql:edited}).problems.includes('reviewed SQL hash mismatch'));
    }
  }
});

const R=(...v)=>v;
for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['a half-applied database (file 1 neither prior nor present)',x=>{x.priorMatches=R(false,true,true);x.bodyMatches=R(false,false,false);}],
  ['a half-applied database (file 2 neither prior nor present)',x=>{x.priorMatches=R(true,false,true);x.bodyMatches=R(false,false,false);}],
  ['a half-applied database (file 3 neither prior nor present)',x=>{x.priorMatches=R(true,true,false);x.bodyMatches=R(false,false,false);}],
  ['a half-applied database that also looks present',x=>{x.priorMatches=R(true,true,true);x.bodyMatches=R(true,true,true);}],
  ['file 1 applied but the others not, nothing recorded',x=>{x.priorMatches=R(false,true,true);x.bodyMatches=R(true,false,false);}],
  ['file 3 applied but the others not, nothing recorded',x=>{x.priorMatches=R(true,true,false);x.bodyMatches=R(false,false,true);}],
  ['file 3 applied and recorded but not the first two',x=>{x.recorded=R(false,false,true);x.priorMatches=R(true,true,false);x.bodyMatches=R(false,false,true);}],
  ['file 2 applied and recorded but not file 1',x=>{x.recorded=R(false,true,false);x.priorMatches=R(true,false,true);x.bodyMatches=R(false,true,false);}],
  ['files 1 and 3 recorded but not 2',x=>{x.recorded=R(true,false,true);x.priorMatches=R(false,true,false);x.bodyMatches=R(true,false,true);}],
  ['all applied but only the first recorded',x=>{x.recorded=R(true,false,false);x.priorMatches=R(false,false,false);x.bodyMatches=R(true,true,true);}],
  // near misses of the resumable prefix
  ['file 1 recorded but its objects missing',x=>{x.recorded=R(true,false,false);x.priorMatches=R(true,true,true);x.bodyMatches=R(false,false,false);}],
  ['file 1 recorded and neither prior nor present',x=>{x.recorded=R(true,false,false);x.priorMatches=R(false,true,true);x.bodyMatches=R(false,false,false);}],
  ['file 1 recorded and present, file 2 applied but unrecorded',x=>{x.recorded=R(true,false,false);x.priorMatches=R(false,false,true);x.bodyMatches=R(true,true,false);}],
  ['file 1 recorded and present, file 2 looks both prior and present',x=>{x.recorded=R(true,false,false);x.priorMatches=R(false,true,true);x.bodyMatches=R(true,true,false);}],
  ['file 1 recorded, present and still looking prior',x=>{x.recorded=R(true,false,false);x.priorMatches=R(true,true,true);x.bodyMatches=R(true,false,false);}],
  ['files 1 and 2 recorded and present, file 3 applied but unrecorded',x=>{x.recorded=R(true,true,false);x.priorMatches=R(false,false,false);x.bodyMatches=R(true,true,true);}],
  ['complete but unrecorded',x=>{x.priorMatches=R(false,false,false);x.bodyMatches=R(true,true,true);}],
  ['recorded but absent',x=>{x.recorded=R(true,true,true);}],
  ['recorded drift',x=>{x.recorded=R(true,true,true);x.bodyMatches=R(false,false,false);x.priorMatches=R(false,false,false);}],
  ['recorded with the third file old',x=>{x.recorded=R(true,true,true);x.priorMatches=R(false,false,true);x.bodyMatches=R(true,true,false);}],
  ['missing history result',x=>x.recorded=undefined],
  ['missing posture result',x=>x.bodyMatches=R(null,false,false)],
  ['too few results',x=>x.recorded=R(false,false)],
  ['too many results',x=>x.recorded=R(false,false,false,false)],
  ['SQL alteration',x=>{x.sql[2]+='\nGRANT SELECT ON public.leads TO anon;';}],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one (file 1)',x=>x.candidate.deferred_contract.at(-3).sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one (file 2)',x=>x.candidate.deferred_contract.at(-2).sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one (file 3)',x=>x.candidate.deferred_contract.at(-1).sha256='0'.repeat(64)],
  ['a fourth new migration',x=>x.candidate.deferred_contract.push({...S46_EVENTS[2],version:'20261126000400',file:'x.sql'})],
  ['only the first two migrations',x=>{x.candidate.deferred_contract.pop();x.candidate.posture.deferred_contract.predicates.pop();}],
  ['only the last two migrations',x=>{x.candidate.deferred_contract.splice(-3,1);x.candidate.posture.deferred_contract.predicates.splice(-3,1);}],
  ['the migrations reversed',x=>{x.candidate.deferred_contract.splice(-3,3,...x.candidate.deferred_contract.slice(-3).reverse());}],
  ['the predicates reversed',x=>{const p=x.candidate.posture.deferred_contract.predicates;p.splice(-3,3,...p.slice(-3).reverse());}],
  ['the batch not last',x=>{const m=x.candidate.deferred_contract.splice(-3);x.candidate.deferred_contract.splice(-1,0,...m);}],
  ['a candidate one migration ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['an S46 migration already in the live release',x=>x.live.deferred_contract.push({...S46_EVENTS[0]})],
  ['an S43 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261124300000');e.sha256='0'.repeat(64);}],
  ['an S43 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s43-leave-cover');p.sql='SELECT true';}],
  ['an S43 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s43-leave-cover'),1);}],
  ['an S39 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261123100000');e.sha256='0'.repeat(64);}],
  ['an S39 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s39-stage-rules-relaxed');p.sql='SELECT true';}],
  ['an S36 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s36-quotation-value-follows-quotations-present');p.sql='SELECT true';}],
  ['an S33 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261121100000');e.sha256='0'.repeat(64);}],
  ['an S32 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s32-tasks-future-only-not-valid');p.sql='SELECT true';}],
  ['an S31 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261120100000');e.sha256='0'.repeat(64);}],
  ['an S16 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s16-notification-warning-type-present');p.sql='SELECT true';}],
  ['an S25 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s25-whatsapp-history-backfill-present'),1);}],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['a weakened first S46 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-3).sql='SELECT true'],
  ['a weakened second S46 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-2).sql='SELECT true'],
  ['a weakened third S46 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['a renamed S46 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-3).name='s46-other'],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
  ['a live release without strict support',x=>{x.live.runs_under.database_phases=x.live.runs_under.database_phases.filter(p=>p!=='strict');}],
  ['a candidate without strict support',x=>{x.candidate.runs_under.database_phases=x.candidate.runs_under.database_phases.filter(p=>p!=='strict');}],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.length>0);
});

for(const [label,recorded,prior,body] of [
  ['file 1 recorded and present, files 2 and 3 absent and unrecorded',R(true,false,false),R(false,true,true),R(true,false,false)],
  ['files 1 and 2 recorded and present, file 3 absent and unrecorded',R(true,true,false),R(false,false,true),R(true,true,false)],
]) test(`a provision that failed part way is resumable: ${label}`,()=>{
  const state={...input(),recorded,priorMatches:prior,bodyMatches:body,expectedSha256:reviewed.map(hashed)};
  assert.deepEqual(judge(state),{problems:[],alreadyRecorded:false});
});

test('a batch recorded out of order is named as such',()=>{
  const state={...input(),recorded:[false,true,false],priorMatches:[true,false,true],bodyMatches:[false,true,false],expectedSha256:reviewed.map(hashed)};
  assert.deepEqual(judge(state).problems,['the S46 batch is recorded out of order']);
});

test('the deploy wrapper gates S46 provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s46-db-plan\|s46-db-provision\) ;;/);
  assert.match(wrapper,/\|s43-db-plan\|s43-db-provision\|s46-db-plan\|s46-db-provision(?:\|[a-z0-9-]+)*>" >&2/);
  const start=wrapper.indexOf('= s46-db-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s46-db-batch-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(wrapper,/s46-db-plan\|s46-db-provision\)\s+s46_db_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s46-db-provision \] \|\| s46_db_mode=--apply[\s\S]*?--phase deferred_contract "\$s46_db_mode"/);
  // the earlier switches are still there,
  for(const s of ['s43','s39','s36','s33','s32','s31','s25','s24','s21','s18','s16'])assert.ok(wrapper.includes(`${s}-db-plan|${s}-db-provision) ;;`),s);
  // and the generic contract operations still require the live release as the candidate
  assert.match(wrapper,/1:contract-apply\|1:contract-verify\|1:contract-rollback\|1:contract-reenter\)/);
});
