import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fixture} from '../management/helpers.js';
import {TrialAuthorizer} from '../../app/trial-authorizer.js';
import {EvaluationBudget} from '../../core/evaluation-budget.js';

test('current occupied-cost shape: background cannot reserve 11 CNY ahead of payable foreground; unknown remains occupied',async t=>{
 const f=await fixture(t),c={...f.c,limitMicros:60000000 as const,models:{...f.c.models,...Object.fromEntries(Object.entries({dialogue:3211264,admission:3211264,summary:3211264,perception:1304167,tts:100000}).map(([slot,reservationMicros])=>[slot,{...f.c.models[slot as keyof typeof f.c.models],reservationMicros,...(slot==='perception'?{inputTokenLimit:1000,outputTokenLimit:1000}:{})}]))}};
 const raw=JSON.stringify(c);await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,product:'companion-v1',phaseId:f.c.phaseId,status:'active',configSha256:createHash('sha256').update(raw).digest('hex')}));
 // Synthetic entries reproduce the live totals observed 2026-09-12T07:58Z;
 // no private operation IDs/config/credentials or real ledger writes are used.
 const entries=[{operationId:'synthetic-known',model:'fixture',reservedMicros:22646043,actualMicros:22646043,status:'settled'},{operationId:'synthetic-unknown',model:'fixture',reservedMicros:25309624,actualMicros:null,status:'unknown'}];
 await writeFile(f.c.budgetFile,JSON.stringify({batchId:f.c.budgetBatchId,currency:'CNY',limitMicros:60000000,blocked:false,entries}));
 const authorizer=new TrialAuthorizer(c,f.configFile,f.activationFile),signal=new AbortController().signal;
 const call=(operation:'memory_turn'|'dialogue'|'summary')=>authorizer.authorize({operation,scope:{characterId:'companion',sessionId:'fixture',turnId:'fixture',generation:1},endpoint:c.models[operation].endpoint,model:c.models[operation].model},signal);
 const before=await readFile(f.c.budgetFile,'utf8');await assert.rejects(call('memory_turn'),/Background reservation would block foreground/);assert.equal(await readFile(f.c.budgetFile,'utf8'),before);
 const dialogue=await call('dialogue');await dialogue.settle({status:'success',requestId:null,usage:{prompt_tokens:100,completion_tokens:100}});
 const after=JSON.parse(await readFile(f.c.budgetFile,'utf8'));assert.deepEqual(after.entries.slice(0,2),entries);assert.equal(after.entries.length,3);assert.equal(after.limitMicros,60000000);
});

test('headroom is an atomic priority check, not a changed budget or a foreground quota',async t=>{
 const f=await fixture(t);const budget=new EvaluationBudget(f.c.budgetFile,f.c.budgetBatchId,20000000);
 await budget.reserve('background','fixture',10000000,undefined,7000000);
 await budget.reserve('foreground','fixture',7000000);
 const state=await budget.snapshot();assert.equal(state.limitMicros,20000000);assert.equal(state.entries.length,3);
 await assert.rejects(budget.reserve('second-background','fixture',1000000,undefined,7000000),/budget exhausted|block foreground/);
});
