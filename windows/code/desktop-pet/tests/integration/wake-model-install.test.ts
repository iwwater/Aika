import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,mkdir,rm,symlink,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {installWakeModels}=await import(pathToFileURL(resolve('tools/install-wake-models.mjs')).href);
const names=['encoder.onnx','decoder.onnx','joiner.onnx','tokens.txt','silero_vad.onnx'];
test('model install verifies all sources first, creates only reviewed names and never overwrites mismatches',async()=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'wake-install-')));try{
  const source=join(root,'source'),dest=join(root,'dest');await mkdir(source);const hashes:Record<string,string>={};
  for(const name of names){await writeFile(join(source,name),name);hashes[name]=createHash('sha256').update(name).digest('hex');}
  const args={sourceDirectory:source,destinationDirectory:dest,expectedHashes:hashes};
  const first=await installWakeModels(args);assert.deepEqual(first.created,names);assert.deepEqual((await installWakeModels(args)).created,[]);
  await writeFile(join(dest,'tokens.txt'),'existing-different');await assert.rejects(installWakeModels(args));assert.equal(await readFile(join(dest,'tokens.txt'),'utf8'),'existing-different');
  const link=join(root,'link');await symlink(dest,link);await assert.rejects(installWakeModels({...args,destinationDirectory:link}));
 }finally{await rm(root,{recursive:true,force:true});}
});
