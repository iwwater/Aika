// First-time local configuration. Never calls a model or opens a device.
import {isOutside,isPrivateFileSync,restrictPrivatePathSync} from '../dist/core/platform-files.js';
import {readFile,writeFile,mkdir,readdir,realpath,stat,access,rename,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {resolve,relative,dirname,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const arg=process.argv[2];
if(!arg)throw Error('Usage: node tools/configure-local.mjs /absolute/path/to/config.local.json [--activate]');
if(arg==='--activate-existing'){
  const directory=resolve(root,'.local/model-evaluation/trial/user-trial');
  const raw=await readFile(resolve(directory,'config.json'));
  const activationFile=resolve(directory,'activation.json');
  const activation=JSON.parse(await readFile(activationFile,'utf8'));
  const {validateTrialConfiguration}=await import('../dist/app/trial-config.js');
  const {verifyTrialRuntime}=await import('../dist/app/trial-launcher.js');
  const config=validateTrialConfiguration(JSON.parse(raw));
  if(config.projectRoot!==root||activation.phaseId!==config.phaseId||activation.status!=='prepared'||activation.configSha256!==createHash('sha256').update(raw).digest('hex'))
    throw Error('Only the unchanged prepared configuration for this directory can be activated.');
  await verifyTrialRuntime(config);
  for(const m of Object.values(config.models)){
    const actual=await realpath(m.credentialFile),info=await stat(actual),local=relative(root,actual);
    if(!isOutside(root,actual)||!isPrivateFileSync(actual,info))throw Error('External credential file permissions changed.');
  }
  const temporary=activationFile+'.'+randomUUID()+'.next';
  try{await writeFile(temporary,JSON.stringify({...activation,status:'active'})+'\n',{flag:'wx',mode:0o600});await rename(temporary,activationFile);}
  finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  console.log('Existing prepared configuration activated. No app started, API request sent, or device opened.');
  process.exit(0);
}
const input=JSON.parse(await readFile(resolve(arg),'utf8'));
const {validateTrialConfiguration}=await import('../dist/app/trial-config.js');
const {readPresentationCatalog}=await import('../dist/management/presentation.js');
const {RegisteredVoiceStore}=await import('../dist/providers/registered-voices.js');
const {defaultManagedSettings,validateManagedSettings}=await import('../dist/management/settings.js');
const {credentialRegistry}=await import('../dist/management/credentials.js');
await readPresentationCatalog(root); // Real licensed model and matching catalog are required.
if(!['darwin','win32'].includes(process.platform))throw Error('The desktop target supports Windows and macOS.');
const code=resolve(root,'code/desktop-pet'),runtimeFiles={};
const hash=b=>createHash('sha256').update(b).digest('hex');
async function pin(base){for(const entry of await readdir(base,{withFileTypes:true})){const path=resolve(base,entry.name);if(entry.isSymbolicLink())throw Error('Runtime symlinks are not accepted');if(entry.isDirectory()){if(!['.cache','.git','node_modules'].includes(entry.name))await pin(path);}else runtimeFiles[relative(root,path).replaceAll('\\','/')]=hash(await readFile(path));}}
await pin(resolve(code,'dist'));await pin(resolve(code,'desktop'));
await pin(resolve(code,'tools'));
for(const model of Object.values(input.models??{})){
  if(typeof model.credentialFile!=='string'||!isAbsolute(model.credentialFile))throw Error('Use absolute paths to your external credential files.');
  const path=await realpath(model.credentialFile),local=relative(root,path),info=await stat(path);
  if(!isOutside(root,path)||!isPrivateFileSync(path,info))throw Error('Credential files must be outside this package and private. Use tools/private-file.mjs to restrict a file you own.');
  model.credentialFile=path;
}
const sourceRevision=hash(JSON.stringify(runtimeFiles)).slice(0,40);
const config=validateTrialConfiguration({version:1,desktopHost:process.platform==='win32'?'electron':'macos',product:'companion-v1',phaseId:'local-trial-personal',purpose:'user-trial',projectRoot:root,sourceRevision,runtimeFiles,
  database:resolve(root,'.local/data/companion.sqlite'),budgetFile:resolve(root,'.local/model-evaluation/budget.json'),budgetBatchId:'local-'+randomUUID(),budgetMode:input.budgetMode,limitMicros:input.limitMicros,
  // Compatibility fields are inert for user-trial; no extra trial quotas are imposed.
  phaseLimitMicros:0,maxCalls:0,operationLimits:{admission:0,dialogue:0,memory_turn:0,summary:0,perception:0,tts:0},
  models:input.models,memory:{mode:'strict',scheduling:'semantic-admission',timeoutMs:300000}});
if(!input.voiceId||input.voiceId==='YOUR_AUTHORIZED_VOICE_ID'||!isAbsolute(input.voiceRegistryFile??''))
  throw Error('MiniMax needs your own authorized voice ID and genuine local registration metadata. No voice is cloned or provisioned by this tool.');
const registryPath=await realpath(input.voiceRegistryFile),registryRelative=relative(root,registryPath);
if(!isOutside(root,registryPath))throw Error('Keep the private voice registry outside this source package.');
const voices=await RegisteredVoiceStore.open(registryPath);
const credentialRef=credentialRegistry(config).ref(config.models.tts.credentialFile,'dashscope');
voices.resolve({voiceId:input.voiceId,provider:'dashscope',endpoint:config.models.tts.endpoint,targetModel:config.models.tts.model,credentialRef});
const managed=defaultManagedSettings(config);
managed.providers.tts={...managed.providers.tts,adapterId:'minimax-tts',voice:input.voiceId};
delete managed.providers.tts.language;
if(input.context)managed.context=input.context;
validateManagedSettings(managed,config,voices);
const dir=resolve(root,'.local/model-evaluation/trial/user-trial');
const voiceFile=resolve(root,'.local/data/registered-voices.json');
for(const p of [config.budgetFile,voiceFile,resolve(dir,'management-settings.json'),resolve(dir,'config.json'),resolve(dir,'activation.json')]){
  try{await access(p);throw Error('Existing local state is never overwritten: '+relative(root,p));}catch(e){if(e.code!=='ENOENT')throw e;}
}
await mkdir(dir,{recursive:true,mode:0o700});await mkdir(dirname(config.database),{recursive:true,mode:0o700});
restrictPrivatePathSync(dir);restrictPrivatePathSync(dirname(config.database));
const raw=JSON.stringify(config,null,2)+'\n';
await writeFile(config.budgetFile,JSON.stringify({batchId:config.budgetBatchId,currency:'CNY',budgetMode:config.budgetMode,limitMicros:config.limitMicros,blocked:false,entries:[]})+'\n',{flag:'wx',mode:0o600});
await writeFile(voiceFile,JSON.stringify(voices.snapshot())+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(dir,'management-settings.json'),JSON.stringify({version:1,current:{revision:1,savedAt:new Date().toISOString(),settings:managed},history:[]})+'\n',{flag:'wx',mode:0o600});
await writeFile(resolve(dir,'config.json'),raw,{flag:'wx',mode:0o600});
await writeFile(resolve(dir,'activation.json'),JSON.stringify({version:1,phaseId:config.phaseId,status:process.argv.includes('--activate')?'active':'prepared',configSha256:hash(raw)})+'\n',{flag:'wx',mode:0o600});
console.log('Local configuration saved. No API calls or device access. '+(process.argv.includes('--activate')?'Explicit activation recorded; starting the app and sending input may incur API charges.':'Prepared only: startup is disabled. Review the configuration and activation procedure before enabling paid providers.'));
