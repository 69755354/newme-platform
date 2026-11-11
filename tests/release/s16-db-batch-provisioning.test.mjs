import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { S16_EVENTS, S16_POSTURE, S16_PRIOR, S16_PREDICATES, S16_PREDICATE_NAMES, judgeS16DbBatchProvisioning } from '../../scripts/check-s16-db-batch-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const urls=S16_EVENTS.map(event=>new URL(`../../supabase/migrations/${event.file}`,import.meta.url));
const inTree=urls.every(url=>fs.existsSync(url));
const noneInTree=urls.every(url=>!fs.existsSync(url));
const at=manifest.deferred_contract.findIndex(x=>x.version===S16_EVENTS[0].version);
const N=S16_EVENTS.length;

// The live release is the one before S16: the manifest minus the S16 entries and their
// predicates. Before the S16 migrations are in the tree the manifest already is that release.
const live=structuredClone(manifest);
if(at>=0){
  if(at!==live.deferred_contract.length-N)throw new Error('the S16 migrations must be the LAST deferred entries');
  live.deferred_contract.splice(-N);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.filter(x=>!S16_PREDICATE_NAMES.includes(x.name));
}
const sqls=inTree?urls.map(url=>fs.readFileSync(url,'utf8')):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(...S16_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
candidate.posture.deferred_contract.predicates.push(...S16_PREDICATES.map(x=>({...x})));
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const reviewed=S16_EVENTS.map((_,i)=>`-- the reviewed S16 SQL ${i}`);
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:[...reviewed],phase:'strict',recorded:[false,false],priorMatches:[true,true],bodyMatches:[false,false]});
const judge=state=>judgeS16DbBatchProvisioning({...state,expectedSha256:state.expectedSha256??state.sql.map(hashed)});

test('the S16 provisioning gate pins exactly two reviewed migrations and their posture predicates',()=>{
  assert.deepEqual(S16_EVENTS.map(x=>x.version),['20261112100000','20261112100100']);
  assert.deepEqual(S16_EVENTS.map(x=>x.file),['20261112100000_notification_constraints_and_lead_owner_contracts.sql','20261112100100_notification_warning_type.sql']);
  for(const event of S16_EVENTS)assert.match(event.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(S16_PREDICATE_NAMES,['s16-notification-constraints-and-lead-owner-present','s16-notification-warning-type-present']);
  assert.match(S16_POSTURE[0],/notifications_type_check/);
  assert.match(S16_POSTURE[0],/notifications_related_type_check/);
  assert.match(S16_POSTURE[0],/coalesce\(v_lead\.assigned_to, v_quote\.created_by, v_actor\)/);
  assert.match(S16_PRIOR[0],/coalesce\(v_quote\.created_by, v_actor\), v_actor/);
  assert.match(S16_POSTURE[1],/'warning'/);
  assert.match(S16_PRIOR[1],/NOT LIKE '%''warning''::%'/);
  for(const text of [...S16_POSTURE,...S16_PRIOR]){
    assert.match(text,/^SELECT /);
    assert.doesNotMatch(text,/;|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT)\b/i);
  }
});

// Always runs (the repository forbids new skipped tests). The switch can be released on its own
// before the migrations: then the files are not in the tree and the manifest must not name them yet.
test('the S16 migrations, when present in the tree, match the pinned hashes, are the last deferred entries and carry the exact predicates',()=>{
  if(noneInTree){
    assert.equal(at,-1,'the manifest lists the S16 migrations but their files are not in the tree');
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>S16_PREDICATE_NAMES.includes(x.name)),false);
    return;
  }
  assert.ok(inTree,'both S16 migration files are part of the tree');
  S16_EVENTS.forEach((event,i)=>assert.equal(hashed(sqls[i]),event.sha256));
  assert.deepEqual(manifest.deferred_contract.slice(at),S16_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
  assert.deepEqual(manifest.posture.deferred_contract.predicates.slice(-N),S16_PREDICATES.map(x=>({...x})));
});

test('the S16 migrations follow the repository conventions',()=>{
  if(!inTree)return;
  for(const sql of sqls){
    assert.match(sql,/^-- NO_ROLLBACK: /);
    assert.match(sql,/Manual undo/);
    assert.doesNotMatch(sql,/create policy|alter policy/i);
    assert.doesNotMatch(sql.replace(/\(select public\.session_token_is_current\(\)\)/g,''),/session_token_is_current\(\)/);
    assert.match(sql,/currently allows values this migration would drop/);
  }
  const [first,second]=sqls;
  assert.match(first,/drop constraint if exists notifications_type_check;\s*alter table public\.notifications add constraint notifications_type_check/);
  assert.match(first,/drop constraint if exists notifications_related_type_check;\s*alter table public\.notifications add constraint notifications_related_type_check/);
  assert.match(second,/drop constraint if exists notifications_type_check;\s*alter table public\.notifications add constraint notifications_type_check/);
  assert.match(second,/'warning'::character varying/);
  const fn=first.slice(first.indexOf('create or replace function public.convert_quotation_to_contract'));
  assert.match(fn,/SECURITY DEFINER\s+SET search_path TO 'pg_catalog', 'public', 'pg_temp'/);
  assert.match(fn,/coalesce\(v_lead\.assigned_to, v_quote\.created_by, v_actor\), v_actor,/);
  assert.doesNotMatch(fn,/coalesce\(v_quote\.created_by, v_actor\), v_actor/);
  assert.match(fn,/advance_lead_to_pending_decision/);
  assert.doesNotMatch(fn,/finalize_lead_won|into public\.projects|'finance'/);
  assert.match(fn,/array\['admin', 'boss', 'operator', 'sales'\]\)/);
});

test('the new routine body differs from the S2 one in exactly the owner expression',()=>{
  if(!inTree)return;
  const s2=fs.readFileSync(new URL('../../supabase/migrations/20261104110000_role_least_privilege.sql',import.meta.url),'utf8');
  const body=text=>{const start=text.indexOf('create or replace function public.convert_quotation_to_contract');return text.slice(start,text.indexOf('\n$function$;',start));};
  const before=body(s2).split('\n'),after=body(sqls[0]).split('\n');
  assert.equal(before.length,after.length);
  const changed=before.map((line,i)=>[line,after[i]]).filter(([a,b])=>a!==b);
  assert.equal(changed.length,1);
  assert.match(changed[0][0],/coalesce\(v_quote\.created_by, v_actor\), v_actor,/);
  assert.match(changed[0][1],/coalesce\(v_lead\.assigned_to, v_quote\.created_by, v_actor\), v_actor,/);
});

test('only the exact additive S16 transition is accepted',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:[true,true],priorMatches:[false,false],bodyMatches:[true,true]}),{problems:[],alreadyRecorded:true});
  // a run that stopped after the first file resumes
  assert.deepEqual(judge({...input(),recorded:[true,false],priorMatches:[false,false],bodyMatches:[true,true]}),{problems:[],alreadyRecorded:false});
});

test('the reviewed SQL hashes are what the gate compares, not file names',()=>{
  const state=input();
  state.sql=[reviewed[0]+'\nGRANT SELECT ON public.leads TO anon;',reviewed[1]];
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS16DbBatchProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
  // and the tree's own files, when present, pass against the pinned constants
  if(inTree)assert.deepEqual(judgeS16DbBatchProvisioning({...input(),sql:sqls}).problems,[]);
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['partial unrecorded rules',x=>x.priorMatches=[false,true]],
  ['partial unrecorded follow-up rules',x=>x.priorMatches=[true,false]],
  ['unrecorded complete rules',x=>{x.priorMatches=[false,false];x.bodyMatches=[true,true];}],
  ['recorded drift',x=>{x.recorded=[true,true];x.bodyMatches=[true,false];x.priorMatches=[false,false];}],
  ['follow-up change present without the first being recorded',x=>{x.priorMatches=[true,false];x.bodyMatches=[false,true];}],
  ['follow-up recorded without the first',x=>{x.recorded=[false,true];x.priorMatches=[true,false];x.bodyMatches=[false,true];}],
  ['missing history result',x=>x.recorded=undefined],
  ['contradictory state',x=>x.bodyMatches=[true,false]],
  ['missing posture result',x=>x.bodyMatches=[null,false]],
  ['SQL alteration',x=>{x.sql[1]+='\nGRANT SELECT ON public.leads TO anon;';}],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['another migration',x=>x.candidate.deferred_contract.push({...S16_EVENTS[1],version:'20261112100200'})],
  ['a candidate one migration ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['an S16 migration already in the live release',x=>x.live.deferred_contract.push({...S16_EVENTS[0]})],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['a weakened S16 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['a weakened first S16 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-2).sql='SELECT true'],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.length>0);
});

test('the deploy wrapper gates S16 provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s16-db-plan\|s16-db-provision\) ;;/);
  assert.match(wrapper,/\|s16-db-plan\|s16-db-provision>" >&2/);
  const start=wrapper.indexOf('= s16-db-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s16-db-batch-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(wrapper,/s16-db-plan\|s16-db-provision\)\s+s16_db_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s16-db-provision \] \|\| s16_db_mode=--apply[\s\S]*?--phase deferred_contract "\$s16_db_mode"/);
  // the generic contract operations still require the live release as the candidate; this switch does not widen them
  assert.match(wrapper,/1:contract-apply\|1:contract-verify\|1:contract-rollback\|1:contract-reenter\)/);
});
