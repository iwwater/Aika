import { token } from "../../kernel";
import type { MemoryRepository } from "./memoryRepository";

/**
 * 记忆仓储。
 *
 * 存储没有 memoryV2 端口时这个 token **不注册**——消费方按 optional +
 * tryResolve 降级到 V1 记忆，不是拿到一个空壳仓储。
 */
export const MemoryRepositoryToken = token<MemoryRepository>("llm.memoryRepository");

/**
 * 记忆能力包：仓储 + 删除后的联动通知。
 *
 * 仓储本身不知道界面存在，但「删掉一条记忆要让相关摘要整段作废」是记忆插件的职责。
 * 界面侧的 Presenter 通过 `onInvalidate` 订阅这件事，而不是自己再造一个仓储——造两份
 * 会让删除联动只对其中一份生效。
 */
export interface MemoryAccess {
  repository: MemoryRepository;
  /** 注册删除联动；返回取消注册。 */
  onInvalidate(listener: () => void): () => void;
}

export const MemoryAccessToken = token<MemoryAccess>("llm.memoryAccess");
