import type { MemoryChange } from '../contracts/index.js';
import type { MemoryTurnPlan } from '../contracts/memory-lifecycle.js';

type ExamplePlan = Omit<MemoryTurnPlan, 'scope' | 'changes' | 'retainSources'> & {
  changes: readonly Pick<MemoryChange, 'reason' | 'operation'>[];
  retainSources: NonNullable<MemoryTurnPlan['retainSources']>;
};
/** Independent minimal inputs. Each complete output is executable by the strict parser. */
export const memoryTurnPlanExamples: readonly { description: string; plan: ExamplePlan }[] = [
  {
    description: '新增：仅当前user s0/v1“我每周五练琴。”，无旧memory。原文已保存，直接引用s0，两个来源数组空。',
    plan: { request: 'none', changes: [{ reason: '首次陈述固定安排', operation: { type: 'add', id: 'n0', text: '用户每周五练琴。', sourceIds: ['s0'] } }], suppressSources: [], retainSources: [], clarification: null, reason: '新增事实，原文保持不变' },
  },
  {
    description: '查询：当前user s0/v1“我哪天练琴？”，历史user s1/v1“忘记练琴的事。”，无新事实。不重放旧命令。',
    plan: { request: 'none', changes: [], suppressSources: [], retainSources: [], clarification: null, reason: '当前是查询，无新事实需要维护' },
  },
  {
    description: '更正：当前user s0/v1“改为每周六练琴。”；user s1/v1“我每周五练琴。”；memory s2/v2“用户每周五练琴。”来自s1/v1；assistant s3/v1“你周五练琴。”来自s1/v1及s2/v2；assistant s4/v1“对，是周五。”来自s3/v1。均eligible=true，无无关事实；处理两级回声。',
    plan: { request: 'correction', changes: [{ reason: '安排改为周六', operation: { type: 'update', id: 's2', expectedVersion: 2, text: '用户每周六练琴。', sourceIds: ['s0'] } }], suppressSources: [{ id: 's1', version: 1 }, { id: 's3', version: 1 }, { id: 's4', version: 1 }], retainSources: [], clarification: null, reason: '旧事实及依赖回声退出，当前原文支撑更新' },
  },
  {
    description: '整件遗忘：当前user s0/v1“忘记练琴的事。”；user s1/v1“我每周五练琴。”；summary s2/v2与memory s3/v2均为“用户每周五练琴。”且来自s1/v1；assistant s4/v1“记得，你周五练琴。”来自s1/v1、s2/v2、s3/v2。均eligible=true，无其他依赖或无关事实。s3只走memory操作，其余走suppress；summary不能soft_delete，memory不能suppress。',
    plan: { request: 'forget', changes: [{ reason: '遗忘该安排', operation: { type: 'soft_delete', id: 's3', expectedVersion: 2 } }], suppressSources: [{ id: 's0', version: 1 }, { id: 's1', version: 1 }, { id: 's2', version: 2 }, { id: 's4', version: 1 }], retainSources: [], clarification: null, reason: '分别软删memory及抑制原文、摘要、回声' },
  },
  {
    description: '部分遗忘：当前user s0/v1“忘记练琴的事。”；旧user s1/v1“周五练琴，周日跑步。”，无memory或其他依赖。s1共10码点，“周日跑步。”是[5,10)；抑制原句并保留无关片段。',
    plan: { request: 'forget', changes: [], suppressSources: [{ id: 's0', version: 1 }, { id: 's1', version: 1 }], retainSources: [{ source: { id: 's1', version: 1 }, fragmentId: 'f0', start: 5, end: 10, supportSourceIds: [] }], clarification: null, reason: '排除练琴，逐字保留无关的跑步安排' },
  },
  {
    description: '先澄清：当前user s0/v1“两个安排忘掉一个。”；user s1/v1“周五练琴。”和s2/v1“周日跑步。”。目标不明，三个动作数组空，s0也不抑制，不复述候选事实。',
    plan: { request: 'forget', changes: [], suppressSources: [], retainSources: [], clarification: '你想忘记哪一个安排？', reason: '目标未明确，先询问' },
  },
];
