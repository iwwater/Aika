import type { TurnScope } from '../contracts/index.js';
import type { RuntimeTrace, TraceContentResult } from '../core/trace-store.js';
import type { SqliteMemoryStore } from './sqlite-store.js';

/** Resolve trace text from the authoritative History store; never persist another plaintext copy. */
export function readTraceContentFromHistory(store: Pick<SqliteMemoryStore, 'inspectMany'>, trace: RuntimeTrace): TraceContentResult {
  try {
    const scope = {
      characterId: trace.characterId as TurnScope['characterId'],
      sessionId: trace.sessionId,
      turnId: trace.turnId,
      generation: 0,
    } satisfies TurnScope;
    const [user, assistant] = store.inspectMany(scope, [`${trace.turnId}:user`, `${trace.turnId}:assistant`]);
    if (!user || !assistant || user.state !== 'active' || assistant.state !== 'active' || !user.message || !assistant.message) {
      return {
        status: user || assistant ? 'forgotten' : 'unavailable',
        reason: user || assistant ? '对应历史已遗忘或清理，Trace 不保留正文副本。' : '旧 Trace 没有可验证的历史消息关联。',
      };
    }
    if (user.message.role !== 'user' || assistant.message.role !== 'assistant') {
      return { status: 'unavailable', reason: '历史消息角色与 Trace 的问答顺序不匹配。' };
    }
    return { status: 'available', userText: user.message.text, replyText: assistant.message.text };
  } catch {
    return { status: 'unavailable', reason: '无法在当前角色与会话作用域内核对历史正文。' };
  }
}
