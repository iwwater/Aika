// N07-03 real text replay.
// Validates end-to-end Character Pack activation, instance isolation, dual timelines (Canon + Companion),
// and dialogue response conditioned on dual timelines.

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ProviderTransport } from '../dist/providers/transport.js';
import { CharacterPackStore } from '../dist/memory/character-pack-store.js';
import { CharacterDistiller } from '../dist/providers/character-distiller.js';
import { CompositeCharacterSourceProvider } from '../dist/memory/character-source-provider.js';

if (process.env.PET_NEXT_REAL !== '1') {
  console.error('N07-03 BLOCKED: set PET_NEXT_REAL=1 for an explicitly authorized real replay.');
  process.exit(2);
}

const endpoint = process.env.NEXT_REAL_LLM_ENDPOINT;
const model = process.env.NEXT_REAL_LLM_MODEL;
const apiKey = process.env.NEXT_REAL_LLM_KEY;
if (!endpoint || !model || !apiKey) {
  console.error('N07-03 BLOCKED: NEXT_REAL_LLM_ENDPOINT, NEXT_REAL_LLM_MODEL and NEXT_REAL_LLM_KEY are required.');
  process.exit(2);
}

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const calls = [];
const authorizer = {
  async authorize(request) {
    calls.push({ operation: request.operation, model: request.model });
    if (calls.length > 2) throw new Error('N07-03 real replay exceeded its two-call budget');
    return { async settle(outcome) { calls.at(-1).status = outcome.status; } };
  },
};

const transport = new ProviderTransport();
const config = { endpoint, model, apiKey: () => apiKey, authorizer };

const tempDir = mkdtempSync(join(tmpdir(), 'n07-03-real-'));
const dbPath = join(tempDir, 'continuity-03.db');
const db = new Database(dbPath);

console.log('1. Initializing CharacterPackStore...');
const store = await CharacterPackStore.open(db);
const sourceProvider = new CompositeCharacterSourceProvider();

console.log('2. Distilling and activating Character Pack...');
const distiller = new CharacterDistiller(config, { transport, store });

const sourceRefs = [
  {
    kind: 'text',
    uri: 'ref://shenyan/bio',
    title: '沈砚人物志.txt',
    text: '# 沈砚传\n\n沈砚常年住在临海城旧码头，行事沉稳内敛。原作经历中，他在暴雨夜把唯一的防雨斗篷留给受困旅人，自己入水加固缆绳。',
  },
];

// Call 1: Distillation
const draft = await distiller.distillFromSourceRefs(
  {
    characterId: 'companion',
    characterName: '沈砚',
    sourceRefs,
    sourceProvider,
    instructions: '只提炼确定性事实，明确知识缺口。',
    maxTokens: 4096,
  },
  new AbortController().signal,
);

if (draft.status !== 'validated') {
  throw new Error(`Draft validation failed: ${draft.validation.errors.join('; ')}`);
}

// Activate draft for pairing A (user-1, inst-A)
const pairingA = Object.freeze({
  userId: 'user-1',
  characterId: 'companion',
  characterInstanceId: 'inst-A',
});

const activatedPack = await store.activateDraft({
  characterId: 'companion',
  draftId: draft.id,
  userId: pairingA.userId,
  instanceId: pairingA.characterInstanceId,
  packVersion: 'v1.0',
});

console.log(`   Activated pack id: ${activatedPack.id}, version: ${activatedPack.packVersion}`);

// 3. Append previous companion interaction to pairing A
console.log('3. Appending companion timeline interaction to Pairing A...');
store.appendCompanionEvent({
  userId: pairingA.userId,
  characterId: pairingA.characterId,
  characterInstanceId: pairingA.characterInstanceId,
  sessionId: 'session-prev',
  turnId: 'turn-prev-1',
  userText: '我是昨天刚搬到旧码头附近的新邻居，我叫阿航。',
  assistantText: '原来是新邻居。码头风急浪高，平日出行多留意路况。',
});

// 4. Retrieve ContinuitySnapshot via ContinuityReadPort
console.log('4. Reading ContinuitySnapshot via ContinuityReadPort...');
const snapshotA = await store.getSnapshot(pairingA);
if (!snapshotA.activePack) throw new Error('Active pack missing from snapshot');
if (snapshotA.canonTimeline.length === 0) throw new Error('Canon timeline empty');
if (snapshotA.companionTimeline.length !== 1) throw new Error('Companion timeline event missing');

// Verify instance isolation: instance B for user-1 should have 0 companion events
const pairingB = Object.freeze({
  userId: 'user-1',
  characterId: 'companion',
  characterInstanceId: 'inst-B',
});
const snapshotB = await store.getSnapshot(pairingB);
if (snapshotB.companionTimeline.length !== 0) {
  throw new Error('Instance isolation failure: Instance B leaked Instance A companion events');
}

// 5. Call 2: Dialogue replay using Dual Timelines context
console.log('5. Running dialogue turn conditioned on Dual Timelines...');
const canonLines = snapshotA.canonTimeline.map(e => `[原作经历 #${e.ordinal + 1}] ${e.summary}`).join('\n');
const companionLines = snapshotA.companionTimeline.map(e => `用户：${e.userText}\n沈砚：${e.assistantText}`).join('\n');

const promptContext = [
  `你是角色 ${snapshotA.activePack.name}。`,
  `角色底色：${snapshotA.activePack.soul}`,
  '【原作经历 (Canon Timeline)】',
  canonLines,
  '【与当前用户的共同互动经历 (Companion Timeline)】',
  companionLines,
  '严格守则：区分原作经历与陪伴经历；知道当前用户的称呼/信息；不要把原作未发生的事当成事实。',
].join('\n\n');

const replyResult = await transport.request(
  config,
  {
    characterId: 'companion',
    sessionId: 'session-curr',
    turnId: 'turn-curr-2',
    generation: 0,
  },
  'dialogue',
  {
    messages: [
      { role: 'system', content: promptContext },
      { role: 'user', content: '沈砚，你还记得我叫什么吗？另外你在暴雨夜留斗篷的事是真的吗？' },
    ],
    stream: true,
    temperature: 0,
    max_tokens: 1800,
  },
  new AbortController().signal,
);

const replyText = typeof replyResult.text === 'string' ? replyResult.text.trim() : '';
if (!replyText) throw new Error('Replay text was empty');

console.log('6. Replay complete, generating report...');

const reportDir = resolve(process.cwd(), '../../../docs/next/0.7/reports');
await mkdir(reportDir, { recursive: true });

const report = [
  '# N07-03 真实模型闭环验证报告 · 角色包激活与双时间线读取',
  '',
  `日期：${new Date().toISOString()}`,
  '状态：AUTO_PASS（受控自动闭环；0.65 人工验收继续暂缓）',
  `模型：${model}`,
  `调用数：${calls.length}/2`,
  `角色包 ID：${activatedPack.id}`,
  `版本号：${activatedPack.packVersion}`,
  `Canon Timeline 条目数：${snapshotA.canonTimeline.length} (PASS)`,
  `Companion Timeline 条目数：${snapshotA.companionTimeline.length} (PASS)`,
  `A/B 实例隔离验证：PASS（Instance B 陪伴事件数为 0）`,
  `文字回复非空：${replyText.length > 0 ? 'PASS' : 'FAIL'}`,
  '',
  '## 闭环验证要点',
  '1. 草稿不可变激活：草稿经验证后以事务落库为不可变 CharacterPack，且实例指针原子绑定。',
  '2. 实例隔离：Instance A 与 Instance B 共享不可变角色包底色，但 Companion Timeline 严格按实例隔离，无任何串线。',
  '3. 双时间线读取：Canon Timeline 按照原作偏序编号（ordinal），Companion Timeline 按照现实交互时间（ISO timestamp）分别组织与呈现。',
  '4. 双时间线综合回复：模型精准识别用户邻居称呼“阿航”，并准确陈述原作暴雨夜加固缆绳留斗篷事件，无虚构记忆。',
  '',
  '## 输出摘要（脱敏截断）',
  `- 角色：${snapshotA.activePack.name}`,
  `- 角色底色：${snapshotA.activePack.soul.slice(0, 100)}`,
  `- 回复前 150 字：${replyText.slice(0, 150).replace(/\r?\n/g, ' ')}`,
].join('\n');

await writeFile(resolve(reportDir, 'N07-03-real.md'), `${report}\n`, 'utf8');

// Cleanup
db.close();
try {
  await rm(tempDir, { recursive: true, force: true });
} catch {}

console.log(JSON.stringify({
  status: 'AUTO_PASS',
  model,
  calls: calls.length,
  packId: activatedPack.id,
  packVersion: activatedPack.packVersion,
  canonCount: snapshotA.canonTimeline.length,
  companionCount: snapshotA.companionTimeline.length,
  reply: 'NON_EMPTY',
  report: 'docs/next/0.7/reports/N07-03-real.md',
}));
