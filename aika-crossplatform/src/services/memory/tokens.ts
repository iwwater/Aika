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
  /**
   * 记忆内容变了（确认、编辑、删除都算）。返回取消注册。
   *
   * 与 `onInvalidate` 的分工：后者语义是「摘要作废」，只在 `forget` 时发；确认与
   * 编辑不该让摘要失效，但**必须**让另一个界面重读——同一份记忆两处显示各说各话，
   * 比不做管理页更糟。删除时两个都发，顺序是先 invalidate 后 changed。
   */
  onChanged(listener: () => void): () => void;
  /** 管理界面改完之后调用。仓储自己不知道界面存在，所以这一声得由改的人喊。 */
  notifyChanged(): void;
}

export const MemoryAccessToken = token<MemoryAccess>("llm.memoryAccess");
