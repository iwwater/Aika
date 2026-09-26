// N07-05 real text replay: pair-scoped Soul/relationship context, bounded composition and forget invalidation.
// The immutable pack is a deterministic fixture; only the two dialogue replies use the real provider.
import { createHash } from 'node:crypto';
import { mkdir, mkdtempSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { ProviderTransport } from '../dist/providers/transport.js';
import { CharacterPackStore } from '../dist/memory/character-pack-store.js';
import { ContinuityMemoryStore } from '../dist/memory/continuity-memory-store.js';
import { ContinuityContextComposer } from '../dist/memory/continuity-context.js';
import { validateDraftEvidence } from '../dist/memory/character-pack-validator.js';

if (process.env.PET_NEXT_REAL !== '1') {
  console.error('N07-05 BLOCKED: set PET_NEXT_REAL=1 for an explicitly authorized real replay.');
  process.exit(2);
}
const endpoint = process.env.NEXT_REAL_LLM_ENDPOINT;
const model = process.env.NEXT_REAL_LLM_MODEL;
const apiKey = process.env.NEXT_REAL_LLM_KEY;
if (!endpoint || !model || !apiKey) {
  console.error('N07-05 BLOCKED: NEXT_REAL_LLM_ENDPOINT, NEXT_REAL_LLM_MODEL and NEXT_REAL_LLM_KEY are required.');
  process.exit(2);
}

const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const calls = [];
const authorizer = {
  async authorize(request) {
    calls.push({ operation: request.operation, model: request.model });
    if (calls.length > 2) throw new Error('N07-05 replay exceeded its two-call budget');
    return { async settle(outcome) { calls.at(-1).status = outcome.status; } };
  },
};
const transport = new ProviderTransport();
const config = { endpoint, model, apiKey: () => apiKey, authorizer };
const scope = { characterId: 'companion', sessionId: 'n07-05-real', turnId: 'text-turn', generation: 0 };
const pairing = { userId: 'real-user', characterId: 'companion', characterInstanceId: 'real-instance' };
const tempDir = mkdtempSync(join(tmpdir(), 'n07-05-real-'));
const db = new Database(join(tempDir, 'continuity.db'));
try {
  const packs = await CharacterPackStore.open(db);
  const memory = await ContinuityMemoryStore.open(db);
  const source = await packs.importSource('companion', { sourceName: 'n07-05-fixture.md', text: '# 沈砚\n\n沈砚住在临海城旧码头，做事沉稳，重视承诺。' });
  const payload = { schemaVersion: '0.7-draft-1', character: { name: '沈砚', soul: '沉稳、克制、重视承诺。' }, canonFacts: [{ id: 'fact-1', text: '沈砚住在临海城旧码头。', status: 'explicit', evidenceIds: [source.snapshot.blocks[0].id] }], gaps: ['更早经历未知'] };
  const validation = validateDraftEvidence(payload, [source.snapshot]);
  if (!validation.valid) throw new Error(`fixture pack validation failed: ${validation.errors.join('; ')}`);
  const draft = await packs.saveDraft({ characterId: 'companion', payload, sourceIds: [source.snapshot.id], validation, packVersion: 'v1.0' });
  await packs.activateDraft({ characterId: 'companion', draftId: draft.id, userId: pairing.userId, instanceId: pairing.characterInstanceId, packVersion: 'v1.0' });
  const soul = memory.record({ pairing, operationId: 'real-soul', layer: 'user_soul', kind: 'user_defined', text: '用户希望被称为阿航。', origin: 'user', sourceIds: ['conversation:real-1'], status: 'active' });
  memory.record({ pairing, operationId: 'real-relation', layer: 'relationship', kind: 'milestone', text: '双方约定把原作经历和共同经历分开。', origin: 'manual', status: 'active' });
  packs.appendCompanionEvent({ ...pairing, sessionId: 's', turnId: 'previous', userText: '我叫阿航，刚搬到旧码头。', assistantText: '记住了。', sourceIds: [soul.fact.id], createdAt: '2026-09-22T00:00:00.000Z' });
  const composer = new ContinuityContextComposer(packs, memory);
  const before = await composer.compose({ pairing, query: '我的称呼是什么？', tokenBudget: 800 });
  if (!before.text.includes('阿航')) throw new Error('pre-forget context did not contain the active User Soul fact');
  const first = await transport.request(config, scope, 'dialogue', { messages: [{ role: 'system', content: `你是沈砚。只使用以下已验证的连续性资料，不要编造共同经历。\n${before.text}` }, { role: 'user', content: '我希望你叫我什么？只回答称呼。' }], stream: true, temperature: 0, max_tokens: 800 }, new AbortController().signal);
  const firstReply = typeof first.text === 'string' ? first.text.trim() : '';
  if (!firstReply) throw new Error('pre-forget reply was empty');
  const forgotten = memory.forget({ pairing, operationId: 'real-forget', targetId: soul.fact.id, expectedVersion: soul.fact.version, reason: '用户要求忘记称呼。' });
  const after = await composer.compose({ pairing, query: '我的称呼是什么？', tokenBudget: 800 });
  if (after.text.includes('阿航')) throw new Error('forgotten User Soul was still injected into Context');
  await composer.assertCurrent(after);
  const second = await transport.request(config, { ...scope, turnId: 'text-turn-after-forget' }, 'dialogue', { messages: [{ role: 'system', content: `你是沈砚。下方资料是当前有效连续性 Context；被遗忘的内容不可猜测或恢复。\n${after.text}` }, { role: 'user', content: '我希望你叫我什么？如果没有可靠资料，只说不知道。' }], stream: true, temperature: 0, max_tokens: 800 }, new AbortController().signal);
  const secondReply = typeof second.text === 'string' ? second.text.trim() : '';
  if (!secondReply) throw new Error('post-forget reply was empty');
  if (secondReply.includes('阿航')) throw new Error('post-forget model reply repeated the forgotten name');
  const reportDir = resolve(process.cwd(), '../../../docs/next/0.7/reports');
  await new Promise((resolveDir, reject) => mkdir(reportDir, { recursive: true }, error => error ? reject(error) : resolveDir()));
  const report = [
    '# N07-05 真实文字闭环报告', '',
    `日期：${new Date().toISOString()}`,
    '状态：AUTO_PASS（受控自动闭环；0.65 人工验收继续暂缓）',
    `模型：${model}`,
    `调用数：${calls.length}/2`,
    `预遗忘 Context SHA-256：${hash(before.text)}`,
    `遗忘后 Context SHA-256：${hash(after.text)}`,
    `遗忘操作：${forgotten.status}; revision=${forgotten.revision}`,
    `遗忘前 Context 含称呼：${before.text.includes('阿航') ? 'PASS' : 'FAIL'}`,
    `遗忘后 Context 不含称呼：${after.text.includes('阿航') ? 'FAIL' : 'PASS'}`,
    `遗忘前回复非空：${firstReply ? 'PASS' : 'FAIL'}`,
    `遗忘后回复非空且未恢复称呼：${secondReply && !secondReply.includes('阿航') ? 'PASS' : 'FAIL'}`,
    '',
    '该回放证明当前配对的 Soul/关系 Context 可被预算组合，并在 forget 后阻止陈旧 User Soul 再次注入；它不替代并发后台压力测试和人工表达验收。',
    '',
    `- 遗忘前回复摘要：${firstReply.slice(0, 120).replace(/\r?\n/g, ' ')}`,
    `- 遗忘后回复摘要：${secondReply.slice(0, 120).replace(/\r?\n/g, ' ')}`,
  ].join('\n');
  await writeFile(resolve(reportDir, 'N07-05-real.md'), `${report}\n`, 'utf8');
  console.log(JSON.stringify({ status: 'AUTO_PASS', model, calls: calls.length, beforeName: 'PRESENT', afterName: 'REMOVED', report: 'docs/next/0.7/reports/N07-05-real.md' }));
} finally {
  db.close();
  await rm(tempDir, { recursive: true, force: true });
}
