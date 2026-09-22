// N07-00 real text probe. Run after `npm run build` with PET_NEXT_REAL=1 and the local
// environment loaded. This is intentionally a probe, not the 0.7 production distiller:
// it validates the existing ProviderTransport boundary before N07-02 freezes its adapter.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ProviderTransport, parseModelJson } from '../dist/providers/transport.js';

if (process.env.PET_NEXT_REAL !== '1') {
  console.error('N07-00 BLOCKED: set PET_NEXT_REAL=1 for an explicitly authorized real replay.');
  process.exit(2);
}

const endpoint = process.env.NEXT_REAL_LLM_ENDPOINT;
const model = process.env.NEXT_REAL_LLM_MODEL;
const apiKey = process.env.NEXT_REAL_LLM_KEY;
if (!endpoint || !model || !apiKey) {
  console.error('N07-00 BLOCKED: NEXT_REAL_LLM_ENDPOINT, NEXT_REAL_LLM_MODEL and NEXT_REAL_LLM_KEY are required.');
  process.exit(2);
}

const scope = Object.freeze({ characterId: 'companion', sessionId: 'n07-00-real', turnId: 'n07-00-probe', generation: 0 });
const sourceBlocks = [
  { id: 'fixture:source:1', text: '沈砚住在临海城，习惯先观察再回答。他重视承诺，表达克制但会在对方需要时主动帮助。' },
  { id: 'fixture:source:2', text: '原作事件：沈砚在暴雨夜把唯一的伞留给同伴，自己沿旧码头回家。该事件属于原作正文，未涉及当前用户。' },
];
const sourceText = sourceBlocks.map(block => `[${block.id}]\n${block.text}`).join('\n\n');
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const calls = [];
const authorizer = {
  async authorize(request) {
    calls.push({ operation: request.operation, model: request.model });
    if (calls.length > 2) throw new Error('N07-00 probe exceeded its two-call budget');
    return { async settle(outcome) { calls.at(-1).status = outcome.status; } };
  },
};
const transport = new ProviderTransport();
const config = { endpoint, model, apiKey: () => apiKey, authorizer };
const request = async messages => {
  const result = await transport.request(config, scope, 'dialogue', {
    messages,
    stream: true,
    temperature: 0,
    max_tokens: 1800,
  }, new AbortController().signal);
  if (typeof result.text !== 'string' || !result.text.trim()) throw new Error('provider returned empty text');
  return result.text.trim();
};

const distillPrompt = [
  '你是 Aika 0.7 的 CharacterDistiller 探针。只根据用户提供的资料输出一行严格 JSON，不要 Markdown、解释或推理过程。每个字符串最多 80 字。',
  '不得补写资料没有的原作事实；每个 canonFacts 项必须引用一个或多个 evidenceIds。evidenceIds 只能逐字使用 "fixture:source:1" 或 "fixture:source:2"。',
  'schema: {"schemaVersion":"0.7-draft-1","character":{"name":string,"soul":string},"canonFacts":[{"id":string,"text":string,"evidenceIds":string[]}],"gaps":string[]}',
].join('\n');
const draftText = await request([
  { role: 'system', content: distillPrompt },
  { role: 'user', content: `资料区块如下：\n${sourceText}` },
]);
const draft = parseModelJson(draftText);
const character = draft.character;
if (!character || typeof character !== 'object' || typeof character.name !== 'string' || !character.name.trim()) throw new Error('draft.character.name missing');
if (typeof character.soul !== 'string' || !character.soul.trim()) throw new Error('draft.character.soul missing');
if (!Array.isArray(draft.canonFacts) || draft.canonFacts.length === 0) throw new Error('draft.canonFacts missing');
const ids = new Set(sourceBlocks.map(block => block.id));
for (const fact of draft.canonFacts) {
  if (!fact || typeof fact !== 'object' || typeof fact.text !== 'string' || !Array.isArray(fact.evidenceIds) || fact.evidenceIds.length === 0) throw new Error('canon fact lacks text/evidenceIds');
  if (fact.evidenceIds.some(id => typeof id !== 'string' || !ids.has(id))) throw new Error(`draft contains an evidence ID outside the source snapshot: ${JSON.stringify(fact.evidenceIds)}`);
}

const replyText = await request([
  { role: 'system', content: `你是角色 ${character.name}。只使用下方已校验的角色资料回答；不要声称与用户有未提供的共同经历。角色底色：${character.soul}\n原作资料：${draft.canonFacts.map(fact => fact.text).join('\n')}` },
  { role: 'user', content: '请用一句简短的话介绍你自己。' },
]);
if (!replyText) throw new Error('continuity reply is empty');

const reportDir = resolve(process.cwd(), '../../../docs/next/0.7/reports');
await mkdir(reportDir, { recursive: true });
const report = [
  '# N07-00 真实文字探针报告',
  '',
  `日期：${new Date().toISOString()}`,
  '状态：AUTO_PASS（受控部分验收；不代表 0.7 整版完成）',
  `模型：${model}`,
  `调用数：${calls.length}/2`,
  `资料输入 SHA-256：${hash(sourceText)}`,
  `提炼输出 SHA-256：${hash(draftText)}`,
  `回复输出 SHA-256：${hash(replyText)}`,
  `角色名非空：${character.name.trim() ? 'PASS' : 'FAIL'}`,
  `Canon evidence 可回源：${draft.canonFacts.every(fact => fact.evidenceIds.every(id => ids.has(id))) ? 'PASS' : 'FAIL'}`,
  `文字回复非空：${replyText.length > 0 ? 'PASS' : 'FAIL'}`,
  '',
  '本报告只证明现有 ProviderTransport 可以承载“短资料→结构化草稿→带角色上下文的文字回复”探针；Character Pack 持久化、双时间线、撤销/遗忘、Context 预算和管理入口仍待 N07-01～N07-05。',
  '',
  '输出摘要（主动截断，避免把完整模型输出写入仓库）：',
  `- 角色：${character.name.slice(0, 80)}`,
  `- Canon 条目数：${draft.canonFacts.length}`,
  `- 回复前 120 字：${replyText.slice(0, 120).replace(/\r?\n/g, ' ')}`,
].join('\n');
await writeFile(resolve(reportDir, 'N07-00-real.md'), `${report}\n`, 'utf8');
console.log(JSON.stringify({ status: 'AUTO_PASS', model, calls: calls.length, evidence: 'PASS', reply: 'NON_EMPTY', report: 'docs/next/0.7/reports/N07-00-real.md' }));
