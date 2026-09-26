import { test, expect } from '@playwright/test';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { startManagementServer } from '../../dist/management/server.js';
import { ManagementSettingsStore } from '../../dist/management/settings-store.js';
import { ManagementRuntime } from '../../dist/management/runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../dist/memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../../dist/memory/management-port.js';
import { confirmedInvitationPolicy } from '../../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../../dist/core/trace-store.js';
import { SkinStore } from '../../dist/management/skin-store.js';
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js';
import { availableAdapters } from '../../dist/management/settings.js';
import { credentialRegistry } from '../../dist/management/credentials.js';

test.use({
  launchOptions: {
    executablePath: 'C:\\Users\\ZYF\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe',
    headless: true,
  },
  viewport: { width: 1280, height: 860 },
});

let serverInstance;
let memoryStore;
let traceStore;
let targetUrl;
const consoleErrors = [];

test.beforeAll(async () => {
  test.setTimeout(120000);
  const root = resolve('..', '..'); // F:\AIVoice\Aika-Next\windows
  const userTrialDir = resolve(root, '.local/model-evaluation/trial/user-trial');
  const userConfigFile = resolve(userTrialDir, 'config.json');
  const userSettingsFile = resolve(userTrialDir, 'management-settings.json');

  const rawConfig = JSON.parse(readFileSync(userConfigFile, 'utf8'));
  const dbPath = rawConfig.database;

  // 1. Open Real SQLite Database & Stores
  memoryStore = new SqliteMemoryStore({
    filename: dbPath,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai'),
  });
  traceStore = RuntimeTraceStore.open(dbPath);

  const settings = await ManagementSettingsStore.open(userSettingsFile, rawConfig);
  const runtime = new ManagementRuntime(rawConfig.sourceRevision);

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

  const token = randomBytes(32).toString('hex');
  const turnsMap = new Map();

  const skinsJson = resolve('.local/acceptance-mgmt/skins.json');
  const packsDir = resolve('.local/acceptance-mgmt/packs');
  const skinsStore = await SkinStore.open(skinsJson, packsDir, resolve('desktop'));
  const presetStore = await CharacterPresetStore.open({
    filePath: resolve('.local/acceptance-mgmt/character-presets.json'),
    memory: memoryPort,
    settings,
    skins: skinsStore,
    base: rawConfig,
  });

  serverInstance = await startManagementServer({
    uiRoot: resolve('management/ui'),
    settings,
    skins: skinsStore,
    presets: presetStore,
    token,
    port: 0,
    memory: memoryPort,
    traces: traceStore,
    traceContent: tr => ({
      traceId: tr.traceId,
      userMessage: '用户自动化测试消息',
      assistantMessage: '助手自动化回复内容',
      retrievedMemories: []
    }),
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
      snapshot: async (pairing, includeCandidates) => ({
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
        candidates: includeCandidates ? [
          { id: 'cand-1', text: '用户计划下个月调研本地离线大模型推理框架。', version: 1, category: '待审计划', observedAt: new Date().toISOString(), tags: ['调研'] }
        ] : [],
        relationship: []
      }),
      record: async () => ({ status: 'applied', fact: { id: 'new-fact-1', version: 1 } }),
      promote: async () => ({ status: 'applied', fact: { id: 'promoted-fact-1', version: 1 } }),
      correct: async () => ({ status: 'applied', fact: { id: 'fact-1', version: 2 } }),
      forget: async () => ({ removed: true })
    },
    playground: {
      session: async (pairing) => ({
        pairing: pairing || { userId: 'default-user', characterId: 'companion', characterInstanceId: 'default-instance' },
        sessionId: 'playwright-session-01',
        capabilities: { canSubmitText: true, canCancel: true, hasStt: true, hasTts: true },
        effectiveConfigRevision: 1,
        status: 'idle'
      }),
      submitTurn: async (input) => {
        const turnId = `turn-${input.operationId}`;
        const turn = {
          turnId,
          operationId: input.operationId,
          status: 'completed',
          text: input.text,
          reply: `收到调试输入：“${input.text}”。后端服务响应正常，SQLite 数据库连接稳定！`,
          traceRef: `trace-${turnId}`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString()
        };
        turnsMap.set(turnId, turn);
        return turn;
      },
      getTurn: async (turnId) => turnsMap.get(turnId) || null,
      cancelTurn: async (turnId) => {
        const turn = turnsMap.get(turnId);
        if (turn) turn.status = 'cancelled';
        return { cancelled: true, turnId };
      }
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
    health: {
      check: async () => ({ ok: true, status: 'healthy', modules: runtime.modules() })
    },
    microphone: {
      test: async () => ({ ok: true, device: 'Default Microphone', volume: 0.85 })
    },
    snapshot: () => ({
      apiVersion: 1,
      runtime: runtime.identity(),
      modules: runtime.modules(),
      events: runtime.recentEvents(),
      adapters: availableAdapters(rawConfig, settings.registeredVoices),
      credentials: credentialRegistry(rawConfig).list(),
      characters: [{ id: rawConfig.characterId || 'companion', label: '青梅竹马', revision: 1 }],
      settings: settings.snapshot()
    })
  });

  targetUrl = `${serverInstance.origin}/#token=${token}`;
});

test.afterAll(async () => {
  if (serverInstance) serverInstance.close();
  if (memoryStore) memoryStore.close();
});

test('Playwright Acceptance: Verify SQLite Database Connection & Queries', async () => {
  // 1. Query Prompt directly from SQLite
  const prompt = memoryStore.prompt({ characterId: 'companion', sessionId: 'test', turnId: '1', generation: 1 });
  expect(prompt).toBeDefined();
  expect(typeof prompt).toBe('string');
  expect(prompt.length).toBeGreaterThan(10);

  // 2. Query records directly from SQLite
  const activeRecords = memoryStore.queryRecords(
    { characterId: 'companion', sessionId: 'test', turnId: '1', generation: 1 },
    { kind: 'memory', query: '', offset: 0, limit: 10, state: 'active' }
  );
  expect(activeRecords).toBeDefined();
  expect(Array.isArray(activeRecords.records)).toBe(true);
  expect(activeRecords.total).toBeGreaterThanOrEqual(1);

  // 3. Query traces directly from SQLite RuntimeTraceStore
  const traces = traceStore.list({ characterId: 'companion', limit: 10, offset: 0, debugOptIn: false });
  expect(traces).toBeDefined();
  expect(Array.isArray(traces.traces)).toBe(true);
});

test('Playwright Acceptance: End-to-End Navigation, Interaction & UI Validation', async ({ page }) => {
  test.setTimeout(120000);
  page.on('response', res => {
    if (res.status() >= 400) {
      console.log('[PW_RES_FAIL]', res.status(), res.url());
    }
  });
  page.on('console', msg => {
    console.log(`[PW_${msg.type().toUpperCase()}]`, msg.text());
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', err => {
    console.log('[PW_UNCAUGHT]', err);
  });

  // 1. Visit Target URL (Token in hash should be parsed and cleaned from address bar)
  await page.goto(targetUrl);
  await page.waitForLoadState('domcontentloaded');

  // Verify URL token is cleaned from address bar
  await expect(page).toHaveURL(/#?$/);

  // 2. Validate Top Navbar: 6 Primary Entries exist
  const navButtons = page.locator('.navbar-nav .nav-module-btn');
  await expect(navButtons).toHaveCount(6);

  const navLabels = await navButtons.allTextContents();
  expect(navLabels.some(l => l.includes('运行总览'))).toBe(true);
  expect(navLabels.some(l => l.includes('知识与 Wiki'))).toBe(true);
  expect(navLabels.some(l => l.includes('角色配置'))).toBe(true);
  expect(navLabels.some(l => l.includes('Playground'))).toBe(true);
  expect(navLabels.some(l => l.includes('插件扩展'))).toBe(true);
  expect(navLabels.some(l => l.includes('全局设置'))).toBe(true);

  // 3. Module 1: Dashboard (运行总览)
  await expect(page.locator('text=当前角色: companion')).toBeVisible({ timeout: 5000 });

  // Verify Dashboard semantic cards
  const cards = page.locator('.dashboard-card');
  expect(await cards.count()).toBeGreaterThanOrEqual(4);

  // Current Character & Effective Model & Real SQLite Stats
  await expect(page.locator('text=今日运行与沉淀概览')).toBeVisible();
  await expect(page.locator('text=正式对话轮次')).toBeVisible();
  await expect(page.locator('text=沉淀记忆事实')).toBeVisible();
  await expect(page.locator('text=核心链路与能力就绪')).toBeVisible();

  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/01_dashboard.png' });

  // 4. Module 2: Knowledge (知识与 Wiki)
  await page.click('button:has-text("知识与 Wiki")');
  await page.waitForTimeout(600);

  await expect(page.locator('text=沉淀知识库与事实 Wiki')).toBeVisible();
  await expect(page.locator('button:has-text("用户记忆事实")')).toBeVisible();
  await expect(page.locator('button:has-text("角色原作 Canon")')).toBeVisible();
  await expect(page.locator('button:has-text("待审候选")')).toBeVisible();

  // Verify settled user fact loaded from backend
  await expect(page.locator('text=用户是全栈方案专家')).toBeVisible();

  // Test click fact to open detail
  await page.click('text=用户是全栈方案专家');
  await page.waitForTimeout(300);
  await expect(page.locator('text=知识详情 · 职业与工作')).toBeVisible();

  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/02_knowledge_wiki.png' });

  // Test switch to "参考资料库" subtab
  await page.click('.sub-nav-tabs button:has-text("参考资料库")');
  await page.waitForTimeout(500);
  await expect(page.locator('.modern-knowledge-container')).toBeVisible();

  // 5. Module 3: Characters (角色配置 - 统一预设视图)
  await page.click('button:has-text("角色配置")');
  await page.waitForTimeout(500);

  // Verify unified Character Preset page and sections in order
  await expect(page.locator('.character-preset-container')).toBeVisible();
  await expect(page.locator('text=当前角色预设 · 作用域与版本状态')).toBeVisible();
  await expect(page.locator('text=1. 表现资源引用')).toBeVisible();
  await expect(page.locator('text=2. Persona 人设设定')).toBeVisible();
  await expect(page.locator('text=3. 模型链路与音色绑定')).toBeVisible();

  // Test updating persona in Character Preset
  await page.fill('#preset-persona-text', '青梅竹马伴侣设定 · Playwright 验收更新。');
  await page.click('button:has-text("保存角色预设")');
  await page.waitForTimeout(400);
  await expect(page.locator('.notice.success')).toBeVisible();
  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/03_characters_preset.png' });

  // Test Appearance view via deep link: Live2D, Sprite Sheet, and Static Image presets switching
  await page.evaluate(() => window.selectCanonicalPage('characters', 'appearance'));
  await page.waitForTimeout(600);

  await expect(page.getByRole('heading', { name: '外观 / 换肤' })).toBeVisible();

  // Verify all 3 imported presets are present: Live2D, Sprite, Static Image
  await expect(page.locator('.card-title:has-text("预设 Live2D · 名取执事")')).toBeVisible();
  await expect(page.locator('.card-title:has-text("预设精灵图 · Aika Chibi Sprite")')).toBeVisible();
  await expect(page.locator('.card-title:has-text("预设静态立绘 · Aika Portrait Image")')).toBeVisible();

  // 1. Switch to Live2D preset
  await page.click('#skin-activate-preset-live2d-natori');
  await page.waitForTimeout(400);
  await expect(page.locator('#skin-activate-preset-live2d-natori:has-text("已是当前外观")')).toBeVisible();
  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/03_characters_live2d.png' });

  // 2. Switch to Sprite preset
  await page.click('#skin-activate-preset-sprite-chibi');
  await page.waitForTimeout(400);
  await expect(page.locator('#skin-activate-preset-sprite-chibi:has-text("已是当前外观")')).toBeVisible();
  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/03_characters_sprite.png' });

  // 3. Switch to Static image preset
  await page.click('#skin-activate-preset-static-portrait');
  await page.waitForTimeout(400);
  await expect(page.locator('#skin-activate-preset-static-portrait:has-text("已是当前外观")')).toBeVisible();
  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/03_characters_static.png' });

  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/03_characters.png' });

  // 6. Module 4: Playground (正式调试)
  await page.click('button:has-text("Playground")');
  await page.waitForTimeout(500);

  // Verify Safety Banner
  await expect(page.locator('text=正式调试模式：当前会话与桌宠共享生产对话通道')).toBeVisible();
  await expect(page.locator('text=当前角色: companion')).toBeVisible();

  // Test submitting a text turn in Playground
  const textarea = page.locator('#playground-text-input');
  await expect(textarea).toBeVisible();
  await textarea.fill('你好！这是来自 Playwright 自动化验收测试的问候。');

  await page.click('button:has-text("发送调试轮次")');
  await page.waitForTimeout(800);

  // Verify user bubble & assistant response bubble appear
  await expect(page.locator('.user-bubble:has-text("来自 Playwright 自动化验收测试")')).toBeVisible();
  await expect(page.locator('.assistant-bubble:has-text("收到调试输入")')).toBeVisible();
  await expect(page.locator('text=查看本次调用 Trace')).toBeVisible();

  // Verify Context Probe section
  await expect(page.locator('text=上下文检索试算 (Context Probe)')).toBeVisible();

  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/04_playground.png' });

  // 7. Module 5: Plugins (插件扩展)
  await page.click('button:has-text("插件扩展")');
  await page.waitForTimeout(500);

  await expect(page.locator('text=插件扩展与能力包 (Plugins)')).toBeVisible();
  await expect(page.locator('text=pkg-core-sherpa-tts')).toBeVisible();
  await expect(page.locator('text=已就绪 (Ready)')).toBeVisible();

  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/05_plugins.png' });

  // 8. Module 6: Settings (全局设置)
  await page.click('button:has-text("全局设置")');
  await page.waitForTimeout(500);

  // Verify Settings subtabs: sources, privacy, work, integrations, diagnostics, developer_mode
  await expect(page.locator('.sub-nav-tabs button:has-text("模型来源与凭据")')).toBeVisible();
  await expect(page.locator('.sub-nav-tabs button:has-text("隐私与授权感知")')).toBeVisible();
  await expect(page.locator('.sub-nav-tabs button:has-text("工作协议与任务")')).toBeVisible();
  await expect(page.locator('.sub-nav-tabs button:has-text("外部集成 (微信)")')).toBeVisible();
  await expect(page.locator('.sub-nav-tabs button:has-text("系统诊断与模块监控")')).toBeVisible();
  await expect(page.locator('.sub-nav-tabs button:has-text("开发者选项")')).toBeVisible();

  // Test Developer Mode toggle in Settings
  await page.click('.sub-nav-tabs button:has-text("开发者选项")');
  await page.waitForTimeout(300);

  await expect(page.locator('text=当前开发者模式状态：已关闭')).toBeVisible();
  await page.click('button:has-text("开启开发者模式")');
  await page.waitForTimeout(400);

  // 9. Module 7: Developer (开启后主导航展示 "开发者 Trace")
  const devNavBtn = page.locator('button:has-text("开发者 Trace")');
  await expect(devNavBtn).toBeVisible();

  await devNavBtn.click();
  await page.waitForTimeout(500);

  await expect(page.locator('text=开发者调试中心 (Developer Mode)')).toBeVisible();
  await expect(page.locator('button:has-text("LLM / Chat Trace")')).toBeVisible();
  await expect(page.locator('button:has-text("Knowledge Ingest Trace")')).toBeVisible();
  await expect(page.locator('button:has-text("Timeline Companion")')).toBeVisible();
  await expect(page.locator('button:has-text("Runtime Logs")')).toBeVisible();

  // Switch to Knowledge Ingest Trace
  await page.click('button:has-text("Knowledge Ingest Trace")');
  await page.waitForTimeout(300);
  await expect(page.locator('text=知识整理与沉淀批次流水')).toBeVisible();

  await page.screenshot({ path: 'F:/AIVoice/Aika-Next/docs/next/ui-rework/evidence/playwright/06_developer_trace.png' });
});
