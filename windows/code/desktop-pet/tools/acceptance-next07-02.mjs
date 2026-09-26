// N07-02 real text replay.
// Validates CharacterSourceProvider -> CharacterDistiller adapter with cutoffPoint and gap extraction.
// Verifies non-empty Soul, at least one verified CanonFact with evidence, explicit/inferred status, and clear gaps.

import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ProviderTransport } from '../dist/providers/transport.js';
import { CharacterPackDraftStore } from '../dist/memory/character-pack-store.js';
import { CharacterDistiller } from '../dist/providers/character-distiller.js';
import { CompositeCharacterSourceProvider } from '../dist/memory/character-source-provider.js';

if (process.env.PET_NEXT_REAL !== '1') {
  console.error('N07-02 BLOCKED: set PET_NEXT_REAL=1 for an explicitly authorized real replay.');
  process.exit(2);
}

const endpoint = process.env.NEXT_REAL_LLM_ENDPOINT;
const model = process.env.NEXT_REAL_LLM_MODEL;
const apiKey = process.env.NEXT_REAL_LLM_KEY;
if (!endpoint || !model || !apiKey) {
  console.error('N07-02 BLOCKED: NEXT_REAL_LLM_ENDPOINT, NEXT_REAL_LLM_MODEL and NEXT_REAL_LLM_KEY are required.');
  process.exit(2);
}

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const calls = [];
const authorizer = {
  async authorize(request) {
    calls.push({ operation: request.operation, model: request.model });
    if (calls.length > 2) throw new Error('N07-02 real replay exceeded its two-call budget');
    return { async settle(outcome) { calls.at(-1).status = outcome.status; } };
  },
};

const transport = new ProviderTransport();
const config = { endpoint, model, apiKey: () => apiKey, authorizer };

const tempDir = mkdtempSync(join(tmpdir(), 'n07-02-real-'));
const dbPath = join(tempDir, 'continuity-02.db');
const db = new Database(dbPath);

console.log('1. Initializing CharacterPackDraftStore and SourceProvider...');
const store = await CharacterPackDraftStore.open(db);
const sourceProvider = new CompositeCharacterSourceProvider();

console.log('2. Running formal CharacterDistiller with cutoffPoint via distillFromSourceRefs...');
const distiller = new CharacterDistiller(config, { transport, store });

const sourceRefs = [
  {
    kind: 'text',
    uri: 'ref://shenyan/intro',
    title: '第一章 临海城的守候.txt',
    text: '# 第一章 临海城的守候\n\n沈砚常年住在临海城旧码头。他寡言少语，习惯在作出承诺前深思熟虑。他精通观潮辨汐，但极少对外提及自己的家世。',
  },
  {
    kind: 'text',
    uri: 'ref://shenyan/storm',
    title: '第二章 暴雨之夜.txt',
    text: '# 第二章 暴雨之夜\n\n原作事件：暴雨之夜，旧码头栈桥发生坍塌险情。沈砚将唯一的防雨斗篷和风灯留给被困的年轻旅人，自己涉水加固缆绳。事件发生在此处，未提及后续远行经历。',
  },
];

const draft = await distiller.distillFromSourceRefs(
  {
    characterId: 'companion',
    characterName: '沈砚',
    sourceRefs,
    sourceProvider,
    cutoffPoint: '第二章 暴雨之夜',
    instructions: '请明确标注文中未提及的知识缺口（如家世、幼年经历或后续去向）。',
    maxTokens: 4096,
  },
  new AbortController().signal,
);

console.log(`   Distilled draft id: ${draft.id}, status: ${draft.status}`);
if (draft.status !== 'validated') {
  throw new Error(`N07-02 draft validation failed: ${draft.validation.errors.join('; ')}`);
}

// Validation assertions per N07-02 threshold
if (!draft.payload.character.soul.trim()) throw new Error('Character Soul is empty');
if (draft.payload.canonFacts.length === 0) throw new Error('No Canon facts extracted');
if (!Array.isArray(draft.payload.gaps) || draft.payload.gaps.length === 0) {
  throw new Error('Gaps analysis is empty');
}

// Check fact statuses
for (const fact of draft.payload.canonFacts) {
  if (!fact.status || !['explicit', 'inferred', 'disputed'].includes(fact.status)) {
    throw new Error(`Fact ${fact.id} lacks valid status classification`);
  }
}

// 3. Dialogue replay with character draft
console.log('3. Running character response turn using distilled draft...');
const scope = Object.freeze({
  characterId: 'companion',
  sessionId: 'n07-02-real',
  turnId: 'turn-1',
  generation: 0,
});

const replyResult = await transport.request(
  config,
  scope,
  'dialogue',
  {
    messages: [
      {
        role: 'system',
        content: `你是角色 ${draft.payload.character.name}。只依据已确认的原作资料回答；若被问及资料中未提及的经历（如下述缺口），请诚实说明未知或不作虚构。\n角色底色：${draft.payload.character.soul}\n原作事实：${draft.payload.canonFacts.map(f => `[${f.status}] ${f.text}`).join('\n')}\n知识缺口：${draft.payload.gaps.join('；')}`,
      },
      { role: 'user', content: '能告诉我你的家人和早年经历吗？另外暴雨夜发生了什么？' },
    ],
    stream: true,
    temperature: 0,
    max_tokens: 1800,
  },
  new AbortController().signal,
);

const replyText = typeof replyResult.text === 'string' ? replyResult.text.trim() : '';
if (!replyText) throw new Error('Replay text reply was empty');

console.log('4. Replay complete, writing N07-02-real.md report...');

const reportDir = resolve(process.cwd(), '../../../docs/next/0.7/reports');
await mkdir(reportDir, { recursive: true });

const report = [
  '# N07-02 真实模型闭环验证报告',
  '',
  `日期：${new Date().toISOString()}`,
  '状态：AUTO_PASS（受控自动闭环；0.65 人工验收继续暂缓）',
  `模型：${model}`,
  `调用数：${calls.length}/2`,
  `草稿 ID：${draft.id}`,
  `草稿状态：${draft.status}`,
  `Soul 非空：${draft.payload.character.soul.trim() ? 'PASS' : 'FAIL'}`,
  `Canon 事实数：${draft.payload.canonFacts.length} (PASS)`,
  `Canon 事实状态标记：${draft.payload.canonFacts.every(f => f.status) ? 'PASS' : 'FAIL'}`,
  `知识缺口识别（Gaps）：${draft.payload.gaps.length > 0 ? 'PASS' : 'FAIL'}`,
  `文字回复非空：${replyText.length > 0 ? 'PASS' : 'FAIL'}`,
  '',
  '## 提炼产物摘要（脱敏截断）',
  `- 角色：${draft.payload.character.name}`,
  `- 角色底色（Soul）：${draft.payload.character.soul.slice(0, 100)}`,
  `- Canon 事实示例：[${draft.payload.canonFacts[0]?.status}] ${draft.payload.canonFacts[0]?.text}`,
  `- 知识缺口（Gaps）：${draft.payload.gaps.join('； ').slice(0, 120)}`,
  `- 回复前 120 字：${replyText.slice(0, 120).replace(/\r?\n/g, ' ')}`,
].join('\n');

await writeFile(resolve(reportDir, 'N07-02-real.md'), `${report}\n`, 'utf8');

// Cleanup
db.close();
try {
  await rm(tempDir, { recursive: true, force: true });
} catch {}

console.log(JSON.stringify({
  status: 'AUTO_PASS',
  model,
  calls: calls.length,
  draftId: draft.id,
  draftStatus: draft.status,
  gapsCount: draft.payload.gaps.length,
  reply: 'NON_EMPTY',
  report: 'docs/next/0.7/reports/N07-02-real.md',
}));
