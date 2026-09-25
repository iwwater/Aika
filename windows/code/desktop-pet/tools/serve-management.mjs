// Standalone Mock Management Server for Offline UI / Component Acceptance Testing ONLY.
// NOT PRODUCTION TRUTH. For real integration, launch via `npm start` or `tools/dev-desktop-real.mjs`.
// Strictly isolated: uses temporary synthetic SQLite, random session token, never opens user data.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { restrictPrivatePathSync } from '../dist/core/platform-files.js';
import { startManagementServer } from '../dist/management/server.js';
import { SkinStore } from '../dist/management/skin-store.js';
import { ManagementSettingsStore } from '../dist/management/settings-store.js';
import { ManagementRuntime } from '../dist/management/runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../dist/memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../dist/memory/management-port.js';
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../dist/core/trace-store.js';
import { readTraceContentFromHistory } from '../dist/memory/trace-history-content.js';
import { credentialRegistry } from '../dist/management/credentials.js';
import { availableAdapters } from '../dist/management/settings.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'desktop');
const acceptanceRunId = process.env.PET_ACCEPTANCE_RUN_ID;
if (acceptanceRunId && !/^[A-Za-z0-9_-]{1,64}$/.test(acceptanceRunId)) throw new Error('Invalid PET_ACCEPTANCE_RUN_ID');
const tempDir = resolve(root, '.local', acceptanceRunId ? `acceptance-mgmt-${acceptanceRunId}` : 'acceptance-mgmt');
mkdirSync(tempDir, { recursive: true });

async function main() {
  const skinsJson = resolve(tempDir, 'skins.json');
  const packsDir = resolve(tempDir, 'packs');
  mkdirSync(packsDir, { recursive: true });

  const store = await SkinStore.open(skinsJson, packsDir, desktop);

  const windowsRoot = resolve(root, '../..');
  const userTrialDir = resolve(windowsRoot, '.local/model-evaluation/trial/user-trial');
  const userConfigFile = resolve(userTrialDir, 'config.json');
  const userSettingsFile = resolve(userTrialDir, 'management-settings.json');
  const hasUserTrial = existsSync(userConfigFile) && existsSync(userSettingsFile);

  let rawConfig;
  let settings;
  let runtime;
  let memoryStore;
  let traceStore;

  if (hasUserTrial) {
    rawConfig = JSON.parse(readFileSync(userConfigFile, 'utf8'));
    settings = await ManagementSettingsStore.open(userSettingsFile, rawConfig);
    runtime = new ManagementRuntime(rawConfig.sourceRevision);
    const dbPath = rawConfig.database;
    memoryStore = new SqliteMemoryStore({
      filename: dbPath,
      retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    });
    traceStore = RuntimeTraceStore.open(dbPath);
  } else {
    const settingsJson = resolve(tempDir, 'settings.json');
    rawConfig = {
      version: 1, product: 'companion-v1', phaseId: 'local-acceptance', purpose: 'user-trial',
      projectRoot: root, sourceRevision: 'a'.repeat(40),
      runtimeFiles: {}, database: resolve(tempDir, 'sample-companion.sqlite'),
      budgetFile: resolve(tempDir, 'budget.json'), budgetBatchId: 'batch-acceptance',
      limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
      operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: 20, tts: 40 },
      memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
      models: {},
    };
    settings = await ManagementSettingsStore.open(settingsJson, rawConfig);
    runtime = new ManagementRuntime(rawConfig.sourceRevision);
    const sampleDb = resolve(tempDir, 'sample-companion.sqlite');
    memoryStore = new SqliteMemoryStore({
      filename: sampleDb,
      retention: CONFIRMED_RETENTION,
      invitations: confirmedInvitationPolicy('Asia/Shanghai'),
    });
    traceStore = RuntimeTraceStore.open(sampleDb);
  }

  const dummyLifecycle = {
    store: memoryStore,
    assertContextCurrent: () => {},
    context: async (scope, query) => {
      const records = memoryStore.queryRecords(scope, { kind: 'memory', query: query || '', offset: 0, limit: 10, state: 'active' });
      const transcripts = memoryStore.queryRecords(scope, { kind: 'transcript', query: '', offset: 0, limit: 10, state: 'active' });
      return {
        scope,
        characterPrompt: memoryStore.prompt(scope).text,
        recent: transcripts.records.map(r => ({ id: r.id, text: r.text, role: r.message?.role || 'user', createdAt: r.createdAt })),
        summaries: [],
        memories: records.records.map(r => ({ id: r.id, text: r.text, version: r.version })),
        perception: null,
        inputTokenBudget: 8192
      };
    }
  };
  const memoryPort = new SqliteManagementMemoryPort(memoryStore, dummyLifecycle);

  runtime.record({ module: 'memory', kind: 'state', message: `已成功连接数据库 (${rawConfig.database})` });
  runtime.record({ module: 'companion', kind: 'started', message: 'Aika 伴侣管理控制台已就绪' });
  runtime.record({ module: 'live2d', kind: 'completed', message: '模型外观与动作映射加载完成' });

  // RV75-08: Use unpredictable cryptographically secure token, never hardcoded.
  const token = randomBytes(32).toString('hex');
  process.on('uncaughtException', err => console.error('Uncaught:', err));
  process.on('unhandledRejection', err => console.error('Unhandled:', err));

  const instance = await startManagementServer({
    uiRoot: resolve(root, 'management/ui'),
    settings,
    skins: store,
    token,
    port: 10158,
    memory: memoryPort,
    traces: traceStore,
    traceContent: tr => readTraceContentFromHistory(memoryStore, tr),
    presentation: {
      snapshot: () => ({ modelId: 'local-model', revision: 0, enabledIds: [] }),
      allowedIntent: () => true,
      update: async () => ({ revision: 1 }),
      list: async () => []
    },
    knowledge: {
      listLibraries: async () => [{ id: 'sample-lib', name: '系统核心知识库', active: true, documentCount: 1, revision: 1 }],
      listDocuments: async () => [{ id: 'doc-1', title: '示例离线规范.md', tokenCount: 120, createdAt: new Date().toISOString() }],
      removeDocument: async () => ({ removed: true, revision: 2 }),
      getDocument: async (id) => ({ id, title: '示例离线规范.md', content: '# 示例离线规范\n\n这是系统知识库文档。', tokenCount: 120 })
    },
    continuity: {
      snapshot: async () => ({ version: 1, soul: [], wiki: [], relationship: [] }),
      record: async () => ({ fact: { id: 'sample-fact', version: 1 } }),
      correct: async () => ({ fact: { id: 'sample-fact', version: 2 } }),
      forget: async () => ({ removed: true })
    },
    snapshot: () => ({
      apiVersion: 1,
      runtime: runtime.identity(),
      modules: runtime.modules(),
      events: runtime.recentEvents(),
      adapters: hasUserTrial ? availableAdapters(rawConfig, settings.registeredVoices) : [],
      credentials: hasUserTrial ? credentialRegistry(rawConfig).list() : [],
      characters: [{ id: rawConfig.characterId || 'companion', label: '青梅竹马', revision: 1 }],
      settings: settings.snapshot()
    })
  });

  const configFile = resolve(tempDir, 'config.json');
  writeFileSync(configFile, JSON.stringify(rawConfig, null, 2), 'utf8');
  restrictPrivatePathSync(configFile);

  const sessionFile = resolve(tempDir, 'management-session.json');
  const descriptor = {
    version: 1,
    url: `${instance.origin}/#token=${token}`,
    pid: process.pid,
    instanceId: runtime.identity().instanceId,
    sourceRevision: runtime.identity().sourceRevision
  };
  writeFileSync(sessionFile, JSON.stringify(descriptor, null, 2), 'utf8');
  restrictPrivatePathSync(sessionFile);

  const url = `${instance.origin}/#page=overview&token=${token}`;
  console.log(`\n======================================================`);
  console.log(`  Aika-Next 运行控制台 (已连接真实数据库与凭据)`);
  console.log(`  数据库路径: ${rawConfig.database}`);
  console.log(`  访问地址: ${url}`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error('启动管理台失败:', err);
  process.exit(1);
});
