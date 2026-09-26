import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fixture } from './helpers.js';
import { startManagementServer } from '../../management/server.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { ManagementRuntime } from '../../management/runtime.js';
import { ManagementError,type ManagementMemoryPort } from '../../contracts/management.js';
import type { WeChatSnapshot } from '../../contracts/wechat.js';
test('actual authenticated management routes serve the imported UI and validate all channel mutations',async t=>{
 const f=await fixture(t),settings=await ManagementSettingsStore.open(resolve(f.c.projectRoot,'settings.json'),f.c),runtime=new ManagementRuntime(f.c.sourceRevision);
 let calls=0;const state:WeChatSnapshot={apiVersion:'0.2',replyMode:'follow_input',revision:0,status:'disconnected',enabled:false,boundUser:null,detail:'synthetic',qr:null,lastInputAt:null,lastOutputAt:null,lastDelivery:'none'};
 const memory:ManagementMemoryPort={characters:()=>[],list(){throw Error('not used');},edit(){throw Error('not used');},context(){throw Error('not used');},prompt(){throw Error('not used');},savePrompt(){throw Error('not used');}};
 const server=await startManagementServer({uiRoot:resolve('management/ui'),settings,memory,wechat:{snapshot:()=>structuredClone(state),async action(a){if(a.expectedRevision!==state.revision)throw new ManagementError('version_conflict','state changed');calls++;state.revision++;return structuredClone(state);}},snapshot:()=>({apiVersion:1,runtime:runtime.identity(),modules:runtime.modules(),events:[],settings:settings.snapshot(),adapters:[],credentials:[],characters:[]})});t.after(()=>server.close());
 const headers={Authorization:'Bearer '+server.token,Origin:server.origin,'Content-Type':'application/json'};
 assert.equal((await fetch(server.origin+'/api/wechat')).status,401);assert.equal(calls,0);
 const view=await fetch(server.origin+'/wechat-view.mjs');assert.equal(view.status,200);assert.match(await view.text(),/api\/wechat/);
 const response=await fetch(server.origin+'/api/wechat',{headers});assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.deepEqual(await response.json(),state);
 const post=(body:unknown,h=headers)=>fetch(server.origin+'/api/wechat',{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await post({action:'login',expectedRevision:0},{...headers,Origin:'https://foreign.invalid'})).status,403);
 for(const body of [{action:'login',expectedRevision:0,token:'injected'},{action:'verify',expectedRevision:0,code:'bad'},{action:'stop',expectedRevision:0,code:'1234'},{action:'login',expectedRevision:-1}])assert.equal((await post(body)).status,400);
 assert.equal(calls,0);for(const action of ['login','start','stop','disconnect','verify']){assert.equal((await post({action,expectedRevision:state.revision,...(action==='verify'?{code:'123456'}:{})})).status,200);}
 assert.equal(calls,5);assert.equal((await post({action:'login',expectedRevision:0})).status,409);
});

test('reply setting HTTP parser requires an exact mode and rejects unrelated fields',async()=>{
 const {wechatRoute}=await import('../../management/wechat-routes.js');let calls=0;
 const snapshot:WeChatSnapshot={apiVersion:'0.2',replyMode:'follow_input',revision:0,status:'paused',enabled:false,boundUser:null,detail:'synthetic',qr:null,lastInputAt:null,lastOutputAt:null,lastDelivery:'none'};
 const channel={snapshot:()=>snapshot,async action(a:import('../../contracts/wechat.js').WeChatAction){calls++;if(a.action==='set_reply_mode')snapshot.replyMode=a.replyMode;return snapshot;}};
 for(const replyMode of ['follow_input','text','voice'])assert.equal((await wechatRoute('POST',channel,async()=>({action:'set_reply_mode',replyMode,expectedRevision:0}))).replyMode,replyMode);
 for(const body of [{action:'set_reply_mode',expectedRevision:0},{action:'set_reply_mode',replyMode:'file',expectedRevision:0},{action:'set_reply_mode',replyMode:'voice',expectedRevision:0,code:'1234'},{action:'login',replyMode:'text',expectedRevision:0}])await assert.rejects(wechatRoute('POST',channel,async()=>body));
 assert.equal(calls,3);
});
