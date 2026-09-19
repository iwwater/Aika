import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OmniEvaluationAuthorizer, OMNI_EVALUATION_MODEL, OMNI_EVALUATION_ENDPOINT, omniUsageMicros } from '../../core/omni-evaluation-authorizer.js';
import type { CallRequest } from '../../providers/transport.js';
const signal=new AbortController().signal;
const request=(turnId='s01-audio'):CallRequest=>({scope:{characterId:'companion',sessionId:'omni-seven-emotion-evaluation',turnId,generation:1},operation:'perception',model:OMNI_EVALUATION_MODEL,endpoint:OMNI_EVALUATION_ENDPOINT});
const usage={prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{audio_tokens:28},completion_tokens_details:{text_tokens:20,audio_tokens:0}};
async function fixture() {
  const parent=resolve(import.meta.dirname,'../../../../../.local/memory-dynamics-01/budget-test');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(resolve(parent,'case-')),file=resolve(dir,'ledger.json');
  const original={operationId:'old',model:'previous',reservedMicros:100,actualMicros:90,status:'settled'};
  await writeFile(file,JSON.stringify({batchId:'test',currency:'CNY',limitMicros:60_000_000,blocked:false,entries:[original]}));
  return {file,original,read:async()=>JSON.parse(await readFile(file,'utf8')),close:()=>rm(dir,{recursive:true})};
}
test('mixed-modality list-price estimate rejects missing or inconsistent usage',()=>{
  assert.equal(omniUsageMicros(usage),2909);
  assert.equal(omniUsageMicros({...usage,prompt_tokens_details:{}}),null);
  assert.equal(omniUsageMicros({...usage,prompt_tokens_details:{audio_tokens:1001}}),null);
  assert.equal(omniUsageMicros({...usage,completion_tokens:513}),null);
  assert.equal(omniUsageMicros({...usage,completion_tokens_details:{audio_tokens:1}}),null);
});
test('one sequence reserves before access, retains history and refuses replay across restart',async()=>{
  const f=await fixture();try {
    const a=new OmniEvaluationAuthorizer(f.file,'test',[]),p=await a.authorize(request(),signal);
    assert.equal((await f.read()).entries[1].status,'reserved');
    await assert.rejects(a.authorize(request('s01-av'),signal));
    await p.settle({status:'success',usage,requestId:'receipt'});
    const after=await f.read();assert.deepEqual(after.entries[0],f.original);assert.equal(after.entries[1].actualMicros,2909);
    await assert.rejects(new OmniEvaluationAuthorizer(f.file,'test',[]).authorize(request(),signal));
    const next=await a.authorize(request('s01-av'),signal);await next.settle({status:'success',usage,requestId:'next'});
    await assert.rejects(next.settle({status:'success',usage,requestId:'next'}));
  }finally{await f.close();}
});
test('unknown settlement retains full reservation and halts subsequent calls',async()=>{
  const f=await fixture();try {
    const a=new OmniEvaluationAuthorizer(f.file,'test',[]),p=await a.authorize(request(),signal);
    await assert.rejects(p.settle({status:'success',usage:null,requestId:'unknown'}));
    const entry=(await f.read()).entries[1];assert.equal(entry.status,'unknown');assert.equal(entry.actualMicros,null);assert.equal(entry.reservedMicros,100000);
    await assert.rejects(a.authorize(request('s01-av'),signal));
  }finally{await f.close();}
});
test('shared 60CNY cap and phase 5CNY cap are independently enforced',async()=>{
  const f=await fixture();try {
    let state=await f.read();state.entries[0].actualMicros=59_950_001;state.entries[0].reservedMicros=59_950_001;await writeFile(f.file,JSON.stringify(state));
    await assert.rejects(new OmniEvaluationAuthorizer(f.file,'test',[]).authorize(request(),signal),/Shared evaluation budget/);
    state.entries=[f.original];await writeFile(f.file,JSON.stringify(state));
    const a=new OmniEvaluationAuthorizer(f.file,'test',[],5_000_000),p=await a.authorize(request(),signal);
    await p.settle({status:'success',usage,requestId:'first'});
    await assert.rejects(a.authorize(request('s01-av'),signal),/Phase budget/);
  }finally{await f.close();}
});
