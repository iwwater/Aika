import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync,mkdtempSync,rmSync,realpathSync } from 'node:fs';
import { resolve,join } from 'node:path';
import { createDecipheriv,createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WeChatApi,ILINK_ORIGIN,type WeChatCredentials } from '../../wechat/api.js';
import { WeChatStore,channelKey } from '../../wechat/store.js';
import { WeChatService,type WeChatInput,type WeChatSend } from '../../wechat/service.js';
import { wechatTranscriber } from '../../wechat/asr.js';
import { wechatAudioFileSender } from '../../wechat/output.js';
import { MemoryMediaStore } from '../../media/store.js';
import { pcm16Wav } from '../../media/wav.js';
import type { TtsProvider,TtsResult } from '../../contracts/index.js';
const signal=new AbortController().signal,auth:WeChatCredentials={token:'synthetic',userId:'user',botId:'bot',baseUrl:ILINK_ORIGIN};
const json=(v:unknown)=>new Response(JSON.stringify(v));
const blocked=(s:AbortSignal)=>new Promise<Response>((_,reject)=>{s.addEventListener('abort',()=>reject(s.reason),{once:true});if(s.aborted)reject(s.reason);});
async function until(p:()=>boolean){for(let n=0;n<200;n++){if(p())return;await sleep(5);}assert.fail('Expected controlled state');}
function root(t:import('node:test').TestContext){const parent=resolve('../../.local/wechat-voice-input-25/tmp');mkdirSync(parent,{recursive:true});const r=mkdtempSync(join(realpathSync(parent),'integration-'));t.after(()=>rmSync(r,{recursive:true,force:true}));return r;}
const message=(id:string,item_list:unknown[],extra={})=>({message_id:id,from_user_id:'user',to_user_id:'bot',message_type:1,message_state:2,context_token:'context',item_list,...extra});

test('official transcript bypass, failed audio isolation, durable policy and snapshot-frozen reply routing',async t=>{
 const file=join(root(t),'channel.sqlite'),store=new WeChatStore(file);store.set('credentials',auth);store.set('enabled',true);
 let polls=0,decode=0,send!:WeChatSend;const inputs:WeChatInput[]=[],textOut:string[]=[],voiceOut:string[]=[];
 const msgs=[message('foreign',[{type:3,voice_item:{}}],{from_user_id:'foreign'}),message('official',[{type:3,voice_item:{text:' 原文 English 七点。 '}}]),message('bad',[{type:3,voice_item:{}}]),message('good',[{type:3,voice_item:{}}]),message('next',[{type:1,text_item:{text:'文字仍可用'}}])];
 const api=new WeChatApi((async(u,o)=>{if(String(u).endsWith('/sendmessage')){textOut.push(JSON.parse(String(o!.body)).msg.item_list[0].text_item.text);return json({ret:0});}if(polls++===0)return json({msgs,get_updates_buf:'cursor'});return blocked(o!.signal!);}) as typeof fetch);
 const service=new WeChatService(store,api,async(_k,out)=>{send=out;return {capture:()=>undefined,close:async()=>{},receive:async i=>{inputs.push(i);await out('回复 '+i.text,i.messageId,i.replyContext);}};},{transcribe:async()=>{decode++;if(decode===1)throw Error('bad audio');await service.action({action:'set_reply_mode',replyMode:'text',expectedRevision:service.snapshot().revision});return 'ASR 原文';},sendVoice:async(_a,_c,text)=>{voiceOut.push(text);}});
 await service.restore();await until(()=>polls===2);
 assert.equal(decode,2);assert.deepEqual(inputs.map(i=>i.text),[' 原文 English 七点。 ','ASR 原文','文字仍可用']);
 assert.deepEqual(inputs.map(i=>i.replyContext),[{source:'voice',replyMode:'follow_input'},{source:'voice',replyMode:'follow_input'},{source:'text',replyMode:'follow_input'}]);
 assert.equal(voiceOut.length,2);assert.ok(!textOut.some(text=>text.startsWith('语音转写')));assert.ok(textOut.includes('回复 文字仍可用'));assert.equal(store.get('cursor:'+channelKey(auth)),'cursor');
 await send('forced','forced',{source:'text',replyMode:'voice'});assert.equal(voiceOut.length,3);
 const revision=service.snapshot().revision;await assert.rejects(service.action({action:'set_reply_mode',replyMode:'voice',expectedRevision:revision-1}));await service.close();
 const fresh=new WeChatStore(file),again=new WeChatService(fresh,new WeChatApi(),async()=>{throw Error('No new connection');});assert.equal(again.snapshot().replyMode,'text');assert.deepEqual(fresh.get('credentials'),auth);await again.close();
});

test('ASR owns a separate scope/store, preserves raw text, rejects wrong scope and releases on cancellation',async()=>{
 const media=new MemoryMediaStore();let bytes=pcm16Wav(new Float32Array(480),24000);
 const transcribe=wechatTranscriber(media,{async transcribe(i){const copy=await media.read(i.scope,i.audio);assert.ok(copy.length>44);copy.fill(0);return {scope:i.scope,transcript:'  seven 七点  '};}},async()=>bytes);
 assert.equal(await transcribe({},'synthetic',signal),'  seven 七点  ');assert.equal(media.count,0);assert.ok(bytes.every(x=>x===0));
 bytes=pcm16Wav(new Float32Array(480),24000);
 await assert.rejects(wechatTranscriber(media,{async transcribe(i){return {scope:{...i.scope,turnId:'foreign'},transcript:'not allowed'};}},async()=>bytes)({},'synthetic',signal));assert.equal(media.count,0);
 const abort=new AbortController();let entered=false;
 bytes=pcm16Wav(new Float32Array(480),24000);
 const pending=wechatTranscriber(media,{transcribe:async()=>{entered=true;return new Promise(()=>{});}},async()=>bytes)({},'synthetic',abort.signal);
 await until(()=>entered);abort.abort();await assert.rejects(pending);assert.equal(media.count,0);
});

test('FILE candidate uses actual encrypted upload and distinct official type; clears bytes and never plays',async()=>{
 const media=new MemoryMediaStore(),original=pcm16Wav(new Float32Array(480).fill(.2),24000);let uploadRequest:any,sent:any,encrypted:Uint8Array|undefined;
 const api=new WeChatApi((async(u,o)=>{const b=JSON.parse(String(o!.body));if(String(u).endsWith('getuploadurl')){uploadRequest=b;return json({upload_param:'opaque+param'});}sent=b;return json({ret:0});}) as typeof fetch);
 const tts:TtsProvider={async synthesize(i){assert.equal(i.text,'Exact reply');return {scope:i.scope,audio:await media.put(i.scope,original,'audio/wav'),expression:i.expression,durationMs:20,synchronization:'amplitude'};}};
 const send=wechatAudioFileSender(media,tts,api,(async(u,o)=>{const url=new URL(String(u));assert.equal(url.origin,'https://novac2c.cdn.weixin.qq.com');assert.equal(url.searchParams.get('encrypted_query_param'),'opaque+param');assert.equal(o!.redirect,'error');assert.equal((o!.headers as any).Authorization,undefined);encrypted=o!.body as Uint8Array;const d=createDecipheriv('aes-128-ecb',Buffer.from(uploadRequest.aeskey,'hex'),null);const plain=Buffer.concat([d.update(encrypted),d.final()]);assert.deepEqual(plain,Buffer.from(original));plain.fill(0);return new Response(null,{headers:{'x-encrypted-param':'download'}});}) as typeof fetch);
 await send(auth,'context','Exact reply','client',signal);assert.equal(uploadRequest.media_type,3);assert.equal(sent.msg.item_list[0].type,4);assert.equal(sent.msg.item_list[0].voice_item,undefined);assert.equal(sent.msg.item_list[0].file_item.len,String(original.length));assert.equal(media.count,0);assert.ok(encrypted!.every(v=>v===0));original.fill(0);
});

test('FILE candidate rejects foreign CDN without upload and discards TTS which completes after cancellation',async()=>{
 const media=new MemoryMediaStore(),audio=pcm16Wav(new Float32Array(480),24000);let uploads=0;
 const api=new WeChatApi((async()=>json({upload_full_url:'https://foreign.invalid/c2c/upload'})) as typeof fetch);
 const tts:TtsProvider={async synthesize(i){return {scope:i.scope,audio:await media.put(i.scope,audio,'audio/wav'),expression:i.expression,durationMs:20,synchronization:'amplitude'};}};
 await assert.rejects(wechatAudioFileSender(media,tts,api,async()=>{uploads++;throw Error();})(auth,'context','reply','client',signal));assert.equal(uploads,0);assert.equal(media.count,0);
 const abort=new AbortController();let finish!:(r:TtsResult)=>void,input:any;
 const pending=wechatAudioFileSender(media,{synthesize:i=>{input=i;return new Promise(r=>finish=r);}},api)(auth,'context','reply','late',abort.signal);
 abort.abort();await assert.rejects(pending);finish({scope:input.scope,audio:await media.put(input.scope,audio,'audio/wav'),expression:input.expression,durationMs:20,synchronization:'amplitude'});await sleep(0);assert.equal(media.count,0);audio.fill(0);
});

test('cancelled upload closes a late response body and never sends a message item',async()=>{
 const media=new MemoryMediaStore(),audio=pcm16Wav(new Float32Array(480),24000),abort=new AbortController();let resolveResponse!:(r:Response)=>void,sent=0,cancelled=false;
 const api=new WeChatApi((async(u)=>{if(String(u).endsWith('getuploadurl'))return json({upload_param:'synthetic'});sent++;return json({ret:0});}) as typeof fetch);
 const tts:TtsProvider={async synthesize(i){return {scope:i.scope,audio:await media.put(i.scope,audio,'audio/wav'),expression:i.expression,durationMs:20,synchronization:'amplitude'};}};
 const pending=wechatAudioFileSender(media,tts,api,()=>new Promise(r=>resolveResponse=r))(auth,'context','reply','id',abort.signal);
 await until(()=>!!resolveResponse);abort.abort();await assert.rejects(pending);
 resolveResponse(new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'x-encrypted-param':'late'}}));await sleep(0);
 assert.equal(cancelled,true);assert.equal(sent,0);assert.equal(media.count,0);audio.fill(0);
});

test('voice reaches conversation without any outbound prerequisite; receive failure uses neutral feedback and duplicate stays consumed',async t=>{
 const store=new WeChatStore(join(root(t),'channel.sqlite'));store.set('credentials',auth);store.set('enabled',true);
 let polls=0;const received:WeChatInput[]=[],out:string[]=[];
 const msgs=[message('voice',[{type:3,voice_item:{text:'下午好，现在帮我查一下现在是几点了'}}]),message('broken',[{type:1,text_item:{text:'ordinary error'}}])];
 const api=new WeChatApi((async(u,o)=>{if(String(u).endsWith('/sendmessage')){out.push(JSON.parse(String(o!.body)).msg.item_list[0].text_item.text);throw Error('outbound unavailable');}if(polls++<2)return json({msgs,get_updates_buf:'after'});return blocked(o!.signal!);}) as typeof fetch);
 const service=new WeChatService(store,api,async()=>({capture:()=>undefined,close:async()=>{},receive:async i=>{received.push(i);assert.equal(out.length,0);if(i.text==='ordinary error')throw Error('controlled receive failure');}}));
 await service.restore();await until(()=>polls===3);
 assert.deepEqual(received.map(i=>i.text),['下午好，现在帮我查一下现在是几点了','ordinary error']);
 assert.equal(out.length,1);assert.equal(out[0],'这条消息未能处理完成，暂时没有可确认的回复。');assert.ok(!out[0]!.includes('任务'));
 assert.equal(store.seenStatus(channelKey(auth),'in:'+createHash('sha256').update('voice').digest('hex')),'handled');assert.equal(store.seenStatus(channelKey(auth),'in:'+createHash('sha256').update('broken').digest('hex')),'unknown');
 await service.close();
});
