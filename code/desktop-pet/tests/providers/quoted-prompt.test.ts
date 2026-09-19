import test from 'node:test';
import assert from 'node:assert/strict';
import { memoryQuotedExamples } from '../../providers/memory-quoted-examples.js';
import { MEMORY_QUOTED_PROMPT } from '../../providers/memory-quoted-prompt.js';
import { buildMemoryTurnFormat } from '../../providers/memory-turn-format.js';
import { input, source, ref, harness, signal } from './quoted-helpers.js';
import { completeClosure } from './fixtures/quoted-original-sources.js';

const memory = (id: string, text: string, version = 1, parents: string[] = []) => source(id, text, { kind: 'memory', messageRole: null, version, sourceVersions: parents.map(p => ref(p)) });
const cases = [
  input([source('current', '我每周五练琴。')]),
  input([source('current', '我哪天练琴？'), memory('memory', '用户每周五练琴。')]),
  input([source('current', '我哪天练琴？'), source('raw', '我每周五练琴。'), memory('first', '用户周五练琴。', 1, ['raw']), memory('second', '用户每周五练琴。', 1, ['raw'])]),
  input([source('current', '我现在改为周六练琴了。'), source('raw', '周五练琴。'), memory('memory', '用户周五练琴。', 2, ['raw']), source('assistant', '你周五练琴。', { messageRole: 'assistant', sourceVersions: [ref('raw'), ref('memory', 2)] })]),
  input([source('current', '那份普通快递今天取到了，没有后续安排。'), source('raw', '明天取普通快递。'), memory('memory', '用户待取普通快递。', 1, ['raw'])]),
  input([source('current', '恢复那条安排。'), memory('memory', '原安排', 2)]),
  input([source('current', '忘记面试的事，养猫保留。'), source('raw', '面试让我难过。我养的猫叫团子。'), memory('interview', '用户面试难过。', 1, ['raw']), memory('cat', '用户的猫叫团子。', 1, ['raw']), source('summary', '用户面试难过。用户的猫叫团子。', { kind: 'summary', messageRole: null, sourceVersions: [ref('raw')] }), source('assistant', '面试的事我记着。团子这个名字很好听。', { messageRole: 'assistant', sourceVersions: [ref('raw'), ref('interview'), ref('cat')] })]),
  input([source('current', '忘记面试的事。'), source('summary', '用户面试难过。用户的猫叫团子。', { kind: 'summary', messageRole: null, sourceVersions: [ref('unread')] })]),
  input([source('current', '两个安排忘掉一个。')]),
];
for (const [index, example] of memoryQuotedExamples.entries()) test(`quoted complete prompt example ${index + 1} preserves its public operation shape`, async t => {
  const run = harness(example.plan), result = await run.provider.plan(cases[index]!, signal());
  assert.equal(result.request, example.plan.request); assert.equal(result.clarification, example.plan.clarification);
  assert.deepEqual(result.changes.map(c => c.operation.type), example.plan.changes.map(c => c.operation.type));
  assert.equal(result.retainSources!.length, example.plan.retainSources.length);
  if (index === 5 || index === 7) t.diagnostic('Format candidate only; restore/expired-ancestor eligibility is still checked by storage, not inferred from this example');
});

test('quoted prompt keeps autonomous five operations and full original42raw input within the unchanged budget', () => {
  assert.deepEqual([...new Set(memoryQuotedExamples.flatMap(e => e.plan.changes.map(c => c.operation.type)))].sort(), ['add', 'merge', 'restore', 'soft_delete', 'update']);
  assert.equal(memoryQuotedExamples[2]!.plan.request, 'none'); assert.equal(memoryQuotedExamples[4]!.plan.request, 'none');
  assert.match(MEMORY_QUOTED_PROMPT, /查询不新增事实，不等于禁止自主维护/);
  assert.match(MEMORY_QUOTED_PROMPT, /重要经历保留时间及自述感受/);
  assert.match(MEMORY_QUOTED_PROMPT, /目标本身未读或目标版本未知/);
  assert.match(MEMORY_QUOTED_PROMPT, /目标和版本已读、只有影响闭包或保留支持未读/);
  assert.match(MEMORY_QUOTED_PROMPT, /首计划只是未提交草案/);
  const f = buildMemoryTurnFormat(completeClosure.input, 'quoted-v2');
  assert.equal(f.input.sources.length, 43); assert.equal(f.input.messages.length, 42);
  const bytes = Buffer.byteLength(JSON.stringify(f.data)) + Buffer.byteLength(f.system) + 2048;
  assert.ok(bytes <= 32768, `actual complete quoted input plus system/reserve: ${bytes}`);
});
