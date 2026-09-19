import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, lstat, realpath, open, unlink } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManagedCredentialStore, managedCredentialDirectory, acquireSetupLock } from '../management/credential-store.js';
import { credentialRegistry } from '../management/credentials.js';
import { createSelfSetup } from '../management/self-setup.js';
import { ManagementSettingsStore } from '../management/settings-store.js';
import { effectiveTrialConfiguration } from '../management/settings.js';
import { RegisteredVoiceStore } from '../providers/registered-voices.js';
import { deepseekFlashModel } from '../providers/text-protocol.js';
import { startManagementServer } from '../management/server.js';
import { readPresentationCatalog } from '../management/presentation.js';
import { ManagementError } from '../contracts/management.js';
import { validateTrialConfiguration, type TrialConfiguration } from './trial-config.js';
import { verifyTrialRuntime, trialFiles } from './trial-launcher.js';

const hash=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
/** Draft metadata has no runtime fingerprint or credentials. It is never accepted by the runtime validator. */
export function firstRunDraft(projectRoot:string,credentialDirectory=managedCredentialDirectory(projectRoot)):TrialConfiguration {
 const deepseek=resolve(credentialDirectory,'unconfigured-deepseek.key'),dashscope=resolve(credentialDirectory,'unconfigured-dashscope.key');
 const text=deepseekFlashModel(deepseek),chat='https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
 return {version:1,product:'companion-v1',phaseId:'local-trial-personal',purpose:'user-trial',projectRoot,sourceRevision:'unprepared',runtimeFiles:{},database:resolve(projectRoot,'.local/data/companion.sqlite'),budgetFile:resolve(projectRoot,'.local/model-evaluation/budget.json'),budgetBatchId:'local-'+hash(projectRoot).slice(0,24),budgetMode:'unlimited',limitMicros:null,phaseLimitMicros:0,maxCalls:0,operationLimits:{dialogue:0,memory_turn:0,summary:0,perception:0,tts:0,admission:0},memory:{mode:'strict',scheduling:'semantic-admission',timeoutMs:300000},models:{
  dialogue:text,summary:text,admission:text,
  memory_turn:{provider:'deepseek',model:'deepseek-v4-pro',endpoint:text.endpoint,credentialFile:deepseek,reservationMicros:11000000,inputTokenLimit:32768,outputTokenLimit:393216,inputMicrosPerToken:9,outputMicrosPerToken:27,thinking:'high'},
  asr:{provider:'dashscope',model:'qwen3-asr-flash-2026-02-10',endpoint:chat,credentialFile:dashscope,reservationMicros:220,inputTokenLimit:0,outputTokenLimit:0,inputMicrosPerToken:0,outputMicrosPerToken:0,audioMicrosPerSecond:220},
  perception:{provider:'dashscope',model:'qwen3.5-omni-flash-2026-03-15',endpoint:chat,credentialFile:dashscope,reservationMicros:1304167,inputTokenLimit:196608,outputTokenLimit:65536,inputMicrosPerToken:2.2,outputMicrosPerToken:13.3},
  tts:{provider:'dashscope',model:'qwen3-tts-instruct-flash-2026-01-26',endpoint:'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',credentialFile:dashscope,reservationMicros:100000,inputTokenLimit:0,outputTokenLimit:0,inputMicrosPerToken:0,outputMicrosPerToken:0,characterMicros:80}
 }};
}
async function exists(file:string):Promise<boolean>{try{await lstat(file);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return false;throw e;}}
async function runtimePins(root:string):Promise<Record<string,string>>{
 const files:Record<string,string>={};
 async function scan(directory:string):Promise<void>{for(const entry of await readdir(directory,{withFileTypes:true})){const file=resolve(directory,entry.name);if(entry.isSymbolicLink())throw Error('runtime_symlink');if(entry.isDirectory()){if(!['node_modules','.cache','.git'].includes(entry.name))await scan(file);}else if(entry.isFile())files[relative(root,file).split('\\').join('/')]=hash(await readFile(file));}}
 await scan(resolve(root,'code/desktop-pet/dist'));await scan(resolve(root,'code/desktop-pet/desktop'));return files;
}
/** Opens without a Key, voice, JSON config, app bundle or Live2D asset. No provider probes or devices. */
export async function startFirstRunSetup(projectRoot:string,options:{credentialDirectory?:string;fetch?:typeof fetch;uiRoot?:string}={}){
 const root=await realpath(projectRoot),files=trialFiles(root),directory=dirname(files.configFile);
 if(await exists(files.configFile)||await exists(files.activationFile))throw new ManagementError('unavailable','本机已有配置。请使用原启动入口；已准备配置可用 configure-local --activate-existing 显式启用。');
 const managed=new ManagedCredentialStore(root,options.credentialDirectory),base=firstRunDraft(root,managed.directory),credentials=credentialRegistry(base,managed);
 // Never adopt or overwrite an unrelated pre-existing ledger.
 if(await exists(base.budgetFile)){const budget=JSON.parse(await readFile(base.budgetFile,'utf8'));if(budget.batchId!==base.budgetBatchId||budget.limitMicros!==base.limitMicros||budget.currency!=='CNY')throw new ManagementError('unavailable','本机已有不同的账目配置，请继续使用原入口。');}
 await mkdir(directory,{recursive:true,mode:0o700});
 const release=acquireSetupLock(resolve(directory,'first-run.lock'),'first-run:'+root);
 const instanceId=randomUUID();
 let server:Awaited<ReturnType<typeof startManagementServer>>|undefined,setup:ReturnType<typeof createSelfSetup>|undefined;
 try{
  const voices=await RegisteredVoiceStore.open(resolve(root,'.local/data/registered-voices.json'));
  const settings=await ManagementSettingsStore.open(resolve(directory,'management-settings.json'),base,voices,{credentials,draftOnly:true});
  let completed=false;
  async function blockers():Promise<string[]>{
   const result:string[]=[],saved=settings.snapshot().saved,available=credentials.list();
   if(Object.values(saved.providers).some(p=>!available.some(c=>c.id===p.credentialRef&&c.provider===p.provider&&c.status==='configured')))result.push('请保存所需Key，并在每个模型模块选择同供应商的凭据。');
   try{await readPresentationCatalog(root);}catch{result.push('启动前还需配置自己有权使用的 Live2D 模型与匹配目录；现在仍可保存Key和准备音色。');}
   const required=['dist/app/trial-backend.js','dist/app/trial-launcher.js','desktop/build/renderer.js','desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'];
   for(const path of required)if(!await exists(resolve(root,'code/desktop-pet',path))){result.push('启动前需要完成本机应用构建；现在仍可完成模型与音色设置。');break;}
   return result;
  }
  setup=createSelfSetup({base,settings,instanceId,mode:'first-run',credentials:managed,...(options.fetch?{fetch:options.fetch}:{}),initialization:async()=>({completed,blockers:await blockers()}),finish:async()=>{
   const missing=await blockers();if(missing.length)throw new ManagementError('invalid_request',missing.join(' '));
   const pins=await runtimePins(root),effective=effectiveTrialConfiguration(base,settings.snapshot().saved,credentials,true);
   const config=validateTrialConfiguration({...effective,sourceRevision:hash(JSON.stringify(pins)).slice(0,40),runtimeFiles:pins});await verifyTrialRuntime(config);
   const raw=JSON.stringify(config,null,2)+'\n',activation=JSON.stringify({version:1,phaseId:config.phaseId,status:'prepared',configSha256:hash(raw)})+'\n';
   // Exclusive writes; retries may complete the exact same partially prepared pair, never replace an existing configuration.
   for(const [file,content] of [[files.configFile,raw],[files.activationFile,activation]] as const){
    try{await writeFile(file,content,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||await readFile(file,'utf8')!==content)throw new ManagementError('version_conflict','已有配置与本次准备不同，未覆盖。');}
   }
   completed=true;
  }});
  server=await startManagementServer({mode:'setup',selfSetup:setup,uiRoot:options.uiRoot??resolve(root,'code/desktop-pet/management/ui')});
  return {...server,setup,async close(){await setup!.close();await server!.close();release();}};
 }catch(error){await setup?.close();await server?.close();release();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../../..');
 startFirstRunSetup(root).then(service=>{
  // Local-only bearer URL is intentionally shown to the user, never stored in project evidence.
  process.stdout.write('本机首次设置（保持此窗口开启）：\n'+service.url+'\n');
  let closing=false;const close=()=>{if(closing)return;closing=true;void service.close().then(()=>{process.exitCode=0;},()=>{process.exitCode=1;});};process.once('SIGINT',close);process.once('SIGTERM',close);
 }).catch(error=>{process.stderr.write((error instanceof ManagementError?error.message:'首次设置无法打开，请检查本机文件权限。')+'\n');process.exitCode=1;});
}
