import type { ConversationTurn } from "../../domain/companion";
import {
  createMemory, isDuplicateMemory, MEMORY_CATEGORIES, parseMemoryCandidates,
  type MemoryRecord,
} from "../../domain/memory";
import { buildSummaryInput, SUMMARY_INSTRUCTIONS } from "../../domain/summary";
import type { ProviderConfig } from "../../domain/providers";
import { requestJson, requestPlainText, type ProviderRequestOptions, type RequestMetric } from "../providerClient";
import type { UsageLedgerRecorder } from "../usage/contracts";

/**
 * 记忆抽取与滚动摘要。
 *
 * 用哪个模型做抽取是 DEVELOPMENT_PLAN 里未决的技术选型（主模型 vs 本地小模型），
 * 所以这里只定接口：换成本地小模型时实现 MemoryExtractor 即可，主程序不用改。
 */
/** 维护请求的计量上下文：物理尝试次数与用途由 providerClient/recorder 记。 */
export interface MaintenanceRequestContext {
  turnId?: string;
  onRequestMetric?: (metric: RequestMetric) => void;
}

export interface MemoryExtractor {
  extract(
    turns: readonly ConversationTurn[],
    existing: readonly MemoryRecord[],
    context?: MaintenanceRequestContext,
  ): Promise<MemoryRecord[]>;
  summarize(
    previousSummary: string | null,
    transcript: string,
    context?: MaintenanceRequestContext,
  ): Promise<string>;
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

/**
 * 后台维护请求的计量接线（LLM-12-A）：抽取记 maintenance、摘要记 summary——
 * 用途由这里的实际调用方声明。装了用量台账时由 recorder 包住 options 登记
 * 每次物理尝试；没装就只透传计量回调。
 */
/** 后台维护只会声明这两种用途；unknown 是「没声明」的记法，不由这里使用。 */
function maintenanceOptions(
  purpose: "maintenance" | "summary",
  context: MaintenanceRequestContext | undefined,
  getProvider: () => ProviderConfig,
  usageRecorder: UsageLedgerRecorder | undefined,
): ProviderRequestOptions {
  const base: ProviderRequestOptions = {
    requestTurnId: context?.turnId,
    onRequestMetric: context?.onRequestMetric,
  };
  if (!usageRecorder) return { ...base, requestPurpose: purpose };
  return usageRecorder.observe({
    config: getProvider(),
    purpose,
    turnId: context?.turnId,
    options: base,
  });
}

export function createModelMemoryExtractor(
  getProvider: () => ProviderConfig,
  usageRecorder?: UsageLedgerRecorder,
): MemoryExtractor {
  return {
    async extract(turns, existing, context) {
      if (turns.length === 0) return [];
      const transcript = formatTurns(turns);
      if (!transcript.trim()) return [];

      const raw = await requestJson(getProvider(), EXTRACTION_INSTRUCTIONS, [
        { role: "user", content: transcript },
      ], maintenanceOptions("maintenance", context, getProvider, usageRecorder));

      const accepted: MemoryRecord[] = [];
      for (const candidate of parseMemoryCandidates(raw)) {
        if (isDuplicateMemory(candidate.content, [...existing, ...accepted])) continue;
        const record = createMemory(candidate.content, candidate.category, "pending");
        if (record) accepted.push(record);
      }
      return accepted;
    },

    async summarize(previousSummary, transcript, context) {
      if (!transcript.trim()) return previousSummary ?? "";
      const text = await requestPlainText(getProvider(), SUMMARY_INSTRUCTIONS, [
        { role: "user", content: buildSummaryInput(previousSummary, transcript) },
      ], maintenanceOptions("summary", context, getProvider, usageRecorder));
      return text.trim();
    },
  };
}

export { formatTurns as formatTranscript };
