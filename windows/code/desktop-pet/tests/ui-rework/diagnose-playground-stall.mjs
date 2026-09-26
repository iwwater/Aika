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
import { CharacterPresetStore } from '../../dist/management/character-preset-store.js';

const root = resolve('..', '..');
const userTrialDir = resolve(root, '.local/model-evaluation/trial/user-trial');
const rawConfig = JSON.parse(readFileSync(resolve(userTrialDir, 'config.json'), 'utf8'));
const settings = await ManagementSettingsStore.open(resolve(userTrialDir, 'management-settings.json'), rawConfig);
const runtime = new ManagementRuntime(rawConfig.sourceRevision);
const memoryStore = new SqliteMemoryStore({ filename: rawConfig.database, retention: CONFIRMED_RETENTION, invitations: confirmedInvitationPolicy('Asia/Shanghai') });
const traceStore = RuntimeTraceStore.open(rawConfig.database);
const memoryPort = new SqliteManagementMemoryPort(memoryStore, { store: memoryStore, assertContextCurrent: () => {}, context: async (s, q) => ({ scope: s, characterPrompt: '', recent: [], summaries: [], memories: [], perception: null, inputTokenBudget: 8192 }) });
const token = randomBytes(32).toString('hex');
const presets = await CharacterPresetStore.open({
  memory: memoryPort,
  settings,
  base: rawConfig,
});

let submitDelayMs = 0;
let failSubmit = false;
let failSession = false;

const server = await startManagementServer({
  uiRoot: resolve('management/ui'),
  settings,
  token,
  port: 0,
  memory: memoryPort,
  traces: traceStore,
  presets,
  playground: {
    session: async () => {
      if (failSession) throw new Error('Backend session disconnected');
      return {
        pairing: { userId: 'u', characterId: 'companion', characterInstanceId: 'i' },
        sessionId: 'diag-session',
        capabilities: { canSubmitText: true, canCancel: true, hasStt: true, hasTts: true },
        effectiveConfigRevision: 1,
        status: 'idle'
      };
    },
    submitTurn: async (input) => {
      if (submitDelayMs > 0) {
        await new Promise(r => setTimeout(r, submitDelayMs));
      }
      if (failSubmit) throw new Error('Backend failed to process turn');
      return {
        turnId: `turn-${input.operationId}`,
        operationId: input.operationId,
        status: 'completed',
        text: input.text,
        reply: `Echo: ${input.text}`,
        traceRef: `trace-1`,
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
    adapters: [],
    credentials: [],
    characters: [{ id: 'companion', label: '青梅竹马', revision: 1 }],
    settings: settings.snapshot()
  })
});

const browser = await chromium.launch({
  executablePath: 'C:\\Users\\ZYF\\AppData\\Local\\ms-playwright\\chromium-1217\\chrome-win64\\chrome.exe',
  headless: true
});
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

await page.goto(`${server.origin}/#token=${token}`);
await page.waitForTimeout(600);

const tabsToTest = ['运行总览', '知识与 Wiki', '角色配置', '插件扩展', '全局设置'];

async function measureNavigationFromPlayground(scenarioName) {
  console.log(`\n=== Testing Scenario: ${scenarioName} ===`);
  await page.click('button:has-text("Playground")');
  await page.waitForTimeout(300);

  for (const tabName of tabsToTest) {
    const tStart = Date.now();
    await page.click(`button:has-text("${tabName}")`);
    const elapsed = Date.now() - tStart;
    console.log(`[Metric] Switch to ${tabName}: ${elapsed}ms (Requirement: < 200ms)`);
    if (elapsed >= 200) {
      console.error(`[FAIL] Exceeded 200ms limit! Took ${elapsed}ms`);
      process.exit(1);
    }
    // Return back to Playground for the next tab switch test
    await page.click('button:has-text("Playground")');
    await page.waitForTimeout(100);
  }
}

// 1. Normal Scenario
submitDelayMs = 0;
failSubmit = false;
failSession = false;
await page.click('button:has-text("Playground")');
await page.waitForTimeout(300);
await page.fill('#playground-text-input', 'Normal turn message');
await page.click('button:has-text("发送调试轮次")');
await page.waitForTimeout(200);
await measureNavigationFromPlayground('Normal Request Completed');

// 2. Slow Request In-Flight Scenario (2000ms server delay)
submitDelayMs = 2000;
failSubmit = false;
failSession = false;
await page.click('button:has-text("Playground")');
await page.waitForTimeout(300);
await page.fill('#playground-text-input', 'Slow turn in-flight message');
await page.click('button:has-text("发送调试轮次")');
// Intentionally do NOT wait for turn completion; switch immediately while in-flight!
await measureNavigationFromPlayground('Slow Request In-Flight');

// 3. Failed Turn Request Scenario (Backend throws 500 error)
submitDelayMs = 0;
failSubmit = true;
failSession = false;
await page.click('button:has-text("Playground")');
await page.waitForTimeout(300);
await page.fill('#playground-text-input', 'Failing turn message');
await page.click('button:has-text("发送调试轮次")');
await page.waitForTimeout(200);
await measureNavigationFromPlayground('Failed Turn Request');

// 4. Session Disconnected / Unavailable Scenario
submitDelayMs = 0;
failSubmit = false;
failSession = true;
await page.click('button:has-text("Playground")');
await page.waitForTimeout(300);
await measureNavigationFromPlayground('Session Disconnected / Unavailable');

console.log('\n[PASS] All navigation latency tests completed under 200ms!');

await browser.close();
server.close();
memoryStore.close();
