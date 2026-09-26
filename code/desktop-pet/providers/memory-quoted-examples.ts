import type { MemoryChange } from '../contracts/index.js';
import type { MemoryTurnPlan, SourceRetention } from '../contracts/memory-lifecycle.js';

type QuotedRetention = Omit<SourceRetention, 'start' | 'end'> & { quote: string; range: { start: number; end: number } | null };
type ExamplePlan = Omit<MemoryTurnPlan, 'scope' | 'changes' | 'retainSources'> & {
  changes: readonly Pick<MemoryChange, 'reason' | 'operation'>[];
  retainSources: readonly QuotedRetention[];
};

/** Independent complete model outputs, not automatic plans or user-facing reply templates. */
export const memoryQuotedExamples: readonly { description: string; plan: ExamplePlan }[] = [
  {
    description: '新增：当前user s0/v1“我每周五练琴。”，无memory，原文已保存。',
    plan: { request: 'none', changes: [{ reason: '首次固定安排', operation: { type: 'add', id: 'n0', text: '用户每周五练琴。', sourceIds: ['s0'] } }], suppressSources: [], retainSources: [], clarification: null, reason: '新增重要事实，原文不变' },
  },
  {
    description: '仅查询：当前user s0/v1“我哪天练琴？”；memory m0/v1已有正确安排，无重复或失效事实。',
    plan: { request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: '查询不产生新事实，此例也无其他维护需要' },
  },
  {
    description: '自主合并：当前user s0/v1“我哪天练琴？”；user s1/v1“我每周五练琴。”；memory m0/v1“用户周五练琴。”和m1/v1“用户每周五练琴。”都来自s1/v1，无其他派生。',
    plan: { request: 'none', changes: [{ reason: '同源同义重复安排', operation: { type: 'merge', targets: [{ id: 'm0', expectedVersion: 1 }, { id: 'm1', expectedVersion: 1 }], replacement: { id: 'n0', text: '用户每周五练琴。', sourceIds: ['s1'] } } }], suppressSources: [], retainSources: [], clarification: null, reason: '维护重复记忆，与当前查询不新增事实并不冲突' },
  },
  {
    description: '自然变化：当前user s0/v1“我现在改为周六练琴了。”；user s1/v1“周五练琴。”；memory m0/v2“用户周五练琴。”来自s1/v1；assistant s2/v1“你周五练琴。”来自s1/v1及m0/v2，均eligible，无无关内容。',
    plan: { request: 'correction', changes: [{ reason: '用户自然告知新安排', operation: { type: 'update', id: 'm0', expectedVersion: 2, text: '用户周六练琴。', sourceIds: ['s0'] } }], suppressSources: [{ id: 's1', version: 1 }, { id: 's2', version: 1 }], retainSources: [], clarification: null, reason: '更新事实并退出旧证据和回声' },
  },
  {
    description: '自主清理普通待办：当前user s0/v1“那份普通快递今天取到了，没有后续安排。”；user s1/v1“明天取普通快递。”；memory m0/v1“用户待取普通快递。”来自s1/v1，无其他依赖。',
    plan: { request: 'none', changes: [{ reason: '普通待办已完成且无后续保留价值', operation: { type: 'soft_delete', id: 'm0', expectedVersion: 1 } }], suppressSources: [{ id: 's1', version: 1 }], retainSources: [], clarification: null, reason: '自主退出失效待办及旧待办原句，保留当前完成信息；不新增完成记录' },
  },
  {
    description: '恢复候选：当前user s0/v1“恢复那条安排。”；程序已提供可恢复memory m0/v2，资格仍由存储核实。普通输入无软删正文或m目标时不猜恢复。',
    plan: { request: 'none', changes: [{ reason: '当前明确要求恢复已提供目标', operation: { type: 'restore', id: 'm0', expectedVersion: 2 } }], suppressSources: [], retainSources: [], clarification: null, reason: '仅提议恢复，程序复核资格后执行' },
  },
  {
    description: '混合遗忘：s0/v1 user“忘记面试的事，养猫保留。”；s1/v1 user“面试让我难过。我养的猫叫团子。”；m0/v1“用户面试难过。”、m1/v1“用户的猫叫团子。”及s2/v1 summary“用户面试难过。用户的猫叫团子。”均来自s1/v1；s3/v1 assistant“面试的事我记着。团子这个名字很好听。”来自s1/v1、m0/v1、m1/v1。m0/m1为实际memory；均eligible，无其他依赖。',
    plan: { request: 'forget', changes: [{ reason: '遗忘面试记忆', operation: { type: 'soft_delete', id: 'm0', expectedVersion: 1 } }, { reason: '猫事实改绑到幸存证据', operation: { type: 'update', id: 'm1', expectedVersion: 1, text: '用户的猫叫团子。', sourceIds: ['f0'] } }], suppressSources: [{ id: 's0', version: 1 }, { id: 's1', version: 1 }, { id: 's2', version: 1 }, { id: 's3', version: 1 }], retainSources: [{ source: { id: 's1', version: 1 }, fragmentId: 'f0', quote: '我养的猫叫团子。', range: null, supportSourceIds: [] }, { source: { id: 's2', version: 1 }, fragmentId: 'f1', quote: '用户的猫叫团子。', range: null, supportSourceIds: ['f0'] }, { source: { id: 's3', version: 1 }, fragmentId: 'f2', quote: '团子这个名字很好听。', range: null, supportSourceIds: ['f0'] }], clarification: null, reason: 'memory用操作，原文摘要回声用抑制和逐字保留；幸存支持完整重绑' },
  },
  {
    description: '无memory、仅summary：当前s0/v1“忘记面试的事。”；s1/v1 summary“用户面试难过。用户的猫叫团子。”来自不可读u2/v1。空支持仅候选，存储须核实祖先全部自然过期raw；没有m目标。',
    plan: { request: 'forget', changes: [], suppressSources: [{ id: 's0', version: 1 }, { id: 's1', version: 1 }], retainSources: [{ source: { id: 's1', version: 1 }, fragmentId: 'f0', quote: '用户的猫叫团子。', range: null, supportSourceIds: [] }], clarification: null, reason: '保留无关摘要候选，交存储核实不可读祖先资格；没有memory目标' },
  },
  {
    description: '澄清：当前s0/v1“两个安排忘掉一个。”，目标未明。三动作数组全空，当前句也不抑制。',
    plan: { request: 'forget', changes: [], suppressSources: [], retainSources: [], clarification: '你指的是哪一个安排？', reason: '先确认范围，不猜测目标' },
  },
];
