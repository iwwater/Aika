import { type AikaPlugin } from "../../kernel";
import { ContextSourcesToken } from "../../services/context/tokens";
import type { ContextSource } from "../../services/context/contextAssembler";
import { createKnowledgeContextSource } from "../../services/knowledge/knowledgeSource";
import { createKnowledgeIndex } from "../../services/knowledge/knowledgeIndex";
import { createMemorySource } from "../../services/memory/memorySource";
import { MemoryRepositoryToken } from "../../services/memory/tokens";
import { StorageToken } from "../../services/storage/tokens";

/**
 * 上下文来源的**唯一装配点**（LLM-05）。
 *
 * Memory 源照旧进来（optional：noMemoryPlugin 宿主没有仓储，不该挡住知识）；
 * Knowledge 源只在存储暴露 sqlExecutor 时加入——浏览器 localStorage 宿主没有
 * SQL 可用，知识能力整体不装，而不是装一个永远为空的假源。两类来源互不绑架：
 * memoryV2 缺失不让 Knowledge 一起消失，反之亦然。
 */
export function contextSourcesPlugin(): AikaPlugin {
  return {
    id: "llm.contextSources",
    version: "1.0.0",
    requires: [StorageToken],
    optional: [MemoryRepositoryToken],
    provides: [ContextSourcesToken],
    activate(context) {
      const storage = context.registrar.resolve(StorageToken);
      const memoryRepository = context.registrar.tryResolve(MemoryRepositoryToken);
      const sources: ContextSource[] = [];
      if (memoryRepository) sources.push(createMemorySource(memoryRepository));
      const db = storage.sqlExecutor;
      if (db) sources.push(createKnowledgeContextSource(createKnowledgeIndex({ db })));
      context.registrar.provide(ContextSourcesToken, () => sources);
    },
  };
}
