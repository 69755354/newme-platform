import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { S39_EVENTS, S39_POSTURE, S39_PRESENT, S39_PRIOR, S39_ROUTINES, S39_PREDICATES, S39_PREDICATE_NAMES, judgeS39DbBatchProvisioning } from '../../scripts/check-s39-db-batch-provisioning.mjs';

const manifest=JSON.parse(fs.readFileSync(new URL('../../infra/release/release-manifest.json',import.meta.url),'utf8'));
const urls=S39_EVENTS.map(event=>new URL(`../../supabase/migrations/${event.file}`,import.meta.url));
const inTree=urls.every(url=>fs.existsSync(url));
const noneInTree=urls.every(url=>!fs.existsSync(url));
const at=manifest.deferred_contract.findIndex(x=>x.version===S39_EVENTS[0].version);
const N=S39_EVENTS.length;
const hashed=text=>createHash('sha256').update(text.replaceAll('\r\n','\n')).digest('hex');
const pinned=S39_EVENTS.map(({version,file,sha256})=>({version,file,sha256}));

// The live release is the one before S39: the manifest minus the S39 entry and its predicate.
// Two states of the repository must both work:
//  (1) switch only: the manifest has no S39 entry yet (this branch on its own);
//  (2) after the S39 branch is merged: the manifest already ends with the S39 entry.
const live=structuredClone(manifest);
const predAt=manifest.posture.deferred_contract.predicates.findIndex(x=>S39_PREDICATE_NAMES.includes(x.name));
if(at>=0){
  live.deferred_contract.splice(at);
  live.posture.deferred_contract.predicates=live.posture.deferred_contract.predicates.slice(0,predAt);
}
const sqls=inTree?urls.map(url=>fs.readFileSync(url,'utf8')):null;
const candidate=structuredClone(live);
candidate.deferred_contract.push(...S39_EVENTS.map(({version,file,sha256})=>({version,file,sha256})));
candidate.posture.deferred_contract.predicates.push(...S39_PREDICATES.map(x=>({...x})));
const reviewed=S39_EVENTS.map((_,i)=>`-- the reviewed S39 SQL ${i}`);
const input=()=>({live:structuredClone(live),candidate:structuredClone(candidate),sql:[...reviewed],phase:'strict',recorded:[false],priorMatches:[true],bodyMatches:[false]});
const judge=state=>judgeS39DbBatchProvisioning({...state,expectedSha256:state.expectedSha256??state.sql.map(hashed)});

// The S39 branch itself, read from git when that ref is available (never written into the tree).
function fromGit(spec){
  for(const ref of ['origin/fix/os-s39-sales']){
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
const SIGNATURES=[
  'public.trg_check_stage_sequence()','public.trg_check_first_contact_gate()','public.trg_enforce_first_contact_milestone()',
  'public.recomplete_lead_milestone(uuid,text,text)','public.check_milestone_order()',
  'public.sync_advance_lead_stage_from_sheet(uuid,text,text)','public.transition_lead_stage(uuid,text,text,text,uuid)',
];
// `one routine` fragment of the present / prior SQL for a signature
const fragment=(sql,signature)=>{
  assert.match(sql,/^SELECT coalesce\(\(SELECT /);
  const parts=sql.slice('SELECT coalesce((SELECT '.length).split(' AND coalesce((SELECT ');
  assert.equal(parts.length,S39_ROUTINES.length);
  const hit=parts.filter(p=>p.includes(`to_regprocedure('${signature}')`));
  assert.equal(hit.length,1,`exactly one fragment for ${signature}`);
  return hit[0];
};

test('the S39 provisioning gate pins exactly one reviewed migration and its posture predicate',()=>{
  assert.deepEqual(S39_EVENTS.map(x=>x.version),['20261123100000']);
  assert.deepEqual(S39_EVENTS.map(x=>x.file),['20261123100000_s39_stage_rules_relaxed.sql']);
  assert.equal(S39_EVENTS[0].sha256,'f37603f9e7a0550b3795d6eb7e06a55220eef6c4caccb5b51ba7bf817415f435');
  assert.deepEqual(S39_PREDICATE_NAMES,['s39-stage-rules-relaxed']);
  assert.equal(S39_POSTURE.length,N);assert.equal(S39_PRESENT.length,N);assert.equal(S39_PRIOR.length,N);
  // the posture (the manifest predicate) reads six routines: the audited transition routine definer / pinned / new marker /
  // authenticated yes, anon no; the two stage triggers by marker; the milestone order trigger definer with its marker; the
  // sheet routine definer without the quality check, service_role yes / authenticated no; recomplete definer / pinned / new
  // message / authenticated yes, anon no
  assert.match(S39_POSTURE[0],/to_regprocedure\('public\.transition_lead_stage\(uuid,text,text,text,uuid\)'\)/);
  assert.match(S39_POSTURE[0],/p\.prosrc LIKE '%S39: a stage may be skipped%'/);
  assert.match(S39_POSTURE[0],/p\.prosrc LIKE '%Stage can only move forward%'/);
  assert.match(S39_POSTURE[0],/p\.prosrc NOT LIKE '%NEW\.quality%'/);
  assert.match(S39_POSTURE[0],/p\.prosrc LIKE '%skipping a milestone going forward%'/);
  assert.match(S39_POSTURE[0],/p\.prosrc NOT LIKE '%v_lead\.quality%'/);
  assert.match(S39_POSTURE[0],/p\.prosrc LIKE '%An earlier milestone must be completed first%'/);
  assert.match(S39_POSTURE[0],/has_function_privilege\('service_role'/);
  assert.match(S39_POSTURE[0],/NOT has_function_privilege\('authenticated'/);
  assert.match(S39_POSTURE[0],/NOT has_function_privilege\('anon'/);
  assert.match(S39_POSTURE[0],/search_path=pg_catalog, public, pg_temp/);
  for(const signature of SIGNATURES.filter(s=>!s.startsWith('public.trg_enforce_first_contact_milestone')))assert.ok(S39_POSTURE[0].includes(`to_regprocedure('${signature}')`),signature);
  // present (what the gate reads) and prior cover all SEVEN replaced routines, each exactly once
  assert.deepEqual(S39_ROUTINES.map(x=>x.signature),SIGNATURES);
  for(const signature of SIGNATURES){
    const present=fragment(S39_PRESENT[0],signature),prior=fragment(S39_PRIOR[0],signature);
    assert.match(present,/^count\(\*\)=1 AND /);assert.match(prior,/^count\(\*\)=1 AND /);
    assert.match(present,/bool_and\(p\.proconfig @> ARRAY\['search_path=pg_catalog, public, pg_temp'\]::text\[\]\)/);
    const r=S39_ROUTINES.find(x=>x.signature===signature);
    // the new marker present and the old one absent after; the reverse before
    assert.ok(present.includes(`bool_and(p.prosrc LIKE '%${r.neu}%')`)&&present.includes(`bool_and(p.prosrc NOT LIKE '%${r.old}%')`),signature);
    assert.ok(prior.includes(`bool_and(p.prosrc LIKE '%${r.old}%')`)&&prior.includes(`bool_and(p.prosrc NOT LIKE '%${r.neu}%')`),signature);
    assert.notEqual(r.old,r.neu);
    // security mode: definer for five, invoker for the two stage triggers (the migration keeps every mode)
    assert.ok(present.includes(r.definer?'bool_and(p.prosecdef)':'bool_and(NOT p.prosecdef)'),signature);
    // literal underscores in a LIKE marker are escaped (an unescaped one is a wildcard)
    assert.doesNotMatch(r.old.replace(/\\_/g,''),/_/);assert.doesNotMatch(r.neu.replace(/\\_/g,''),/_/);
  }
  assert.deepEqual(S39_ROUTINES.filter(x=>!x.definer).map(x=>x.signature),['public.trg_check_stage_sequence()','public.trg_check_first_contact_gate()']);
  // the grants the migration pins: transition / recomplete to authenticated (not anon), the sheet routine to service_role only
  for(const signature of ['public.transition_lead_stage(uuid,text,text,text,uuid)','public.recomplete_lead_milestone(uuid,text,text)']){
    const present=fragment(S39_PRESENT[0],signature);
    assert.match(present,/bool_and\(has_function_privilege\('authenticated',p\.oid,'EXECUTE'\)\)/);
    assert.match(present,/bool_and\(NOT has_function_privilege\('anon',p\.oid,'EXECUTE'\)\)/);
  }
  const sheet=fragment(S39_PRESENT[0],'public.sync_advance_lead_stage_from_sheet(uuid,text,text)');
  assert.match(sheet,/bool_and\(has_function_privilege\('service_role',p\.oid,'EXECUTE'\)\)/);
  assert.match(sheet,/bool_and\(NOT has_function_privilege\('authenticated',p\.oid,'EXECUTE'\)\)/);
  assert.match(sheet,/bool_and\(NOT has_function_privilege\('anon',p\.oid,'EXECUTE'\)\)/);
  // the old markers are the production bodies' own words (the one-step rules and the quality checks)
  assert.deepEqual(S39_ROUTINES.map(x=>x.old),['Stage must advance sequentially','NEW.quality','lead\\_quality','Previous milestone must be completed first','Cannot skip:','v\\_lead.quality','v\\_allowed\\_next\\_stage']);
  for(const text of [...S39_POSTURE,...S39_PRESENT,...S39_PRIOR]){readOnly(text);assert.match(text,/^SELECT coalesce\(/);}
});

// The old / new markers must really tell the two bodies apart: the production bodies (the latest migration or the
// captured baseline that defines each routine) carry the old marker and not the new one; the S39 file the reverse.
test('each marker separates the production body from the S39 body',()=>{
  const neu=fromGit('supabase/migrations/'+S39_EVENTS[0].file)??(inTree?sqls[0]:null);
  const unescape=m=>m.replaceAll('\\_','_');
  if(neu){
    for(const r of S39_ROUTINES){
      assert.ok(neu.includes(unescape(r.neu)),`new marker of ${r.signature}`);
    }
    // the old markers must be gone from the S39 file (apart from the undo note in its header, which names no marker)
    for(const r of S39_ROUTINES)assert.ok(!neu.includes(unescape(r.old)),`old marker of ${r.signature} absent from the S39 file`);
  }
  const sources={
    'public.transition_lead_stage(uuid,text,text,text,uuid)':'supabase/migrations/20261104110000_role_least_privilege.sql',
    'public.sync_advance_lead_stage_from_sheet(uuid,text,text)':'supabase/migrations/20261121100000_sync_advance_lead_stage_from_sheet.sql',
  };
  const baseline=fs.readFileSync(new URL('../../supabase/replay/production-schema-baseline.sql',import.meta.url),'utf8');
  for(const r of S39_ROUTINES){
    const file=sources[r.signature];
    const text=file?fs.readFileSync(new URL('../../'+file,import.meta.url),'utf8'):baseline;
    assert.ok(text.includes(unescape(r.old)),`old marker of ${r.signature} in ${file??'the production baseline'}`);
    assert.ok(!text.includes(unescape(r.neu)),`new marker of ${r.signature} absent before S39`);
  }
});

// Always runs (the repository forbids new skipped tests). The switch is released on its own
// before the migration: then the file is not in the tree and the manifest must not name it yet.
test('the S39 migration, when present in the tree, matches the pinned hash, keeps its entry and carries the exact predicate',()=>{
  if(noneInTree){
    assert.equal(at,-1,'the manifest lists the S39 migration but its file is not in the tree');
    assert.equal(manifest.posture.deferred_contract.predicates.some(x=>S39_PREDICATE_NAMES.includes(x.name)),false);
    return;
  }
  assert.ok(inTree,'the S39 migration file is part of the tree');
  S39_EVENTS.forEach((event,i)=>assert.equal(hashed(sqls[i]),event.sha256));
  assert.deepEqual(manifest.deferred_contract.slice(at,at+N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(manifest.posture.deferred_contract.predicates.slice(predAt,predAt+N),S39_PREDICATES.map(x=>({...x})));
});

test('state 1 (switch only): the live manifest is untouched by S39 and the derived candidate passes',()=>{
  assert.deepEqual(judge(input()),{problems:[],alreadyRecorded:false});
  assert.deepEqual(judge({...input(),recorded:[true],priorMatches:[false],bodyMatches:[true]}),{problems:[],alreadyRecorded:true});
  // the live side never names S39, whichever state the repository is in
  assert.equal(live.deferred_contract.some(x=>x.version>=S39_EVENTS[0].version),false);
  assert.equal(live.posture.deferred_contract.predicates.some(x=>S39_PREDICATE_NAMES.includes(x.name)),false);
  // the S37 entry and rule check (the end of the S36 + S37 batch) are the last of the prefix the gate pins
  assert.equal(live.deferred_contract.at(-1).version,'20261122300000');
  assert.equal(live.posture.deferred_contract.predicates.at(-1).name,'s37-new-lead-not-dormant');
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

test('state 2 (after the S39 branch is merged): its real manifest is accepted against the live prefix',()=>{
  // The S39 branch's own manifest and migration, read from git when available. Without the ref
  // the synthetic candidate above (live + the pinned entry and predicate) stands in for it.
  const text=fromGit('infra/release/release-manifest.json');
  const brManifest=text?JSON.parse(text):structuredClone(candidate);
  const brSql=S39_EVENTS.map((event,i)=>fromGit('supabase/migrations/'+event.file)??(inTree?sqls[i]:null));
  const synthetic=brSql.some(x=>x===null);
  const state={...input(),live:structuredClone(live),candidate:brManifest,sql:synthetic?[...reviewed]:brSql};
  const expectedSha256=synthetic?reviewed.map(hashed):undefined;
  const result=judgeS39DbBatchProvisioning({...state,expectedSha256});
  assert.deepEqual(result.problems,[]);
  // the S39 branch's manifest differs from the live one by exactly the pinned entry and predicate
  const stripped=structuredClone(brManifest);
  stripped.deferred_contract.splice(-N);
  stripped.posture.deferred_contract.predicates.splice(-N);
  assert.deepEqual(stripped,live);
  assert.deepEqual(brManifest.deferred_contract.slice(-N).map(({version,file,sha256})=>({version,file,sha256})),pinned);
  assert.deepEqual(brManifest.posture.deferred_contract.predicates.slice(-N),S39_PREDICATES.map(x=>({...x})));
  // a manifest where the S39 entry is NOT last is refused
  const reordered=structuredClone(brManifest);
  const moved=reordered.deferred_contract.splice(-N);
  reordered.deferred_contract.splice(-1,0,...moved);
  assert.ok(judgeS39DbBatchProvisioning({...state,candidate:reordered,expectedSha256}).problems.length>0);
});

test('the reviewed SQL hash is what the gate compares, not the file name',()=>{
  const state=input();
  state.sql=[reviewed[0]+'\nGRANT SELECT ON public.leads TO anon;'];
  state.expectedSha256=reviewed.map(hashed);
  assert.ok(judge(state).problems.includes('reviewed SQL hash mismatch'));
  assert.ok(judgeS39DbBatchProvisioning(input()).problems.includes('reviewed SQL hash mismatch'));
  if(inTree)assert.deepEqual(judgeS39DbBatchProvisioning({...input(),sql:sqls}).problems,[]);
  const real=S39_EVENTS.map(event=>fromGit('supabase/migrations/'+event.file));
  if(real.every(x=>x!==null)){
    assert.deepEqual(judgeS39DbBatchProvisioning({...input(),sql:real}).problems,[]);
    assert.ok(judgeS39DbBatchProvisioning({...input(),sql:[real[0]+'\n-- edited']}).problems.includes('reviewed SQL hash mismatch'));
    assert.ok(judgeS39DbBatchProvisioning({...input(),sql:[real[0].replaceAll('\n','\r\n')]}).problems.length===0,'CRLF normalised');
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
  ['a candidate with another file name',x=>x.candidate.deferred_contract.at(-1).file='20261123100000_other.sql'],
  ['a second new migration',x=>x.candidate.deferred_contract.push({...S39_EVENTS[0],version:'20261123100100',file:'x.sql'})],
  ['the S39 entry not last',x=>{const m=x.candidate.deferred_contract.splice(-1);x.candidate.deferred_contract.splice(-1,0,...m);}],
  ['a candidate without the S39 entry',x=>{x.candidate.deferred_contract.pop();}],
  ['a candidate without the S39 predicate',x=>{x.candidate.posture.deferred_contract.predicates.pop();}],
  ['a candidate one migration ahead of the live release',x=>{x.live.deferred_contract.pop();}],
  ['an S39 migration already in the live release',x=>x.live.deferred_contract.push({...S39_EVENTS[0]})],
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
  ['a weakened S39 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
  ['a renamed S39 predicate',x=>x.candidate.posture.deferred_contract.predicates.at(-1).name='s39-other'],
  ['an S39 predicate expecting false',x=>x.candidate.posture.deferred_contract.predicates.at(-1).expect=false],
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

test('the deploy wrapper gates S39 provisioning like the other additive suffixes',()=>{
  const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8');
  assert.match(wrapper,/s39-db-plan\|s39-db-provision\) ;;/);
  assert.match(wrapper,/\|s21-db-plan\|s21-db-provision(?:\|[a-z0-9-]+)*\|s36-db-plan\|s36-db-provision\|s39-db-plan\|s39-db-provision(?:\|[a-z0-9-]+)*>" >&2/);
  const start=wrapper.indexOf('= s39-db-plan ]');
  const block=wrapper.slice(start,wrapper.indexOf('case "$DB_TRANSITION_OPERATION" in',start));
  assert.match(block,/--phase deferred_contract --verify-only/);
  assert.match(block,/check-s39-db-batch-provisioning\.mjs/);
  assert.match(block,/require_canonical_main_sha/);
  assert.match(block,/require_ci_gate_still_fresh/);
  assert.match(block,/merge-base --is-ancestor "\$ROLLBACK_SHA" "\$SHA"/);
  assert.match(wrapper,/s39-db-plan\|s39-db-provision\)\s+s39_db_mode=--plan\s+\[ "\$DB_TRANSITION_OPERATION" != s39-db-provision \] \|\| s39_db_mode=--apply[\s\S]*?--phase deferred_contract "\$s39_db_mode"/);
  // the earlier switches are still there,
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
