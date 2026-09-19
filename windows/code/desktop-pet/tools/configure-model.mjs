// Rebuild a catalog binding for a model that the user has already installed locally.
// Does not download, copy, decrypt, alter, or remove watermarks from any model.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
const code=fileURLToPath(new URL('..',import.meta.url));
const base=await realpath(resolve(code,'desktop/assets/local-model'));
const refs=JSON.parse(await readFile(resolve(base,'pet.model3.json'),'utf8')).FileReferences;
if(!refs?.Moc||!refs.Physics||!refs.DisplayInfo||!Array.isArray(refs.Textures)||!Array.isArray(refs.Expressions)||!refs.Motions?.Idle?.[0]?.File)
  throw Error('This adapter requires Moc, Physics, DisplayInfo, Textures, Expressions and Motions.Idle[0]. Adapt the renderer for other rigs.');
const paths=[...new Set(['pet.model3.json',refs.Moc,refs.Physics,...refs.Expressions.map(x=>x.File),...Object.values(refs.Motions).flat().map(x=>x.File)])].sort();
const hash=b=>createHash('sha256').update(b).digest('hex');let binding='';
for(const p of [...paths,...refs.Textures,refs.DisplayInfo]){
 if(typeof p!=='string'||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..')||/[:%\\]/.test(p))throw Error('Unsafe model-relative path');
 const actual=await realpath(resolve(base,p)),rel=relative(base,actual);if(rel.startsWith('..')||isAbsolute(rel))throw Error('Model reference escapes its directory');
 if(paths.includes(p))binding+=p+'\0'+hash(await readFile(actual))+'\n';
}
// Use a new template, preserving an existing hand-authored catalog.
const catalog=JSON.parse(await readFile(resolve(code,'config/presets.example.json'),'utf8'));
catalog.modelFingerprint=hash(binding);
await writeFile(resolve(base,'presets.json'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});
console.log('Created a disabled catalog bound to local model bytes. Configure parameter-map.json and catalog items, then validate your rig locally.');
