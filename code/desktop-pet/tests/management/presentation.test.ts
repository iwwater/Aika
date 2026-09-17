import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fixture } from './helpers.js';
import { PresentationSettingsStore, readPresentationCatalog } from '../../management/presentation.js';
import { startManagementServer } from '../../management/server.js';
import { presentationAssetRoutes } from '../../management/presentation-assets.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { QwenDialogueProvider } from '../../providers/qwen-dialogue.js';
import { ProviderTransport } from '../../providers/transport.js';
import type { DialogueRequest } from '../../contracts/index.js';
import type { ManagementMemoryPort } from '../../contracts/management.js';
const root=resolve(import.meta.dirname,'../../../../..');

test('actual catalog settings persist per model; stale saves and appearance cannot enter automatic policy',async t=>{
 const f=await fixture(t), catalog=await readPresentationCatalog(root), file=join(f.c.projectRoot,'presentation-settings.json');
 let changed=0;const store=await PresentationSettingsStore.open(file,catalog,()=>changed++);
 assert.equal(catalog.items.length,40);assert.equal(store.snapshot().enabledIds.length,12);
 assert.equal(catalog.items.filter(p=>p.availability==='automatic').length,21);
 const baseline=await readFile(f.configFile,'utf8');
 await store.save(catalog.modelId,0,[]);assert.deepEqual(store.allowedIntent(),{emotions:['neutral'],gestures:[],presets:[]});
 await assert.rejects(store.save(catalog.modelId,0,['exp-zzz']),/更新/);
 await assert.rejects(store.save(catalog.modelId,1,[catalog.items.find(p=>p.category==='appearance')!.id]),/自动表现/);
 await assert.rejects(store.save('different-model',1,[]),/模型已变化/);
 const reopened=await PresentationSettingsStore.open(file,catalog);assert.deepEqual(reopened.snapshot(),store.snapshot());
 await reopened.save(catalog.modelId,1,['exp-zzz']);assert.deepEqual(reopened.allowedIntent().presets,[{id:'exp-zzz',label:catalog.items.find(p=>p.id==='exp-zzz')!.label}]);
 const alternate={...catalog,modelId:'alternate-model'};const next=await PresentationSettingsStore.open(file,alternate);assert.equal(next.snapshot().revision,0);assert.equal(next.snapshot().enabledIds.length,12);
 await next.save(alternate.modelId,0,[]);assert.deepEqual((await PresentationSettingsStore.open(file,catalog)).snapshot().enabledIds,['exp-zzz']);
 assert.equal(changed,1);assert.equal((await stat(file)).mode&0o777,0o600);assert.equal(await readFile(f.configFile,'utf8'),baseline);
});

test('real HTTP policy save delivers latest snapshot, preserves preview availability and rejects foreign writes',async t=>{
 const f=await fixture(t), catalog=await readPresentationCatalog(root), presentation=await PresentationSettingsStore.open(join(f.c.projectRoot,'presentation.json'),catalog);
 const settings=await ManagementSettingsStore.open(join(f.c.projectRoot,'settings.json'),f.c),runtime=new ManagementRuntime(f.c.sourceRevision);
 const memory:ManagementMemoryPort={characters:()=>[],list(){throw Error();},edit(){throw Error();},context(){throw Error();},prompt(){throw Error();},savePrompt(){throw Error();}};
 const server=await startManagementServer({uiRoot:resolve(root,'code/desktop-pet/management/ui'),settings,memory,presentation,presentationAssets:await presentationAssetRoutes(root),snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:[],events:[],settings:settings.snapshot(),adapters:[],credentials:[],characters:[]})});t.after(()=>server.close());
 const headers={Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'};
 const put=(body:unknown,h=headers)=>fetch(server.origin+'/api/presentation',{method:'PUT',headers:h,body:JSON.stringify(body)});
 assert.equal((await fetch(server.origin+'/api/presentation')).status,401);
 assert.equal((await put({modelId:catalog.modelId,expectedRevision:0,enabledIds:[]},{...headers,Origin:'https://foreign.invalid'})).status,403);
 const result=await put({modelId:catalog.modelId,expectedRevision:0,enabledIds:[]});assert.equal(result.status,200);
 const data=await result.json() as {policy:{enabledIds:string[]},catalog:typeof catalog};assert.deepEqual(data.policy.enabledIds,[]);assert.equal(data.catalog.items.find(p=>p.id==='exp-zzz')?.previewable,true);
 assert.equal((await put({modelId:catalog.modelId,expectedRevision:0,enabledIds:[]})).status,409);
 assert.equal((await fetch(server.origin+'/presentation-assets/pet.model3.json')).status,200);
 assert.equal((await fetch(server.origin+'/presentation-assets/%2e%2e%2fconfig.json')).status,404);
 assert.equal((await fetch(server.origin+'/presentation-runtime/core.js')).status,200);
});

test('dynamic visual intent rejects a late disabled result while preserving spoken content and TTS emotion',async()=>{
 let presets=[{id:'exp-zzz',label:'困倦'}],release!:()=>void,arrived!:()=>void,system='';
 const sent=new Promise<void>(r=>arrived=r),wait=new Promise<void>(r=>release=r);
 const provider=new QwenDialogueProvider({endpoint:'https://controlled.invalid/chat/completions',model:'fixture',apiKey:()=> 'fixture',authorizer:{async authorize(){return{async settle(){}}}}},new ProviderTransport(async(_url,init)=>{
  system=JSON.parse(String(init?.body)).messages[0].content;arrived();await wait;
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'慢慢来，我在。',expression:{emotion:'warm',intensity:.4,delivery:'温柔完整',gesture:'comfort',presetId:'exp-zzz'}})}}]});
 }),()=>({presets}));
 const scope={characterId:'companion' as const,sessionId:'s',turnId:'t',generation:1};const input:DialogueRequest={scope,text:'晚安',context:{scope,characterPrompt:'人工设定原样',recent:[],summary:'',memories:[],perception:null,inputTokenBudget:4096}};
 const reply=provider.reply(input,new AbortController().signal);await sent;assert.ok(system.includes('exp-zzz'));assert.ok(!system.includes('exp-tushe'));presets=[];release();
 const output=await reply;assert.equal(output.text,'慢慢来，我在。');assert.deepEqual(output.expression,{emotion:'warm',intensity:.4,delivery:'温柔完整',gesture:'comfort',presetId:null});assert.equal(input.context.characterPrompt,'人工设定原样');
});
