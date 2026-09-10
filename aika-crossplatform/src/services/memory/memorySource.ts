/**
 * 把 MemoryRepository 接成 LLM-02 的 ContextSource。
 *
 * 记忆只是「可参考的材料」，所以这里也只产片段，不做任何排序决策——
 * 排序在 domain/memoryRetrieval，预算裁剪在 ContextAssembler。
 */

import { MEMORY_TYPE_LABELS, type MemoryQuery } from "../../domain/memoryRetrieval";
import type { ContextSnippet } from "../../domain/context";
import type { ContextSource } from "../context/contextAssembler";
import type { MemoryRepository } from "./memoryRepository";

export interface MemorySourceOptions {
  id?: string;
  limit?: number;
  tokenBudget?: number;
}

export function createMemorySource(
  repository: MemoryRepository,
  options: MemorySourceOptions = {},
): ContextSource {
  return {
    id: options.id ?? "memory",
    section: "memory",
    async load(input: { query: string; now: number }): Promise<ContextSnippet[]> {
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
