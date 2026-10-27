import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {spawnSync} from "node:child_process";
import test from "node:test";
import {createHash} from "node:crypto";
import {ADS_WRITER,ADS_WRITER_POSTURE_SQL,judgeAdsProvisioning} from "../../scripts/check-meta-ads-provisioning.mjs";
const bash=process.platform==='win32'?path.join(process.env.ProgramFiles||'C:/Program Files','Git/bin/bash.exe'):'bash';
const sql=fs.readFileSync(new URL('../../supabase/preflight/meta-ads-atomic-window.sql',import.meta.url),'utf8');
function input(){
 const live={runs_under:{database_phases:['strict']},required_for_app:[{version:'1',file:'a',sha256:'a'}],deferred_contract:[{version:'2',file:'b',sha256:'b'}]};
 live.posture={required_for_app:{predicates:[{name:'prior',expect:true,sql:'SELECT true'}]},deferred_contract:{predicates:[{name:'prior-strict',expect:true,sql:'SELECT true'}]}};
 const candidate=structuredClone(live);candidate.deferred_contract.push({...ADS_WRITER});candidate.posture.deferred_contract.predicates.push({name:'meta-ads-atomic-writer-is-reviewed-and-server-only',expect:true,sql:ADS_WRITER_POSTURE_SQL});
 return {live,candidate,sql,phase:'strict',recorded:false,objectExists:false,bodyMatches:false};
}
test('only the additive pinned suffix is accepted',()=>{
 assert.equal(createHash('sha256').update(sql).digest('hex'),ADS_WRITER.sha256);
 assert.deepEqual(judgeAdsProvisioning(input()).problems,[]);
});
for(const [name,mutate]of [
 ['SQL tampering',s=>s.sql+='\nselect 1;'],
 ['another suffix',s=>s.candidate.deferred_contract.push({version:'3',file:'other',sha256:'x'})],
 ['required-prefix drift',s=>s.candidate.required_for_app[0].sha256='x'],
 ['deferred-prefix drift',s=>s.candidate.deferred_contract[0].sha256='x'],
 ['non-strict mode',s=>s.phase='compat'],
 ['unrecorded object collision',s=>s.objectExists=true],
 ['recorded missing function',s=>s.recorded=true],
 ['recorded body mismatch',s=>{s.recorded=true;s.objectExists=true;}],
])test(`refuses ${name}`,()=>{const s=input();mutate(s);assert.ok(judgeAdsProvisioning(s).problems.length);});
test('exact recorded object supports safe reentry',()=>{
 const s=input();Object.assign(s,{recorded:true,objectExists:true,bodyMatches:true});
 assert.deepEqual(judgeAdsProvisioning(s).problems,[]);
});
const wrapper=fs.readFileSync(new URL('../../infra/systemd/newme-deploy.sh',import.meta.url),'utf8').replaceAll('\r\n','\n');
const preconditions=wrapper.match(/  # Additive ads writer:[\s\S]*?\n  fi/)?.[0];
const arm=wrapper.match(/    meta-ads-plan\|meta-ads-provision\)\n([\s\S]*?)      ;;/)?.[1];
assert.ok(preconditions&&arm);
function coordinator(operation,failure='none'){
 return spawnSync(bash,['-c',`set -Eeuo pipefail
DB_TRANSITION_OPERATION=${operation}
FAIL_STAGE=${failure}
MIRROR=/approved/mirror
ROLLBACK_SHA=live
SHA=candidate
LIVE_RELEASE=/approved/live
WORKTREE=/approved/candidate
MIGRATION_DB_URL_FILE=/approved/private-url
NODE_BIN=mock_node
git(){ printf 'ancestry\\n'; [ "$FAIL_STAGE" != ancestry ]; }
mock_node(){
 if [ "$1" = /approved/live/scripts/db-phase-push.mjs ];then printf 'live-posture\\n'; [ "$FAIL_STAGE" != live-posture ];
 elif [ "$1" = /approved/candidate/scripts/check-meta-ads-provisioning.mjs ];then printf 'ads-policy\\n'; [ "$FAIL_STAGE" != ads-policy ];
 elif [ "$1" = /approved/candidate/scripts/db-phase-push.mjs ];then printf 'APPLIER:%s\\n' "$*";
 else return 89;fi
}
require_canonical_main_sha(){ printf 'canonical-main\\n'; [ "$FAIL_STAGE" != canonical-main ]; }
require_ci_gate_still_fresh(){ printf 'fresh-ci\\n'; [ "$FAIL_STAGE" != fresh-ci ]; }
${preconditions}
${arm}
`],{encoding:'utf8'});
}
for(const [operation,mode]of [['meta-ads-plan','--plan'],['meta-ads-provision','--apply']]){
 test(`${operation} enforces all antecedents`,()=>{
  const p=coordinator(operation);assert.equal(p.status,0,p.stderr);
  assert.match(p.stdout,/ancestry\nlive-posture\nads-policy\ncanonical-main\nfresh-ci\nAPPLIER:/);
  assert.ok(p.stdout.includes(`--phase deferred_contract ${mode}`));
 });
 for(const failure of ['ancestry','live-posture','ads-policy','canonical-main','fresh-ci'])test(`${operation} stops after ${failure} failure`,()=>{
  const p=coordinator(operation,failure);assert.notEqual(p.status,0);assert.doesNotMatch(p.stdout,/APPLIER:/);
 });
}

test('CRLF input is normalized before exact SQL hash validation',()=>{
 const s=input();s.sql=s.sql.replaceAll("\n","\r\n");assert.deepEqual(judgeAdsProvisioning(s).problems,[]);
});
test('catalog reentry verifies timeout settings and import coordination guards',()=>{
 const checker=fs.readFileSync(new URL('../../scripts/check-meta-ads-provisioning.mjs',import.meta.url),'utf8');
 assert.match(checker,/p\.proconfig @> ARRAY/);assert.match(checker,/lock_timeout=5s/);
 assert.match(checker,/statement_timeout=20s/);assert.match(checker,/ad_spend_coordinate_writers/);
 assert.match(checker,/ad_spend_insert_source_guard/);
});

for(const [name,mutate] of [
 ['prior posture removed',s=>s.candidate.posture.required_for_app.predicates.pop()],
 ['prior posture weakened',s=>s.candidate.posture.deferred_contract.predicates[0].sql='SELECT false'],
 ['new atomic predicate weakened',s=>s.candidate.posture.deferred_contract.predicates.at(-1).sql='SELECT true'],
 ['extra posture section',s=>s.candidate.posture.extra={}],
])test(`refuses ${name}`,()=>{const s=input();mutate(s);assert.ok(judgeAdsProvisioning(s).problems.length);});
