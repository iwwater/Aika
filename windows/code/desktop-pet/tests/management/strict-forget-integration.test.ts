import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
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
 return {store,forget,server,projectRoot:f.c.projectRoot,send,calls:()=>calls,mode:(m:string)=>{mode=m;}};
}
test('real HTTP, strict semantic adapter and SQLite share one atomic mixed-source forget and model-free retry',async t=>{
 const f=await setup(t),before=f.store.revision(scope());
 const [a,b]=await Promise.all([f.send(),f.send()]);const aa=await a.json(),bb=await b.json();assert.equal(a.status,200,JSON.stringify(aa));assert.equal(b.status,200,JSON.stringify(bb));assert.deepEqual(aa,bb);assert.equal(f.calls(),1);
 assert.ok(f.store.revision(scope())>before);assert.equal(f.store.inspect(scope(),'tea')!.state,'deleted');assert.equal(f.store.inspect(scope(),'cat')!.version,2);
 assert.equal(f.store.search(scope(),'红茶',20,'lexical').length,0);assert.equal(f.store.search(scope(),'团子',20,'lexical').length,1);
 assert.ok(f.store.visible(scope(),'transcript').every(x=>!x.text.includes('网页')&&!x.text.includes('红茶')));
 assert.deepEqual(await(await f.send()).json(),aa);assert.equal(f.calls(),1);
 assert.equal((await f.send({...action,reason:'changed'})).status,409);
 // FIX61-10: explicit idempotent teardown before the after-hooks (see the next test).
 await f.server.close();f.store.close();
});
test('a stale details-page version returns conflict without invoking the planner or changing the record',async t=>{
 const f=await setup(t);
 try {
  f.store.apply(change({type:'update',id:'tea',expectedVersion:1,text:'喜欢乌龙茶',sourceIds:['raw']},'concurrent-edit'));
  const before=f.store.revision(scope());
  const response=await f.send({...action,operationId:'stale-details-page',expectedVersion:1});
  const body=await response.json();
  assert.equal(response.status,409,JSON.stringify(body));
  assert.equal(f.calls(),0,'a stale UI snapshot must fail before semantic planning');
  assert.equal(f.store.revision(scope()),before);
  assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
  assert.equal(f.store.inspect(scope(),'tea')!.version,2);
  assert.equal(f.store.inspect(scope(),'cat')!.state,'active');
 } finally { await f.forget.drain();f.forget.close();await f.server.close();f.store.close(); }
});
test('failed plan, racing source update and shutdown do not report successful forgetting',async t=>{
 const f=await setup(t),before=f.store.revision(scope());f.mode('failure');assert.equal((await f.send()).status,503);assert.equal(f.store.revision(scope()),before);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 f.mode('bad-dynamics');assert.equal((await f.send()).status,503);assert.equal(f.store.revision(scope()),before);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 f.mode('stale');assert.equal((await f.send()).status,409);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 f.mode('valid');const p=f.send();await new Promise(r=>setTimeout(r,10));f.forget.close();assert.equal((await p).status,503);assert.equal(f.store.inspect(scope(),'tea')!.state,'active');
 // FIX61-10: t.after hooks run in registration order — the fixture rm (registered first) would run
 // while these handles are still open, and on Windows that deletes an open SQLite file (EBUSY).
 // Explicit idempotent closes put the shared rm last in a safe order on every platform.
 await f.forget.drain();f.forget.close();await f.server.close();f.store.close();
});
test('S4 a cancelled forget request leaves the record active and reopens cleanly',async t=>{
 const f=await setup(t),before=f.store.revision(scope());
 // The management page's取消 button simply never issues the POST. The server contract that matters is that
 // a request the client abandons before the model settles cannot half-apply.
 const controller=new AbortController();
 const pending=fetch(f.server.origin+'/api/memory/forget',{method:'POST',headers:{Authorization:'Bearer '+f.server.token,Origin:f.server.origin,'Content-Type':'application/json'},body:JSON.stringify(action),signal:controller.signal});
 controller.abort();
 await assert.rejects(pending);
 await f.forget.drain();
 assert.equal(f.store.revision(scope()),before,'an aborted request must not advance the revision');
 assert.equal(f.store.inspect(scope(),'tea')!.state,'active','an aborted forget must leave the record active');
 assert.equal(f.store.inspect(scope(),'cat')!.state,'active');
 // The same action must still succeed afterwards: a cancelled request may not poison the operation id.
 const after=await f.send();
 assert.equal(after.status,200,JSON.stringify(await after.clone().json()));
 assert.equal(f.store.inspect(scope(),'tea')!.state,'deleted');
 await f.forget.drain();f.forget.close();await f.server.close();f.store.close();
});
test('S4 a forgotten record stays forgotten after the store is reopened and is not recalled',async t=>{
 const f=await setup(t);
 const done=await f.send();assert.equal(done.status,200);
 assert.equal(f.store.inspect(scope(),'tea')!.state,'deleted');
 assert.equal(f.store.search(scope(),'红茶',20,'lexical').length,0,'a forgotten record is not lexically recallable');
 await f.forget.drain();f.forget.close();await f.server.close();f.store.close();
 // Reopen the SAME database file: the deletion must be durable, not an in-memory tombstone.
 const reopened=new SqliteMemoryStore({filename:resolve(f.projectRoot,'.local/data/companion.sqlite'),retention:CONFIRMED_RETENTION,invitations:confirmedInvitationPolicy('Asia/Shanghai'),clock:()=>NOW});
 // Close inline rather than in a t.after hook: the fixture's own cleanup rm must run after every handle is
 // released, and on Windows deleting an open SQLite file fails with EBUSY.
 try{
  assert.equal(reopened.inspect(scope(),'tea')!.state,'deleted','the forgotten record must stay deleted after a restart');
  assert.equal(reopened.search(scope(),'红茶',20,'lexical').length,0,'a restarted process must not recall a forgotten record');
  assert.equal(reopened.inspect(scope(),'cat')!.state,'active','an unrelated record survives the restart');
  assert.equal(reopened.search(scope(),'团子',20,'lexical').length,1);
 }finally{reopened.close();}
});

test('P0 RV-02 single target source forget fails-closed when planner throws, never creating fallback retain fragments', async t => {
  const f = await fixture(t);
  const store = new SqliteMemoryStore({
    filename: f.c.database,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    clock: () => NOW,
  });

  store.append(scope(), [message('raw-single', '我喜欢红茶')]);
  store.apply(change({ type: 'add', id: 'tea-only', text: '喜欢红茶', sourceIds: ['raw-single'] }, 'tea-only'));

  const singleAction = {
    characterId: 'companion' as const,
    id: 'tea-only',
    expectedVersion: 1,
    operationId: 'single-forget-err',
    reason: '请遗忘红茶',
  };

  const forget = new StrictManagementForget(
    store,
    store.lifecycle,
    { inputTokenBudget: 32768, countTokens: i => buildMemorySemanticFormat(i, true).inputUpperBound + 1024 },
    async () => { throw new Error('controlled single planner crash'); },
  );

  const memory = withStrictManagementForget(new SqliteManagementMemoryPort(store, lifecycle(store)), forget);
  const settings = await ManagementSettingsStore.open(resolve(f.c.projectRoot, 'settings.json'), f.c);
  const runtime = new ManagementRuntime(f.c.sourceRevision);
  const server = await startManagementServer({
    uiRoot: resolve('management/ui'),
    settings,
    memory,
    snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: [], settings: settings.snapshot(), adapters: [], credentials: [], characters: memory.characters() }),
  });

  try {
    const headers = { Authorization: 'Bearer ' + server.token, Origin: server.origin, 'Content-Type': 'application/json' };
    const beforeRev = store.revision(scope());

    const resp = await fetch(server.origin + '/api/memory/forget', {
      method: 'POST',
      headers,
      body: JSON.stringify(singleAction),
    });

    assert.equal(resp.status, 503, 'Must return 503 on planner error');
    const body = await resp.json() as { error?: { code: string; message: string } | string };
    const errorCode = typeof body.error === 'object' && body.error ? body.error.code : body.error;
    assert.equal(errorCode, 'unavailable');

    assert.equal(store.revision(scope()), beforeRev);
    assert.equal(store.inspect(scope(), 'tea-only')!.state, 'active');

    const fragments = store.visible(scope(), 'transcript').filter(r => r.fragment);
    assert.equal(fragments.length, 0, 'No retain fragments may be created on failure');
  } finally {
    await forget.drain();
    forget.close();
    await server.close();
    store.close();
  }
});

test('actual memory page reads SQLite, previews without mutation, then performs strict shared-source forgetting in Windows Chromium',async t=>{
 const f=await setup(t),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
 try{
  const harness=resolve(import.meta.dirname,'../../../tests/management/strict-forget-electron.mjs');
  const url=f.server.origin+'/#token='+f.server.token+'&page=memory&section=dynamics';
  const child=spawn(createRequire(import.meta.url)('electron'),[harness,url],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill();});
  let output='';child.stdout.on('data',bytes=>{output+=bytes;});child.stderr.on('data',bytes=>t.diagnostic(bytes.toString()));
  await new Promise<void>((resolveExit,reject)=>{const timeout=setTimeout(()=>{child.kill();reject(Error('Electron memory UI scenario timed out'));},30000);child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',code=>{clearTimeout(timeout);code===0?resolveExit():reject(Error('Electron exited '+code));});});
  const line=output.split(/\r?\n/).find(value=>value.startsWith('STRICT_FORGET_UI_RESULT='));assert.ok(line,'Electron must return UI scenario results');
  const result=JSON.parse(line.slice('STRICT_FORGET_UI_RESULT='.length));assert.equal(result.error,undefined);assert.equal(result.passed,1);assert.deepEqual(result.errors,[]);
  assert.equal(f.store.inspect(scope(),'tea')!.state,'deleted');assert.equal(f.store.inspect(scope(),'cat')!.state,'active');assert.equal(f.calls(),1);
 }finally{await f.forget.drain();f.forget.close();await f.server.close();f.store.close();}
});
