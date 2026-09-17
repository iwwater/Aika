import test from 'node:test';import assert from 'node:assert/strict';
import {selectDialogueThinking,dialogueJsonProtocol} from '../../providers/dialogue-thinking.js';
import {DEEPSEEK_ENDPOINT,DEEPSEEK_FLASH_MODEL,textJsonProtocol} from '../../providers/text-protocol.js';
import {JsonDialogueProvider} from '../../providers/qwen-dialogue.js';
import {ProviderTransport,denyPaidCalls} from '../../providers/transport.js';
const config={endpoint:DEEPSEEK_ENDPOINT,model:DEEPSEEK_FLASH_MODEL,apiKey:()=>'',authorizer:denyPaidCalls};
test('local difficulty policy keeps daily chat fast and enables bounded structured reasoning',()=>{
 for(const text of ['晚上好','这两个就是你的名字！','我今天很难过。'.repeat(80),'明天吃什么好？','算一下2+2','这证明你还记得我','今天去开了个在读证明','我不想分析，只想聊聊'])assert.equal(selectDialogueThinking(text),false,text);
 for(const text of ['证明根号2是无理数','请分析计划：1.预算有限；2.三天内完成；3.比较两条路线','Solve x+2=7 and explain each step.'])assert.equal(selectDialogueThinking(text),true,text);
 const previous={characterId:'companion' as const,id:'prior',role:'user' as const,text:'证明根号2是无理数',createdAt:'2026-09-16T00:00:00Z'};
 assert.equal(selectDialogueThinking('那根号3呢？',[previous]),true);assert.equal(selectDialogueThinking('晚安',[previous]),false);
 assert.equal(selectDialogueThinking('那根号3呢？',[{...previous,origin:'manual'}]),false);
 assert.deepEqual(dialogueJsonProtocol(config,'晚上好',[]),textJsonProtocol(config));
 assert.deepEqual(dialogueJsonProtocol(config,'证明根号2是无理数',[]),{stream:false,thinking:{type:'enabled'},reasoning_effort:'high',response_format:{type:'json_object'}});
 assert.equal(textJsonProtocol(config).thinking&&JSON.stringify(textJsonProtocol(config).thinking),'{"type":"disabled"}');
 const qwen={...config,endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',model:'qwen'};
 assert.deepEqual(dialogueJsonProtocol(qwen,'证明根号2是无理数',[]),textJsonProtocol(qwen));
});
test('actual dialogue wire selects thinking without a classifier and returns only final content',async()=>{
 const scope={characterId:'companion' as const,sessionId:'synthetic',turnId:'one',generation:1},requests:Record<string,unknown>[]=[];
 const transport=new ProviderTransport(async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'这是最后的答复。',expression:{emotion:'neutral',intensity:0,delivery:'natural',gesture:null}}),reasoning_content:'PRIVATE_REASONING_MUST_NOT_ESCAPE'}}]}),{status:200});});
 const allow={async authorize(){return {async settle(){}};}};
 const provider=new JsonDialogueProvider({...config,apiKey:()=> 'synthetic-not-a-real-key',authorizer:allow},transport);
 const context={scope,characterPrompt:'synthetic companion',recent:[],summary:'',memories:[],perception:null,inputTokenBudget:32768};
 for(const text of ['你好','证明根号2是无理数']){const reply=await provider.reply({scope,text,context},new AbortController().signal);assert.equal(reply.text,'这是最后的答复。');assert.ok(!JSON.stringify(reply).includes('PRIVATE_REASONING'));}
 assert.equal(requests.length,2);assert.deepEqual(requests.map(r=>r.thinking),[{type:'disabled'},{type:'enabled'}]);
 assert.ok(requests.every(r=>!('tools' in r)&&!('enable_thinking' in r)&&!JSON.stringify(r).includes('PRIVATE_REASONING')));
});
