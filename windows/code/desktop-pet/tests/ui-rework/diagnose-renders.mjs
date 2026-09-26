import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

import { startManagementServer } from '../../dist/management/server.js';
import { ManagementSettingsStore } from '../../dist/management/settings-store.js';
import { ManagementRuntime } from '../../dist/management/runtime.js';
import { SqliteMemoryStore, CONFIRMED_RETENTION } from '../../dist/memory/sqlite-store.js';
import { SqliteManagementMemoryPort } from '../../dist/memory/management-port.js';
import { confirmedInvitationPolicy } from '../../dist/companion/invitations.js';
import { RuntimeTraceStore } from '../../dist/core/trace-store.js';

const root = resolve('..', '..');
const userTrialDir = resolve(root, '.local/model-evaluation/trial/user-trial');
const rawConfig = JSON.parse(readFileSync(resolve(userTrialDir, 'config.json'), 'utf8'));
const settings = await ManagementSettingsStore.open(resolve(userTrialDir, 'management-settings.json'), rawConfig);
const runtime = new ManagementRuntime(rawConfig.sourceRevision);
const memoryStore = new SqliteMemoryStore({ filename: rawConfig.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
const traceStore = RuntimeTraceStore.open(rawConfig.database);
const memoryPort = new SqliteManagementMemoryPort(memoryStore, { store: memoryStore, assertContextCurrent: () => {}, context: async (s, q) => ({ scope: s, characterPrompt: '', recent: [], summaries: [], memories: [], perception: null, inputTokenBudget: 8192 }) });
const token = randomBytes(32).toString('hex');

const server = await startManagementServer({
  uiRoot: resolve('management/ui'),
  settings,
  token,
  port: 0,
  memory: memoryPort,
  traces: traceStore,
  snapshot: () => ({ apiVersion: 1, runtime: runtime.identity(), modules: runtime.modules(), events: runtime.recentEvents(), adapters: [], credentials: [], characters: [{ id: 'companion', label: '青梅竹马', revision: 1 }], settings: settings.snapshot() })
});

const browser = await chromium.launch({
  executablePath: 'C:\\Users\\ZYF\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe',
  headless: true
});
const page = await browser.newPage();
page.on('console', msg => console.log('PAGE_LOG:', msg.text()));

await page.goto(server.origin + '/#token=' + token);
await page.waitForTimeout(600);

// Hook replaceChildren on app element
await page.evaluate(() => {
  window.renderCount = 0;
  const app = document.getElementById('app');
  const orig = app.replaceChildren;
  app.replaceChildren = function(...args) {
    window.renderCount++;
    if (window.renderCount <= 10) {
      console.log(`[RENDER_TRIGGERED #${window.renderCount}] Stack:\n`, new Error().stack);
    }
    return orig.apply(this, args);
  };
});

console.log('--- Clicking Playground ---');
await page.click('button:has-text("Playground")');
await page.waitForTimeout(300);

console.log('--- Clicking 插件扩展 ---');
await page.click('button:has-text("插件扩展")');
await page.waitForTimeout(300);

console.log('--- Clicking 全局设置 ---');
await page.click('button:has-text("全局设置")');
await page.waitForTimeout(600);

await browser.close();
server.close();
memoryStore.close();
