import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { fixture } from '../management/helpers.js';
import { defaultManagedSettings } from '../../management/settings.js';
const project=resolve(import.meta.dirname,'../../..');
const {prepareTrialUpdate}=await import(pathToFileURL(join(project,'tools/prepare-trial-update.mjs')).href);
const {prepareTextUpdate}=await import(pathToFileURL(join(project,'tools/deepseek-text-update.mjs')).href);
const {installTrialUpdate,inspectTrialUpdate}=await import(pathToFileURL(join(project,'tools/install-trial-update.mjs')).href);
const hash=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function prepared(t:Parameters<typeof fixture>[0], voice=false) {
 const f=await fixture(t),root=f.c.projectRoot,candidate=join(root,'candidate'),directory=join(root,'.local/model-evaluation/trial/user-trial');
 await mkdir(directory,{recursive:true});
 for(const p of Object.keys(f.c.runtimeFiles)) {await mkdir(dirname(join(root,p)),{recursive:true});await writeFile(join(root,p),'controlled');await mkdir(dirname(join(candidate,p)),{recursive:true});await writeFile(join(candidate,p),'candidate');}
 const config=join(directory,'config.json'),activation=join(directory,'activation.json'),settings=join(directory,'management-settings.json');
 await writeFile(config,JSON.stringify(f.c));await writeFile(activation,await readFile(f.activationFile));
 const settingsBytes=JSON.stringify({version:1,current:{revision:1,savedAt:'old',settings:defaultManagedSettings(f.c)},history:[]});await writeFile(settings,settingsBytes);
 const review=await prepareTrialUpdate({projectRoot:root,candidateRoot:candidate,sourceRevision:'b'.repeat(40),outputDirectory:'.local/deepseek-text-01/update'});
 const {prepareVoiceUpdate}=await import(pathToFileURL(join(project,'tools/voice-pipeline-update.mjs')).href);
 const plan=await (voice?prepareVoiceUpdate:prepareTextUpdate)(join(candidate,'.local/deepseek-text-01/update/plan.json'));
 return {...f,root,candidate,config,activation,settings,settingsBytes,plan,review};
}
test('text update transaction preserves historical settings and ledger and rejects unrelated model changes',async t=>{
 const f=await prepared(t),before=await readFile(f.c.budgetFile),quiet=async()=>{};
 const nextBytes=await readFile(f.plan.nextConfigFile),tampered=JSON.parse(nextBytes.toString());tampered.models.tts.model='changed';const bad=JSON.stringify(tampered);await writeFile(f.plan.nextConfigFile,bad);
 await assert.rejects(inspectTrialUpdate({...f.plan,nextConfigSha256:hash(bad)},quiet),/exact registered/);await writeFile(f.plan.nextConfigFile,nextBytes);
 const result=await installTrialUpdate(f.plan,{quiescent:quiet});assert.equal(result.status,'installed_active');
 const settings=JSON.parse(await readFile(f.settings,'utf8'));assert.equal(settings.current.revision,2);assert.deepEqual(settings.history[0],JSON.parse(f.settingsBytes).current);
 for(const slot of ['dialogue','summary','admission'])assert.equal(settings.current.settings.providers[slot].model,'deepseek-flash');
 assert.deepEqual(await readFile(f.c.budgetFile),before);
});
test('failure after writing new settings restores exact previous settings and runtime before leaving activation prepared',async t=>{
 const f=await prepared(t);let checks=0;
 await assert.rejects(installTrialUpdate(f.plan,{quiescent:async()=>{if(++checks===4)throw Error('synthetic final quiescence failure');}}),/synthetic/);
 assert.equal(await readFile(f.settings,'utf8'),f.settingsBytes);assert.deepEqual(JSON.parse(await readFile(f.config,'utf8')),f.c);
 for(const p of Object.keys(f.c.runtimeFiles))assert.equal(await readFile(join(f.root,p),'utf8'),'controlled');
 assert.equal(JSON.parse(await readFile(f.activation,'utf8')).status,'prepared');
});

test('a settings edit detected during install is preserved because this installer has not touched it',async t=>{
 const f=await prepared(t),external=JSON.parse(f.settingsBytes);external.current.settings.context.maxMemories=11;const bytes=JSON.stringify(external);let written=false;
 await assert.rejects(installTrialUpdate(f.plan,{quiescent:async()=>{},afterWrite:async()=>{if(!written){written=true;await writeFile(f.settings,bytes);}}}),/User settings changed during install/);
 assert.equal(await readFile(f.settings,'utf8'),bytes);assert.equal(JSON.parse(await readFile(f.activation,'utf8')).status,'prepared');
});

test('voice update adds original-language ASR and image prices while preserving unrelated settings and ledger',async t=>{
 const f=await prepared(t,true),budget=await readFile(f.c.budgetFile),quiet=async()=>{};
 const result=await installTrialUpdate(f.plan,{quiescent:quiet});assert.equal(result.status,'installed_active');
 const current=JSON.parse(await readFile(f.config,'utf8')),settings=JSON.parse(await readFile(f.settings,'utf8'));
 assert.equal(current.models.asr.model,'qwen3-asr-flash-2026-02-10');assert.equal(current.models.perception.inputMicrosPerToken,2.2);
 assert.equal(current.operationLimits,undefined);assert.equal(current.maxCalls,undefined);assert.equal(current.phaseLimitMicros,undefined);
 assert.deepEqual(settings.history[0],JSON.parse(f.settingsBytes).current);
 for(const slot of ['dialogue','summary','admission','memory_turn','tts'])assert.deepEqual(settings.current.settings.providers[slot],JSON.parse(f.settingsBytes).current.settings.providers[slot]);
 assert.deepEqual(await readFile(f.c.budgetFile),budget);
});
