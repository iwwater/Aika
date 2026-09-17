import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { managementUrl } from './management-url.mjs';
import { openLocalUrl } from '../dist/core/open-url.js';
const config = process.env.PET_TRIAL_CONFIG || fileURLToPath(new URL('../../../.local/model-evaluation/trial/user-trial/config.json', import.meta.url));
try { await openLocalUrl(await managementUrl(resolve(config))); }
catch { console.error('Start the configured desktop before opening its management page.'); process.exitCode = 1; }
