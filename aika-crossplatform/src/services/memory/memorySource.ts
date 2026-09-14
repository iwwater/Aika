/**
 * 把 MemoryRepository 接成 LLM-02 的 ContextSource。
 *
 * 记忆只是「可参考的材料」，所以这里也只产片段，不做任何排序决策——
 * 排序在 domain/memoryRetrieval，预算裁剪在 ContextAssembler。
 */

import { MEMORY_TYPE_LABELS, type MemoryQuery } from "../../domain/memoryRetrieval";
import { LOCAL_PRINCIPAL_ID } from "../../domain/identity";
import type { ContextSnippet } from "../../domain/context";
import type { ContextSource } from "../context/contextAssembler";
import type { MemoryRepository } from "./memoryRepository";

export interface MemorySourceOptions {
  id?: string;
  limit?: number;
  tokenBudget?: number;
  /**
   * 长期记忆读写总开关（MVP-06 AC-D）。resolve false = 一个片段都不产、
   * **也不调用 `repository.retrieve`**——「禁止长期读」必须是零查询，不是「查了不用」。
   * 开关读取失败按关闭处理（个人数据宁可不读）。不传 = 恒开（既有行为）。
   */
  isEnabled?: () => Promise<boolean>;
}

/**
 * 谁能读这份个人记忆（RT-02-D）。
 *
 * 记忆库是**本地主体**的个人数据：只有 legacy 本地链路（未声明 principal 的
 * 旧调用方，RT-01 已把旧数据归属 local）和显式的本地主体可以读。任何外部
 * principal——无论绑定与否、无论声明了什么 userId——都不读它；绑定外部主体的
 * 个人记忆库是 RT-04 的事。没有明确授权就拒绝，是这里的唯一取向。
 */
function mayReadPersonalMemories(principalId: string | undefined): boolean {
  return principalId === undefined || principalId === LOCAL_PRINCIPAL_ID;
}

export function createMemorySource(
  repository: MemoryRepository,
  options: MemorySourceOptions = {},
): ContextSource {
  return {
    id: options.id ?? "memory",
    section: "memory",
    async load(input: { query: string; now: number; scope?: { principalId?: string } }): Promise<ContextSnippet[]> {
      if (!mayReadPersonalMemories(input.scope?.principalId)) {
        // 未授权主体：一个片段都不给。这是隔离，不是「没检索到」。
        return [];
      }
      if (options.isEnabled) {
        let enabled = true;
        try {
          enabled = await options.isEnabled();
        } catch {
          // 开关读不出来就当关着：个人数据的读取宁可保守。
          enabled = false;
        }
        if (!enabled) return [];
      }
      const query: MemoryQuery = {
        text: input.query,
        now: input.now,
        limit: options.limit ?? 8,
        tokenBudget: options.tokenBudget ?? 400,
      };
      const hits = await repository.retrieve(query);
      return hits.map((hit) => ({
        id: hit.record.id,
        category: MEMORY_TYPE_LABELS[hit.record.type],
        content: hit.record.content,
        source: "memory",
        // 只有用户确认过的记忆才标 confirmed，候选一律 unknown。
        precision: hit.record.status === "confirmed" ? "confirmed" : "unknown",
        // 过期的事件仍然真实，但必须让模型知道那是过去的事。
        temporal: hit.temporalStatus,
      }));
    },
  };
}
