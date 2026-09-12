import type { ConversationScopeV1 } from "../../domain/identity";
import type { AikaStorage } from "../storage/contracts";
import type { RuntimeStorage } from "./companionRuntime";

/**
 * 会话 scope 的存储视图（RT-02）。
 *
 * Runtime 的每一轮在提交时就固定自己的 scope，并拿到**这个视图**做全部存储
 * 读写——在途 I/O 闭包里握着的是自己那一份，不存在「全局变量换了 scope 让
 * 别人的轮次读到」的通道。视图经底层存储的 scope 参数过滤，旧数据（无
 * conversationId）只归属 legacy 本地会话。
 */
export function createScopedRuntimeStorage(storage: AikaStorage, scope: ConversationScopeV1): RuntimeStorage {
  const conversation = { conversationId: scope.conversationId };
  return {
    listMessages: (limit) => storage.listMessages(limit, conversation),
    appendMessage: (message) => storage.appendMessage({ ...message, conversationId: scope.conversationId }),
    listMessageTimestamps: () => storage.listMessageTimestamps(conversation),
    latestSummary: () => storage.latestSummary(conversation),
  };
}
