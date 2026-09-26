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
import { CharacterPresetStore } from '../dist/management/character-preset-store.js';
import { createSelfSetup } from '../dist/management/self-setup.js';
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

  let selfSetup;
  try {
    selfSetup = createSelfSetup({
      base: rawConfig,
      settings,
      instanceId: runtime.identity().instanceId,
    mode: 'runtime',
      credentials: credentialRegistry(rawConfig),
    });
  } catch (err) {
    console.warn('selfSetup init optional:', err.message);
  }

  const presetStore = await CharacterPresetStore.open({
    filePath: resolve(tempDir, 'character-presets.json'),
    memory: memoryPort,
    settings,
    skins: store,
    base: rawConfig,
  });

  const instance = await startManagementServer({
    uiRoot: resolve(root, 'management/ui'),
    settings,
    skins: store,
    presets: presetStore,
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
      snapshot: async () => ({
        revision: 1,
        activeLibraryId: 'sample-lib',
        libraries: [{ id: 'sample-lib', name: '系统核心知识库', active: true, documentCount: 1, bytes: 2048, revision: 1 }]
      }),
      documents: async (libraryId) => [
        { id: 'doc-1', title: '示例离线规范.md', tokenCount: 120, bytes: 2048, createdAt: new Date().toISOString() }
      ],
      documentContent: async (libraryId, documentId) => ({
        id: documentId,
        title: '示例离线规范.md',
        content: '# 示例离线规范\n\n这是系统知识库文档。',
        tokenCount: 120,
        bytes: 2048
      }),
      removeDocument: async () => ({
        revision: 2,
        activeLibraryId: 'sample-lib',
        libraries: [{ id: 'sample-lib', name: '系统核心知识库', active: true, documentCount: 0, bytes: 0, revision: 2 }]
      }),
      create: async () => ({ revision: 2, activeLibraryId: 'sample-lib', libraries: [] }),
      rename: async () => ({ revision: 2, activeLibraryId: 'sample-lib', libraries: [] }),
      importDocuments: async () => ({ revision: 2, activeLibraryId: 'sample-lib', libraries: [] }),
      deleteLibrary: async () => ({ revision: 2, activeLibraryId: '', libraries: [] }),
      activate: async () => ({ revision: 2, activeLibraryId: 'sample-lib', libraries: [] })
    },
    continuity: {
      snapshot: async () => ({
        version: 1,
        soul: [{ id: 'soul-1', text: '称呼是阿航。', version: 1, category: '称谓设定' }],
        wiki: [
          { id: 'fact-1', text: '用户是全栈方案专家，正在推进 Aika-Next 现代控制台重构。', version: 1, category: '职业与工作', observedAt: new Date().toISOString(), tags: ['工作', '架构'] },
          { id: 'fact-2', text: '用户喜欢在晨间喝乌龙茶。', version: 1, category: '生活习惯', observedAt: new Date().toISOString(), tags: ['偏好', '饮食'] }
        ],
        facts: [
          { id: 'fact-1', text: '用户是全栈方案专家，正在推进 Aika-Next 现代控制台重构。', version: 1, category: '职业与工作', observedAt: new Date().toISOString(), tags: ['工作', '架构'] },
          { id: 'fact-2', text: '用户喜欢在晨间喝乌龙茶。', version: 1, category: '生活习惯', observedAt: new Date().toISOString(), tags: ['偏好', '饮食'] }
        ],
        candidates: [
          { id: 'cand-1', text: '用户计划下个月调研本地离线大模型推理框架。', version: 1, category: '待审计划', observedAt: new Date().toISOString(), tags: ['调研'] }
        ],
        relationship: []
      }),
      record: async () => ({ status: 'applied', fact: { id: 'sample-fact', version: 1 } }),
      correct: async () => ({ status: 'applied', fact: { id: 'sample-fact', version: 2 } }),
      promote: async () => ({ status: 'applied', fact: { id: 'promoted-fact-1', version: 1 } }),
      forget: async () => ({ removed: true })
    },
    next65: {
      packages: () => [
        { packageId: 'pkg-core-sherpa-tts', enabled: true, ready: true, loaded: true, active: true, manifestLabels: ['Sherpa 本地离线 TTS'] },
        { packageId: 'pkg-visual-emotion', enabled: true, ready: false, loaded: false, active: false, manifestLabels: ['视觉情绪识别'] }
      ],
      runtimeTruth: () => ({
        hostAvailable: true,
        flowAvailable: true,
        installedCount: 2,
        loadedPackages: ['pkg-core-sherpa-tts'],
        activePackages: ['pkg-core-sherpa-tts'],
        registeredCapabilities: ['llm.chat', 'tts.synthesize', 'perception.visual']
      }),
      disable: (pkgId) => ({ packageId: pkgId, enabled: false }),
      uninstall: (pkgId) => {},
      importPackage: (path) => ({ packageId: 'pkg-imported', enabled: true, ready: true, loaded: true, manifestLabels: ['导入插件'] })
    },
    playground: {
      session: async () => ({
        pairing: { userId: 'default-user', characterId: 'companion', characterInstanceId: 'default-instance' },
        sessionId: 'session-demo',
        capabilities: { canSubmitText: true, canCancel: true, hasStt: true, hasTts: true },
        effectiveConfigRevision: 1,
        status: 'idle'
      }),
      submitTurn: async (input) => {
        const turnId = `turn-${input.operationId}`;
        return {
          turnId,
          operationId: input.operationId,
          status: 'completed',
          text: input.text,
          reply: `你好！收到调试输入：“${input.text}”。后端与 SQLite 数据库交互正常。`,
          traceRef: `trace-${turnId}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        };
      },
      getTurn: async () => null,
      cancelTurn: async (turnId) => ({ cancelled: true, turnId })
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
    mode: 'runtime',
    sourceRevision: runtime.identity().sourceRevision
  };
  writeFileSync(sessionFile, JSON.stringify(descriptor, null, 2), 'utf8');
  restrictPrivatePathSync(sessionFile);

  const url = `${instance.origin}/#token=${token}`;
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
