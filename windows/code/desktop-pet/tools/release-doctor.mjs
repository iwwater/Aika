import {access,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
const code=fileURLToPath(new URL('..',import.meta.url));
const exists=async path=>{try{await access(resolve(code,path));return true;}catch{return false;}};
const checks={node:process.version,platform:process.platform,architecture:process.arch,
  backendBuilt:await exists('dist/app/trial-backend.js'),
  cubismCore:await exists('desktop/vendor/cubism/Core/live2dcubismcore.min.js'),
  cubismFramework:await exists('desktop/vendor/cubism/Framework/src/live2dcubismframework.ts'),
  localModel:await exists('desktop/assets/local-model/pet.model3.json'),
  localPresets:await exists('desktop/assets/local-model/presets.json'),
  rendererBuilt:await exists('desktop/build/renderer.js'),
  managementPreviewBuilt:await exists('management/ui/presentation-preview.js'),
  windowsHost:await exists('desktop/electron/main.mjs'),
  nativeBuilt:process.platform==='win32' ? await exists('node_modules/electron/dist/electron.exe') : await exists('desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet'),
  wakePackaged:await exists('dist/media/wake/vendor/sherpa-onnx-node/sherpa-onnx.js')};
console.log(JSON.stringify({checks,scope:'Local file checks only. No credentials read, servers started, models called, or devices opened.',next:'Backend build/tests do not need Live2D. Desktop setup requires your licensed SDK, rig and local configuration.'},null,2));
if(!checks.backendBuilt)process.exitCode=1;
