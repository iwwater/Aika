import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../desktop/', import.meta.url));
const electron = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PET_TRIAL_CONFIG;
delete env.PET_TRIAL_ACTIVATION;
const child = spawn(electron, [
  fileURLToPath(new URL('../desktop/electron/main.mjs', import.meta.url)),
  '--root', root,
  '--backend', fileURLToPath(new URL('./real-backend.mjs', import.meta.url)),
  '--node', process.execPath,
  '--preview',
  ...process.argv.slice(2)
], { env, windowsHide: true, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
