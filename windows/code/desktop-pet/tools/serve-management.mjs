// Standalone Management Server for Acceptance Testing
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { restrictPrivatePathSync } from '../dist/core/platform-files.js';
import { tmpdir } from 'node:os';
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
    runtimeFiles: {}, database: resolve(tempDir, 'data.sqlite'),
    budgetFile: resolve(tempDir, 'budget.json'), budgetBatchId: 'batch-acceptance',
    limitMicros: 20000000, phaseLimitMicros: 20000000, maxCalls: 200,
    operationLimits: { admission: 40, dialogue: 40, memory_turn: 40, summary: 20, perception: 20, tts: 40 },
    memory: { mode: 'strict', scheduling: 'semantic-admission', timeoutMs: 300000 },
    models: {}
  };
  const settings = await ManagementSettingsStore.open(settingsJson, dummyConfig);
  const runtime = new ManagementRuntime(dummyConfig.sourceRevision);
  const companionDb = resolve(root, '../../.local/data/companion.sqlite');
  const memoryStore = new SqliteMemoryStore({
    filename: companionDb,
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

  runtime.record({ module: 'memory', kind: 'state', message: '已从本地 SQLite 加载长期记忆库与对话连续性索引' });
  runtime.record({ module: 'companion', kind: 'started', message: '桌宠伴侣角色就绪，载入青梅竹马设定与实时情感引擎' });
  runtime.record({ module: 'live2d', kind: 'completed', message: '模型外观与动作映射加载完成' });

  const traceStore = RuntimeTraceStore.open(companionDb);

  const token = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
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
    snapshot: () => ({
      apiVersion: 1,
      runtime: runtime.identity(),
      modules: runtime.modules(),
      events: runtime.recentEvents(),
      adapters: [],
      credentials: [],
      characters: [{ id: 'companion', label: '青梅竹马', revision: 1 }],
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
  console.log(`  Aika-Next 运行控制台服务已就绪！`);
  console.log(`  访问地址: ${url}`);
  console.log(`======================================================\n`);
}

main().catch(err => {
  console.error('启动管理台失败:', err);
  process.exit(1);
});
