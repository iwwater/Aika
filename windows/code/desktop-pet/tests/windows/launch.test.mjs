import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { validateTrialConfiguration } from '../../dist/app/trial-config.js';
import { trialFiles, verifyTrialRuntime, prepareTrialLaunch } from '../../dist/app/trial-launcher.js';
const hash = value => createHash('sha256').update(value).digest('hex');
test('Windows launch pins host and preload, preserves spaced arguments, and refuses changed files', async t => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'AAAAGENT launch 中文 '));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const { models } = JSON.parse(await readFile(new URL('../../config/providers.example.json', import.meta.url), 'utf8'));
  for (const model of Object.values(models)) model.credentialFile = join(tmpdir(), 'synthetic-external.key');
  const runtimeFiles = {};
  for (const path of ['dist/app/trial-backend.js','dist/app/trial-launcher.js','desktop/build/renderer.js',
    'desktop/electron/main.mjs','desktop/electron/preload.cjs','desktop/electron/transport.mjs','desktop/electron/layout.mjs','desktop/electron/assets.mjs','tools/management-url.mjs']) {
    const key = 'code/desktop-pet/' + path, file = join(projectRoot, key);
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, 'synthetic'); runtimeFiles[key] = hash('synthetic');
  }
  const config = validateTrialConfiguration({ version: 1, desktopHost: 'electron', product: 'companion-v1', phaseId: 'local-trial-windows-test', purpose: 'user-trial',
    projectRoot, sourceRevision: 'a'.repeat(40), runtimeFiles, database: join(projectRoot, '.local/data/companion.sqlite'),
    budgetFile: join(projectRoot, '.local/model-evaluation/budget.json'), budgetBatchId: 'synthetic', budgetMode: 'unlimited', limitMicros: null,
    phaseLimitMicros: 0, maxCalls: 0, operationLimits: {}, models, memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 } });
  const { configFile, activationFile } = trialFiles(projectRoot), raw = JSON.stringify(config);
  await mkdir(dirname(configFile), { recursive: true }); await writeFile(configFile, raw);
  await writeFile(activationFile, JSON.stringify({ version: 1, phaseId: config.phaseId, status: 'active', configSha256: hash(raw) }));
  await verifyTrialRuntime(config);
  const plan = await prepareTrialLaunch(projectRoot, 'C:\\Node folder\\node.exe', { ELECTRON_RUN_AS_NODE: '1' });
  assert.ok(plan.executable.endsWith(process.platform === 'win32' ? 'electron.exe' : 'Electron'));
  assert.equal(plan.arguments.at(-1), 'C:\\Node folder\\node.exe');
  assert.equal(plan.environment.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(plan.environment.PET_TRIAL_CONFIG, configFile);
  await writeFile(join(projectRoot, 'code/desktop-pet/desktop/electron/preload.cjs'), 'changed');
  await assert.rejects(verifyTrialRuntime(config));
  const missing = structuredClone(config); delete missing.runtimeFiles['code/desktop-pet/desktop/electron/main.mjs'];
  assert.throws(() => validateTrialConfiguration(missing));
  assert.throws(() => validateTrialConfiguration({ ...config, runtimeFiles: { ...runtimeFiles, 'code/desktop-pet/C:\\escape': hash('x') } }));
});
