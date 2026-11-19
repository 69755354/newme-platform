import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { S25_EVENTS, S25_POSTURE, S25_PRIOR, S25_PREDICATES, S25_PREDICATE_NAMES, judgeS25DbBatchProvisioning } from '../../scripts/check-s25-db-batch-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const urls=S25_EVENTS.map(event=>new URL(`../../supabase/migrations/${event.file}`,import.meta.url));
const inTree=urls.every(url=>fs.existsSync(url));
const noneInTree=urls.every(url=>!fs.existsSync(url));
const at=manifest.deferred_contract.findIndex(x=>x.version===S25_EVENTS[0].version);
const N=S25_EVENTS.length;
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const pinned=S25_EVENTS.map(({version,file,sha256})=>({version,file,sha256}));

// The live release is the one before S25: the manifest minus the S25 entry and its predicate.
// Two states of the repository must both work:
//  (1) switch only: the manifest has no S25 entry yet (this branch on its own);
//  (2) after the S25 branch is merged: the manifest already ends with the S25 entry.
const live=structuredClone(manifest);
const predAt=manifest.posture.deferred_contract.predicates.findIndex(x=>S25_PREDICATE_NAMES.includes(x.name));
if(at>=0){
  live.deferred_contract.splice(at);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.slice(0,predAt);
}
const sqls=inTree?urls.map(url=>fs.readFileSync(url,'utf8')):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(...S25_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
candidate.posture.deferred_contract.predicates.push(...S25_PREDICATES.map(x=>({...x})));
const reviewed=S25_EVENTS.map((_,i)=>`-- the reviewed S25 SQL ${i}`);
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:[...reviewed],phase:'strict',recorded:[false],priorMatches:[true],bodyMatches:[false]});
const judge=state=>judgeS25DbBatchProvisioning({...state,expectedSha256:state.expectedSha256??state.sql.map(hashed)});

// The S25 branch itself, read from git when that ref is available (never written into the tree).
function fromGit(spec){
  for(const ref of ['origin/fix/os-s25-wa-history']){
    try{return execFileSync('git',['show',`${ref}:${spec}`],{encoding:'utf8',stdio:['ignore','pipe','ignore'],maxBuffer:64*1024*1024});}catch{/* ref not available here */}
  }
  return null;
}

test('the S25 provisioning gate pins exactly one reviewed migration and its posture predicate',()=>{
  assert.deepEqual(S25_EVENTS.map(x=>x.version),['20261119150000']);
  assert.deepEqual(S25_EVENTS.map(x=>x.file),['20261119150000_whatsapp_history_backfill.sql']);
  assert.equal(S25_EVENTS[0].sha256,'e94c432f3169a61114421287f8aedb873777ec26dda82bbd32e11660d798f7f5');
  assert.deepEqual(S25_PREDICATE_NAMES,['s25-whatsapp-history-backfill-present']);
  assert.match(S25_POSTURE[0],/backfilled/);
  assert.match(S25_POSTURE[0],/whatsapp_synced_contacts/);
  assert.match(S25_POSTURE[0],/record_whatsapp_history_messages/);
  assert.match(S25_POSTURE[0],/record_whatsapp_synced_contacts/);
  // the posture query runs on a database that does not have the objects yet: it must answer false, not fail
  assert.doesNotMatch(S25_POSTURE[0],/FROM public\./);
  assert.match(S25_PRIOR[0],/to_regclass\('public\.whatsapp_synced_contacts'\) IS NULL/);
  assert.match(S25_PRIOR[0],/column_name='backfilled'/);
  for(const text of [...S25_POSTURE,...S25_PRIOR]){
    assert.match(text,/^SELECT /);
    // read-only: no statement separator and no write verb outside quoted literals (the privilege
    // probes name INSERT/UPDATE/DELETE inside strings)
    assert.doesNotMatch(text.replace(/'[^']*'/g,"''"),/;|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT)\b/i);
  }
});

// Always runs (the repository forbids new skipped tests). The switch is released on its own
// before the migration: then the file is not in the tree and the manifest must not name it yet.
test('the S25 migration, when present in the tree, matches the pinned hash, keeps its entry and carries the exact predicate',()=>{
  if(noneInTree){
    assert.equal(at,-1,'the manifest lists the S25 migration but its file is not in the tree');
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>S25_PREDICATE_NAMES.includes(x.name)),false);
    return;
  }
  assert.ok(inTree,'the S25 migration file is part of the tree');
  S25_EVENTS.forEach((event,i)=>assert.equal(hashed(sqls[i]),event.sha256));
  assert.deepEqual(manifest.deferred_contract.slice(at,at+N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(manifest.posture.deferred_contract.predicates.slice(predAt,predAt+N),S25_PREDICATES.map(x=>({...x})));
});

test('state 1 (switch only): the live manifest is untouched by S25 and the derived candidate passes',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:[true],priorMatches:[false],bodyMatches:[true]}),{problems:[],alreadyRecorded:true});
  // the live side never names S25, whichever state the repository is in
  assert.equal(live.deferred_contract.some(x=>x.version===S25_EVENTS[0].version),false);
  assert.equal(live.posture.deferred_contract.predicates.some(x=>S25_PREDICATE_NAMES.includes(x.name)),false);
  // the S18 entry and rule check are part of the prefix the gate pins
  assert.ok(live.deferred_contract.some(x=>x.version==='20261118200000'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s18-whatsapp-ctwa-leads-present'));
  // the S16 entries and rule checks are part of the prefix the gate pins
  assert.ok(live.deferred_contract.some(x=>x.version==='20261112100000')&&live.deferred_contract.some(x=>x.version==='20261112100100'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s16-notification-constraints-and-lead-owner-present'));
  assert.ok(live.posture.deferred_contract.predicates.some(x=>x.name==='s16-notification-warning-type-present'));
});

test('state 2 (after the S25 branch is merged): its real manifest is accepted against the live prefix',()=>{
  // The S25 branch's own manifest and migration, read from git when available. Without the ref
  // the synthetic candidate above (live + the pinned entry and predicate) stands in for it.
  const text=fromGit('infra/release/release-manifest.json');
  const waManifest=text?JSON.parse(text):structuredClone(candidate);
  const waSql=fromGit('supabase/migrations/'+S25_EVENTS[0].file)??(inTree?sqls[0]:null);
  const state={...input(),live:structuredClone(live),candidate:waManifest,sql:waSql===null?[...reviewed]:[waSql]};
  const expectedSha256=waSql===null?reviewed.map(hashed):undefined;
  const result=judgeS25DbBatchProvisioning({...state,expectedSha256});
  assert.deepEqual(result.problems,[]);
  // the S25 branch's manifest differs from the live one by exactly the pinned entry and predicate
  const stripped=structuredClone(waManifest);
  stripped.deferred_contract.splice(-N);
  stripped.posture.deferred_contract.predicates.splice(-N);
  assert.deepEqual(stripped,live);
  assert.deepEqual(waManifest.deferred_contract.slice(-N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(waManifest.posture.deferred_contract.predicates.slice(-N),S25_PREDICATES.map(x=>({...x})));
  // and a manifest where the new migration is NOT last is refused
  const reordered=structuredClone(waManifest);
  const [moved]=reordered.deferred_contract.splice(-N);
  reordered.deferred_contract.splice(-1,0,moved);
  assert.ok(judgeS25DbBatchProvisioning({...state,candidate:reordered,expectedSha256}).problems.length>0);
});

test('the reviewed SQL hash is what the gate compares, not the file name',()=>{
  const state=input();
  state.sql=[reviewed[0]+'\nGRANT SELECT ON public.leads TO anon;'];
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS25DbBatchProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
  if(inTree)assert.deepEqual(judgeS25DbBatchProvisioning({...input(),sql:sqls}).problems,[]);
  const real=fromGit('supabase/migrations/'+S25_EVENTS[0].file);
  if(real!==null){
    assert.deepEqual(judgeS25DbBatchProvisioning({...input(),sql:[real]}).problems,[]);
    assert.ok(judgeS25DbBatchProvisioning({...input(),sql:[real+'\n-- edited']}).problems.includes('reviewed SQL hash mismatch'));
  }
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['a half-applied database (rules neither prior nor present)',x=>{x.priorMatches=[false];x.bodyMatches=[false];}],
  ['a half-applied database that also looks present',x=>{x.priorMatches=[true];x.bodyMatches=[true];}],
  ['complete but unrecorded',x=>{x.priorMatches=[false];x.bodyMatches=[true];}],
  ['recorded but absent',x=>{x.recorded=[true];}],
  ['recorded drift',x=>{x.recorded=[true];x.bodyMatches=[false];x.priorMatches=[false];}],
  ['missing history result',x=>x.recorded=undefined],
  ['missing posture result',x=>x.bodyMatches=[null]],
  ['too many results',x=>x.recorded=[false,false]],
  ['SQL alteration',x=>{x.sql[0]+='\nGRANT SELECT ON public.leads TO anon;';}],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['a candidate with a hash other than the pinned one',x=>x.candidate.deferred_contract.at(-1).sha256='0'.repeat(64)],
  ['a second new migration',x=>x.candidate.deferred_contract.push({...S25_EVENTS[0],version:'20261119100100',file:'x.sql'})],
  ['the new migration not last',x=>{const [m]=x.candidate.deferred_contract.splice(-1);x.candidate.deferred_contract.splice(-1,0,m);}],
  ['a candidate one migration ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['an S25 migration already in the live release',x=>x.live.deferred_contract.push({...S25_EVENTS[0]})],
  ['an S16 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261112100000');e.sha256='0'.repeat(64);}],
  ['an S16 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s16-notification-warning-type-present');p.sql='SELECT true';}],
  ['an S16 rule check removed',x=>{const preds=x.candidate.posture.deferred_contract.predicates;preds.splice(preds.findIndex(y=>y.name==='s16-notification-warning-type-present'),1);}],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['an S18 entry rewritten',x=>{const e=x.candidate.deferred_contract.find(y=>y.version==='20261118200000');e.sha256='0'.repeat(64);}],
  ['an S18 rule check weakened',x=>{const p=x.candidate.posture.deferred_contract.predicates.find(y=>y.name==='s18-whatsapp-ctwa-leads-present');p.sql='SELECT true';}],
  ['a weakened S25 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['a renamed S25 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).name='s25-other'],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
  ['a live release without strict support',x=>{x.live.runs_under.database_phases=x.live.runs_under.database_phases.filter(p=>p!=='strict');}],
  ['a candidate without strict support',x=>{x.candidate.runs_under.database_phases=x.candidate.runs_under.database_phases.filter(p=>p!=='strict');}],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.length>0);
});

test('the deploy wrapper gates S25 provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s25-db-plan\|s25-db-provision\) ;;/);
  assert.match(wrapper,/\|s21-db-plan\|s21-db-provision(?:\|[a-z0-9-]+)*\|s25-db-plan\|s25-db-provision(?:\|[a-z0-9-]+)*>" >&2/);
  const start=wrapper.indexOf('= s25-db-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s25-db-batch-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(wrapper,/s25-db-plan\|s25-db-provision\)\s+s25_db_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s25-db-provision \] \|\| s25_db_mode=--apply[\s\S]*?--phase deferred_contract "\$s25_db_mode"/);
  // the earlier switches are still there,
  assert.match(wrapper,/s21-db-plan\|s21-db-provision\) ;;/);
  assert.match(wrapper,/s18-db-plan\|s18-db-provision\) ;;/);
  // and the generic contract operations still require the live release as the candidate
  assert.match(wrapper,/s16-db-plan\|s16-db-provision\) ;;/);
  assert.match(wrapper,/1:contract-apply\|1:contract-verify\|1:contract-rollback\|1:contract-reenter\)/);
});
