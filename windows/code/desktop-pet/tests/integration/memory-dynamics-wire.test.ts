import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture,scope,message } from '../memory/sqlite-fixture.js';
import { lifecycle,signal } from '../memory/lifecycle-fixture.js';
import { QwenMemoryTurnProvider } from '../../providers/qwen-memory-lifecycle.js';
import { ProviderTransport } from '../../providers/transport.js';
test('provider JSON traits cross real strict transaction and invalid traits roll back structural writes',async()=>{
 const f=fixture(undefined,'memory-dynamics-01');f.setTime('2026-09-12T00:00:00Z');
 try{
  const store=f.open();let valid=true,requests=0;
  const provider=new QwenMemoryTurnProvider({endpoint:'https://controlled.invalid',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}},new ProviderTransport(async(_url,init)=>{
   requests++;const sent=JSON.parse(String(init?.body));const data=JSON.parse(sent.messages[1].content);const current=data.currentMessage;
   const plan={request:'none',changes:[{reason:'explicitly remembered fact',operation:{type:'add',id:'new',text:valid?'我的猫叫橘子':'这次写下悲伤二字',sourceIds:[current.id]}}],suppressSources:[],retainSources:[],clarification:null,reason:'controlled',
    dynamics:{traits:[{recordId:'new',expectedVersion:0,traits:{category:'stable_profile',importance:1,evidenceSources:[{id:current.id,version:current.version}],emotion:{status:'observed',intensity:.7,sources:[{id:current.id,version:current.version}],observation:valid?'非常开心':'悲伤'}}}],reinforcements:[]}};
   return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan)}}]});
  }),'numeric-v1',true);
  const port=lifecycle(store,provider.plan.bind(provider));
  store.append(scope(),[message('raw','请记住我的猫叫橘子，我非常开心','companion',store.now())]);
  const out=await port.prepareTurn(scope(),'raw','请记住我的猫叫橘子，我非常开心',signal());assert.equal(out.status,'applied');
  const memory=store.visible(scope(),'memory')[0]!;assert.equal(store.dynamics.state(scope(),memory.id)!.traits.importance,1);assert.equal(store.dynamics.state(scope(),memory.id)!.emotion,.7);
  const s=scope('companion','next');store.append(s,[message('next','这次写下悲伤二字','companion',store.now())]);valid=false;
  const before=store.revision(s);const rejected=await port.prepareTurn(s,'next','这次写下悲伤二字',signal());assert.equal(rejected.status,'rejected');assert.equal(rejected.rejectionCode,'unverified_emotion_intensity');
  assert.equal(store.visible(s,'memory').length,1);assert.equal(store.revision(s),before);assert.equal(requests,2);
 }finally{f.cleanup();}
});
