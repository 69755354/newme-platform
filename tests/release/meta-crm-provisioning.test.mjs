import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CRM_EVENT, CRM_POSTURE_SQL, CRM_PREDICATE_NAME, judgeCrmProvisioning } from '../../scripts/check-meta-crm-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const live=structuredClone(manifest);
live.deferred_contract=live.deferred_contract.filter(x=>x.version!==CRM_EVENT.version);
live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.filter(x=>x.name!==CRM_PREDICATE_NAME);
const sql=fs.readFileSync(new URL(`../../supabase/migrations/${CRM_EVENT.file}`,import.meta.url),'utf8');
const candidate=structuredClone(live);
candidate.deferred_contract.push(CRM_EVENT);
candidate.posture.deferred_contract.predicates.push({name:CRM_PREDICATE_NAME,expect:true,sql:CRM_POSTURE_SQL});
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql,phase:'strict',recorded:false,priorMatches:true,bodyMatches:false});

test('the committed manifest is exactly the reviewed CRM transition',()=>{
  assert.deepEqual(manifest,candidate);
  assert.deepEqual(manifest.deferred_contract.at(-1),CRM_EVENT);
});

test('only the exact additive CRM schema transition is accepted',()=>{
  assert.deepEqual(judgeCrmProvisioning(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judgeCrmProvisioning({...input(),recorded:true,priorMatches:false,bodyMatches:true}),{problems:[],alreadyRecorded:true});
  assert.equal(createHash('sha256').update(sql.replaceAll('\r\n','\n')).digest('hex'),CRM_EVENT.sha256);
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['partial unrecorded schema',x=>x.priorMatches=false],
  ['unrecorded complete schema',x=>{x.priorMatches=false;x.bodyMatches=true;}],
  ['recorded schema drift',x=>{x.recorded=true;x.bodyMatches=false;}],
  ['missing history result',x=>x.recorded=undefined],
  ['contradictory schema state',x=>x.bodyMatches=true],
  ['missing schema result',x=>x.bodyMatches=null],
  ['SQL alteration',x=>x.sql+='\nGRANT SELECT ON public.meta_crm_stage_events TO anon;'],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['another migration',x=>x.candidate.deferred_contract.push({...CRM_EVENT,version:'20261025180001'})],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['a weakened CRM predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);assert.ok(judgeCrmProvisioning(state).problems.length>0);
});

test('the migration is additive and keeps the outbox server-only',()=>{
  assert.match(sql,/SET LOCAL lock_timeout = '5s'/);
  assert.match(sql,/ADD COLUMN IF NOT EXISTS meta_leadgen_id text;/);
  assert.match(sql,/ENABLE ROW LEVEL SECURITY/);
  assert.match(sql,/CREATE TRIGGER trg_require_current_session\s+BEFORE INSERT OR UPDATE OR DELETE ON public\.meta_crm_stage_events\s+FOR EACH STATEMENT EXECUTE FUNCTION public\.require_current_session\(\);/);
  assert.match(sql,/REVOKE ALL ON public\.meta_crm_stage_events FROM PUBLIC, anon, authenticated;/);
  assert.doesNotMatch(sql,/\b(?:GRANT|DISABLE|TRUNCATE|CREATE POLICY|ALTER POLICY)\b/i);
  // The only DROP is the idempotent re-install of the session boundary trigger.
  assert.deepEqual([...sql.matchAll(/\bDROP\b[^;]*;/gi)].map(x=>x[0]),['DROP TRIGGER IF EXISTS trg_require_current_session ON public.meta_crm_stage_events;']);
  assert.doesNotMatch(sql,/^\s*DELETE\b/im);
  assert.doesNotMatch(sql,/^\s*UPDATE\b/im);
});

test('the deploy wrapper gates CRM provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/meta-crm-plan\|meta-crm-provision\) ;;/);
  const block=wrapper.slice(wrapper.indexOf('= meta-crm-plan ]'),wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',wrapper.indexOf('= meta-crm-plan ]')));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-meta-crm-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
});
