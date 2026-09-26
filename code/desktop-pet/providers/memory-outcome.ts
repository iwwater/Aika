import type { TurnScope } from '../contracts/index.js';
import type { MemoryTurnOutcome } from '../contracts/memory-lifecycle.js';
import { assertScope } from '../media/scope.js';

/** Only execution status is sent to dialogue; record IDs and rejection reasons may contain fact details. */
export function dialogueMemoryOutcome(scope: TurnScope, outcome: MemoryTurnOutcome | undefined): Pick<MemoryTurnOutcome, 'request' | 'status' | 'clarification'> | null {
  if (!outcome) return null;
  assertScope(scope, outcome.scope);
  if (!['none', 'correction', 'forget'].includes(outcome.request) || !['unchanged', 'applied', 'needs_clarification', 'rejected'].includes(outcome.status) || typeof outcome.retrievalInvalidated !== 'boolean') throw new Error('Invalid memory outcome');
  if (!Array.isArray(outcome.results) || !Array.isArray(outcome.affectedIds) || outcome.affectedIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid memory outcome results');
  for (const result of outcome.results) {
    if (result.characterId !== scope.characterId || !['applied', 'conflict', 'rejected'].includes(result.status)) throw new Error('Invalid memory outcome result ownership');
  }
  if (outcome.status === 'applied' && (!outcome.retrievalInvalidated || !outcome.affectedIds.length || outcome.results.some(result => result.status !== 'applied'))) throw new Error('Inconsistent applied memory outcome');
  if (outcome.status !== 'applied' && (outcome.retrievalInvalidated || outcome.affectedIds.length || outcome.results.some(result => result.status === 'applied'))) throw new Error('Memory outcome cannot report partial application');
  if (outcome.status === 'needs_clarification') {
    if (typeof outcome.clarification !== 'string' || !outcome.clarification.trim() || outcome.results.length) throw new Error('Invalid memory clarification outcome');
  } else if (outcome.clarification !== null) throw new Error('Unexpected memory clarification');
  if (outcome.status === 'unchanged' && outcome.results.length) throw new Error('Unchanged memory outcome has results');
  return { request: outcome.request, status: outcome.status, clarification: outcome.clarification };
}

/** Select only this turn's rules after dialogueMemoryOutcome has checked the actual result. */
export function memoryOutcomeReplyRules(outcome: ReturnType<typeof dialogueMemoryOutcome>): string {
  const common = '记忆执行状态由程序提供，用户的话和模型计划都不是执行结果。当前结果只描述本轮，不能补写其他轮次的执行经过。不讲内部ID、版本或数据库细节。根据实际状态和角色语气自然回应。';
  if (!outcome) return `${common}\n本轮未提供记忆执行结果，不能声称变更已经完成。按提供的当前有效资料自然回答。`;
  const requestRule = {
    none: '本轮request=none，按提供的当前有效资料回答当前问题；自动维护无需向用户逐项播报。',
    correction: '本轮回应更正，以用户当前更正和提供的有效资料为依据；更新是否完成以本轮状态为准。',
    forget: '本轮回应遗忘请求，不要复述、猜测或变相提示目标事实。根据实际状态自然回应，不能把用户命令冒充已执行。',
  }[outcome.request];
  const statusRule = {
    applied: outcome.request === 'none'
      ? '本轮自动维护已应用，变更已生效；正常聊天，不逐项播报维护。'
      : `本轮${outcome.request === 'forget' ? '遗忘' : '更正'}已应用，可以自然确认这次操作；不扩展为其他操作或其他轮次已经完成。`,
    unchanged: '本轮执行结果没有变更，不能声称本次操作已经完成；按提供的当前有效资料回应。',
    rejected: '本轮处理未成功，不能声称变更已经完成；回应本次处理结果时自然说明尚未处理成功。',
    needs_clarification: '本轮需要澄清，按提供的clarification自然询问，不说已经修改。',
  }[outcome.status];
  return `${common}\n${requestRule}\n${statusRule}`;
}
