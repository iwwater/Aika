import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync,statSync,writeFileSync,symlinkSync,realpathSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WeChatApi,WeChatApiError,ILINK_ORIGIN,type WeChatCredentials,weixinOrigin } from '../../wechat/api.js';
import { WeChatStore,channelKey } from '../../wechat/store.js';
import { WeChatService,type WeChatConversation,type WeChatSend } from '../../wechat/service.js';
import type { WorkInputBinding } from '../../contracts/desktop-work.js';
const auth:WeChatCredentials={token:'synthetic-private-token',botId:'bot',userId:'user',baseUrl:ILINK_ORIGIN};
const signal=new AbortController().signal;
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
function root(t:import('node:test').TestContext){const parent=resolve('../../.local/wechat-21/tmp');mkdirSync(parent,{recursive:true});const r=mkdtempSync(join(realpathSync(parent),'channel-'));t.after(()=>rmSync(r,{recursive:true,force:true}));return r;}
async function until(p:()=>boolean){for(let n=0;n<200;n++){if(p())return;await sleep(10);}assert.fail('controlled channel did not reach expected state');}
const json=(v:unknown)=>new Response(JSON.stringify(v),{headers:{'Content-Type':'application/json'}});
function blocked(s:AbortSignal):Promise<Response>{return new Promise((_,reject)=>{if(s.aborted)reject(s.reason);else s.addEventListener('abort',()=>reject(s.reason),{once:true});});}

test('official methods, scoped auth, uint64 IDs and redacted protocol failures',async()=>{
 const calls:{url:URL;options:RequestInit;body:any}[]=[];
 let response='{"ret":0,"msgs":[{"message_id":18446744073709551615,"text":"message_id: 18446744073709551615"}]}';
 const api=new WeChatApi((async(u,o)=>{calls.push({url:new URL(String(u)),options:o!,body:o?.body?JSON.parse(String(o.body)):undefined});return new Response(response);}) as typeof fetch);
 const result=await api.updates(auth,'cursor',signal);assert.equal(result.msgs![0]!.message_id,'18446744073709551615');assert.equal((result.msgs![0] as any).text,'message_id: 18446744073709551615');
 const c=calls[0]!;assert.equal(c.url.origin,ILINK_ORIGIN);assert.equal(c.options.redirect,'error');assert.equal(c.options.method,'POST');assert.equal((c.options.headers as any).Authorization,'Bearer '+auth.token);assert.match(Buffer.from((c.options.headers as any)['X-WECHAT-UIN'],'base64').toString(),/^\d+$/);assert.equal(c.body.get_updates_buf,'cursor');
 response='{"status":"wait"}';await api.qrStatus(ILINK_ORIGIN,'synthetic-qr',signal,'123456');assert.equal(calls[1]!.options.method,'GET');assert.equal((calls[1]!.options.headers as any).Authorization,undefined);assert.equal(calls[1]!.url.searchParams.get('verify_code'),'123456');
 response='{"ret":0}';await api.send(auth,'context','hello','client',signal);assert.equal(calls[2]!.body.msg.to_user_id,'user');assert.equal(calls[2]!.body.msg.context_token,'context');assert.equal(calls[2]!.body.msg.message_state,2);
 for(const raw of ['{"ret":-14,"errmsg":"secret"}','{"ret":9,"errmsg":"secret"}','[]','not JSON secret']){response=raw;await assert.rejects(api.updates(auth,'',signal),(e:any)=>e instanceof WeChatApiError&&!String(e).includes('secret'));}
 for(const url of ['https://evil.invalid','http://ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com.evil.invalid','https://x@ilinkai.weixin.qq.com','https://ilinkai.weixin.qq.com/redirect','https://ilinkai.weixin.qq.com:444'])assert.throws(()=>weixinOrigin(url));
});
test('private metadata database persists claims/cursor across restart and refuses foreign files or symlinks',t=>{
 const r=root(t),file=join(r,'channel.sqlite');let store=new WeChatStore(file);assert.equal(statSync(file).mode&0o777,0o600);store.set('cursor','opaque');assert.equal(store.claim('channel','one'),true);store.close();store=new WeChatStore(file);assert.equal(store.get('cursor'),'opaque');assert.equal(store.claim('channel','one'),false);assert.equal(store.seenStatus('channel','one'),'claimed');store.finish('channel','one','handled');store.close();
 const bad=join(r,'bad');mkdirSync(bad);writeFileSync(join(bad,'channel.sqlite'),'user document',{mode:0o600});assert.throws(()=>new WeChatStore(join(bad,'channel.sqlite')));
 const link=join(r,'link');mkdirSync(link);symlinkSync(file,join(link,'channel.sqlite'));assert.throws(()=>new WeChatStore(join(link,'channel.sqlite')));
});
test('bound peer filter, durable dedup/cursor, frozen batch confirmation and unknown outgoing are never replayed',async t=>{
 const file=join(root(t),'channel.sqlite'),store=new WeChatStore(file),key=channelKey(auth);store.set('credentials',auth);store.set('enabled',true);store.set('boundAt:'+key,100);
 const before={draftId:'first',draftVersion:1} satisfies WorkInputBinding,after={draftId:'second',draftVersion:2} satisfies WorkInputBinding;
 let shown:WorkInputBinding=before,send!:WeChatSend,closed=0,polls=0,sends=0;const inputs:{text:string;binding:WorkInputBinding|undefined}[]=[];
 const message=(id:string,extra:any={})=>({message_id:id,from_user_id:'user',to_user_id:'bot',message_type:1,message_state:2,context_token:'synthetic-context',create_time_ms:200,item_list:[{type:1,text_item:{text:id}}],...extra});
 const api=new WeChatApi((async(u,o)=>{if(String(u).endsWith('sendmessage')){sends++;throw Error('unknown private response');}polls++;if(polls===1)return json({ret:0,get_updates_buf:'next',msgs:[message('foreign',{from_user_id:'other'}),message('group',{group_id:'group'}),message('old',{create_time_ms:10}),message('partial',{message_state:1}),message('first'),message('confirm'),message('first')]});return blocked(o!.signal!);}) as typeof fetch);
 const service=new WeChatService(store,api,async(_key,output)=>{send=output;return {capture:()=>structuredClone(shown),receive:async(i,b)=>{inputs.push({text:i.text,binding:b});shown=after;await output('reply','same-output');},close:async()=>{closed++;}};});
 await service.restore();await until(()=>polls>=2);assert.deepEqual(inputs,[{text:'first',binding:before},{text:'confirm',binding:before}]);assert.equal(sends,1);assert.equal(await send('reply','same-output'),false);assert.equal(sends,1);assert.equal(service.snapshot().lastDelivery,'unknown');assert.equal(store.get('cursor:'+key),'next');await service.close();assert.equal(closed,1);
 const again=new WeChatStore(file);let replayed=0,restarts=0;const restarted=new WeChatService(again,new WeChatApi((async(_u,o)=>{restarts++;assert.equal(JSON.parse(String(o!.body)).get_updates_buf,'next');if(restarts===1)return json({ret:0,msgs:[message('first'),message('confirm')]});return blocked(o!.signal!);}) as typeof fetch),async()=>({capture:()=>undefined,receive:async()=>{replayed++;},close:async()=>{}}));
 await restarted.restore();await until(()=>restarts>=2);assert.equal(replayed,0);assert.equal(again.seenStatus(key,'in:'+hash('first')),'handled');await restarted.close();
});
test('late QR result cannot bind after stop; unbound pause returns to login; expiry disables restart',async t=>{
 const store=new WeChatStore(join(root(t),'channel.sqlite'));let statusStarted=false,factoryCalls=0;
 const service=new WeChatService(store,new WeChatApi((async(u,o)=>{if(String(u).includes('get_bot_qrcode'))return json({qrcode:'synthetic',qrcode_img_content:'https://example.invalid/synthetic'});statusStarted=true;await new Promise<void>(r=>o!.signal!.addEventListener('abort',()=>r(),{once:true}));return json({status:'confirmed',bot_token:'late',ilink_bot_id:'bot',ilink_user_id:'user',baseurl:ILINK_ORIGIN});}) as typeof fetch),async()=>{factoryCalls++;throw Error('must not start');});
 await service.action({action:'login',expectedRevision:service.snapshot().revision});await until(()=>statusStarted);assert.match(service.snapshot().qr!.imageDataUrl,/^data:image\/png;base64,/);
 await service.action({action:'stop',expectedRevision:service.snapshot().revision});assert.equal(service.snapshot().status,'disconnected');assert.equal(store.get('credentials'),undefined);assert.equal(factoryCalls,0);await service.close();
 const store2=new WeChatStore(join(root(t),'channel.sqlite'));store2.set('credentials',auth);store2.set('enabled',true);
 const expired=new WeChatService(store2,new WeChatApi((async()=>json({ret:-14})) as typeof fetch),async()=>({capture:()=>undefined,receive:async()=>{},close:async()=>{}}));await expired.restore();await until(()=>expired.snapshot().status==='expired');assert.equal(store2.get('enabled'),false);assert.equal(expired.snapshot().enabled,false);await expired.close();
});
test('factory failure is recoverable and stop aborts an active input without a late reply',async t=>{
 const store=new WeChatStore(join(root(t),'channel.sqlite'));store.set('credentials',auth);store.set('enabled',true);let attempts=0,receiving=false,stopped=false,polls=0;
 const service=new WeChatService(store,new WeChatApi((async(_u,o)=>{if(polls++===0)return json({msgs:[{message_id:'1',from_user_id:'user',message_type:1,message_state:2,item_list:[{type:1,text_item:{text:'hold'}}]}]});return blocked(o!.signal!);}) as typeof fetch),async()=>{if(attempts++===0)throw Error('synthetic failure');return {capture:()=>undefined,receive:async(_i,_b,s)=>{receiving=true;await blocked(s).catch(()=>{stopped=true;});},close:async()=>{}};});
 await service.restore();assert.equal(service.snapshot().status,'error');assert.equal(service.snapshot().enabled,false);await service.action({action:'start',expectedRevision:service.snapshot().revision});await until(()=>receiving);await service.action({action:'stop',expectedRevision:service.snapshot().revision});assert.equal(stopped,true);assert.equal(service.snapshot().status,'paused');await service.close();
});
