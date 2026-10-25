import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { CAPI_EVENT, CAPI_EVENT_POSTURE_SQL, judgeCapiProvisioning } from '../../scripts/check-meta-capi-provisioning.mjs';

const live=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
live.deferred_contract=live.deferred_contract.filter(x=>x.version!==CAPI_EVENT.version);
live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.filter(x=>x.name!=='meta-capi-delivery-event-type-allowed');
const sql=fs.readFileSync(new URL('../fixtures/website-capi-delivery-event.sql',import.meta.url),'utf8');
const candidate=structuredClone(live);
candidate.deferred_contract.push(CAPI_EVENT);
candidate.posture.deferred_contract.predicates.push({name:'meta-capi-delivery-event-type-allowed',expect:true,sql:CAPI_EVENT_POSTURE_SQL});
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql,phase:'strict',recorded:false,priorMatches:true,bodyMatches:false});

test('only the exact additive CAPI event transition is accepted',()=>{
  assert.deepEqual(judgeCapiProvisioning(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judgeCapiProvisioning({...input(),recorded:true,priorMatches:false,bodyMatches:true}),{problems:[],alreadyRecorded:true});
  assert.equal(createHash('sha256').update(sql).digest('hex'),CAPI_EVENT.sha256);
});

for(const [label,change] of [
  ['wrong phase',x=>x.phase='compat'],
  ['old constraint drift',x=>x.priorMatches=false],
  ['unrecorded new body',x=>{x.priorMatches=false;x.bodyMatches=true;}],
  ['recorded body drift',x=>{x.recorded=true;x.bodyMatches=false;}],
  ['missing history result',x=>x.recorded=undefined],
  ['contradictory constraint state',x=>x.bodyMatches=true],
  ['missing constraint result',x=>x.bodyMatches=null],
  ['SQL alteration',x=>x.sql+='\nGRANT SELECT ON public.leads TO anon;'],
  ['required prefix rewrite',x=>x.candidate.required_for_app[0].sha256='0'.repeat(64)],
  ['another migration',x=>x.candidate.deferred_contract.push({...CAPI_EVENT,version:'20261025151001'})],
  ['prior posture rewrite',x=>x.candidate.posture.deferred_contract.predicates[0].expect=false],
  ['an extra posture predicate',x=>x.candidate.posture.deferred_contract.predicates.push({name:'foreign',expect:true,sql:'SELECT true'})],
  ['rollback declaration change',x=>x.candidate.runs_under.database_phases.push('absent')],
]) test(`provisioning refuses ${label}`,()=>{
  const state=input();change(state);assert.ok(judgeCapiProvisioning(state).problems.length>0);
});

test('the future migration preserves every old event type and adds only CAPI',()=>{
  const baseline=fs.readFileSync(new URL('../../supabase/replay/production-schema-baseline.sql',import.meta.url),'utf8')
    .split('\n').find(x=>x.startsWith('ALTER TABLE ONLY public.business_events ADD CONSTRAINT chk_event_type '));
  const values=s=>[...s.matchAll(/'([^']+)'::text/g)].map(x=>x[1]);
  assert.deepEqual(values(sql),[...values(baseline),'meta_capi_lead_delivery']);
  assert.match(sql,/SET LOCAL lock_timeout = '5s'/);
  assert.match(sql,/NOT VALID;/);
  assert.doesNotMatch(sql,/\b(?:GRANT|REVOKE|DISABLE|DELETE|TRUNCATE)\b/i);
});

test('the branch replay floor retains the captured production event constraint',()=>{
  const constraint=source=>source.split(/\r?\n/).find(line=>line.startsWith('ALTER TABLE ONLY public.business_events ADD CONSTRAINT chk_event_type '));
  const read=name=>fs.readFileSync(new URL(`../../supabase/replay/${name}`,import.meta.url),'utf8');
  const baseline=constraint(read('production-schema-baseline.sql'));
  assert.ok(baseline);
  assert.equal(constraint(read('01_floor_schema.sql')),baseline);
});
