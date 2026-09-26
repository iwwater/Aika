import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,scope,message } from '../memory/sqlite-fixture.js';
import { lifecycle,signal } from '../memory/lifecycle-fixture.js';
import { StrictTrialMemoryProvider } from '../../app/trial-backend.js';
import { ProviderTransport } from '../../providers/transport.js';
import { buildMemorySemanticFormat } from '../../app/memory-semantic-format.js';

test('installed-backend strict semantic provider compiles dynamics in the same request and atomic storage plan',async()=>{
 const f=fixture(undefined,'memory-dynamics-01');f.setTime('2026-09-12T00:00:00Z');
 try{
  const store=f.open();let calls=0,repeat=false;
  const provider=new StrictTrialMemoryProvider(store,{endpoint:'https://controlled.invalid',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}},new ProviderTransport(async(_url,init)=>{
   calls++;const body=JSON.parse(String(init?.body)),data=JSON.parse(body.messages[1].content),current=data.currentMessage;
   assert.match(body.messages[0].content,/Runtime additive dynamics extension/);
   const ref={id:current.id,version:current.version},basis=[{source:ref,quote:{text:current.text,context:null}}];
   const plan=repeat?{request:'none',erase:[],facts:[],assessments:[],reason:'User confirms fact',unresolved:null,dynamics:{traits:[],reinforcements:[{target:{id:data.evidence.find((x:any)=>x.kind==='memory').id,version:1},source:ref,kind:'confirmation'}]}}:
    {request:'none',erase:[],facts:[{intent:'remember',statement:'猫叫橘子',evidence:basis,basis}],assessments:[],reason:'User explicitly requests memory',unresolved:null,
     dynamics:{traits:[{target:{factIndex:0},traits:{category:'event',importance:1,evidenceSources:[ref],emotion:{status:'observed',intensity:.7,sources:[ref],observation:'非常开心'}}}],reinforcements:[]}};
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan)}}]});
  }), 'controlled-dynamics',async()=>{},undefined,'controlled_stub');
  const port=lifecycle(store,provider.plan.bind(provider),undefined,{turn:{provider,inputTokenBudget:32768,countTokens:i=>buildMemorySemanticFormat(i,true).inputUpperBound}});
  const text='请记住猫叫橘子，我非常开心';store.append(scope(),[message('raw',text,'companion',store.now())]);
  const result=await port.prepareTurn(scope(),'raw',text,signal());assert.equal(result.status,'applied');
  const memory=store.visible(scope(),'memory')[0]!,state=store.dynamics.state(scope(),memory.id)!;
  assert.equal(state.traits.importance,1);assert.equal(state.emotion,.7);assert.equal(calls,1);
  repeat=true;f.setTime('2026-09-22T00:00:00Z');const s=scope('companion','confirm'),text2='对，猫叫橘子';store.append(s,[message('confirm',text2,'companion',store.now())]);
  const before=store.dynamics.state(s,memory.id)!.activation;
  assert.equal((await port.prepareTurn(s,'confirm',text2,signal())).status,'applied');
  assert.equal(store.dynamics.state(s,memory.id)!.activation,before+.2*(1-before));assert.equal(calls,2);
 }finally{f.cleanup();}
});
