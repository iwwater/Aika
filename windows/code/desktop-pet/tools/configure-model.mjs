// Rebuild a catalog binding for a model that the user has already installed locally.
// Does not download, copy, decrypt, alter, or remove watermarks from any model.
//
// FIX61-11: the validation is exported as `validateModelDirectory(dir)` so it can be called on its own
// (the FIX61-11 test imports the export to check it is still present). The skin registry does NOT call it:
// `management/skin-store.ts` validates imports with its own `referencePath()`, which is the STRICTER of the
// two (it also refuses a percent-escape). Nothing in production imports this function, so a rule added here
// does not automatically apply to skin imports and vice versa — they are two validators, not one shared one.
// This file remains the single binding authority for the built-in rig (`desktop/assets/local-model`); the
// skin registry imports packs, it never writes a presets.json or a parameter map, so a skin is never a
// second configuration authority.
import {readFile,writeFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

const hash=b=>createHash('sha256').update(b).digest('hex');
const UNSAFE_REFERENCE=/[:%\\]/;

/**
 * Validate one model directory against the rules this adapter requires.
 *
 * Returns the model-relative paths, the manifest references and the binding fingerprint. It throws with
 * the exact reason rather than returning a partial result: a directory that is half-valid must never be
 * treated as installable.
 */
export async function validateModelDirectory(directory){
  const base=await realpath(resolve(directory));
  const refs=JSON.parse(await readFile(resolve(base,'pet.model3.json'),'utf8')).FileReferences;
  if(!refs?.Moc||!refs.Physics||!refs.DisplayInfo||!Array.isArray(refs.Textures)||!Array.isArray(refs.Expressions)||!refs.Motions?.Idle?.[0]?.File)
    throw Error('This adapter requires Moc, Physics, DisplayInfo, Textures, Expressions and Motions.Idle[0]. Adapt the renderer for other rigs.');
  const paths=[...new Set(['pet.model3.json',refs.Moc,refs.Physics,...refs.Expressions.map(x=>x.File),...Object.values(refs.Motions).flat().map(x=>x.File)])].sort();
  let binding='';
  for(const p of [...paths,...refs.Textures,refs.DisplayInfo]){
    if(typeof p!=='string'||p.startsWith('/')||p.split('/').some(x=>!x||x==='.'||x==='..')||UNSAFE_REFERENCE.test(p))throw Error('Unsafe model-relative path');
    const actual=await realpath(resolve(base,p)),rel=relative(base,actual);if(rel.startsWith('..')||isAbsolute(rel))throw Error('Model reference escapes its directory');
    if(paths.includes(p))binding+=p+'\0'+hash(await readFile(actual))+'\n';
  }
  return {base,refs,paths,binding,fingerprint:hash(binding)};
}

// Only run the writer when this file is the entry point; importing it must have no side effects.
const invokedDirectly=process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url);
if(invokedDirectly){
  const code=fileURLToPath(new URL('..',import.meta.url));
  const {base,fingerprint}=await validateModelDirectory(resolve(code,'desktop/assets/local-model'));
  // Use a new template, preserving an existing hand-authored catalog.
  const catalog=JSON.parse(await readFile(resolve(code,'config/presets.example.json'),'utf8'));
  catalog.modelFingerprint=fingerprint;
  await writeFile(resolve(base,'presets.json'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});
  console.log('Created a disabled catalog bound to local model bytes. Configure parameter-map.json and catalog items, then validate your rig locally.');
}
