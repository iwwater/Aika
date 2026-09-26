import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readActiveTrialConfiguration, validateTrialConfiguration, type TrialConfiguration, type TrialModel, type TrialOperation } from '../../app/trial-config.js';
import { TrialAuthorizer, estimateTrialMicros } from '../../app/trial-authorizer.js';

const hash = (raw: string) => createHash('sha256').update(raw).digest('hex');
const scope = { characterId: 'friend' as const, sessionId: 'session', turnId: 'turn', generation: 1 };
export async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const parent = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.local/companion-step1-01/tmp');
  await mkdir(parent, { recursive: true });
  const projectRoot = await mkdtemp(join(parent, 'trial-config-'));
  // FIX61-10: on Windows, a SQLite file handle that was just closed (or a freshly created database
  // picked up by the antivirus scanner) can stay briefly locked, so the recursive rm fails with
  // EBUSY/EPERM even though the test itself passed. Retrying the cleanup with a backoff — up to
  // ~10 seconds, only for those transient codes — is test-infrastructure hygiene, not a relaxed
  // assertion; every other error surfaces immediately.
  t.after(async () => { for (let attempt = 0; ; attempt++) { try { await rm(projectRoot, { recursive: true, force: true }); return; } catch (error) { if (attempt >= 25 || !['EBUSY','EPERM','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; await new Promise(done => setTimeout(done, 400)); } } });
  const chat: TrialModel = { provider: 'dashscope', model: 'qwen-plus-2025-12-01', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    credentialFile: '/nonexistent-external-trial-key', reservationMicros: 100000, inputTokenLimit: 32768, outputTokenLimit: 32768, inputMicrosPerToken: .8, outputMicrosPerToken: 2 };
  const memory: TrialModel = { ...chat, provider: 'deepseek', credentialFile: '/nonexistent-external-deepseek-key', model: 'deepseek-v4-pro', endpoint: 'https://api.deepseek.com/chat/completions',
    reservationMicros: 11000000, inputMicrosPerToken: 9, outputMicrosPerToken: 27, outputTokenLimit: 393216, thinking: 'high' };
  const c: TrialConfiguration = { version: 1, product: 'companion-v1', phaseId: 'local-trial-controlled', purpose: 'user-trial', projectRoot, sourceRevision: 'a'.repeat(40),
    desktopHost: process.platform === 'win32' ? 'electron' : 'macos',
    runtimeFiles: Object.fromEntries((process.platform === 'win32'
      ? ['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
         'desktop/electron/main.mjs', 'desktop/electron/preload.cjs', 'desktop/electron/transport.mjs', 'desktop/electron/layout.mjs', 'desktop/electron/assets.mjs', 'tools/management-url.mjs']
      : ['dist/app/trial-backend.js', 'dist/app/trial-launcher.js', 'desktop/build/renderer.js',
         'desktop/build/星月陪伴.app/Contents/MacOS/DesktopPet']).map(p => [`code/desktop-pet/${p}`, hash('controlled')])),
    database: join(projectRoot, '.local/data/companion.sqlite'), budgetFile: join(projectRoot, '.local/model-evaluation/budget.json'),
    budgetBatchId: 'original-fixture-batch', limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
    operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: 20, tts: 40 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: { dialogue: chat, admission: chat, summary: chat, memory_turn: memory,
      perception: { ...chat, model: 'qwen3.5-omni-flash-2026-03-15', inputTokenLimit: 196608, outputTokenLimit: 65536,
        inputMicrosPerToken: 18, outputMicrosPerToken: 13.3, reservationMicros: 4500000 },
      tts: { ...chat, model: 'qwen3-tts-instruct-flash-2026-01-26', endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', characterMicros: 80 } } };
  const configFile = join(projectRoot, 'config.json'), activationFile = join(projectRoot, 'activation.json'), raw = JSON.stringify(c);
  await writeFile(configFile, raw); const activate = async (status = 'active') => writeFile(activationFile, JSON.stringify({ version: 1, product: 'companion-v1', phaseId: c.phaseId, status, configSha256: hash(raw) }));
  const historical = { operationId: 'historical-settled', model: 'prior', reservedMicros: 2000000, actualMicros: 1615338, status: 'settled' };
  await mkdir(dirname(c.budgetFile), { recursive: true }); await writeFile(c.budgetFile, JSON.stringify({ batchId: c.budgetBatchId, currency: 'CNY', limitMicros: 20000000, blocked: false, entries: [historical] }));
  await activate();
  return { c, configFile, activationFile, activate, historical, authorizer: new TrialAuthorizer(c, configFile, activationFile) };
}
