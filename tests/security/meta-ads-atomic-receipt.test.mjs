import assert from "node:assert/strict";
import test from "node:test";
import {atomicWriteError,atomicWriteResult} from "../../src/lib/meta-ads-write.mjs";
const receipt={ok:true,atomic:true,inserted:2,deleted:2,present:2,total_spend_aed:20};
test('only a complete atomic readback receipt authorizes success',()=>{
 assert.equal(atomicWriteResult(receipt,2).ok,true);
 for(const change of [{ok:false},{atomic:false},{present:1},{inserted:1},{deleted:-1},{total_spend_aed:NaN}])
  assert.equal(atomicWriteResult({...receipt,...change},2).ok,false);
 for(const missing of [null,undefined,[],{},true])assert.equal(atomicWriteResult(missing,2).ok,false);
});
test('contention and timeouts remain retryable without claiming a write',()=>{
 for(const code of ['55P03','57014'])assert.deepEqual(atomicWriteError({code}),{error:'sync_already_running',status:409});
});
test('foreign source and unexpected empty reports require deliberate resolution',()=>{
 for(const message of ['overlapping_spend_window','empty_window_requires_review'])
  assert.deepEqual(atomicWriteError({code:'P0001',message}),{error:message,status:409});
});
test('database failures and missing migration never leak database details',()=>{
 assert.deepEqual(atomicWriteError({code:'PGRST202',message:'private details'}),{error:'atomic_writer_unavailable',status:503});
 assert.deepEqual(atomicWriteError({code:'22023',message:'private details'}),{error:'invalid_window_rows',status:422});
 assert.deepEqual(atomicWriteError({code:'23514',message:'private details'}),{error:'atomic_window_replace_failed',status:500});
});
