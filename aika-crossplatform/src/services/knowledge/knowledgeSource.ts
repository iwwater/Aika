/**
 * Knowledge ContextSource（LLM-05）。
 *
 * 把知识检索挂进 Assembler 的来源集合：scope（角色/关系阶段/模式）由本轮
 * AssembleInput 透传进来——**缺 scope 就不给知识**（默认拒绝），绝不从 UI
 * 全局状态读，也不拿用户 query 覆盖解锁级别。文档内容永远以「资料」进入
 * knowledge section，超时/空结果返回带原因的空 section，不阻塞回复。
 */

import {
  sanitizeRetrievedText,
  type ContextSection,
  type ContextSnippet,
} from "../../domain/context";
import type { ContextSource, ContextSourceInput } from "../context/contextAssembler";
import { KNOWLEDGE_MIN_SCORE } from "../../domain/knowledge";
import type { KnowledgeIndex } from "./knowledgeIndex";

const KNOWLEDGE_SECTION: ContextSection = "knowledge";

export interface KnowledgeSourceOptions {
  /**
   * 知识库（RAG）检索开关（MVP-06 AC-D）。resolve false = 本源零 snippet、
   * **零检索调用**（「禁止额外检索」必须是零查询）。开关读取失败按可用处理——
   * 知识不是个人数据，这里与 memorySource 的 fail-closed 刻意不同。不传 = 恒开。
   */
  isEnabled?: () => Promise<boolean>;
}

export function createKnowledgeContextSource(index: KnowledgeIndex, options: KnowledgeSourceOptions = {}): ContextSource {
  return {
    id: "knowledge",
    section: KNOWLEDGE_SECTION,
    async load(input: ContextSourceInput): Promise<readonly ContextSnippet[]> {
      const scope = input.scope;
      if (!scope?.characterId || !scope.stage || !scope.mode) {
        // 没有本轮 scope 就没有可判定的解锁/授权依据：宁可空，不可越权。
        return [];
      }
      if (options.isEnabled) {
        let enabled = true;
        try {
          enabled = await options.isEnabled();
        } catch {
          // 读不到开关：知识不是个人数据，不因一次开关读取失败而静默下线。
          enabled = true;
        }
        if (!enabled) return [];
      }
      const retrieval = await index.retrieve({
        text: input.query,
        characterId: scope.characterId,
        stage: scope.stage,
        mode: scope.mode as never,
        limit: 5,
        tokenBudget: 900,
      });
      return retrieval.hits.map((hit) => ({
        id: hit.citation.chunkId,
        category: hit.document.type,
        content: sanitizeRetrievedText(hit.chunk.text),
        source: `knowledge:${hit.citation.documentId}#${hit.citation.chunkId}@v${hit.citation.version}`,
        tags: hit.document.tags,
        precision: "confirmed",
      }));
    },
  };
}

export { KNOWLEDGE_MIN_SCORE };
