import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {mkdir} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {fixture} from './helpers.js';
import {scope,message,change,NOW} from '../memory/sqlite-fixture.js';
import {lifecycle} from '../memory/lifecycle-fixture.js';
import {SqliteMemoryStore,CONFIRMED_RETENTION} from '../../memory/sqlite-store.js';
import {confirmedInvitationPolicy} from '../../companion/invitations.js';
import {SqliteManagementMemoryPort} from '../../memory/management-port.js';
import {ManagementSettingsStore} from '../../management/settings-store.js';
import {ManagementRuntime} from '../../management/runtime.js';
import {startManagementServer} from '../../management/server.js';
import {StrictManagementForget,withStrictManagementForget} from '../../app/management-forget.js';
import {StrictTrialMemoryProvider} from '../../app/trial-backend.js';
import {ProviderTransport} from '../../providers/transport.js';
import {buildMemorySemanticFormat} from '../../app/memory-semantic-format.js';
const action={characterId:'companion' as const,id:'tea',expectedVersion:1,operationId:'web-forget',reason:'请遗忘红茶'};
async function setup(t:any){
 const f=await fixture(t),store=new SqliteMemoryStore({filename:f.c.database,retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock:()=>NOW});t.after(()=>store.close());
 store.append(scope(),[message('raw','我喜欢红茶；我养的猫叫团子')]);
 store.apply(change({type:'add',id:'tea',text:'喜欢红茶',sourceIds:['raw']},'tea'));
 store.apply(change({type:'add',id:'cat',text:'猫叫团子',sourceIds:['raw']},'cat'));
 let calls=0,mode='valid';
 const provider=new StrictTrialMemoryProvider(store,{endpoint:'https://controlled.invalid',model:'controlled',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}},new ProviderTransport(async(_url,init)=>{
  calls++;const data=JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  assert.equal(data.management.request,'forget');const current=data.currentMessage,raw=data.evidence.find((x:any)=>x.kind==='transcript'),tea=data.evidence.find((x:any)=>x.text==='喜欢红茶'),cat=data.evidence.find((x:any)=>x.text==='猫叫团子');
  assert.deepEqual(data.management.target,{id:tea.id,version:tea.version});assert.notEqual(tea.id,'tea');
  const ref=(s:any)=>({id:s.id,version:s.version}),quote=(text:string)=>({text,context:null}),ev=(s:any,text=s.text)=>({source:ref(s),quote:quote(text)}),basis=[ev(current)];
  await new Promise(r=>setTimeout(r,25));
  if(mode==='failure')throw Error('controlled model failure');
  if(mode==='stale')store.append(scope(),[message('other','独立消息')]);
  const declaration={request:'forget',erase:[],facts:[{intent:'retire',target:ref(tea),basis},{intent:'revise',target:ref(cat),statement:'猫叫团子',evidence:[ev(raw,'我养的猫叫团子')],basis:[ev(raw,'我养的猫叫团子')]}],assessments:[
   {source:ref(raw),classification:'mixed',retain:[{quote:quote('我养的猫叫团子'),supports:[]}],discard:[{quote:quote('我喜欢红茶；'),target:ref(tea),basis:[ev(raw,'我喜欢红茶；')]}]},
   {source:ref(current),classification:'target_only',retain:[],discard:[{quote:quote(current.text),target:ref(tea),basis}]}],reason:'按网页选中目标遗忘并保留无关猫信息',unresolved:null};
  const result=mode==='bad-dynamics'?{...declaration,dynamics:{traits:[{target:{id:cat.id,version:2},traits:{category:'event',importance:1,evidenceSources:[ref(raw)],emotion:{status:'missing',sources:[]}}}],reinforcements:[]}}:declaration;
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}]});
 }), 'controlled-management',async()=>{},undefined,'controlled_stub');
 const forget=new StrictManagementForget(store,store.lifecycle,{inputTokenBudget:32768,countTokens:i=>buildMemorySemanticFormat(i,true).inputUpperBound+1024},(input,signal,a)=>provider.planManagement(input,signal,{id:a.id,version:a.expectedVersion}));
 t.after(async()=>{forget.close();await forget.drain();});
 const memory=withStrictManagementForget(new SqliteManagementMemoryPort(store,lifecycle(store)),forget),settings=await ManagementSettingsStore.open(resolve(f.c.projectRoot,'settings.json'),f.c),runtime=new ManagementRuntime(f.c.sourceRevision);
 const server=await startManagementServer({uiRoot:resolve('management/ui'),settings,memory,snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:runtime.modules(),events:[],settings:settings.snapshot(),adapters:[],credentials:[],characters:memory.characters()})});t.after(()=>server.close());
 const headers={Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'};
 const send=(a=action)=>fetch(server.origin+'/api/memory/forget',{method:'POST',headers,body:JSON.stringify(a)});
 return {store,forget,server,send,calls:()=>calls,mode:(m:string)=>{mode=m;}};
}
test('real HTTP, strict semantic adapter and SQLite share one atomic mixed-source forget and model-free retry',async t=>{
 const f=await setup(t),before=f.store.revision(scope());
 const [a,b]=await Promise.all([f.send(),f.send()]);const aa=await a.json(),bb=await b.json();assert.equal(a.status,200,JSON.stringify(aa));assert.equal(b.status,200,JSON.stringify(bb));assert.deepEqual(aa,bb);assert.equal(f.calls(),1);
 assert.ok(f.store.revision(scope())>before);assert.equal(f.store.inspect(scope(),'tea')!.state,'deleted');assert.equal(f.store.inspect(scope(),'cat')!.version,2);
 assert.equal(f.store.search(scope(),'红茶',20,'lexical').length,0);assert.equal(f.store.search(scope(),'团子',20,'lexical').length,1);
 assert.ok(f.store.visible(scope(),'transcript').every(x=>!x.text.includes('网页')&&!x.text.includes('红茶')));
 assert.deepEqual(await(await f.send()).json(),aa);assert.equal(f.calls(),1);
 assert.equal((await f.send({...action,reason:'changed'})).status,409);
});
test('failed plan, racing source update and shutdown do not report successful forgetting',async t=>{
 const f=await setup(t),before=f.store.revision(scope());f.mode('failure');assert.equal((await f.send()).status,503);assert.equal(f.store.revision(scope()),before);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 f.mode('bad-dynamics');assert.equal((await f.send()).status,503);assert.equal(f.store.revision(scope()),before);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 f.mode('stale');assert.equal((await f.send()).status,409);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 f.mode('valid');const p=f.send();await new Promise(r=>setTimeout(r,10));f.forget.close();assert.equal((await p).status,503);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
});
test('actual memory page reads SQLite, previews now without mutation, then performs strict shared-source forgetting',{skip:!process.env.PLAYWRIGHT_MODULE},async t=>{
 const f=await setup(t);const {chromium}=await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE!).href);const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1280,height:960}});page.setDefaultTimeout(6000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));
 await page.goto(f.server.url);await page.locator('#nav-memory').click();await page.locator('[data-md-record="tea"]').waitFor();
 const before=f.store.revision(scope());assert.equal(f.calls(),0);assert.equal(f.store.revision(scope()),before);
 await page.locator('#memory-policy').click();await page.locator('#md-preview-query').fill('红茶');await page.locator('#md-preview-horizon').click();await page.locator('#md-preview-horizon').press('Home');await page.locator('#md-preview-horizon').press('Enter');
 await page.locator('#md-preview-run').click();await page.locator('#md-preview-result').waitFor();assert.equal(f.store.revision(scope()),before);assert.equal(f.calls(),0);
 const output=resolve('../../.local/memory-dynamics-01');await mkdir(output,{recursive:true});await page.screenshot({path:resolve(output,'actual-sqlite-preview.png'),fullPage:true});
 await page.locator('#memory-dynamics').click();
 // Browser DOM drives the same HTTP and strict model adapter as the first test.
 await page.locator('[data-md-record="tea"]').click();
 const text=await page.locator('body').innerText();assert.match(text,/喜欢红茶/);assert.match(text,/未评估|未提供/);
 await page.locator('#md-reason').fill(action.reason);
 await page.locator('#md-record-action').click();
 await page.getByRole('button',{name:'确认遗忘',exact:true}).click();
 await page.waitForFunction(()=>document.body.textContent?.includes('遗忘已确认'));
 assert.equal(f.store.inspect(scope(),'tea')!.state,'deleted');assert.equal(f.store.inspect(scope(),'cat')!.state,'active');assert.equal(f.calls(),1);assert.deepEqual(errors,[]);await page.screenshot({path:resolve(output,'actual-sqlite-forgotten.png'),fullPage:true});
});
