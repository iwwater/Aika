import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
// Runtime dependencies travel inside the same fingerprinted application update.
// No runtime npm install, Python environment or unpinned global resolver.
if(process.platform!=='darwin'||process.arch!=='arm64')throw Error('B28 wake package is pinned to this Mac arm64 runtime');
await build({absWorkingDir:root,entryPoints:['media/wake/keywords.ts'],outfile:'dist/media/wake/keywords.js',bundle:true,platform:'node',format:'esm',target:'node20',legalComments:'inline'});
const vendor=new URL('../dist/media/wake/vendor/',import.meta.url);await mkdir(vendor,{recursive:true});
for(const name of ['sherpa-onnx-node','sherpa-onnx-darwin-arm64']){
 const source=new URL('../node_modules/'+name+'/',import.meta.url);
 if(JSON.parse(await readFile(new URL('package.json',source),'utf8')).version!=='1.13.8')throw Error('Wake dependency revision differs');
 await cp(source,new URL(name+'/',vendor),{recursive:true,dereference:true});
}
const worker=new URL('../dist/media/wake/detector-worker.js',import.meta.url);
const body=await readFile(worker,'utf8'),needle="require('sherpa-onnx-node')";
if(body.split(needle).length!==2)throw Error('Wake worker import changed; inspect runtime packaging');
await writeFile(worker,body.replace(needle,"require('./vendor/sherpa-onnx-node/sherpa-onnx.js')"));
