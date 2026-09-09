import type { ChatMessage } from "../../domain/conversation";
import type { AikaStorage } from "./contracts";

/**
 * 为同一消息 ID 串行化异步落库。
 *
 * 语音轮次可能同时收到 provider 完成、播放失败和 abort 的回调；SQLite 与
 * localStorage 都是异步边界，若不按 ID 排队，interrupted/complete 更新可能
 * 反序覆盖。时间戳集合单独去重，避免同一用户消息重复增加关系统计。
 */
export function createSerializedMessagePersister(
  getStorage: () => Pick<AikaStorage, "appendMessage"> | null,
  persistedMessageIds: Set<string>,
  onNewTimestamp: (createdAt: number) => void,
): (message: ChatMessage) => Promise<void> {
  const chains = new Map<string, Promise<void>>();

  return async (message) => {
    const previous = chains.get(message.id) ?? Promise.resolve();
    let operation: Promise<void>;
    operation = previous.catch(() => undefined).then(async () => {
      await getStorage()?.appendMessage(message);
      if (!message.error && !persistedMessageIds.has(message.id)) {
        persistedMessageIds.add(message.id);
        onNewTimestamp(message.createdAt);
      }
    });
    chains.set(message.id, operation);
    try {
      await operation;
    } finally {
      if (chains.get(message.id) === operation) chains.delete(message.id);
    }
  };
}
