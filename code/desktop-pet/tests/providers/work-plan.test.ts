import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkPlanner, explicitWorkExecutor } from '../../providers/work-plan.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
const scope={characterId:'c',sessionId:'s',turnId:'t',generation:1};
const endpoint:EndpointConfig={endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}};
const catalog={projects:[{id:'p',version:3,name:'Project',abstract:'metadata only',detailRef:{rootPath:'/project'}}],targets:[{threadId:'t1',hostId:'local' as const,title:'Actual user task',projectPath:'/project'}]};
const ready={kind:'ready',executor:'codex',title:'Task',text:'Do requested work',reason:'Explicit choice',targetId:'t1',projectId:'p',projectVersion:3,question:'',spokenSummary:'完成指定任务，并保留原始材料'};
function planner(output:unknown){
 return new WorkPlanner(endpoint,new ProviderTransport((async (_url,init)=>{
 const body=JSON.parse(String(init?.body));assert.equal(body.max_tokens,2048);const data=JSON.parse(body.messages[1].content);
 assert.equal(data.request,'synthetic task');assert.deepEqual(data.projects,catalog.projects);
 return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}),{status:200,headers:{'Content-Type':'application/json'}});
 }) as typeof fetch));
}
test('planner creates full card only from actual IDs and preserves optional native executor target',async()=>{
 assert.equal((await planner(ready).plan(scope,'synthetic task',catalog,new AbortController().signal)).kind,'ready');
 const native=await planner({...ready,executor:'harness',targetId:''}).plan(scope,'synthetic task',catalog,new AbortController().signal);
 assert.equal(native.kind,'ready');if(native.kind==='ready')assert.equal(native.targetId,undefined);
});
test('fabricated IDs, stale project versions/unexpected identities and cross-project targets are refused',async()=>{
 for(const change of [{targetId:'invented'},{projectVersion:4},{scope:{...scope,generation:2}},{executor:'harness',targetId:'t1'}])
  await assert.rejects(planner({...ready,...change}).plan(scope,'synthetic task',catalog,new AbortController().signal));
 const cross={...catalog,targets:[{...catalog.targets[0]!,projectPath:'/other'}]};
 const stub=new WorkPlanner(endpoint,{request:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(ready)}}]})} as unknown as ProviderTransport);
 await assert.rejects(stub.plan(scope,'synthetic task',cross,new AbortController().signal));
});
test('a genuine missing detail stays a single clarification, not a fabricated request',async()=>{
 const answer=await planner({...ready,kind:'clarify',question:'Which project?'}).plan(scope,'synthetic task',catalog,new AbortController().signal);
 assert.deepEqual(answer,{kind:'clarify',question:'Which project?'});
});

test('host cancellation rejects a delayed plan even without model-generated identity',async()=>{
 const stop=new AbortController();let release:(v:any)=>void=()=>{};
 const transport={request:()=>new Promise(resolve=>{release=resolve;})} as unknown as ProviderTransport;
 const promise=new WorkPlanner(endpoint,transport).plan(scope,'synthetic task',catalog,stop.signal);
 stop.abort();release({choices:[{finish_reason:'stop',message:{content:JSON.stringify(ready)}}]});
 await assert.rejects(promise);
});

for(const routing of [{targetId:null,projectId:null,projectVersion:null},{targetId:undefined,projectId:undefined,projectVersion:undefined}])test('B40 Harness empty optional routing normalizes without fabricating destination',async()=>{
 const output={...ready,executor:'harness',...routing};const result=await planner(output).plan(scope,'synthetic task',catalog,new AbortController().signal);assert.equal(result.kind,'ready');if(result.kind==='ready'){assert.equal(result.executor,'harness');assert.equal(result.projectId,undefined);assert.equal(result.targetId,undefined);}
});
test('B40 malformed routing and required content stay rejected with safe reason codes',async()=>{
 for(const [change,code] of [[{targetId:'invented'},'candidate'],[{projectVersion:4},'candidate'],[{projectVersion:null},'schema'],[{spokenSummary:''},'incomplete'],[{text:'x'.repeat(20001)},'length'],[{scope:'private'},'schema']] as const){
  await assert.rejects(planner({...ready,...change}).plan(scope,'synthetic task',catalog,new AbortController().signal),(error:any)=>error.code===code);
 }
});
test('B40 completion, JSON and provider failures expose no response body',async()=>{
 const responses=[{raw:{choices:[{finish_reason:'length',message:{content:'private'}}]},code:'completion'},{raw:{choices:[{finish_reason:'stop',message:{content:'private-invalid-json'}}]},code:'json'}];
 for(const item of responses){const p=new WorkPlanner(endpoint,{request:async()=>item.raw} as unknown as ProviderTransport);await assert.rejects(p.plan(scope,'synthetic',catalog,new AbortController().signal),(e:any)=>e.code===item.code&&!e.message.includes('private'));}
 const p=new WorkPlanner(endpoint,{request:async()=>{throw Error('private provider response');}} as unknown as ProviderTransport);await assert.rejects(p.plan(scope,'synthetic',catalog,new AbortController().signal),(e:any)=>e.code==='provider'&&!e.message.includes('private'));
});

test('B40 explicit executor cannot silently switch; quoted/conditional/mixed mentions remain semantic',async()=>{
 const p=new WorkPlanner(endpoint,{request:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(ready)}}]})} as unknown as ProviderTransport);
 await assert.rejects(p.plan(scope,'用DeepSeek Harness检索论文',catalog,new AbortController().signal),(e:any)=>e.code==='executor_mismatch');
 for(const text of ['“请用Harness检索”是什么意思','请用Harness解释“Codex是什么”','如果用Harness会如何','请用Harness或Codex','不要用Harness','是否用Harness','说明一下用Harness'])assert.equal(explicitWorkExecutor(text),undefined,text);
 assert.equal(explicitWorkExecutor('请用Codex修复项目'),'codex');
});
