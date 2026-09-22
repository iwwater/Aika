// Standalone Mock Management Server for Offline UI / Component Acceptance Testing ONLY.
// NOT PRODUCTION TRUTH. For real integration, launch via `npm start` or `tools/dev-desktop-real.mjs`.
// Strictly isolated: uses temporary synthetic SQLite, random session token, never opens user data.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
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

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = resolve(root, 'desktop');
const tempDir = resolve(root, '.local/acceptance-mgmt');
mkdirSync(tempDir, { recursive: true });

async function main() {
  const skinsJson = resolve(tempDir, 'skins.json');
  const packsDir = resolve(tempDir, 'packs');
  mkdirSync(packsDir, { recursive: true });

  const store = await SkinStore.open(skinsJson, packsDir, desktop);

  // Settings store with mock/local trial config
  const settingsJson = resolve(tempDir, 'settings.json');
  const dummyConfig = {
    version: 1, product: 'companion-v1', phaseId: 'local-acceptance', purpose: 'user-trial',
    projectRoot: root, sourceRevision: 'a'.repeat(40),
    runtimeFiles: {}, database: resolve(tempDir, 'sample-companion.sqlite'),
    budgetFile: resolve(tempDir, 'budget.json'), budgetBatchId: 'batch-acceptance',
    limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
    operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: 20, tts: 40 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: {}
  };
  const settings = await ManagementSettingsStore.open(settingsJson, dummyConfig);
  const runtime = new ManagementRuntime(dummyConfig.sourceRevision);

  // RV75-08: Isolated sample database only. Never connects to user's real companion.sqlite.
  const sampleDb = resolve(tempDir, 'sample-companion.sqlite');
  const memoryStore = new SqliteMemoryStore({
    filename: sampleDb,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai')
  });

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

  runtime.record({ module: 'memory', kind: 'state', message: '已加载离线验收样本数据（与真实用户数据严格隔离）' });
  runtime.record({ module: 'companion', kind: 'started', message: '桌宠伴侣界面验收测试环境就绪' });
  runtime.record({ module: 'live2d', kind: 'completed', message: '模型外观与动作映射加载完成' });

  const traceStore = RuntimeTraceStore.open(sampleDb);

  // RV75-08: Use unpredictable cryptographically secure token, never hardcoded.
  const token = randomBytes(32).toString('hex');
  process.on('uncaughtException', err => console.error('Uncaught:', err));
  process.on('unhandledRejection', err => console.error('Unhandled:', err));

  // FIX-05: Injected mock presentation, knowledge, and continuity ports for standalone page testing.
  const instance = await startManagementServer({
    uiRoot: resolve(root, 'management/ui'),
    settings,
    skins: store,
    token,
    port: 10158,
    memory: memoryPort,
    traces: traceStore,
    presentation: {
      snapshot: () => ({ modelId: 'local-model', revision: 0, enabledIds: [] }),
      allowedIntent: () => true,
      update: async () => ({ revision: 1 }),
      list: async () => []
    },
    knowledge: {
      listLibraries: async () => [{ id: 'sample-lib', name: '示例知识库', active: true, documentCount: 1, revision: 1 }],
      listDocuments: async () => [{ id: 'doc-1', title: '示例离线规范.md', tokenCount: 120, createdAt: new Date().toISOString() }],
      removeDocument: async () => ({ removed: true, revision: 2 }),
      getDocument: async (id) => ({ id, title: '示例离线规范.md', content: '# 示例离线规范\n\n这是用于 UI 验收的离线样本。', tokenCount: 120 })
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
      adapters: [],
      credentials: [],
      characters: [{ id: 'companion', label: '青梅竹马（验收样本）', revision: 1 }],
      settings: settings.snapshot()
    })
  });

  const configFile = resolve(tempDir, 'config.json');
  writeFileSync(configFile, JSON.stringify(dummyConfig, null, 2), 'utf8');
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
  console.log(`  [HARNESS ONLY] Aika-Next 离线验收控制台（隔离样本环境）`);
  console.log(`  警告: 本服务仅用于 UI 模板/组件离线验证，不连真实桌宠与用户数据！`);
  console.log(`  访问地址: ${url}`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error('启动离线管理台失败:', err);
  process.exit(1);
});
