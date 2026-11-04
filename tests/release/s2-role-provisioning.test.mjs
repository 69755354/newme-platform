import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { S2_EVENT, S2_POSTURE_SQL, S2_PREDICATE_NAME, S2_PRIOR_SQL, judgeS2RoleProvisioning } from '../../scripts/check-s2-role-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const migrationUrl=new URL(`../../supabase/migrations/${S2_EVENT.file}`,import.meta.url);
const migrationInTree=fs.existsSync(migrationUrl);
const s2At=manifest.deferred_contract.findIndex(x=>x.version===S2_EVENT.version);

// The live release is the one before S2: when the S2 version is already in the
// manifest, drop S2 and every later additive suffix (each appended exactly one
// deferred entry and one posture predicate), the same derivation as
// tests/release/meta-crm-provisioning.test.mjs. Before S2 merges, the manifest
// on this branch already is that live release.
const live=structuredClone(manifest);
if(s2At>=0){
  const laterSuffixes=live.deferred_contract.length-s2At-1;
  live.deferred_contract=live.deferred_contract.slice(0,s2At);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.slice(0,live.posture.deferred_contract.predicates.length-laterSuffixes);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.filter(x=>x.name!==S2_PREDICATE_NAME);
}
// The reviewed SQL is not in this tree until the S2 version merges, so the
// provisioning tests judge a fixed stand-in whose hash is swapped for the
// reviewed one: the judge compares hashes, never file names.
const sql=migrationInTree?fs.readFileSync(migrationUrl,'utf8'):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(S2_EVENT);
candidate.posture.deferred_contract.predicates.push({name:S2_PREDICATE_NAME,expect:true,sql:S2_POSTURE_SQL});
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:'-- the reviewed S2 SQL',phase:'strict',recorded:false,priorMatches:true,bodyMatches:false});
// judge() takes the hash of the supplied text; give it the reviewed hash by
// swapping the pinned value in a candidate-local copy of the constants.
const judge=state=>judgeS2RoleProvisioning({...state,expectedSha256:state.expectedSha256??hashed(state.sql)});

test('the S2 provisioning gate pins exactly one reviewed migration and its posture predicate',()=>{
  assert.equal(S2_EVENT.version,'20261104110000');
  assert.equal(S2_EVENT.file,'20261104110000_role_least_privilege.sql');
  assert.match(S2_EVENT.sha256,/^[0-9a-f]{64}$/);
  assert.equal(S2_PREDICATE_NAME,'s2-role-least-privilege-present');
  assert.match(S2_POSTURE_SQL,/trg_guard_projects_lead_binding/);
  assert.match(S2_POSTURE_SQL,/tgenabled = 'O'/);
  assert.match(S2_POSTURE_SQL,/contract_lead_display\(uuid\)/);
  assert.match(S2_POSTURE_SQL,/NOT IN \(''admin'', ''boss'', ''operator'', ''sales'', ''user'', ''salesperson''\)/);
  assert.match(S2_PRIOR_SQL,/NOT IN \(''admin'', ''boss'', ''sales'', ''user'', ''salesperson''\)/);
  // both predicates are one read-only select, like the manifest requires
  for(const text of [S2_POSTURE_SQL,S2_PRIOR_SQL]){
    assert.match(text,/^SELECT /);
    assert.doesNotMatch(text,/;|\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|GRANT)\b/i);
  }
});

// Always runs (the repository forbids new skipped tests). Before the S2
// version merges the migration is not in the tree and the manifest must not carry
// the S2 entry yet; once it is in the tree, its bytes must be the pinned ones.
test('the S2 migration, when present in the tree, matches the pinned hash and the manifest suffix',()=>{
  if(!migrationInTree){
    assert.equal(s2At,-1,'the manifest lists the S2 migration but its file is not in the tree');
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>x.name===S2_PREDICATE_NAME),false);
    return;
  }
  assert.equal(hashed(sql),S2_EVENT.sha256);
  assert.deepEqual(manifest.deferred_contract[s2At],S2_EVENT);
  const predicate=manifest.posture.deferred_contract.predicates.find(x=>x.name===S2_PREDICATE_NAME);
  assert.deepEqual(predicate,{name:S2_PREDICATE_NAME,expect:true,sql:S2_POSTURE_SQL});
});

test('only the exact additive S2 transition is accepted',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:true,priorMatches:false,bodyMatches:true}),{problems:[],alreadyRecorded:true});
});

test('the reviewed SQL hash is what the gate compares, not a file name',()=>{
  const state=input();
  state.sql='-- the reviewed S2 SQL\nGRANT SELECT ON public.leads TO anon;';
  state.expectedSha256=hashed('-- the reviewed S2 SQL');
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  // with no override the gate compares against the pinned constant
  assert.ok(judgeS2RoleProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['partial unrecorded role rules',x=>x.priorMatches=false],
  ['unrecorded complete role rules',x=>{x.priorMatches=false;x.bodyMatches=true;}],
  ['recorded drift',x=>{x.recorded=true;x.bodyMatches=false;}],
  ['missing history result',x=>x.recorded=undefined],
  ['contradictory state',x=>x.bodyMatches=true],
  ['missing posture result',x=>x.bodyMatches=null],
  ['SQL alteration',x=>{x.sql+='\nGRANT SELECT ON public.leads TO anon;';}],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['another migration',x=>x.candidate.deferred_contract.push({...S2_EVENT,version:'20261104110001'})],
  ['a candidate that is two migrations ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['the S2 migration already in the live release',x=>x.live.deferred_contract.push(S2_EVENT)],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['a weakened S2 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);
  state.expectedSha256=hashed('-- the reviewed S2 SQL');
  assert.ok(judge(state).problems.length>0);
});

test('the deploy wrapper gates S2 role provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s2-roles-plan\|s2-roles-provision\) ;;/);
  assert.match(wrapper,/\|s2-roles-plan\|s2-roles-provision>" >&2/);
  const start=wrapper.indexOf('= s2-roles-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s2-role-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  // the apply branch is the same two-flag shape as CAPI and CRM: plan reads, provision applies
  assert.match(wrapper,/s2-roles-plan\|s2-roles-provision\)\s+s2_roles_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s2-roles-provision \] \|\| s2_roles_mode=--apply[\s\S]*?--phase deferred_contract "\$s2_roles_mode"/);
});

test('the CI test list reaches the new gate test',()=>{
  // run-node-tests globs tests/**/*.test.mjs; the file must sit where the glob finds it
  assert.ok(fs.globSync('tests/**/s2-role-provisioning.test.mjs').length===1);
});
