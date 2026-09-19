import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretWork } from '../../providers/work-conversation.js';
import { ProviderTransport, type EndpointConfig } from '../../providers/transport.js';
import type { PendingWorkContext } from '../../contracts/desktop-work.js';
const scope={characterId:'c',sessionId:'s',turnId:'t',generation:1};
const endpoint:EndpointConfig={endpoint:'https://api.deepseek.com/chat/completions',model:'deepseek-flash',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}};
const context:PendingWorkContext={stage:'confirming',originalRequest:'在合成项目做文献目录',currentRequest:'只读整理合成文献目录',conversation:[],arrangement:{executor:'codex',title:'合成文献目录',projectName:'Synthetic'}};
const answer=(kind:string)=>({kind,text:'',question:'',executionAuthorized:false});
function fixture(output:unknown){const calls:any[]=[];const transport=new ProviderTransport((async(_url,init)=>{calls.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(output)}}]}));}) as typeof fetch);return {calls,run:(text:string,c=context,s=new AbortController().signal)=>interpretWork(endpoint,transport,scope,text,c,s)};}
for(const text of ['确认','确认执行','确认。','确认执行！'])test('whole affirmative uses no model: '+text,async()=>{const f=fixture({});assert.deepEqual(await f.run(text),{kind:'confirm'});assert.equal(f.calls.length,0);});
for(const text of ['不要确认','“确认”','确认吗？','确认，但改成另一个项目'])test('non-exact utterance requires interpretation: '+text,async()=>{const f=fixture(answer('companion'));await f.run(text);assert.equal(f.calls.length,1);});
test('pending payload contains only bounded task conversation and no supplied identifiers or hidden fields',async()=>{
 const f=fixture({kind:'supplement',text:'完整合成任务',question:'',executionAuthorized:false});
 await f.run('是的',{...context,stage:'clarifying',question:'是整理文献吗？',conversation:[{role:'assistant',text:'是整理文献吗？'}],privateHistory:'must-not-leak'} as PendingWorkContext);
 const b=f.calls[0],p=JSON.parse(b.messages[1].content);assert.equal(b.max_tokens,2048);assert.deepEqual(b.thinking,{type:'disabled'});
 assert.equal(p.pending.question,'是整理文献吗？');assert.equal(p.pending.privateHistory,undefined);assert.equal(JSON.stringify(b).includes('must-not-leak'),false);assert.equal(b.messages.length,2);
});
for(const output of [{...answer('confirm'),requestId:'forged'},answer('confirm'),{...answer('companion'),executionAuthorized:true},{...answer('supplement'),text:''}])test('strict fields and incomplete context cannot authorize',async()=>{const f=fixture(output);await assert.rejects(f.run('是的',{...context,stage:'clarifying'}));});
test('explicit supplement authorization remains a host-checked flag',async()=>{const f=fixture({kind:'supplement',text:'完整任务',question:'',executionAuthorized:true});assert.deepEqual(await f.run('整理目录，直接开始',{...context,stage:'clarifying'}),{kind:'supplement',text:'完整任务',executionAuthorized:true});});
test('pre-cancelled exact command does not bypass cancellation',async()=>{const f=fixture({}),stop=new AbortController();stop.abort();await assert.rejects(f.run('确认',context,stop.signal));assert.equal(f.calls.length,0);});
