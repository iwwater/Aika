import test from 'node:test';
import assert from 'node:assert/strict';
import{readFile,writeFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{fixture}from'../management/helpers.js';
import{validateTrialConfiguration,readActiveTrialConfiguration}from'../../app/trial-config.js';
import{TrialAuthorizer}from'../../app/trial-authorizer.js';
import{EvaluationBudget}from'../../core/evaluation-budget.js';
import{accountingSnapshot}from'../../management/accounting.js';
import{startManagementServer}from'../../management/server.js';
import{ManagementRuntime}from'../../management/runtime.js';
import{ManagementSettingsStore}from'../../management/settings-store.js';

test('unlimited is explicit, rejects disguised finite limits and keeps nonfinancial configuration checks',async t=>{
 const f=await fixture(t),candidate={...f.c,budgetMode:'unlimited',limitMicros:null};
 assert.equal(validateTrialConfiguration(candidate).limitMicros,null);
 assert.doesNotThrow(()=>validateTrialConfiguration({...candidate,reviewedUnknownCosts:[{operationId:'historical',auditFile:'/old-project/audit.json'}]}),'historical financial audit metadata cannot gate unlimited mode');
 for(const bad of [{...candidate,budgetMode:undefined},{...candidate,limitMicros:60000000},{...candidate,purpose:'smoke-text'},{...candidate,memory:{...candidate.memory,mode:'legacy'}},{...candidate,models:{...candidate.models,dialogue:{...candidate.models.dialogue,endpoint:'https://unknown.invalid'}}}])assert.throws(()=>validateTrialConfiguration(bad));
 assert.doesNotThrow(()=>validateTrialConfiguration({...candidate,models:{...candidate.models,memory_turn:{...candidate.models.memory_turn,reservationMicros:1}}}),'estimate sufficiency is not a financial gate in unlimited mode');
 assert.throws(()=>validateTrialConfiguration({...f.c,models:{...f.c.models,memory_turn:{...f.c.models.memory_turn,reservationMicros:1}}}),'bounded historical modes retain their constraints');
});

test('large unknown records, old blocked flag and estimate overruns never stop unlimited authorizations or erase accounting',async t=>{
 const f=await fixture(t),config=validateTrialConfiguration({...f.c,budgetMode:'unlimited',limitMicros:null,phaseLimitMicros:1,maxCalls:0,operationLimits:Object.fromEntries(Object.keys(f.c.operationLimits).map(x=>[x,0]))});
 const bytes=JSON.stringify(config);await writeFile(f.configFile,bytes);await writeFile(f.activationFile,JSON.stringify({version:1,product:'companion-v1',phaseId:config.phaseId,status:'active',configSha256:createHash('sha256').update(bytes).digest('hex')}));
 const entries=[{operationId:'synthetic-old-unknown',model:'synthetic',reservedMicros:990000000,actualMicros:null,status:'unknown'}];
 await writeFile(config.budgetFile,JSON.stringify({batchId:config.budgetBatchId,currency:'CNY',budgetMode:'unlimited',limitMicros:null,blocked:true,entries}));
 const authorizer=new TrialAuthorizer(config,f.configFile,f.activationFile),signal=new AbortController().signal,scope={characterId:'companion' as const,sessionId:'test',turnId:'test',generation:1};
 const authorize=()=>authorizer.authorize({operation:'memory_turn',scope,model:config.models.memory_turn.model,endpoint:config.models.memory_turn.endpoint},signal);
 const first=await authorize();await first.settle({status:'success',requestId:'synthetic',usage:{prompt_tokens:2000000,completion_tokens:1000000}}); //45CNY exceeds the11CNY estimate.
 const second=await authorize();await second.settle({status:'failed',requestId:null,usage:null});
 assert.equal((await readActiveTrialConfiguration(f.configFile,f.activationFile)).budgetMode,'unlimited');
 const ledger=JSON.parse(await readFile(config.budgetFile,'utf8'));assert.deepEqual(ledger.entries.slice(0,1),entries);assert.equal(ledger.entries.length,3);assert.equal(ledger.entries[1].actualMicros,45000000);assert.equal(ledger.entries[2].status,'unknown');assert.equal(ledger.limitMicros,null);
 const summary=await accountingSnapshot(config);assert.equal(summary.mode,'unlimited');assert.equal(summary.limitMicros,null);assert.equal(summary.knownMicros,45000000);assert.equal(summary.unknownReservedMicros,1001000000);
 const settings=await ManagementSettingsStore.open(config.projectRoot+'/settings.json',config),runtime=new ManagementRuntime(config.sourceRevision);
 const server=await startManagementServer({uiRoot:'management/ui',settings,memory:{characters:()=>[],list(){throw Error();},edit(){throw Error();},context(){throw Error();},prompt(){throw Error();},savePrompt(){throw Error();}},snapshot:async()=>({apiVersion:1,runtime:runtime.identity(),accounting:await accountingSnapshot(config),settings:settings.snapshot(),modules:[],events:[],adapters:[],credentials:[],characters:[]})});t.after(()=>server.close());
 const response=await(await fetch(server.origin+'/api/snapshot',{headers:{Authorization:'Bearer '+server.token}})).json() as {accounting:typeof summary};assert.deepEqual(response.accounting,summary);
 await authorizer.stop('explicit_user_stop');await assert.rejects(authorize(),/stopped/,'a real explicit stop remains effective');
});

test('unlimited ledger ignores financial scopes/headroom but rejects duplicate operations and invalid values',async t=>{
 const f=await fixture(t),file=f.c.budgetFile;await writeFile(file,JSON.stringify({batchId:f.c.budgetBatchId,currency:'CNY',budgetMode:'unlimited',limitMicros:null,blocked:false,entries:[]}));const ledger=new EvaluationBudget(file,f.c.budgetBatchId,null);
 await ledger.reserve('job','synthetic',90000000,{operationIdPrefix:'job',limitMicros:1,maxCalls:1},90000000);
 await assert.rejects(ledger.reserve('job','synthetic',1),/already reserved/);await assert.rejects(ledger.reserve('bad','synthetic',NaN),/Invalid call reservation/);
 await ledger.settle('job',100000000);assert.equal((await ledger.snapshot()).blocked,false);
 await assert.rejects(new EvaluationBudget(file,f.c.budgetBatchId,60000000).reserve('legacy','synthetic',1),/mismatch/);
});
