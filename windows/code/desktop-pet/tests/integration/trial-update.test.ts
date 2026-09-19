import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile, stat, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const project=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const { inspectTrialUpdate, installTrialUpdate, assertTrialQuiescent }=await import(pathToFileURL(join(project,'tools/install-trial-update.mjs')).href);
const { prepareCompanionUpdate, freezeCompanionUpdate }=await import(pathToFileURL(join(project,'tools/prepare-companion-update.mjs')).href);
const { prepareTrialUpdate }=await import(pathToFileURL(join(project,'tools/prepare-trial-update.mjs')).href);
const quiet=async()=>{};
const {prepareTrialLaunch}=await import('../../app/trial-launcher.js');
async function fixture(t:{after(fn:()=>Promise<void>):void}) {
  const parent=resolve(project,'../../.local/panel-stability-01/tmp');await mkdir(parent,{recursive:true});
  const temp=await mkdtemp(join(parent,'update-'));t.after(()=>rm(temp,{recursive:true,force:true}));
  const root=join(temp,'root'),candidate=join(temp,'candidate');await mkdir(root);await mkdir(candidate);
  const chat={provider:'dashscope',model:'controlled',endpoint:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',credentialFile:'/nonexistent-external-key',reservationMicros:100000,inputTokenLimit:100,outputTokenLimit:100,inputMicrosPerToken:1,outputMicrosPerToken:1};
  const paths=['dist/app/trial-backend.js','dist/app/trial-launcher.js','desktop/build/renderer.js','desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'].map(p=>'code/desktop-pet/'+p);
  for(const where of [root,candidate])for(const name of paths){const path=join(where,name);await mkdir(dirname(path),{recursive:true});await writeFile(path,where===root?'old':'new');}
  const directory=join(root,'.local/model-evaluation/trial/user-trial');await mkdir(directory,{recursive:true});
  const c={version:1,projectRoot:root,phaseId:'local-trial-update-fixture',purpose:'user-trial',sourceRevision:'a'.repeat(40),runtimeFiles:Object.fromEntries(paths.map(p=>[p,hash('old')])),database:join(directory,'state.sqlite'),budgetFile:join(root,'.local/model-evaluation/budget.json'),budgetBatchId:'shared-original',limitMicros:20000000,phaseLimitMicros:20000000,maxCalls:6,operationLimits:{dialogue:1,admission:1,memory_turn:1,summary:1,perception:1,tts:1},memory:{mode:'strict',scheduling:'semantic-admission',timeoutMs:300000},models:{dialogue:chat,admission:chat,summary:chat,perception:chat,memory_turn:{...chat,provider:'deepseek',endpoint:'https://api.deepseek.com/chat/completions'},tts:{...chat,endpoint:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',characterMicros:80}}};
  const next={...c,sourceRevision:'b'.repeat(40),runtimeFiles:Object.fromEntries(paths.map(p=>[p,hash('new')]))};
  const configFile=join(directory,'config.json'),activationFile=join(directory,'activation.json'),nextFile=join(candidate,'next.json');
  const currentRaw=JSON.stringify(c),activationRaw=JSON.stringify({version:1,phaseId:c.phaseId,status:'active',configSha256:hash(currentRaw)}),nextRaw=JSON.stringify(next);
  await writeFile(configFile,currentRaw);await writeFile(activationFile,activationRaw);await writeFile(nextFile,nextRaw);
  const budgetRaw=JSON.stringify({batchId:c.budgetBatchId,limitMicros:20000000,blocked:false,entries:[{status:'settled',operationId:'old-paid',actualMicros:12}]});
  await writeFile(c.budgetFile,budgetRaw);await writeFile(c.database,'synthetic opaque user state');
  const plan={version:1,projectRoot:root,candidateRoot:candidate,nextConfigFile:nextFile,currentConfigSha256:hash(currentRaw),currentActivationSha256:hash(activationRaw),nextConfigSha256:hash(nextRaw),files:paths.map(path=>({path,before:hash('old'),after:hash('new')}))};
  return {root,candidate,c,next,plan,paths,configFile,activationFile,nextFile,currentRaw,activationRaw,budgetRaw};
}

for(const mode of ['success','changed-ledger','rollback'] as const)test(`unlimited accounting migration ${mode}: only policy fields may change`,async t=>{
 const f=await fixture(t),current={...f.c,product:'companion-v1',database:join(f.root,'.local/data/companion.sqlite')},raw=JSON.stringify(current);
 await mkdir(dirname(current.database),{recursive:true});await writeFile(current.database,'synthetic preserved personal data');await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:current.phaseId,status:'active',configSha256:hash(raw)}));
 const entries=[{operationId:'old-paid',model:'synthetic',reservedMicros:100,actualMicros:12,status:'settled'},{operationId:'old-unknown',model:'synthetic',reservedMicros:90000000,actualMicros:null,status:'unknown'}],ledger={batchId:current.budgetBatchId,currency:'CNY',limitMicros:20000000,blocked:false,entries},before=JSON.stringify(ledger);await writeFile(current.budgetFile,before);
 const review=await prepareTrialUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40),unlimitedAccounting:true});
 const next=JSON.parse(await readFile(review.plan.nextConfigFile,'utf8'));assert.equal(next.budgetMode,'unlimited');assert.equal(next.limitMicros,null);for(const key of ['phaseLimitMicros','maxCalls','operationLimits'])assert.equal(key in next,false);assert.deepEqual(next.models,current.models);
 if(mode==='changed-ledger'){await writeFile(current.budgetFile,JSON.stringify({...ledger,entries:[...entries,{operationId:'new-paid',model:'synthetic',reservedMicros:20,actualMicros:10,status:'settled'}]}));await assert.rejects(installTrialUpdate(review.plan,{quiescent:quiet}),/differs from review/);assert.equal(await readFile(f.configFile,'utf8'),raw);}
 else if(mode==='rollback'){await assert.rejects(installTrialUpdate(review.plan,{quiescent:async(c:any)=>{if(c.budgetMode==='unlimited')throw Error('controlled post-migration failure');}}),/controlled post-migration failure/);assert.equal(await readFile(current.budgetFile,'utf8'),before);assert.equal(await readFile(f.configFile,'utf8'),raw);}
 else{assert.equal((await installTrialUpdate(review.plan,{quiescent:quiet})).status,'installed_active');const after=JSON.parse(await readFile(current.budgetFile,'utf8'));assert.deepEqual(after,{...ledger,budgetMode:'unlimited',limitMicros:null});assert.equal((await prepareTrialLaunch(f.root,process.execPath)).version,'b'.repeat(40));assert.equal((await installTrialUpdate(review.plan,{quiescent:quiet})).status,'already_active');}
 assert.equal(await readFile(current.database,'utf8'),'synthetic preserved personal data');
});

test('ordinary companion update preparation and installation retain the exact existing new database and sidecars',async t=>{
  const f=await fixture(t),database=join(f.root,'.local/data/companion.sqlite');
  const current={...f.c,product:'companion-v1',database};
  const raw=JSON.stringify(current);await writeFile(f.configFile,raw);
  await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:current.phaseId,status:'active',configSha256:hash(raw)}));
  await mkdir(dirname(database),{recursive:true});
  for(const suffix of ['', '-wal', '-shm'])await writeFile(database+suffix,'existing new companion user data'+suffix);
  const before=await Promise.all(['','-wal','-shm'].map(s=>readFile(database+s)));
  const review=await prepareTrialUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40)});
  assert.equal(review.legacyRetirement,false);assert.equal('legacyData' in review.plan,false);assert.equal(review.databaseRead,false);
  const next=JSON.parse(await readFile(review.plan.nextConfigFile,'utf8'));
  const policy=(value:any)=>{const {sourceRevision,runtimeFiles,...rest}=value;return rest;};assert.deepEqual(policy(next),policy(current));
  assert.equal((await installTrialUpdate(review.plan,{quiescent:quiet})).status,'installed_active');
  assert.deepEqual(await Promise.all(['','-wal','-shm'].map(s=>readFile(database+s))),before);
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
  assert.equal(await readFile(f.c.database,'utf8'),'synthetic opaque user state','unrelated old-path fixture is untouched too');
  await assert.rejects(stat(join(f.root,'.local/companion-step1-01/update')),{code:'ENOENT'});
});

test('ordinary preparation needs neither business data nor ledger; a legacy transition cannot enter this path',async t=>{
  const f=await fixture(t);
  await assert.rejects(prepareTrialUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40)}),/existing companion/);
  const current={...f.c,product:'companion-v1',database:join(f.root,'.local/data/companion.sqlite')},raw=JSON.stringify(current);
  await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:current.phaseId,status:'active',configSha256:hash(raw)}));
  await rm(f.c.budgetFile);await rm(f.c.database);
  const review=await prepareTrialUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40)});
  assert.equal(review.databaseRead,false);assert.equal(review.ledgerRead,false);assert.equal(review.calls,0);
  await assert.rejects(stat(current.database),{code:'ENOENT'});await assert.rejects(stat(current.budgetFile),{code:'ENOENT'});
});

test('daily install preserves unknown reservations without requiring per-call audit',async t=>{
  const f=await fixture(t), current={...f.c,product:'companion-v1',database:join(f.root,'.local/data/companion.sqlite')};
  const raw=JSON.stringify(current); await writeFile(f.configFile,raw);
  await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:current.phaseId,status:'active',configSha256:hash(raw)}));
  const entry={operationId:'W0-I:B-DANIA-MINIMAX-AUDITION-01:clone-demo',model:'MiniMax/speech-2.8-hd',reservedMicros:19600,actualMicros:null,status:'unknown'};
  const auditFile=join(f.root,'.local/minimax-default-01/budget-bound/audit.json');
  const audit=JSON.stringify({kind:'unknown_reservation_upper_bound_correction',status:'applied',actualChargeStillUnknown:true,correctedEntry:entry});
  await mkdir(dirname(auditFile),{recursive:true});await writeFile(auditFile,audit);
  const budget=JSON.parse(f.budgetRaw);budget.entries.push(entry);const budgetRaw=JSON.stringify(budget);await writeFile(f.c.budgetFile,budgetRaw);
  const reviewedUnknownCosts=[{operationId:entry.operationId,model:entry.model,reservedMicros:entry.reservedMicros,auditFile,auditSha256:hash(audit)}];
  const review=await prepareTrialUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40),reviewedUnknownCosts});
  await writeFile(auditFile,audit+' ');await inspectTrialUpdate(review.plan,quiet);await writeFile(auditFile,audit);
  budget.entries.push({...entry,operationId:'unreviewed'});await writeFile(f.c.budgetFile,JSON.stringify(budget));
  await inspectTrialUpdate(review.plan,quiet);await writeFile(f.c.budgetFile,budgetRaw);
  assert.equal((await installTrialUpdate(review.plan,{quiescent:quiet})).status,'installed_active');
  assert.equal(await readFile(f.c.budgetFile,'utf8'),budgetRaw);
  assert.deepEqual(JSON.parse(await readFile(f.configFile,'utf8')).reviewedUnknownCosts,reviewedUnknownCosts);
});

test('ordinary update evidence stays in its current package and rejects outside or symlink output',async t=>{
  const f=await fixture(t), current={...f.c,product:'companion-v1',database:join(f.root,'.local/data/companion.sqlite')},raw=JSON.stringify(current);
  await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:current.phaseId,status:'active',configSha256:hash(raw)}));
  const args={projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40)};
  for(const outputDirectory of ['/tmp/elsewhere','.local/update','.local/../../elsewhere'])
    await assert.rejects(prepareTrialUpdate({...args,outputDirectory}),/integration artifact/);
  await mkdir(join(f.candidate,'.local'),{recursive:true});
  await symlink(f.root,join(f.candidate,'.local/link'));
  await assert.rejects(prepareTrialUpdate({...args,outputDirectory:'.local/link/update'}),/Symlink/);
  const outputDirectory='.local/panel-stability-01/update';
  const review=await prepareTrialUpdate({...args,outputDirectory});
  assert.equal(review.plan.nextConfigFile,join(f.candidate,outputDirectory,'next-config.json'));
  assert.equal(JSON.parse(await readFile(join(f.candidate,outputDirectory,'plan.json'),'utf8')).nextConfigSha256,review.plan.nextConfigSha256);
  await assert.rejects(stat(join(f.candidate,'.local/companion-feedback-01')),{code:'ENOENT'});
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
});

test('review preparation reads neither old data nor ledger; final freeze requires quiescence and preserves policy',async t=>{
  const f=await fixture(t);
  const additions=['contracts/character','app/companion-data','app/companion-data-transition','companion/introduction','memory/database-identity']
    .flatMap(path=>[`code/desktop-pet/${path}.ts`,`code/desktop-pet/dist/${path}.js`]);
  additions.push('code/desktop-pet/tools/prepare-companion-update.mjs');
  for(const name of additions){await mkdir(dirname(join(f.candidate,name)),{recursive:true});await writeFile(join(f.candidate,name),'synthetic candidate');}
  await rm(f.c.budgetFile);
  await rm(f.c.database);
  const before=await readFile(f.configFile),activationBefore=await readFile(f.activationFile);
  const prepared=await prepareCompanionUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40)});
  const review=JSON.parse(await readFile(prepared.reviewFile,'utf8')),next=JSON.parse(await readFile(review.nextConfigFile,'utf8'));
  assert.equal(prepared.status,'candidate_prepared_requires_quiescent_freeze');
  assert.equal(next.product,'companion-v1');assert.equal(next.database,join(f.root,'.local/data/companion.sqlite'));
  const policy=(value:any)=>{const {product,database,runtimeFiles,sourceRevision,...rest}=value;return rest;};assert.deepEqual(policy(next),policy(f.c));
  assert.ok((await readFile(f.configFile)).equals(before));assert.ok((await readFile(f.activationFile)).equals(activationBefore));
  const missingOldData=join(f.root,'.local/model-evaluation/trial/user-trial/state.sqlite');
  await assert.rejects(readFile(missingOldData),{code:'ENOENT'});
  await assert.rejects(freezeCompanionUpdate(prepared.reviewFile,{quiescent:async()=>{throw Error('still running');}}),/still running/);
  await writeFile(missingOldData,'only synthetic legacy data');await writeFile(f.c.budgetFile,f.budgetRaw);
  const frozen=await freezeCompanionUpdate(prepared.reviewFile,{quiescent:quiet});
  const plan=JSON.parse(await readFile(frozen.planFile,'utf8'));assert.equal(plan.legacyData.files.database,hash('only synthetic legacy data'));
  assert.equal(plan.legacyData.files.wal,null);assert.equal(plan.legacyData.files.shm,null);
  assert.equal(await readFile(missingOldData,'utf8'),'only synthetic legacy data');
  assert.ok((await readFile(f.configFile)).equals(before));assert.ok((await readFile(f.activationFile)).equals(activationBefore));
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
  await writeFile(join(f.candidate,f.paths[0]!), 'changed after review');
  await assert.rejects(installTrialUpdate(plan,{quiescent:quiet}),/Reviewed update bytes changed|Candidate runtime changed/);
  assert.equal(await readFile(missingOldData,'utf8'),'only synthetic legacy data');
});

test('running-process refusal happens before activation, config, runtime or update-artifact writes',async t=>{
  const f=await fixture(t);await assert.rejects(installTrialUpdate(f.plan,{quiescent:async()=>{throw new Error('still running');}}),/still running/);
  assert.equal(await readFile(f.activationFile,'utf8'),f.activationRaw);assert.equal(await readFile(f.configFile,'utf8'),f.currentRaw);
  assert.equal(await readFile(join(f.root,f.paths[0]!),'utf8'),'old');await assert.rejects(stat(join(f.root,'.local/trial-feedback-01/update')),/ENOENT/);
});

test('phase, data, model and budget policy changes cannot reset existing trial authorization',async t=>{
  const f=await fixture(t);
  for(const patch of [{phaseId:'local-trial-reset'},{database:f.c.database+'.other'},{maxCalls:7},{models:{...f.next.models,dialogue:{...f.next.models.dialogue,model:'other'}}}]){
    const raw=JSON.stringify({...f.next,...patch});await writeFile(f.nextFile,raw);
    await assert.rejects(inspectTrialUpdate({...f.plan,nextConfigSha256:hash(raw)},quiet),/preserve phase/);
  }
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);assert.equal(await readFile(f.activationFile,'utf8'),f.activationRaw);
});

test('updated candidate bytes and unfinished ledger entries are refused without writes',async t=>{
  const f=await fixture(t);await writeFile(join(f.candidate,f.paths[0]!), 'tampered');await assert.rejects(inspectTrialUpdate(f.plan,quiet),/bytes changed/);
  await writeFile(join(f.candidate,f.paths[0]!), 'new');await writeFile(f.c.budgetFile,JSON.stringify({batchId:f.c.budgetBatchId,limitMicros:20000000,blocked:false,entries:[{status:'reserved'}]}));
  await assert.rejects(inspectTrialUpdate(f.plan,quiet),/unreviewed pending/);assert.equal(await readFile(f.activationFile,'utf8'),f.activationRaw);
});

test('successful update preserves opaque data and ledger, retains backup, and leaves activation prepared',async t=>{
  const f=await fixture(t);const data=await readFile(f.c.database);const result=await installTrialUpdate(f.plan,{quiescent:quiet});
  assert.equal(result.status,'installed_prepared');assert.equal(result.changedFiles,4);
  assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'prepared');
  assert.equal(await readFile(join(f.root,f.paths[0]!),'utf8'),'new');assert.equal(await readFile(join(result.backup,f.paths[0]!),'utf8'),'old');
  assert.deepEqual(await readFile(f.c.database),data);assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
  assert.equal(JSON.parse(await readFile(f.configFile,'utf8')).phaseId,f.c.phaseId);
});

test('failure after first changed file restores prior bytes and config but does not reactivate automatically',async t=>{
  const f=await fixture(t);await assert.rejects(installTrialUpdate(f.plan,{quiescent:quiet,afterWrite:async()=>{throw new Error('controlled disk failure');}}),/controlled disk/);
  for(const path of f.paths)assert.equal(await readFile(join(f.root,path),'utf8'),'old');
  assert.equal(await readFile(f.configFile,'utf8'),f.currentRaw);assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'prepared');
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);assert.equal(await readFile(f.c.database,'utf8'),'synthetic opaque user state');
});

test('actual process probe refuses a live fixture backend without signaling it',async t=>{
  const f=await fixture(t);const script=join(f.root,f.paths[0]!);await writeFile(script,'setInterval(()=>{},1000);');
  const child=spawn(process.execPath,[script],{stdio:'ignore'});await once(child,'spawn');
  try{await assert.rejects(assertTrialQuiescent(f.c),/先退出桌宠/);assert.equal(child.exitCode,null);}finally{const exit=once(child,'exit');child.kill();await exit;}
});

test('new files roll back to absence and an app appearing after activation gate prevents installation',async t=>{
  const f=await fixture(t);const path='code/desktop-pet/dist/media/recorder-worklet.js';await mkdir(dirname(join(f.candidate,path)),{recursive:true});await writeFile(join(f.candidate,path),'new module');
  const next={...f.next,runtimeFiles:{...f.next.runtimeFiles,[path]:hash('new module')}};const raw=JSON.stringify(next);await writeFile(f.nextFile,raw);
  const plan={...f.plan,nextConfigSha256:hash(raw),files:[{path,before:null,after:hash('new module')},...f.plan.files]};
  await assert.rejects(installTrialUpdate(plan,{quiescent:quiet,afterWrite:async()=>{throw new Error('first file failure');}}),/first file/);
  await assert.rejects(stat(join(f.root,path)),/ENOENT/);await writeFile(f.activationFile,f.activationRaw);
  let observations=0;await assert.rejects(installTrialUpdate(plan,{quiescent:async()=>{if(++observations===3)throw new Error('app appeared');}}),/app appeared/);
  assert.equal(observations,3);assert.equal(await readFile(join(f.root,f.paths[0]!),'utf8'),'old');
  assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'prepared');
});

test('reviewed automatic enable occurs only after all bytes and final quiescence are verified',async t=>{
  const f=await fixture(t);let observations=0;
  const quiescent=async()=>{
    observations++;
    if(observations>=3)assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'prepared');
    if(observations===4)for(const path of f.paths)assert.equal(await readFile(join(f.root,path),'utf8'),'new');
  };
  const result=await installTrialUpdate({...f.plan,activateOnSuccess:true},{quiescent});
  assert.equal(observations,4);assert.equal(result.status,'installed_active');
  assert.deepEqual(JSON.parse(await readFile(f.activationFile,'utf8')),{version:1,phaseId:f.c.phaseId,status:'active',configSha256:f.plan.nextConfigSha256});
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
});

test('automatic enable remains off when final process check fails after files were installed',async t=>{
  const f=await fixture(t);let observations=0;
  await assert.rejects(installTrialUpdate({...f.plan,activateOnSuccess:true},{quiescent:async()=>{if(++observations===4)throw new Error('late process');}}),/late process/);
  assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'prepared');
  assert.equal(await readFile(f.configFile,'utf8'),f.currentRaw);
  for(const path of f.paths)assert.equal(await readFile(join(f.root,path),'utf8'),'old');
});

test('reusing the reviewed entry starts the exact installed version without rewriting state or counters',async t=>{
  const f=await fixture(t);const plan={...f.plan,activateOnSuccess:true};await installTrialUpdate(plan,{quiescent:quiet});
  const before=await Promise.all([readFile(f.configFile),readFile(f.activationFile),readFile(f.c.budgetFile),readFile(f.c.database)]);
  const result=await installTrialUpdate(plan,{quiescent:quiet,afterWrite:async()=>{throw new Error('must not reinstall');}});
  assert.deepEqual(result,{status:'already_active',changedFiles:0});
  assert.deepEqual(await Promise.all([readFile(f.configFile),readFile(f.activationFile),readFile(f.c.budgetFile),readFile(f.c.database)]),before);
  await assert.rejects(installTrialUpdate(plan,{quiescent:async()=>{throw new Error('still running');}}),/still running/);
  await writeFile(join(f.root,f.paths[0]!),'changed after install');await assert.rejects(installTrialUpdate(plan,{quiescent:quiet}),/程序文件发生变化/);
});

test('the actual update-and-launch command installs once and reuses the same entry on its next run',async t=>{
  const f=await fixture(t), launcher=f.paths[1]!, body='process.stdout.write("CONTROLLED_LAUNCH\\n");';
  await writeFile(join(f.candidate,launcher),body);
  const next={...f.next,runtimeFiles:{...f.next.runtimeFiles,[launcher]:hash(body)}}, raw=JSON.stringify(next);await writeFile(f.nextFile,raw);
  const plan={...f.plan,activateOnSuccess:true,nextConfigSha256:hash(raw),files:f.plan.files.map(entry=>entry.path===launcher?{...entry,after:hash(body)}:entry)};
  const planFile=join(f.candidate,'plan.json');await writeFile(planFile,JSON.stringify(plan));
  for(const expected of ['installed_active','already_active']){
    const child=spawn(process.execPath,[join(project,'tools/install-trial-update.mjs'),'--apply-and-launch',planFile],{stdio:['ignore','pipe','pipe']});
    let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);
    const [code]=await once(child,'exit');assert.equal(code,0,error);assert.ok(output.includes(expected));assert.ok(output.includes('CONTROLLED_LAUNCH'));
  }
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);assert.equal(await readFile(f.c.database,'utf8'),'synthetic opaque user state');
});

async function companionFixture(t:{after(fn:()=>Promise<void>):void},sidecars=false) {
  const f=await fixture(t),next={...f.next,product:'companion-v1',database:join(f.root,'.local/data/companion.sqlite')};
  const raw=JSON.stringify(next);await writeFile(f.nextFile,raw);
  if(sidecars){await writeFile(f.c.database+'-wal','synthetic wal');await writeFile(f.c.database+'-shm','synthetic shm');}
  const legacyData={kind:'retire_legacy_trial_data',id:'companion-step1-fixture',files:{database:hash(await readFile(f.c.database)),wal:sidecars?hash('synthetic wal'):null,shm:sidecars?hash('synthetic shm'):null}};
  return {...f,next,plan:{...f.plan,nextConfigSha256:hash(raw),activateOnSuccess:true,legacyData}};
}

test('reviewed companion update retires exact legacy data, preserves ledger and keeps new data on repeated update',async t=>{
  const f=await companionFixture(t),before=await readFile(f.c.budgetFile);
  const result=await installTrialUpdate(f.plan,{quiescent:quiet});assert.equal(result.status,'installed_active');
  await assert.rejects(stat(f.c.database),/ENOENT/);assert.deepEqual(await readFile(f.c.budgetFile),before);
  assert.equal(JSON.parse(await readFile(f.configFile,'utf8')).database,f.next.database);
  const receipt=JSON.parse(await readFile(join(f.root,'.local/companion-step1-01/update/companion-step1-fixture.json'),'utf8'));assert.equal(receipt.state,'complete');
  await mkdir(dirname(f.next.database),{recursive:true});await writeFile(f.next.database,'new companion conversations');
  assert.equal((await installTrialUpdate(f.plan,{quiescent:quiet})).status,'already_active');
  assert.equal(await readFile(f.next.database,'utf8'),'new companion conversations');assert.deepEqual(await readFile(f.c.budgetFile),before);
});

test('legacy bytes changed after review and arbitrary database destinations are rejected before runtime writes',async t=>{
  const f=await companionFixture(t);await writeFile(f.c.database,'changed by another writer');
  await assert.rejects(inspectTrialUpdate(f.plan,quiet),/Legacy data transition/);
  assert.equal(await readFile(join(f.root,f.paths[0]!),'utf8'),'old');assert.equal(await readFile(f.activationFile,'utf8'),f.activationRaw);
  await writeFile(f.c.database,'synthetic opaque user state');const next={...f.next,database:join(f.root,'unregistered.sqlite')},raw=JSON.stringify(next);await writeFile(f.nextFile,raw);
  await assert.rejects(inspectTrialUpdate({...f.plan,nextConfigSha256:hash(raw)},quiet),/Legacy data transition/);
  assert.equal(await readFile(f.c.database,'utf8'),'synthetic opaque user state');
});

test('partially retired legacy data stays on prepared new code and resumes without restoring the old identity',async t=>{
  const f=await companionFixture(t,true);let inject=true;
  const guard=async()=>{if(inject){try{await stat(f.c.database+'-wal');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')throw Error('controlled interruption after wal deletion');throw e;}}};
  await assert.rejects(installTrialUpdate(f.plan,{quiescent:guard}),/controlled interruption/);
  assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).status,'prepared');
  assert.equal(JSON.parse(await readFile(f.configFile,'utf8')).database,f.next.database);
  assert.equal(await readFile(join(f.root,f.paths[0]!),'utf8'),'new');assert.equal(await readFile(f.c.database,'utf8'),'synthetic opaque user state');
  inject=false;await writeFile(join(f.root,f.paths[0]!), 'unexpected replacement');
  await assert.rejects(installTrialUpdate(f.plan,{quiescent:guard}),/发生变化/);
  assert.equal(await readFile(f.c.database,'utf8'),'synthetic opaque user state');
  await writeFile(join(f.root,f.paths[0]!),'new');const result=await installTrialUpdate(f.plan,{quiescent:guard});assert.equal(result.status,'installed_active');
  for(const suffix of ['', '-wal','-shm'])await assert.rejects(stat(f.c.database+suffix),/ENOENT/);
  assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
});

test('first companion update refuses existing new data rather than mixing or overwriting it',async t=>{
  const f=await companionFixture(t);await mkdir(dirname(f.next.database),{recursive:true});await writeFile(f.next.database,'already meaningful new data');
  await assert.rejects(inspectTrialUpdate(f.plan,quiet),/Legacy data transition/);
  assert.equal(await readFile(f.next.database,'utf8'),'already meaningful new data');assert.equal(await readFile(f.configFile,'utf8'),f.currentRaw);
});

test('authorized cumulative60 transition preserves all entries/data, updates config together, and cannot run twice',async t=>{
 const f=await fixture(t);
 const {upgradeTrialBudget}=await import(pathToFileURL(join(project,'tools/upgrade-trial-budget.mjs')).href);
 const beforeData=await readFile(f.c.database), before=JSON.parse(f.budgetRaw);
 // This fixture has no unknown costs; no real ledger or provider is accessed.
 const result=await upgradeTrialBudget(f.root,undefined,{quiescent:quiet});
 assert.equal(result.status,'applied');assert.equal(result.entriesUnchanged,true);
 const ledger=JSON.parse(await readFile(f.c.budgetFile,'utf8')),config=JSON.parse(await readFile(f.configFile,'utf8'));
 assert.equal(ledger.limitMicros,60000000);assert.equal(config.limitMicros,60000000);assert.deepEqual(ledger.entries,before.entries);
 assert.deepEqual(await readFile(f.c.database),beforeData);
 assert.equal(JSON.parse(await readFile(f.activationFile,'utf8')).configSha256,hash(await readFile(f.configFile)));
 await assert.rejects(upgradeTrialBudget(f.root,undefined,{quiescent:quiet}),/20CNY/);
});


test('a new runtime pin is included in the transaction even when its file already matches the candidate',async t=>{
 const f=await fixture(t),current={...f.c,product:'companion-v1',database:join(f.root,'.local/data/companion.sqlite')},raw=JSON.stringify(current);
 await writeFile(f.configFile,raw);await writeFile(f.activationFile,JSON.stringify({version:1,phaseId:current.phaseId,status:'active',configSha256:hash(raw)}));
 const added='code/desktop-pet/dist/app/new-module.js';for(const root of [f.root,f.candidate])await writeFile(join(root,added),'same unregistered bytes');
 const review=await prepareTrialUpdate({projectRoot:f.root,candidateRoot:f.candidate,sourceRevision:'b'.repeat(40),newRuntimePaths:[added]});
 assert.deepEqual(review.plan.files.find((x:any)=>x.path===added),{path:added,before:hash('same unregistered bytes'),after:hash('same unregistered bytes')});
 assert.equal((await inspectTrialUpdate(review.plan,quiet)).changes.size,5);
 assert.equal((await installTrialUpdate(review.plan,{quiescent:quiet})).status,'installed_active');
 assert.equal(JSON.parse(await readFile(f.configFile,'utf8')).runtimeFiles[added],hash('same unregistered bytes'));
 assert.equal(await readFile(f.c.budgetFile,'utf8'),f.budgetRaw);
});
