import type { ConversationTurn } from "../../domain/companion";
import {
  createMemory, isDuplicateMemory, MEMORY_CATEGORIES, parseMemoryCandidates,
  type MemoryRecord,
} from "../../domain/memory";
import { buildSummaryInput, SUMMARY_INSTRUCTIONS } from "../../domain/summary";
import type { ProviderConfig } from "../../domain/providers";
import { requestJson, requestPlainText } from "../providerClient";

/**
 * 记忆抽取与滚动摘要。
 *
 * 用哪个模型做抽取是 DEVELOPMENT_PLAN 里未决的技术选型（主模型 vs 本地小模型），
 * 所以这里只定接口：换成本地小模型时实现 MemoryExtractor 即可，主程序不用改。
 */
export interface MemoryExtractor {
  extract(turns: readonly ConversationTurn[], existing: readonly MemoryRecord[]): Promise<MemoryRecord[]>;
  summarize(previousSummary: string | null, transcript: string): Promise<string>;
}

const EXTRACTION_INSTRUCTIONS = [
  "从下面这段对话里挑出值得长期记住的事实，用于以后自然地想起对方。",
  `只记对方（用户）的事：${MEMORY_CATEGORIES.join("、")}。`,
  "每条一句话，写清楚是什么，不要写「用户说」这种前缀，不要推测，不要写你自己的事。",
  "没有值得记的就返回空数组。宁可少记，也不要把闲聊当成事实。",
  '只输出 JSON 数组，不要 Markdown：[{"category":"偏好","content":"喜欢傍晚散步"}]',
].join("\n");

function formatTurns(turns: readonly ConversationTurn[]): string {
  return turns
    .map((turn) => `${turn.role === "companion" ? "Aika" : "用户"}：${turn.text}`)
    .join("\n");
}

export function createModelMemoryExtractor(getProvider: () => ProviderConfig): MemoryExtractor {
  return {
    async extract(turns, existing) {
      if (turns.length === 0) return [];
      const transcript = formatTurns(turns);
      if (!transcript.trim()) return [];

      const raw = await requestJson(getProvider(), EXTRACTION_INSTRUCTIONS, [
        { role: "user", content: transcript },
      ]);

      const accepted: MemoryRecord[] = [];
      for (const candidate of parseMemoryCandidates(raw)) {
        if (isDuplicateMemory(candidate.content, [...existing, ...accepted])) continue;
        const record = createMemory(candidate.content, candidate.category, "pending");
        if (record) accepted.push(record);
      }
      return accepted;
    },

    async summarize(previousSummary, transcript) {
      if (!transcript.trim()) return previousSummary ?? "";
      const text = await requestPlainText(getProvider(), SUMMARY_INSTRUCTIONS, [
        { role: "user", content: buildSummaryInput(previousSummary, transcript) },
      ]);
      return text.trim();
    },
  };
}

export { formatTurns as formatTranscript };
