// Unified Real Desktop Pet & Production Backend Launcher.
// Production runtime authority: dist/app/trial-backend.js -> BackendSession -> DialoguePipeline.
// Launches Electron + TrialBackend with genuine PET_TRIAL_CONFIG / PET_TRIAL_ACTIVATION.
// NO --preview flag is passed, ensuring Desktop Pet and Management Console share the same live instance.

import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareTrialLaunch } from '../dist/app/trial-launcher.js';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../../..');

try {
  const plan = await prepareTrialLaunch(projectRoot, process.execPath, process.env);
  const child = spawn(plan.executable, [...plan.arguments, ...process.argv.slice(2)], {
    env: plan.environment,
    windowsHide: true,
    stdio: 'inherit'
  });
  child.once('error', error => { console.error('Desktop Pet launch error:', error.message); process.exitCode = 1; });
  child.once('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error('Failed to prepare trial launch:', error.message);
  process.exit(1);
}
