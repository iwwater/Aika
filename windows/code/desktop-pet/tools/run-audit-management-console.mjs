#!/usr/bin/env node
/**
 * tools/run-audit-management-console.mjs
 *
 * Node-side launcher for full Management Console automated frontend acceptance.
 * 1. Opens real production SQLite and management stores in Node (ABI compatible).
 * 2. Spawns Electron to drive the Chromium browser frontend.
 * 3. Aggregates results, outputs formatted audit summary, and exits with code 0 on pass.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, mkdirSync } from 'node:fs';

import { startManagementServer } from '../dist/management/server.js';
import { SkinStore } from '../dist/management/skin-store.js';
import { ManagementSettingsStore } from '../dist/management/settings-store.js';
import { ManagementRuntime } from '../dist/management/runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../dist/memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../dist/memory/management-port.js';
import { confirmedInvitationPolicy } from '../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../dist/core/trace-store.js';
import { readTraceContentFromHistory } from '../dist/memory/trace-history-content.js';
import { healthManagement } from '../dist/management/health-routes.js';
import { knowledgeManagement } from '../dist/management/knowledge-routes.js';
import { continuityManagement } from '../dist/management/continuity-routes.js';
import { presentationAssetRoutes } from '../dist/management/presentation-assets.js';
import { PresentationSettingsStore, readPresentationCatalog } from '../dist/management/presentation.js';

const here = dirname(fileURLToPath(import.meta.url));
const codeRoot = resolve(here, '..');
const windowsRoot = resolve(codeRoot, '../..');
const trialDir = resolve(windowsRoot, '.local/model-evaluation/trial/user-trial');
const evidenceDir = resolve(windowsRoot, 'docs/next/0.79/evidence/acceptance-20260923');
mkdirSync(evidenceDir, { recursive: true });

async function main() {
  const rawConfig = JSON.parse(readFileSync(resolve(trialDir, 'config.json'), 'utf8'));
  const dbPath = rawConfig.database;

  // Real database & stores
  const memoryStore = new SqliteMemoryStore({
    filename: dbPath,
    retention: CONFIRMED_RETENTION,
    invitations: confirmedInvitationPolicy('Asia/Shanghai')
  });

  const memoryPort = new SqliteManagementMemoryPort(memoryStore, {
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
  });

  const traceStore = RuntimeTraceStore.open(dbPath);
  const skinsJson = resolve(windowsRoot, '.local/skins.json');
  const skinsStore = await SkinStore.open(skinsJson, resolve(windowsRoot, '.local/packs'), resolve(codeRoot, 'desktop'));
  const settingsStore = await ManagementSettingsStore.open(resolve(trialDir, 'management-settings.json'), rawConfig);
  const runtime = new ManagementRuntime(rawConfig.sourceRevision);
  const presentationAssets = await presentationAssetRoutes(windowsRoot);
  const catalog = await readPresentationCatalog(windowsRoot);
  const presentationSettings = await PresentationSettingsStore.open(resolve(trialDir, 'presentation-settings.json'), catalog);

  const server = await startManagementServer({
    uiRoot: resolve(codeRoot, 'management/ui'),
    settings: settingsStore,
    memory: memoryPort,
    traces: traceStore,
    traceContent: tr => readTraceContentFromHistory(memoryStore, tr),
    skins: skinsStore,
    health: healthManagement(runtime.health),
    presentation: presentationSettings,
    presentationAssets,
    knowledge: knowledgeManagement({
      listLibraries: async () => [{ id: 'knowledge-core', name: '系统核心知识库', active: true, documentCount: 0, revision: 1 }],
      listDocuments: async () => [],
      removeDocument: async () => ({ removed: true, revision: 2 }),
      getDocument: async () => null
    }),
    continuity: continuityManagement({
      snapshot: async () => ({ version: 1, soul: [], wiki: [], relationship: [] }),
      record: async () => ({ fact: { id: 'sample-fact', version: 1 } }),
      correct: async () => ({ fact: { id: 'sample-fact', version: 2 } }),
      forget: async () => ({ removed: true })
    }),
    snapshot: () => ({
      apiVersion: 1,
      runtime: runtime.identity(),
      modules: runtime.modules(),
      events: runtime.recentEvents(),
      adapters: [],
      credentials: [],
      characters: [{ id: rawConfig.characterId || 'companion', label: '青梅竹马', revision: 1 }],
      settings: settingsStore.snapshot()
    })
  });

  const targetUrl = `${server.origin}/#token=${server.token}&page=overview`;
  console.log(`[Server] Management server listening at: ${server.origin}`);

  const electronPath = createRequire(import.meta.url)('electron');
  const browserScript = resolve(here, '../tests/management/console-audit-electron.mjs');

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, [browserScript, targetUrl], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; process.stdout.write(b); });
  child.stderr.on('data', b => { stderr += b; process.stderr.write(b); });

  const exitCode = await new Promise((done) => {
    const timeout = setTimeout(() => {
      child.kill();
      console.error('[Error] Browser audit timed out after 90 seconds');
      done(1);
    }, 90000);
    child.once('exit', code => {
      clearTimeout(timeout);
      done(code ?? 0);
    });
  });

  server.close();
  memoryStore.close();

  const marker = 'CONSOLE_AUDIT_UI_RESULT=';
  const resultLine = stdout.split(/\r?\n/).find(l => l.startsWith(marker));
  if (!resultLine) {
    console.error(`[Error] No structured audit result received. (exitCode=${exitCode}, stderr=${stderr})`);
    process.exit(1);
  }

  const result = JSON.parse(resultLine.slice(marker.length));
  console.log('\n======================================================');
  console.log(`  管理控制台前端全项自动化验收汇总报告:`);
  console.log(`  综合裁定: ${result.overallVerdict}`);
  console.log(`  检查页面数: ${result.pagesTested?.length || 0}`);
  console.log(`  通过页面数: ${result.pagesTested?.filter(p => p.verdict === 'PASS').length || 0}`);
  console.log(`  警告页面数: ${result.pagesTested?.filter(p => p.verdict === 'WARN').length || 0}`);
  console.log(`  记忆子分区数: ${result.memorySectionsTested?.length || 0}`);
  console.log(`  记忆遗忘确认交互: ${result.interactiveTests?.memoryForgetConfirmation?.success ? 'PASS' : 'FAIL'}`);
  console.log(`  Trace 默认脱敏与展开: ${result.interactiveTests?.traceMaskingAndReveal?.success ? 'PASS' : 'FAIL'}`);
  console.log(`  生成证据截图数: ${result.screenshots?.length || 0}`);
  console.log(`  控制台严重错误: ${result.browserErrors?.length || 0}`);
  console.log('======================================================\n');

  process.exit((result.overallVerdict && result.overallVerdict.startsWith('PASS')) ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal audit launcher error:', err);
  process.exit(1);
});
