import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration, validateTrialConfiguration, type TrialConfiguration, type TrialModel, type TrialOperation } from '../../app/trial-config.js';
import { TrialAuthorizer, estimateTrialMicros, assertReviewedUnknownCosts } from '../../app/trial-authorizer.js';
import { prepareTrialLaunch, trialFiles } from '../../app/trial-launcher.js';
import { TrialTransport } from '../../app/trial-backend.js';

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const scope = { characterId: 'friend' as const, sessionId: 'session', turnId: 'turn', generation: 1 };
async function fixture(t: { after(fn: () => Promise<void>): void }, smoke = false) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/companion-step1-01/tmp');
  await mkdir(parent, { recursive: true });
  const projectRoot = await mkdtemp(join(parent, 'trial-config-')); t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const chat: TrialModel = { provider: 'dashscope', model: 'qwen-plus-2025-12-01', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    credentialFile: '/nonexistent-external-trial-key', reservationMicros: 100000, inputTokenLimit: 32768, outputTokenLimit: 32768, inputMicrosPerToken: .8, outputMicrosPerToken: 2 };
  const memory: TrialModel = { ...chat, provider: 'deepseek', model: 'deepseek-v4-pro', endpoint: 'https://api.deepseek.com/chat/completions',
    reservationMicros: 11000000, inputMicrosPerToken: 9, outputMicrosPerToken: 27, outputTokenLimit: 393216, thinking: 'high' };
  const c: TrialConfiguration = { version: 1, product: 'companion-v1', phaseId: 'local-trial-controlled', purpose: smoke ? 'smoke-text' : 'user-trial', ...(smoke ? {smokeInput:'合成文字'} : {}), projectRoot, sourceRevision: 'a'.repeat(40),
    runtimeFiles: Object.fromEntries(['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
      'desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'].map(p => [`code/desktop-pet/${p}`, hash('controlled')])),
    database: join(projectRoot, '.local/data/companion.sqlite'), budgetFile: join(projectRoot, '.local/model-evaluation/budget.json'),
    budgetBatchId: 'original-fixture-batch', limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
    operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: smoke ? 0 : 20, tts: 40 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: chat, admission: chat, summary: chat, memory_turn: memory,
      perception: { ...chat, model: 'qwen3.5-omni-flash-2026-03-15', inputTokenLimit: 196608, outputTokenLimit: 65536,
        inputMicrosPerToken: 18, outputMicrosPerToken: 13.3, reservationMicros: 4500000 },
      tts: { ...chat, model: 'qwen3-tts-instruct-flash-2026-01-26', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', characterMicros: 80 } } };
  const configFile = join(projectRoot, 'config.json'), activationFile = join(projectRoot, 'activation.json'), raw = JSON.stringify(c);
  await writeFile(configFile, raw); const activate = async (status = 'active') => writeFile(activationFile, JSON.stringify({ version: 1, phaseId: c.phaseId, status, configSha256: hash(raw) }));
  const historical = { operationId: 'historical-settled', model: 'prior', reservedMicros: 2000000, actualMicros: 1615338, status: 'settled' };
  await mkdir(dirname(c.budgetFile), { recursive: true }); await writeFile(c.budgetFile, JSON.stringify({ batchId: c.budgetBatchId, currency: 'CNY', limitMicros: 20000000, blocked: false, entries: [historical] }));
  await activate();
  return { c, configFile, activationFile, activate, historical, authorizer: new TrialAuthorizer(c, configFile, activationFile) };
}

test('inactive, tampered and incomplete real trial configurations fail before resource access', async t => {
  const f = await fixture(t); assert.equal((await readActiveTrialConfiguration(f.configFile, f.activationFile)).phaseId, f.c.phaseId);
  await f.activate('prepared'); await assert.rejects(readActiveTrialConfiguration(f.configFile, f.activationFile), /尚未启用/);
  await f.activate(); await writeFile(f.configFile, JSON.stringify({ ...f.c, maxCalls: 201 }));
  await assert.rejects(readActiveTrialConfiguration(f.configFile, f.activationFile), /已变化/);
  assert.throws(() => validateTrialConfiguration({ ...f.c, limitMicros: 10000000 }), /记账模式与共享账目配置/);
  assert.throws(() => validateTrialConfiguration({ ...f.c, memory: { mode: 'legacy' } }), /不能回退/);
  assert.throws(() => validateTrialConfiguration({ ...f.c, models: { ...f.c.models, memory_turn: { ...f.c.models.memory_turn, reservationMicros: 1000000 } } }), /最坏费用/);
});

test('trial reservations preserve previous spending and serialize simultaneous calls against the shared ceiling', async t => {
  const f = await fixture(t), m = f.c.models.memory_turn, request = { scope, operation: 'memory_turn' as const, model: m.model, endpoint: m.endpoint };
  const outcomes = await Promise.allSettled([f.authorizer.authorize(request, new AbortController().signal), f.authorizer.authorize(request, new AbortController().signal)]);
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1); assert.equal(outcomes.filter(r => r.status === 'rejected').length, 1);
  const permit = outcomes.find(r => r.status === 'fulfilled'); assert.ok(permit?.status === 'fulfilled');
  await permit.value.settle({ status: 'success', usage: { prompt_tokens: 2171, completion_tokens: 17714, completion_tokens_details: { reasoning_tokens: 17176 } }, requestId: null });
  const ledger = JSON.parse(await readFile(f.c.budgetFile, 'utf8'));
  assert.deepEqual(ledger.entries[0], f.historical); assert.equal(ledger.entries.length, 2); assert.equal(ledger.entries[1].actualMicros, 497817);
});

test('smoke unknown costs stop subsequent calls, rejected configuration never appends a reservation, and missing ledger is not reset', async t => {
  const f = await fixture(t, true), m = f.c.models.admission, request = { scope, operation: 'admission' as const, model: m.model, endpoint: m.endpoint };
  const before = await readFile(f.c.budgetFile, 'utf8');
  await assert.rejects(f.authorizer.authorize({ ...request, operation: 'memory_maintenance' }, new AbortController().signal), /Legacy/);
  assert.equal(await readFile(f.c.budgetFile, 'utf8'), before);
  const permit = await f.authorizer.authorize(request, new AbortController().signal);
  await permit.settle({ status: 'cancelled', usage: null, requestId: null });
  await assert.rejects(f.authorizer.authorize(request, new AbortController().signal), /stopped/);
  const unknown = await readFile(f.c.budgetFile, 'utf8'); await f.activate('stopped');
  await assert.rejects(f.authorizer.authorize(request, new AbortController().signal), /stopped/); assert.equal(await readFile(f.c.budgetFile, 'utf8'), unknown);
  await f.activate(); await rm(f.c.budgetFile);
  const restarted = new TrialAuthorizer(f.c, f.configFile, f.activationFile);
  await assert.rejects(restarted.authorize(request, new AbortController().signal), /ENOENT/);
  await assert.rejects(readFile(f.c.budgetFile), /ENOENT/);
});

test('only the pinned reviewed unknown reservation survives restart; changed audit or a new unknown still stops before reserve', async t => {
  const f = await fixture(t, true);
  const entry = { operationId: 'W0-I:B-DANIA-MINIMAX-AUDITION-01:clone-demo', model: 'MiniMax/speech-2.8-hd', reservedMicros: 19600, actualMicros: null, status: 'unknown' };
  const auditFile = join(f.c.projectRoot, '.local/minimax-default-01/budget-bound/audit.json');
  const audit = JSON.stringify({ kind: 'unknown_reservation_upper_bound_correction', status: 'applied', actualChargeStillUnknown: true, correctedEntry: entry });
  await mkdir(dirname(auditFile), { recursive: true }); await writeFile(auditFile, audit);
  const c = validateTrialConfiguration({ ...f.c, reviewedUnknownCosts: [{ operationId: entry.operationId, model: entry.model,
    reservedMicros: entry.reservedMicros, auditFile, auditSha256: hash(audit) }] });
  const raw = JSON.stringify(c); await writeFile(f.configFile, raw);
  await writeFile(f.activationFile, JSON.stringify({ version: 1, phaseId: c.phaseId, status: 'active', configSha256: hash(raw) }));
  const state = JSON.parse(await readFile(c.budgetFile, 'utf8')); state.entries.push(entry); await writeFile(c.budgetFile, JSON.stringify(state));
  const request = { scope, operation: 'admission' as const, ...c.models.admission };
  const authorizer = new TrialAuthorizer(c, f.configFile, f.activationFile);
  const permit = await authorizer.authorize(request, new AbortController().signal);
  await permit.settle({ status: 'success', usage: { prompt_tokens: 1, completion_tokens: 1 }, requestId: null });
  const valid = await readFile(c.budgetFile, 'utf8'); assert.deepEqual(JSON.parse(valid).entries[1], entry);
  await writeFile(auditFile, audit + ' ');
  await assert.rejects(authorizer.authorize(request, new AbortController().signal), /review changed/);
  assert.equal(await readFile(c.budgetFile, 'utf8'), valid); await writeFile(auditFile, audit);
  const changed = JSON.parse(valid); changed.entries.push({ ...entry, operationId: 'new-unknown', reservedMicros: 100 });
  await writeFile(c.budgetFile, JSON.stringify(changed));
  await assert.rejects(authorizer.authorize(request, new AbortController().signal), /unknown-cost/);
  assert.equal(JSON.parse(await readFile(c.budgetFile, 'utf8')).entries.length, 4);
  assert.throws(() => validateTrialConfiguration({ ...c, reviewedUnknownCosts: [{ ...c.reviewedUnknownCosts![0], reservedMicros: 1 }] }), /单笔/);
});

test('reported costs reject malformed or overflowing usage and charge TTS per actual billed character', async t => {
  const f = await fixture(t);
  const outcome = (usage: unknown) => ({ status: 'success' as const, usage, requestId: null });
  assert.equal(estimateTrialMicros(f.c.models.tts, 'tts', outcome({ characters: 1200 })), 96000);
  for (const operation of ['dialogue', 'admission', 'summary'] as const) {
    assert.equal(estimateTrialMicros(f.c.models[operation], operation, outcome({ prompt_tokens: -1, completion_tokens: 1 })), null);
    assert.equal(estimateTrialMicros(f.c.models[operation], operation, outcome({ prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: Number.MAX_SAFE_INTEGER })), null);
  }
});

test('launch plan supplies the real native arguments and refuses changed build bytes before a process starts', async t => {
  const f = await fixture(t), paths = trialFiles(f.c.projectRoot);
  const priorDirectory = join(f.c.projectRoot, '.local/model-evaluation/trial');
  const priorConfig = join(priorDirectory, 'config.json'), priorActivation = join(priorDirectory, 'activation.json');
  await mkdir(priorDirectory, { recursive: true });
  await writeFile(priorConfig, 'frozen-smoke-config'); await writeFile(priorActivation, 'frozen-smoke-activation');
  assert.equal(paths.configFile, join(priorDirectory, 'user-trial/config.json'));
  for (const name of Object.keys(f.c.runtimeFiles)) { const path = join(f.c.projectRoot, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, 'controlled'); }
  await mkdir(dirname(paths.configFile), { recursive: true });
  await writeFile(paths.configFile, await readFile(f.configFile)); await writeFile(paths.activationFile, await readFile(f.activationFile));
  const plan = await prepareTrialLaunch(f.c.projectRoot, '/controlled/node');
  assert.equal(plan.version, f.c.sourceRevision); assert.equal(plan.arguments[0], '--root');
  assert.ok(plan.arguments.includes(join(f.c.projectRoot, 'code/desktop-pet/dist/app/trial-backend.js')));
  assert.ok(!plan.arguments.includes('backend.js')); assert.equal(plan.environment.PET_TRIAL_CONFIG, paths.configFile);
  assert.equal(await readFile(priorConfig, 'utf8'), 'frozen-smoke-config');
  assert.equal(await readFile(priorActivation, 'utf8'), 'frozen-smoke-activation');
  await writeFile(join(f.c.projectRoot, 'code/desktop-pet/dist/app/trial-backend.js'), 'changed');
  await assert.rejects(prepareTrialLaunch(f.c.projectRoot, '/controlled/node'), /程序文件/);
});

test('request bounds reject oversized TTS instructions before a key or network can be accessed', async t => {
  const f = await fixture(t); let keys = 0, calls = 0;
  const transport = new TrialTransport(f.c, async () => { calls++; throw new Error('Unexpected network'); });
  const endpoint = { ...f.c.models.tts, apiKey: () => { keys++; return 'controlled-key'; }, authorizer: f.authorizer };
  await assert.rejects(transport.request(endpoint, scope, 'tts', { input: { text: '你好', instructions: 'a'.repeat(1601) } }, new AbortController().signal, 4), /bounds/);
  await assert.rejects(transport.request(endpoint, scope, 'tts', { input: { text: '你好', instructions: '自然' } }, new AbortController().signal, 2), /bounds/);
  assert.equal(keys, 0); assert.equal(calls, 0);
});

test('the smoke phase stops after its first failed known-cost call and enforces zero-operation quotas', async t => {
  const f = await fixture(t);
  const c = { ...f.c, purpose: 'smoke-text' as const, smokeInput: '合成文字', operationLimits: { ...f.c.operationLimits, perception: 0 } };
  const raw = JSON.stringify(c); await writeFile(f.configFile, raw);
  await writeFile(f.activationFile, JSON.stringify({ version: 1, phaseId: c.phaseId, status: 'active', configSha256: hash(raw) }));
  const authorizer = new TrialAuthorizer(c, f.configFile, f.activationFile), p = c.models.perception;
  await assert.rejects(authorizer.authorize({ scope, operation: 'perception', model: p.model, endpoint: p.endpoint }, new AbortController().signal), /call limit/);
  const m = c.models.admission, request = { scope, operation: 'admission' as const, model: m.model, endpoint: m.endpoint };
  const permit = await authorizer.authorize(request, new AbortController().signal);
  await permit.settle({ status: 'failed', usage: { prompt_tokens: 1, completion_tokens: 0 }, requestId: null });
  assert.equal(JSON.parse(await readFile(f.activationFile, 'utf8')).status, 'stopped');
  await assert.rejects(authorizer.authorize(request, new AbortController().signal), /stopped/);
});


test('reviewed trial memory unknown costs survive restart beyond three entries without losing bound or tamper guards', async t => {
  const f=await fixture(t), m=f.c.models.memory_turn;
  const entries=[], reviews:NonNullable<TrialConfiguration['reviewedUnknownCosts']>[number][]=[];
  const bounds={inputTokenLimit:m.inputTokenLimit,outputTokenLimit:m.outputTokenLimit,inputMicrosPerToken:m.inputMicrosPerToken,outputMicrosPerToken:m.outputMicrosPerToken};
  for(let i=1;i<=4;i++){
    const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
    const entry={operationId:`W0-I:${f.c.phaseId}:memory_turn:${id}`,model:m.model,reservedMicros:m.reservationMicros,actualMicros:null,status:'unknown' as const};
    const auditFile=join(f.c.projectRoot,`.local/model-evaluation/unknown-cost-reviews/${id}.json`);
    const audit=JSON.stringify({kind:'unknown_trial_reservation_upper_bound_review',status:'applied',actualChargeStillUnknown:true,phaseId:f.c.phaseId,originalEntry:entry,correctedEntry:entry,bounds,maximumMicros:10911744});
    await mkdir(dirname(auditFile),{recursive:true});await writeFile(auditFile,audit);
    entries.push(entry);reviews.push({operationId:entry.operationId,model:entry.model,reservedMicros:entry.reservedMicros,auditFile,auditSha256:hash(audit)});
  }
  const c=validateTrialConfiguration({...f.c,limitMicros:60000000,phaseLimitMicros:60000000,reviewedUnknownCosts:reviews});
  await assertReviewedUnknownCosts(entries,c);
  for(const patch of [{model:'foreign-model'},{reservedMicros:1},{operationId:reviews[0]!.operationId.replace(c.phaseId,'local-trial-other')},{auditFile:join(c.projectRoot,'outside.json')},{auditSha256:'bad'}])
    assert.throws(()=>validateTrialConfiguration({...c,reviewedUnknownCosts:[{...reviews[0],...patch}]}));
  const review=reviews[0]!,original=await readFile(review.auditFile,'utf8');await writeFile(review.auditFile,original+' ');
  await assert.rejects(assertReviewedUnknownCosts(entries,c),/review changed/);await writeFile(review.auditFile,original);
  for(const patch of [{phaseId:'local-trial-other'},{bounds:{...bounds,outputTokenLimit:1}},{maximumMicros:1},{originalEntry:{...entries[0],actualMicros:0}},{kind:'unknown_reservation_upper_bound_correction'}]){
    const raw=JSON.stringify({...JSON.parse(original),...patch});await writeFile(review.auditFile,raw);
    await assert.rejects(assertReviewedUnknownCosts(entries,{...c,reviewedUnknownCosts:[{...review,auditSha256:hash(raw)},...reviews.slice(1)]}),/upper-bound/);
  }
  await writeFile(review.auditFile,original);
  await assert.rejects(assertReviewedUnknownCosts([...entries,{...entries[0]!,operationId:'unreviewed'}],c),/unknown-cost/);
  const ledger={batchId:c.budgetBatchId,currency:'CNY',limitMicros:60000000,blocked:false,entries:[f.historical,...entries]};await writeFile(c.budgetFile,JSON.stringify(ledger));
  const raw=JSON.stringify(c);await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:c.phaseId,status:'active',configSha256:hash(raw)}));
  const authorizer=new TrialAuthorizer(c,f.configFile,f.activationFile);
  await assert.rejects(authorizer.authorize({scope,operation:'memory_turn',model:m.model,endpoint:m.endpoint},new AbortController().signal),/Background reservation would block foreground/);
  const front=c.models.admission,permit=await authorizer.authorize({scope,operation:'admission',model:front.model,endpoint:front.endpoint},new AbortController().signal);
  await permit.settle({status:'success',usage:{prompt_tokens:1,completion_tokens:1},requestId:null});
  assert.deepEqual(JSON.parse(await readFile(c.budgetFile,'utf8')).entries.slice(0,5),ledger.entries);
});


test('daily use ignores legacy quotas and keeps bounded unknown costs without disabling the next user request', async t=>{
 const f=await fixture(t),zero=Object.fromEntries(Object.keys(f.c.operationLimits).map(k=>[k,0])) as TrialConfiguration['operationLimits'];
 const c=validateTrialConfiguration({...f.c,limitMicros:60000000,phaseLimitMicros:1,maxCalls:0,operationLimits:zero});
 const raw=JSON.stringify(c);await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:c.phaseId,status:'active',configSha256:hash(raw)}));
 const unknown={operationId:`W0-I:${c.phaseId}:memory_turn:prior-unmetered`,model:c.models.memory_turn.model,reservedMicros:11000000,actualMicros:null,status:'unknown'};
 const prior={...f.historical,operationId:`W0-I:${c.phaseId}:perception:prior`,reservedMicros:22000000,actualMicros:22000000};
 await writeFile(c.budgetFile,JSON.stringify({batchId:c.budgetBatchId,currency:'CNY',limitMicros:60000000,blocked:false,entries:[prior,unknown]}));
 const authorizer=new TrialAuthorizer(c,f.configFile,f.activationFile),m=c.models.admission,request={scope,operation:'admission' as const,model:m.model,endpoint:m.endpoint};
 const first=await authorizer.authorize(request,new AbortController().signal);await first.settle({status:'failed',usage:null,requestId:null});
 assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'active');
 const second=await authorizer.authorize(request,new AbortController().signal);await second.settle({status:'success',usage:{prompt_tokens:1,completion_tokens:1},requestId:null});
 const entries=JSON.parse(await readFile(c.budgetFile,'utf8')).entries;assert.deepEqual(entries.slice(0,2),[prior,unknown]);assert.equal(entries[2].status,'unknown');assert.equal(entries[2].reservedMicros,m.reservationMicros);
 const spent={batchId:c.budgetBatchId,currency:'CNY',limitMicros:60000000,blocked:false,entries:[{...prior,reservedMicros:49000000,actualMicros:49000000},unknown]};await writeFile(c.budgetFile,JSON.stringify(spent));
 await assert.rejects(authorizer.authorize(request,new AbortController().signal),/budget exhausted/);assert.deepEqual(JSON.parse(await readFile(c.budgetFile,'utf8')),spent);
});

test('independent ASR proves WAV duration, preserves unknown reservations, and exposes a separate runtime counter', async t => {
  const f=await fixture(t);
  const {pcm16Wav}=await import('../../media/wav.js');
  const {MemoryMediaStore}=await import('../../media/store.js');
  const {QwenAsrProvider}=await import('../../providers/qwen-asr.js');
  const {ManagementRuntime}=await import('../../management/runtime.js');
  const {defaultManagedSettings,validateManagedSettings}=await import('../../management/settings.js');
  const tool=await import(resolve(dirname(fileURLToPath(import.meta.url)),'../../../tools/voice-pipeline-update.mjs'));
  const c:TrialConfiguration=tool.nextVoiceConfiguration(f.c);
  assert.equal(c.operationLimits,undefined); assert.equal(c.maxCalls,undefined); assert.equal(c.phaseLimitMicros,undefined);
  const settings=defaultManagedSettings(c); validateManagedSettings(settings,c);
  assert.equal(settings.providers.asr?.adapterId,'qwen-asr');assert.equal(settings.providers.perception.adapterId,'qwen-visual-emotion');
  const withoutAsr=structuredClone(settings);delete (withoutAsr.providers as {asr?:unknown}).asr;
  assert.throws(()=>validateManagedSettings(withoutAsr,c));
  const previous={version:1,current:{revision:5,savedAt:'before',settings:defaultManagedSettings(f.c)},history:[]};
  const migrated=tool.nextVoiceSettings(previous,c,'after');
  assert.deepEqual(migrated.history,[previous.current]);
  for(const slot of ['dialogue','memory_turn','summary','admission','tts'] as const)assert.deepEqual(migrated.current.settings.providers[slot],previous.current.settings.providers[slot]);
  validateManagedSettings(migrated.current.settings,c);validateManagedSettings(previous.current.settings,c,undefined,true);
  const runtime=new ManagementRuntime(c.sourceRevision),store=new MemoryMediaStore();
  const authorizer=new TrialAuthorizer(c,f.configFile,f.activationFile,f.c),model=c.models.asr!;
  let calls=0,keys=0;
  const transport=new TrialTransport(c,async(_url,init)=>{calls++;const body=JSON.parse(String(init?.body));
    assert.equal(body.asr_options.enable_itn,false);assert.equal(body.messages.length,1);
    return Response.json({choices:[{finish_reason:'stop',message:{content:'Hello，今天 meeting。'}}]});},runtime);
  const endpoint={model:model.model,endpoint:model.endpoint,apiKey:()=>{keys++;return 'synthetic-key';},authorizer};
  const audio=await store.put(scope,pcm16Wav(new Float32Array(16001),16000),'audio/wav');
  const provider=new QwenAsrProvider(endpoint,store,transport);
  const result=await provider.transcribe({scope,audio},new AbortController().signal);assert.equal(result.transcript,'Hello，今天 meeting。');
  const ledger=JSON.parse(await readFile(c.budgetFile,'utf8'));assert.deepEqual(ledger.entries[0],f.historical);
  assert.equal(ledger.entries.at(-1).reservedMicros,440);assert.equal(ledger.entries.at(-1).status,'unknown');
  await provider.transcribe({scope,audio},new AbortController().signal);assert.equal(calls,2);
  const modules=runtime.modules();assert.equal(modules.find(m=>m.id==='asr')?.calls,2);assert.equal(modules.find(m=>m.id==='perception')?.calls,0);
  const data='data:audio/wav;base64,'+Buffer.from(await store.read(scope,audio)).toString('base64');
  await assert.rejects(transport.request(endpoint,scope,'asr',{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data}}]}]},new AbortController().signal,undefined,0.1),/duration mismatch/);
  assert.equal(calls,2);assert.equal(keys,2);
  await assert.rejects(transport.request({...endpoint,...c.models.perception},scope,'perception',{messages:[{role:'user',content:[{type:'input_audio',input_audio:{data}}]}]},new AbortController().signal),/Visual request/);
  assert.equal(calls,2);await store.releaseScope(scope);
});

test('MiniMax request guard rejects explicit emotion before authorization, key access or HTTP', async t => {
  const f = await fixture(t); let accesses = 0;
  for (const model of ['MiniMax/speech-2.8-turbo', 'MiniMax/speech-2.8-hd']) {
    const selection = { ...f.c.models.tts, model, endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' };
    const config = { ...f.c, models: { ...f.c.models, tts: selection } };
    const transport = new TrialTransport(config, async () => { accesses++; throw Error('Unexpected HTTP'); });
    const endpoint = { ...selection, apiKey: () => { accesses++; return 'synthetic'; }, authorizer: {
      async authorize() { accesses++; throw Error('Unexpected authorization'); }
    } };
    for (const emotion of ['happy', 'surprised', 'calm']) {
      await assert.rejects(transport.request(endpoint, scope, 'tts', { input: {
        text: 'A', voice_setting: { voice_id: 'synthetic', speed: 1, vol: 1, pitch: 0, emotion },
        audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 }, output_format: 'hex', language_boost: 'Chinese'
      } }, new AbortController().signal, 1), /reviewed bounds/);
    }
  }
  assert.equal(accesses, 0);
});
