import test from 'node:test';
import assert from 'node:assert/strict';
import type { BackendToDesktop } from '../../contracts/desktop-bridge.js';
import { BackendSession, type BackendPorts, parseDesktopCommand } from '../../app/backend-session.js';
import { MemoryMediaStore } from '../../media/store.js';
import type { AssistantMemoryPort, MemoryTurnPort, SummaryPort } from '../../contracts/memory-lifecycle.js';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../memory/sqlite-store.js';
import { SqliteMemoryPort } from '../../memory/sqlite-port.js';
import { confirmedInvitationPolicy } from '../../companion/invitations.js';

test('trusted session connects text, saved conversation, TTS playback feedback and automatic maintenance', async () => {
  const outgoing: BackendToDesktop[] = [], saved: string[] = [], maintained: string[] = [];
  let closed = false;
  const store = new MemoryMediaStore();
  const ports: BackendPorts = {
    mediaStore: store,
    perception: { async perceive() { throw new Error('Text must not perceive'); } },
    memory: {
      async append(scope, messages) { saved.push(...messages.map(m => `${scope.characterId}:${m.role}`)); },
      async context(scope) { return { scope, characterPrompt: 'companion', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000 }; },
      maintenanceInput(scope) { return { scope, messages: [], relevantMemories: [] }; },
      async maintain(input) { maintained.push(input.scope.characterId); return []; },
    },
    dialogue: { async reply(input) { return { scope: input.scope, text: '我在', expression: { emotion: 'calm', intensity: .4, delivery: '自然', gesture: null } }; } },
    tts: { async synthesize(input) { return { ...input, audio: await store.put(input.scope, Uint8Array.of(1, 2), 'audio/wav'), durationMs: 10, synchronization: 'amplitude' }; } },
  };
  const session = new BackendSession(ports, message => {
    outgoing.push(message);
    if (message.channel === 'play') queueMicrotask(() => {
      for (const event of [{ type: 'started', audioId: message.tts.audio.id, timingBasis: 'audio_output_timestamp' }, { type: 'amplitude', value: .5 }, { type: 'ended' }]) void session.receiveLine(JSON.stringify({ channel: 'playback', requestId: message.requestId, event: { ...event, scope: message.tts.scope, at: new Date().toISOString() } }));
    });
  }, () => { closed = true; });
  assert.equal(outgoing[0]?.channel, 'backend_ready');
  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: '今天有点累' } }));
  await session.drain();
  assert.deepEqual(saved, ['companion:user', 'companion:assistant']); assert.deepEqual(maintained, ['companion']);
  assert.equal(outgoing.some(m => m.channel.startsWith('capture')), false); assert.equal(store.count, 0);
  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'switch_character', characterId: 'sweetheart' } }));
  assert.equal(outgoing.at(-1)?.channel, 'event');
  const ready = outgoing[0];
  assert.ok(ready?.channel === 'backend_ready'); assert.equal(ready.characterId, 'companion');
  await session.close(); assert.equal(closed, true);
});

test('desktop JSON commands validate role and text before entering the trusted runtime', () => {
  assert.throws(() => parseDesktopCommand({ type: 'switch_character', characterId: 'all' }), /Unsupported/);
  assert.throws(() => parseDesktopCommand({ type: 'submit_text', text: 23 }), /Text/);
  assert.deepEqual(parseDesktopCommand({ type: 'submit_text', text: '你好', apiKey: 'untrusted-extra-field' }), { type: 'submit_text', text: '你好' });
});

test('lifecycle session uses pre-reply preparation once and summary failure never stops valid playback', async () => {
  const calls: string[] = [], outgoing: BackendToDesktop[] = [];
  const media = new MemoryMediaStore();
  const memory: BackendPorts['memory'] & MemoryTurnPort & SummaryPort & AssistantMemoryPort = {
    async append(_scope, messages) { assert.equal(messages[0]?.role, 'user'); calls.push('append:user'); },
    async appendAssistant(scope, message, context, currentId, signal) {
      signal.throwIfAborted(); assert.equal(message.role, 'assistant'); assert.equal(context.scope.turnId, scope.turnId);
      assert.equal(currentId, `${scope.turnId}:user`); calls.push('append:assistant');
    },
    async context(scope) { calls.push('context'); return { scope, characterPrompt: 'companion', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 1000 }; },
    maintenanceInput() { throw new Error('legacy path must not run'); }, async maintain() { throw new Error('duplicate maintenance'); },
    async prepareTurn(scope) { calls.push('prepare'); return { scope, request: 'none', status: 'unchanged', results: [], affectedIds: [], retrievalInvalidated: false, clarification: null }; },
    assertContextCurrent() {}, async summarizePending() { calls.push('summary'); throw new Error('provider unavailable'); },
  };
  const session = new BackendSession({ memory, lifecycleMemory: memory, mediaStore: media,
    perception: { async perceive() { throw new Error('unexpected capture'); } },
    dialogue: { async reply(input) { calls.push('reply'); assert.equal(input.memoryOutcome?.status, 'unchanged'); return { scope: input.scope, text: '你好。', expression: { emotion: 'neutral', intensity: 0, delivery: 'natural', gesture: null } }; } },
    tts: { async synthesize(reply) { return { ...reply, audio: await media.put(reply.scope, Uint8Array.of(1, 2), 'audio/wav'), durationMs: 100, synchronization: 'amplitude' }; } },
  }, message => {
    outgoing.push(message);
    if (message.channel === 'play') queueMicrotask(() => {
      for (const event of [{ type: 'started', audioId: message.tts.audio.id }, { type: 'ended' }]) void session.receiveLine(JSON.stringify({ channel: 'playback', requestId: message.requestId, event: { ...event, scope: message.tts.scope, at: new Date().toISOString() } }));
    });
  }, () => {}, (_scope, kind) => calls.push(`background_failure:${kind}`));
  await session.receiveLine(JSON.stringify({ channel: 'command', command: { type: 'submit_text', text: '你好' } })); await session.drain();
  assert.deepEqual(calls.slice(0, 5), ['append:user', 'prepare', 'context', 'reply', 'append:assistant']);
  assert.equal(calls.filter(c => c === 'prepare').length, 1); assert.equal(calls.includes('summary'), true); assert.equal(calls.includes('background_failure:summary'), true);
  assert.equal(outgoing.some(m => m.channel === 'event' && m.event.type === 'error'), false);
  assert.equal(outgoing.some(m => m.channel === 'event' && m.event.type === 'playback' && m.event.playback.type === 'ended'), true);
  assert.equal(media.count, 0); await session.close();
});

test('voice intent IDs survive command parsing while malformed or overlong identifiers are refused', () => {
  assert.deepEqual(parseDesktopCommand({type:'start_voice', clientRequestId:'voice_123-retry'}), {type:'start_voice',clientRequestId:'voice_123-retry'});
  assert.deepEqual(parseDesktopCommand({type:'start_voice'}), {type:'start_voice'});
  for (const clientRequestId of ['', 'two words', '<script>', 'x'.repeat(129), 0, null]) {
    assert.throws(()=>parseDesktopCommand({type:'start_voice',clientRequestId}), /Invalid voice request ID/);
  }
});

test('actual session preserves rapid start-cancel-retry order and echoes the matching voice intent', async () => {
  const outgoing: BackendToDesktop[] = [];
  const mediaStore = new MemoryMediaStore();
  const session = new BackendSession({mediaStore,
    perception:{async perceive(){throw new Error('cancelled before capture');}},
    dialogue:{async reply(){throw new Error('no dialogue');}},
    tts:{async synthesize(){throw new Error('no TTS');}},
    memory:{async append(){throw new Error('no memory write');},async context(){throw new Error('no context');},async maintain(){return [];},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}},
  },message=>{
    outgoing.push(message);
    if (message.channel==='capture_stop' || message.channel==='stop') queueMicrotask(()=>void session.receiveLine(JSON.stringify({channel:'ack',requestId:message.requestId})));
  },()=>{});
  const command = (value: unknown) => session.receiveLine(JSON.stringify({channel:'command',command:value}));
  await Promise.all([command({type:'start_voice',clientRequestId:'before'}), command({type:'cancel'}), command({type:'start_voice',clientRequestId:'after'})]);
  const turns = outgoing.filter(m=>m.channel==='event' && m.event.type==='turn');
  assert.equal(turns.length,2);
  for (const [index,id] of ['before','after'].entries()) {
    const message=turns[index]!;
    assert.ok(message.channel==='event' && message.event.type==='turn');
    assert.equal(message.event.input.clientRequestId,id);
    const scope=message.event.input.scope;
    assert.ok(outgoing.findIndex(m=>m.channel==='capture_start' && m.scope.turnId===scope.turnId)>outgoing.indexOf(message));
  }
  await session.close();
});

test('integrated actual desktop entry and BackendSession recover capture failure then display scoped voice transcript and reply', async () => {
  // The real main/view/chat/playback and backend/pipeline/bridge run together.
  // Only DOM, physical devices and provider responses are controlled by the desktop harness.
  const {app}=await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);
  const a=await app(), outgoing:BackendToDesktop[]=[], failures:unknown[]=[];
  const saved:{role:string;characterId:string;text:string}[]=[], mediaStore=new MemoryMediaStore();
  let perceived=0, replies=0, synthesized=0, uiIndex=0, backendIndex=0;
  const transcript='这次语音实际转写 <b>今天练琴顺利</b>';
  const session=new BackendSession({mediaStore,
    perception:{async perceive(input){perceived++;return {scope:input.scope,transcript,modalities:[],cues:[],status:'complete'};}},
    dialogue:{async reply(input){replies++;assert.equal(input.text,transcript);return {scope:input.scope,text:'听起来今天练得很顺。',expression:{emotion:'欣赏',intensity:.7,delivery:'自然轻快',gesture:'comfort'}};}},
    tts:{async synthesize(reply){synthesized++;return {...reply,audio:await mediaStore.put(reply.scope,Uint8Array.of(1,2),'audio/wav'),durationMs:10,synchronization:'amplitude'};}},
    memory:{async append(_scope,messages){saved.push(...messages);},async context(scope){return {scope,characterPrompt:'朋友',recent:[],summary:'',memories:[],perception:null,inputTokenBudget:4000};},async maintain(){return [];},maintenanceInput(scope){return {scope,messages:[],relevantMemories:[]};}},
  },message=>outgoing.push(message),()=>{});
  const launch=(promise:Promise<unknown>)=>{void promise.catch(error=>failures.push(error));};
  const tick=()=>new Promise<void>(r=>setImmediate(r));
  const pump=async(predicate:()=>boolean)=>{
    for(let i=0;i<100;i++){
      while(uiIndex<a.messages.length){const m=a.messages[uiIndex++];if(m.name==='desktop')launch(session.receiveLine(JSON.stringify(m.value.message)));}
      while(backendIndex<outgoing.length){const m=outgoing[backendIndex++]!;
        if(m.channel==='event'&&m.event.type==='turn'&&m.event.input.kind==='voice')assert.ok(m.event.input.clientRequestId,'real backend must supply the token; harness must not invent it');
        launch(a.bridge.receive(JSON.parse(JSON.stringify(m)),1));
      }
      await tick();assert.deepEqual(failures,[]);
      if(predicate())return;
    }
    assert.fail('actual frontend/backend did not reach the expected state');
  };
  try{
    a.changed(1);await pump(()=>a.node('voice').disabled===false);
    a.node('voice').onclick();await pump(()=>a.harness.captureOpens===1);
    const denial=new Error('private device detail');denial.name='NotAllowedError';a.harness.rejectCapture(denial);
    await pump(()=>outgoing.some(m=>m.channel==='event'&&m.event.type==='error')&&a.node('voice').disabled===false);
    assert.match(a.node('status').textContent,/权限/);assert.ok(!a.renderedText().includes('private device detail'));
    assert.deepEqual([perceived,replies,synthesized,saved.length],[0,0,0,0]);
    a.node('voice').onclick();await pump(()=>a.harness.captureOpens===2);
    a.harness.openCapture({stop(){},async finish(){return {audio:Uint8Array.of(1,2,3),images:Array.from({length:3},(_,i)=>({bytes:Uint8Array.of(4+i),mimeType:'image/jpeg'})),captureStoppedAt:new Date().toISOString()};}});
    await pump(()=>a.node('status').textContent.includes('正在听'));
    a.node('voice').onclick();await pump(()=>a.renderedText().includes(transcript)&&a.harness.playback);
    assert.ok(a.renderedText().includes('听起来今天练得很顺。'));assert.ok(!a.renderedText().includes('语音输入 · 准备中'));
    assert.equal(saved.find(m=>m.role==='user')?.text,transcript);assert.equal(saved.every(m=>m.characterId==='companion'),true);
    assert.deepEqual([perceived,replies,synthesized],[1,1,1]);
    const play=outgoing.find((m):m is Extract<BackendToDesktop,{channel:'play'}>=>m.channel==='play')!;
    for(const event of [{type:'started',audioId:play.tts.audio.id},{type:'amplitude',value:.3},{type:'ended'}])a.harness.playback.emit({...event,at:new Date().toISOString()});
    a.harness.playback.session.stop();await pump(()=>outgoing.some(m=>m.channel==='event'&&m.event.type==='playback'&&m.event.playback.type==='ended'));
    await session.drain();assert.equal(mediaStore.count,0);
    assert.ok(a.renderedText().includes(transcript));
    assert.equal(a.messages.some((m:{value?:{message?:{command?:{type?:string}}}})=>m.value?.message?.command?.type==='switch_character'),false);
  }finally{a.changed(1,'disconnected');await session.close();}
});


test('fictional introduction acknowledgement persists through profile port without conversation, model or devices', async () => {
  const outgoing: BackendToDesktop[] = [], acknowledgements: string[] = [];
  let dataWrites = 0, modelCalls = 0;
  const mediaStore = new MemoryMediaStore();
  const session = new BackendSession({mediaStore,
    companionProfile: {introduction: () => ({id:'companion-opening-v1',text:'有些事情像蒙着雾，但我还认得你。'}), acknowledgeIntroduction(id) {acknowledgements.push(id);}},
    memory: {async append() {dataWrites++;}, async maintain() {dataWrites++;return [];}, maintenanceInput(scope) {return {scope,messages:[],relevantMemories:[]};}, async context() {throw Error('No context should be requested');}},
    perception: {async perceive() {modelCalls++;throw Error('No perception');}}, dialogue: {async reply() {modelCalls++;throw Error('No dialogue');}}, tts: {async synthesize() {modelCalls++;throw Error('No TTS');}},
  }, message => outgoing.push(message), () => {});
  const ready = outgoing[0];assert.ok(ready?.channel==='backend_ready');assert.equal(ready.introduction?.id,'companion-opening-v1');
  assert.deepEqual(acknowledgements,[]);
  await session.receiveLine(JSON.stringify({channel:'command',command:{type:'acknowledge_introduction',introductionId:ready.introduction!.id}}));
  assert.deepEqual(acknowledgements,['companion-opening-v1']);assert.equal(outgoing.length,1);
  assert.equal(dataWrites,0);assert.equal(modelCalls,0);assert.equal(mediaStore.count,0);await session.close();
});

test('actual desktop display and BackendSession persist opening ack in SQLite across reopen without producing memory', async t => {
  const parent = resolve('../../.local/companion-step1-01/tmp');
  mkdirSync(parent, {recursive:true});
  const directory = mkdtempSync(join(parent, 'opening-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const {app} = await import(new URL('../../../tests/desktop/ui-harness.mjs',import.meta.url).href);
  let forbiddenCalls = 0;
  const forbidden = async () => { forbiddenCalls++; throw Error('Opening must not call providers'); };
  for (const [cycle, display] of [false, true, false].entries()) {
    const store = new SqliteMemoryStore({filename:join(directory,'companion.sqlite'), retention:CONFIRMED_RETENTION, invitations:confirmedInvitationPolicy('Asia/Shanghai')});
    const memory = new SqliteMemoryPort(store, {inputTokenBudget:4000,maxRecentMessages:12,maxMemories:8,summaryLimit:4,countTokens:()=>1,relevance:()=>1});
    const ui = await app(), outgoing: BackendToDesktop[] = [], mediaStore = new MemoryMediaStore();
    const session = new BackendSession({memory,companionProfile:store,mediaStore,
      perception:{perceive:forbidden},dialogue:{reply:forbidden},tts:{synthesize:forbidden}}, message=>outgoing.push(message),()=>{});
    try {
      const ready = outgoing[0]; assert.ok(ready?.channel==='backend_ready');
      assert.equal(Boolean(ready.introduction),cycle<2);
      ui.changed(1); await ui.bridge.receive(JSON.parse(JSON.stringify(ready)),1);
      ui.frame(); ui.frame(); assert.equal(ui.wire().length,0,'hidden drawer never consumes opening');
      if (display) {
        ui.node('open').onclick();ui.frame();assert.equal(ui.wire().length,0);
        ui.frame();const messages=ui.wire();assert.equal(messages.length,1);
        assert.equal(messages[0].value.message.command.type,'acknowledge_introduction');
        await session.receiveLine(JSON.stringify(messages[0].value.message));
        assert.equal(store.introduction(),null);
        assert.ok(ui.node('introduction').textContent.includes(ready.introduction!.text));
      }
      const scope={characterId:'companion',sessionId:ready.sessionId,turnId:'inspection',generation:1};
      assert.deepEqual(store.visible(scope,'transcript'),[]);assert.deepEqual(store.visible(scope,'memory'),[]);
      assert.equal(store.revision(scope),0);assert.equal(store.transcriptBytes(),0);
      const context=await memory.context(scope,'你好',null,new AbortController().signal);
      assert.deepEqual(context.recent,[]);assert.equal(context.summary,'');assert.deepEqual(context.memories,[]);
      assert.equal(ui.node('reply').children.filter((node:{className?:string})=>node.className?.includes('chat-row')).length,0);
      assert.equal(ui.harness.captureOpens,0);assert.equal(ui.harness.playback,undefined);assert.equal(mediaStore.count,0);
      t.diagnostic(JSON.stringify({cycle,offered:Boolean(ready.introduction),displayed:display,acknowledged:store.introduction()===null,records:0}));
    } finally {ui.changed(1,'disconnected');await session.close();store.close();}
  }
  assert.equal(forbiddenCalls,0);
});
