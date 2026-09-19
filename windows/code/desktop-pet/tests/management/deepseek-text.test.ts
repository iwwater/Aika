import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.js';
import { defaultManagedSettings, availableAdapters, validateManagedSettings, effectiveTrialConfiguration } from '../../management/settings.js';
import { ManagementSettingsStore } from '../../management/settings-store.js';
import { deepseekFlashModel, TEXT_SLOTS } from '../../providers/text-protocol.js';
import { JsonDialogueProvider } from '../../providers/qwen-dialogue.js';
import { JsonSummaryProvider } from '../../providers/qwen-memory-lifecycle.js';
import { TrialAdmission } from '../../app/trial-admission.js';
import { TrialTransport } from '../../app/trial-backend.js';
import { estimateTrialMicros } from '../../app/trial-authorizer.js';
import type { DialogueContext } from '../../contracts/index.js';

const scope = { characterId: 'companion' as const, sessionId: 'synthetic', turnId: 'text', generation: 1 };
const context: DialogueContext = { scope, characterPrompt: 'Synthetic persona preserved exactly.', recent: [], summary: '', memories: [], perception: null, inputTokenBudget: 32768 };
function nextBase(base: Awaited<ReturnType<typeof fixture>>['c']) {
  return { ...base, models: { ...base.models, ...Object.fromEntries(TEXT_SLOTS.map(slot => [slot, deepseekFlashModel(base.models.memory_turn.credentialFile)])) } };
}
test('DeepSeek-only current catalog preserves old settings history but forbids restoring Qwen text', async t => {
  const f = await fixture(t), base = nextBase(f.c), old = defaultManagedSettings(f.c), next = defaultManagedSettings(base);
  const file = join(f.c.projectRoot, 'deepseek-settings.json');
  await writeFile(file, JSON.stringify({version:1,current:{revision:2,savedAt:'now',settings:next},history:[{revision:1,savedAt:'old',settings:old}]}));
  const store = await ManagementSettingsStore.open(file, base);
  assert.equal(store.snapshot().history.length, 1);
  await assert.rejects(store.rollback(2,1), {code:'invalid_request'});
  for (const slot of TEXT_SLOTS) {
    const adapters = availableAdapters(base).filter(a=>a.slots.includes(slot));
    assert.equal(adapters.length,1); assert.equal(adapters[0]!.provider,'deepseek');
    assert.deepEqual(adapters[0]!.models,['deepseek-flash']);
    assert.equal(next.providers[slot].adapterId,`deepseek-${slot}`);
  }
  const effective = effectiveTrialConfiguration(base,next);
  for (const slot of ['memory_turn','perception','tts'] as const) assert.deepEqual(effective.models[slot],f.c.models[slot]);
  for (const mutate of [
    (v:typeof next)=>{v.providers.dialogue.credentialRef=old.providers.dialogue.credentialRef;},
    (v:typeof next)=>{v.providers.dialogue.inputMicrosPerToken=.8;},
    (v:typeof next)=>{v.providers.summary.model='deepseek-v4-pro';},
    (v:typeof next)=>{v.providers.admission.outputTokenLimit=393217;},
  ]) {const v=structuredClone(next);mutate(v);assert.throws(()=>validateManagedSettings(v,base));}
  assert.equal(estimateTrialMicros(base.models.dialogue,'dialogue',{status:'success',requestId:null,usage:{prompt_tokens:100,completion_tokens:20,prompt_cache_hit_tokens:90}}),360);
});

test('all three actual text paths send DeepSeek JSON dialect and return validated scoped results', async t => {
  const f = await fixture(t), base=nextBase(f.c), calls:Record<string,unknown>[]=[];
  let reply:unknown={text:'准备好了。',expression:{emotion:'neutral',intensity:.5,delivery:'自然',gesture:null}};
  const transport = new TrialTransport(base,async(url,init)=>{
    assert.equal(url,'https://api.deepseek.com/chat/completions');
    const body=JSON.parse(String(init?.body)); calls.push(body);
    assert.equal(body.model,'deepseek-flash');assert.deepEqual(body.thinking,{type:'disabled'});
    assert.equal('enable_thinking' in body,false);assert.deepEqual(body.response_format,{type:'json_object'});
    assert.equal(body.max_tokens,393216);assert.match(body.messages[0].content,/JSON/);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify(reply)}}]});
  });
  const endpoint={model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}};
  const dialogue=await new JsonDialogueProvider(endpoint,transport).reply({scope,text:'合成检查',context},new AbortController().signal);
  assert.equal(dialogue.text,'准备好了。');assert.deepEqual(dialogue.scope,scope);
  assert.ok(JSON.stringify(calls[0]).includes(context.characterPrompt));
  reply={text:'合成摘要',sourceVersions:[{id:'s0',version:1}]};
  const summary=await new JsonSummaryProvider(endpoint,transport).summarize({scope,sources:[{id:'source',kind:'transcript',scope,version:1,text:'合成原文',messageRole:'user',createdAt:'2026-09-12T00:00:00Z',evidenceEligible:true,sourceVersions:[]}]},new AbortController().signal);
  assert.equal(summary.sourceVersions[0]!.id,'source');
  reply={scope,decision:'independent',reason:'Self-contained synthetic request'};
  const admission=new TrialAdmission(endpoint,transport,async()=>context);
  const pending={snapshot:{characterId:'companion' as const,queued:0,running:0,revision:0},assertCurrent(){}};
  assert.equal(await admission.isIndependent(scope,'合成问题',new AbortController().signal,pending),true);
  reply={scope:{...scope,generation:2},decision:'independent',reason:'stale'};
  assert.equal(await admission.isIndependent(scope,'合成问题',new AbortController().signal,pending),false);
  assert.equal(calls.length,4);
});

test('empty, truncated and cancelled DeepSeek replies fail without fallback or retry', async t => {
  const f=await fixture(t),base=nextBase(f.c);
  for(const [content,finish_reason] of [['','stop'],['{}','length']]) {
    let calls=0;
    const transport=new TrialTransport(base,async()=>{calls++;return Response.json({choices:[{finish_reason,message:{content}}]});});
    const p=new JsonDialogueProvider({model:'deepseek-flash',endpoint:'https://api.deepseek.com/chat/completions',apiKey:()=> 'synthetic',authorizer:{async authorize(){return {async settle(){}};}}},transport);
    await assert.rejects(p.reply({scope,text:'合成',context},new AbortController().signal));assert.equal(calls,1);
    await assert.rejects(p.reply({scope,text:'合成',context},AbortSignal.abort()));assert.equal(calls,1);
  }
});
