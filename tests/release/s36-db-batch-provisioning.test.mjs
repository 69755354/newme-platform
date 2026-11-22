import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { S36_EVENTS, S36_POSTURE, S36_PRESENT, S36_PRIOR, S36_PREDICATES, S36_PREDICATE_NAMES, judgeS36DbBatchProvisioning } from '../../scripts/check-s36-db-batch-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const urls=S36_EVENTS.map(event=>new URL(`../../supabase/migrations/${event.file}`,import.meta.url));
const inTree=urls.every(url=>fs.existsSync(url));
const noneInTree=urls.every(url=>!fs.existsSync(url));
const at=manifest.deferred_contract.findIndex(x=>x.version===S36_EVENTS[0].version);
const N=S36_EVENTS.length;
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const pinned=S36_EVENTS.map(({version,file,sha256})=>({version,file,sha256}));

// The live release is the one before S36 / S37: the manifest minus the two entries and their predicates.
// Two states of the repository must both work:
//  (1) switch only: the manifest has no S36 / S37 entry yet (this branch on its own);
//  (2) after the S37 branch (which carries S36) is merged: the manifest already ends with the two entries.
const live=structuredClone(manifest);
const predAt=manifest.posture.deferred_contract.predicates.findIndex(x=>S36_PREDICATE_NAMES.includes(x.name));
if(at>=0){
  live.deferred_contract.splice(at);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.slice(0,predAt);
}
const sqls=inTree?urls.map(url=>fs.readFileSync(url,'utf8')):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(...S36_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
candidate.posture.deferred_contract.predicates.push(...S36_PREDICATES.map(x=>({...x})));
const reviewed=S36_EVENTS.map((_,i)=>`-- the reviewed S36 batch SQL ${i}`);
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:[...reviewed],phase:'strict',recorded:[false,false],priorMatches:[true,true],bodyMatches:[false,false]});
const judge=state=>judgeS36DbBatchProvisioning({...state,expectedSha256:state.expectedSha256??state.sql.map(hashed)});

// The S37 branch itself (it merges S36), read from git when that ref is available (never written into the tree).
function fromGit(spec){
  for(const ref of ['origin/fix/os-s37-numbers']){
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

test('the S36 provisioning gate pins exactly two reviewed migrations, S36 then S37, and their posture predicates',()=>{
  assert.deepEqual(S36_EVENTS.map(x=>x.version),['20261122200000','20261122300000']);
  assert.deepEqual(S36_EVENTS.map(x=>x.file),['20261122200000_quotation_value_follows_quotations.sql','20261122300000_s37_new_lead_not_dormant.sql']);
  assert.equal(S36_EVENTS[0].sha256,'56782b7a0e47d907085c8020574b36f1dd5a5ce9dbda22fdaa66615acbc36e0e');
  assert.equal(S36_EVENTS[1].sha256,'f0235899c6c9b84ccf30a80808dc85bdf03efc65ab6d61fec8d2745638fe828b');
  assert.deepEqual(S36_PREDICATE_NAMES,['s36-quotation-value-follows-quotations-present','s37-new-lead-not-dormant']);
  assert.equal(S36_POSTURE.length,N);assert.equal(S36_PRESENT.length,N);assert.equal(S36_PRIOR.length,N);
  // S36 posture (the manifest predicate): the three triggers enabled, the value routine definer / pinned / closed to clients
  assert.match(S36_POSTURE[0],/count\(\*\)=3 AND bool_and\(NOT t\.tgisinternal\)/);
  for(const trigger of ['trg_quotation_sync_lead_value','trg_contract_sync_lead_value','trg_lead_won_sync_value'])assert.ok(S36_POSTURE[0].includes(`'${trigger}'`));
  assert.match(S36_POSTURE[0],/t\.tgenabled='O'/);
  assert.match(S36_POSTURE[0],/to_regprocedure\('public\.sync_lead_quotation_value\(uuid,numeric\)'\)/);
  assert.match(S36_POSTURE[0],/bool_and\(p\.prosecdef\)/);
  assert.match(S36_POSTURE[0],/search_path=pg_catalog, public, pg_temp/);
  assert.match(S36_POSTURE[0],/NOT has_function_privilege\('anon'/);
  assert.match(S36_POSTURE[0],/NOT has_function_privilege\('authenticated'/);
  // S36 present (what the gate reads): all three routines definer / pinned / closed, and each trigger on its exact table
  // calling its exact routine, not internal, enabled 'O'
  assert.match(S36_PRESENT[0],/count\(\*\)=3 AND bool_and\(p\.prosecdef\) AND bool_and\(p\.proconfig @> ARRAY\['search_path=pg_catalog, public, pg_temp'\]::text\[\]\)/);
  for(const routine of ['public.sync_lead_quotation_value(uuid,numeric)','public.trg_sync_lead_quotation_value()','public.trg_lead_won_sync_quotation_value()'])assert.ok(S36_PRESENT[0].includes(`to_regprocedure('${routine}')`));
  assert.match(S36_PRESENT[0],/NOT has_function_privilege\('anon'/);
  assert.match(S36_PRESENT[0],/NOT has_function_privilege\('authenticated'/);
  assert.match(S36_PRESENT[0],/count\(\*\)=3 AND bool_and\(NOT t\.tgisinternal\) AND bool_and\(t\.tgenabled='O'\)/);
  assert.ok(S36_PRESENT[0].includes("(to_regclass('public.quotations'),'trg_quotation_sync_lead_value',to_regprocedure('public.trg_sync_lead_quotation_value()'))"));
  assert.ok(S36_PRESENT[0].includes("(to_regclass('public.contracts'),'trg_contract_sync_lead_value',to_regprocedure('public.trg_sync_lead_quotation_value()'))"));
  assert.ok(S36_PRESENT[0].includes("(to_regclass('public.leads'),'trg_lead_won_sync_value',to_regprocedure('public.trg_lead_won_sync_quotation_value()'))"));
  // S36 prior: none of the routines, none of the triggers
  for(const routine of ['public.sync_lead_quotation_value(uuid,numeric)','public.trg_sync_lead_quotation_value()','public.trg_lead_won_sync_quotation_value()'])assert.ok(S36_PRIOR[0].includes(`to_regprocedure('${routine}') IS NULL`));
  assert.match(S36_PRIOR[0],/NOT EXISTS \(SELECT 1 FROM pg_catalog\.pg_trigger t WHERE t\.tgname IN \('trg_quotation_sync_lead_value','trg_contract_sync_lead_value','trg_lead_won_sync_value'\) AND NOT t\.tgisinternal\)/);
  // S37 posture = present: the one trigger routine, definer / pinned, carrying the 48-hour marker of the new rule
  assert.equal(S36_PRESENT[1],S36_POSTURE[1]);
  assert.match(S36_POSTURE[1],/count\(\*\)=1 AND bool_and\(p\.prosecdef\)/);
  assert.match(S36_POSTURE[1],/search_path=pg_catalog, public, pg_temp/);
  assert.match(S36_POSTURE[1],/p\.prosrc LIKE '%48 hours%'/);
  assert.match(S36_POSTURE[1],/to_regprocedure\('public\.derive_lead_status\(\)'\)/);
  // S37 prior: the routine exists with the old body (no marker); a missing routine is not a prior state
  assert.match(S36_PRIOR[1],/^SELECT coalesce\(\(SELECT count\(\*\)=1 AND bool_and\(p\.prosrc NOT LIKE '%48 hours%'\) FROM pg_catalog\.pg_proc p WHERE p\.oid=to_regprocedure\('public\.derive_lead_status\(\)'\)\),false\)$/);
  for(const text of [...S36_POSTURE,...S36_PRESENT,...S36_PRIOR])readOnly(text);
  for(const text of [...S36_POSTURE,...S36_PRESENT,S36_PRIOR[1]])assert.match(text,/^SELECT coalesce\(/);
});

// Always runs (the repository forbids new skipped tests). The switch is released on its own
// before the migrations: then the files are not in the tree and the manifest must not name them yet.
test('the S36 and S37 migrations, when present in the tree, match the pinned hashes, keep their entries and carry the exact predicates',()=>{
  if(noneInTree){
    assert.equal(at,-1,'the manifest lists the S36 migration but its file is not in the tree');
    assert.equal(manifest.deferred_contract.some(x=>x.version===S36_EVENTS[1].version),false);
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>S36_PREDICATE_NAMES.includes(x.name)),false);
    return;
  }
  assert.ok(inTree,'both migration files are part of the tree');
  S36_EVENTS.forEach((event,i)=>assert.equal(hashed(sqls[i]),event.sha256));
  assert.deepEqual(manifest.deferred_contract.slice(at,at+N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(manifest.posture.deferred_contract.predicates.slice(predAt,predAt+N),S36_PREDICATES.map(x=>({...x})));
});

test('state 1 (switch only): the live manifest is untouched by S36 / S37 and the derived candidate passes',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:[true,true],priorMatches:[false,false],bodyMatches:[true,true]}),{problems:[],alreadyRecorded:true});
  // the live side never names S36 / S37, whichever state the repository is in
  assert.equal(live.deferred_contract.some(x=>x.version>=S36_EVENTS[0].version),false);
  assert.equal(live.posture.deferred_contract.predicates.some(x=>S36_PREDICATE_NAMES.includes(x.name)),false);
  // the S33 entry and rule check are the last of the prefix the gate pins
  assert.equal(live.deferred_contract.at(-1).version,'20261121100000');
  assert.equal(live.posture.deferred_contract.predicates.at(-1).name,'s33-sync-advance-lead-stage-from-sheet-present');
  // the S32 and S31 entries and rule checks are part of the prefix the gate pins
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
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s16-notification-warning-type-present'));
});

test('state 2 (after the S37 branch is merged): its real manifest is accepted against the live prefix',()=>{
  // The S37 branch's own manifest and migrations, read from git when available. Without the ref
  // the synthetic candidate above (live + the pinned entries and predicates) stands in for it.
  const text=fromGit('infra/release/release-manifest.json');
  const brManifest=text?JSON.parse(text):structuredClone(candidate);
  const brSql=S36_EVENTS.map((event,i)=>fromGit('supabase/migrations/'+event.file)??(inTree?sqls[i]:null));
  const synthetic=brSql.some(x=>x===null);
  const state={...input(),live:structuredClone(live),candidate:brManifest,sql:synthetic?[...reviewed]:brSql};
  const expectedSha256=synthetic?reviewed.map(hashed):undefined;
  const result=judgeS36DbBatchProvisioning({...state,expectedSha256});
  assert.deepEqual(result.problems,[]);
  // the S37 branch's manifest differs from the live one by exactly the two pinned entries and predicates
  const stripped=structuredClone(brManifest);
  stripped.deferred_contract.splice(-N);
  stripped.posture.deferred_contract.predicates.splice(-N);
  assert.deepEqual(stripped,live);
  assert.deepEqual(brManifest.deferred_contract.slice(-N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(brManifest.posture.deferred_contract.predicates.slice(-N),S36_PREDICATES.map(x=>({...x})));
  // a manifest where the two new migrations are swapped (S37 before S36) is refused
  const swapped=structuredClone(brManifest);
  swapped.deferred_contract.splice(-N,N,...swapped.deferred_contract.slice(-N).reverse());
  assert.ok(judgeS36DbBatchProvisioning({...state,candidate:swapped,expectedSha256}).problems.length>0);
  // and a manifest where the batch is NOT last is refused
  const reordered=structuredClone(brManifest);
  const moved=reordered.deferred_contract.splice(-N);
  reordered.deferred_contract.splice(-1,0,...moved);
  assert.ok(judgeS36DbBatchProvisioning({...state,candidate:reordered,expectedSha256}).problems.length>0);
});

test('the reviewed SQL hashes are what the gate compares, not the file names',()=>{
  const state=input();
  state.sql=[reviewed[0]+'\nGRANT SELECT ON public.leads TO anon;',reviewed[1]];
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS36DbBatchProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS36DbBatchProvisioning({...input(),sql:[reviewed[1],reviewed[0]],expectedSha256:reviewed.map(hashed)}).problems.includes('reviewed SQL hash mismatch'));
  if(inTree)assert.deepEqual(judgeS36DbBatchProvisioning({...input(),sql:sqls}).problems,[]);
  const real=S36_EVENTS.map(event=>fromGit('supabase/migrations/'+event.file));
  if(real.every(x=>x!==null)){
    assert.deepEqual(judgeS36DbBatchProvisioning({...input(),sql:real}).problems,[]);
    assert.ok(judgeS36DbBatchProvisioning({...input(),sql:[real[0]+'\n-- edited',real[1]]}).problems.includes('reviewed SQL hash mismatch'));
    assert.ok(judgeS36DbBatchProvisioning({...input(),sql:[real[0],real[1]+'\n-- edited']}).problems.includes('reviewed SQL hash mismatch'));
    assert.ok(judgeS36DbBatchProvisioning({...input(),sql:[real[1],real[0]]}).problems.includes('reviewed SQL hash mismatch'));
  }
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['a half-applied database (S36 neither prior nor present)',x=>{x.priorMatches=[false,true];x.bodyMatches=[false,false];}],
  ['a half-applied database (S37 neither prior nor present: derive_lead_status missing)',x=>{x.priorMatches=[true,false];x.bodyMatches=[false,false];}],
  ['a half-applied database that also looks present',x=>{x.priorMatches=[true,true];x.bodyMatches=[true,true];}],
  ['S36 applied but S37 not, nothing recorded',x=>{x.priorMatches=[false,true];x.bodyMatches=[true,false];}],
  ['S37 applied but S36 not, nothing recorded',x=>{x.priorMatches=[true,false];x.bodyMatches=[false,true];}],
  ['S37 applied and recorded but S36 not',x=>{x.recorded=[false,true];x.priorMatches=[true,false];x.bodyMatches=[false,true];}],
  ['both applied but only S36 recorded',x=>{x.recorded=[true,false];x.priorMatches=[false,false];x.bodyMatches=[true,true];}],
  // near misses of the resumable prefix (S36 recorded and present, S37 absent and unrecorded)
  ['S36 recorded but its objects missing, S37 absent',x=>{x.recorded=[true,false];x.priorMatches=[true,true];x.bodyMatches=[false,false];}],
  ['S36 recorded but its objects mismatched (neither prior nor present), S37 absent',x=>{x.recorded=[true,false];x.priorMatches=[false,true];x.bodyMatches=[false,false];}],
  ['S36 recorded and present, S37 applied but unrecorded',x=>{x.recorded=[true,false];x.priorMatches=[false,false];x.bodyMatches=[true,true];}],
  ['S36 recorded and present, derive_lead_status missing',x=>{x.recorded=[true,false];x.priorMatches=[false,false];x.bodyMatches=[true,false];}],
  ['S36 recorded and present, S37 looks both prior and present',x=>{x.recorded=[true,false];x.priorMatches=[false,true];x.bodyMatches=[true,true];}],
  ['S36 recorded, present and still looking prior, S37 absent',x=>{x.recorded=[true,false];x.priorMatches=[true,true];x.bodyMatches=[true,false];}],
  ['complete but unrecorded',x=>{x.priorMatches=[false,false];x.bodyMatches=[true,true];}],
  ['recorded but absent',x=>{x.recorded=[true,true];}],
  ['recorded drift',x=>{x.recorded=[true,true];x.bodyMatches=[false,false];x.priorMatches=[false,false];}],
  ['recorded with S36 objects present but the S37 body old',x=>{x.recorded=[true,true];x.priorMatches=[false,true];x.bodyMatches=[true,false];}],
  ['missing history result',x=>x.recorded=undefined],
  ['missing posture result',x=>x.bodyMatches=[null,false]],
  ['too few results',x=>x.recorded=[false]],
  ['too many results',x=>x.recorded=[false,false,false]],
  ['SQL alteration',x=>{x.sql[1]+='\nGRANT SELECT ON public.leads TO anon;';}],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one (S36)',x=>x.candidate.deferred_contract.at(-2).sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one (S37)',x=>x.candidate.deferred_contract.at(-1).sha256='0'.repeat(64)],
  ['a third new migration',x=>x.candidate.deferred_contract.push({...S36_EVENTS[1],version:'20261122300100',file:'x.sql'})],
  ['only the S36 migration',x=>{x.candidate.deferred_contract.pop();x.candidate.posture.deferred_contract.predicates.pop();}],
  ['only the S37 migration',x=>{x.candidate.deferred_contract.splice(-2,1);x.candidate.posture.deferred_contract.predicates.splice(-2,1);}],
  ['the two migrations swapped',x=>{x.candidate.deferred_contract.splice(-2,2,...x.candidate.deferred_contract.slice(-2).reverse());}],
  ['the two predicates swapped',x=>{const p=x.candidate.posture.deferred_contract.predicates;p.splice(-2,2,...p.slice(-2).reverse());}],
  ['the batch not last',x=>{const m=x.candidate.deferred_contract.splice(-2);x.candidate.deferred_contract.splice(-1,0,...m);}],
  ['a candidate one migration ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['an S36 migration already in the live release',x=>x.live.deferred_contract.push({...S36_EVENTS[0]})],
  ['an S33 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261121100000');e.sha256='0'.repeat(64);}],
  ['an S33 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s33-sync-advance-lead-stage-from-sheet-present');p.sql='SELECT true';}],
  ['an S33 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s33-sync-advance-lead-stage-from-sheet-present'),1);}],
  ['an S32 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261120200000');e.sha256='0'.repeat(64);}],
  ['an S32 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s32-tasks-future-only-not-valid');p.sql='SELECT true';}],
  ['an S31 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261120100000');e.sha256='0'.repeat(64);}],
  ['an S31 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s31-dispatch-and-history-corrections-present');p.sql='SELECT true';}],
  ['an S16 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261112100000');e.sha256='0'.repeat(64);}],
  ['an S16 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s16-notification-warning-type-present');p.sql='SELECT true';}],
  ['an S18 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s18-whatsapp-ctwa-leads-present');p.sql='SELECT true';}],
  ['an S24 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261119300000');e.sha256='0'.repeat(64);}],
  ['an S25 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s25-whatsapp-history-backfill-present'),1);}],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['a weakened S36 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-2).sql='SELECT true'],
  ['a weakened S37 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['a renamed S36 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-2).name='s36-other'],
  ['a renamed S37 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).name='s37-other'],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
  ['a live release without strict support',x=>{x.live.runs_under.database_phases=x.live.runs_under.database_phases.filter(p=>p!=='strict');}],
  ['a candidate without strict support',x=>{x.candidate.runs_under.database_phases=x.candidate.runs_under.database_phases.filter(p=>p!=='strict');}],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.length>0);
});

test('a provision that failed after S36 committed is resumable: S36 recorded and present, S37 absent and unrecorded',()=>{
  const state={...input(),recorded:[true,false],priorMatches:[false,true],bodyMatches:[true,false],expectedSha256:reviewed.map(hashed)};
  assert.deepEqual(judge(state),{problems:[],alreadyRecorded:false});
});

test('a batch recorded out of order is named as such',()=>{
  const state={...input(),recorded:[false,true],priorMatches:[true,false],bodyMatches:[false,true],expectedSha256:reviewed.map(hashed)};
  assert.deepEqual(judge(state).problems,['the S36 and S37 batch is recorded out of order']);
});

test('the deploy wrapper gates S36 provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s36-db-plan\|s36-db-provision\) ;;/);
  assert.match(wrapper,/\|s21-db-plan\|s21-db-provision(?:\|[a-z0-9-]+)*\|s33-db-plan\|s33-db-provision\|s36-db-plan\|s36-db-provision>" >&2/);
  const start=wrapper.indexOf('= s36-db-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s36-db-batch-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(wrapper,/s36-db-plan\|s36-db-provision\)\s+s36_db_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s36-db-provision \] \|\| s36_db_mode=--apply[\s\S]*?--phase deferred_contract "\$s36_db_mode"/);
  // the earlier switches are still there,
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
