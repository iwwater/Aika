import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { mkdir,copyFile } from 'node:fs/promises';
// Keep the installed QR renderer inside the same fingerprinted update as the channel.
// No optional OpenClaw runtime or on-demand dependency download is used.
await build({absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),entryPoints:['wechat/qr.ts'],outfile:'dist/wechat/qr.js',bundle:true,platform:'node',format:'esm',target:'node20',
  banner:{js:"import { createRequire as qrCreateRequire } from 'node:module'; const require = qrCreateRequire(import.meta.url);"},legalComments:'inline'});
// Bundle the worker entry and keep its WASM at the exact relative URL resolved by silk-wasm.
await build({absWorkingDir:fileURLToPath(new URL('..',import.meta.url)),entryPoints:['wechat/voice.ts'],outfile:'dist/wechat/voice.js',bundle:true,platform:'node',format:'esm',target:'node20',legalComments:'inline',mainFields:['module','main']});
await mkdir(new URL('../dist/wechat/',import.meta.url),{recursive:true});
await copyFile(new URL('../node_modules/silk-wasm/lib/silk.wasm',import.meta.url),new URL('../dist/wechat/silk.wasm',import.meta.url));
