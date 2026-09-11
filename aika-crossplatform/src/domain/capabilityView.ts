/**
 * 一轮之内各项能力做了什么（F5）。
 *
 * 按**现有能力如实展示**：这个仓库的 tool call 面很窄（`actions` 只有 sticker
 * 一种），所以这里不假装有一套通用工具链，也不为将来可能有的能力留空占位。
 *
 * 「没发生」与「发生了但结果为 0」必须分得开：没有 memory_extract 事件是「这一轮
 * 没跑抽取」，`candidates: 0` 是「跑了但一条都没抽出来」。两者的排查方向完全不同。
 */

import type { TraceEventV1 } from "./trace";

export type CapabilityOutcome = "ok" | "empty" | "degraded" | "failed" | "absent";

export interface CapabilityCall {
  /** 能力名，界面直接显示。 */
  capability: string;
  outcome: CapabilityOutcome;
  /** 一句话说明这次调用的结果。 */
  detail: string;
  /** 附加条目（来源清单、被丢掉的来源等），没有就是空数组。 */
  items: string[];
}

const DROP_REASON_LABELS: Record<string, string> = {
  budget: "超出预算",
  timeout: "来源超时",
  error: "来源报错",
  empty: "来源为空",
  unavailable: "来源不可用",
};

function dropLabel(reason: string): string {
  return DROP_REASON_LABELS[reason] ?? reason;
}

/** 这一轮的能力调用清单，按固定顺序给出（缺的那项标 absent，不从列表里消失）。 */
export function capabilityCalls(events: readonly TraceEventV1[], turnId: string): CapabilityCall[] {
  const turnEvents = events.filter((event) => event.turnId === turnId);
  const find = <K extends TraceEventV1["kind"]>(kind: K) =>
    turnEvents.find((event): event is Extract<TraceEventV1, { kind: K }> => event.kind === kind);

  const assemble = find("context_assemble");
  const reply = find("reply");
  const memory = find("memory_extract");
  const tts = find("tts");

  return [
    assemble
      ? {
        capability: "上下文检索",
        outcome: assemble.retrievedSources.length ? "ok" : "empty",
        detail: assemble.retrievedSources.length
          ? `注入 ${assemble.retrievedSources.length} 个来源，估算 ${assemble.estimatedTokens} token`
          : `没有注入任何来源，估算 ${assemble.estimatedTokens} token`,
        items: assemble.retrievedSources,
      }
      : absent("上下文检索"),
    assemble
      ? {
        capability: "来源降级",
        outcome: assemble.droppedSources.length ? "degraded" : "ok",
        detail: assemble.droppedSources.length
          ? `${assemble.droppedSources.length} 个来源没进上下文`
          : "没有来源被丢掉",
        items: assemble.droppedSources.map((dropped) => `${dropped.source} · ${dropped.section} · ${dropLabel(dropped.reason)}`),
      }
      : absent("来源降级"),
    reply
      ? {
        capability: "表情包",
        outcome: reply.sticker ? "ok" : "empty",
        detail: reply.sticker ? `挑了 ${reply.sticker}` : "这一轮没挑表情包",
        items: reply.actions,
      }
      : absent("表情包"),
    reply
      ? {
        capability: "双语回包",
        // 协议合法但语义退化：同一句话被当成正文和翻译返回两遍。
        outcome: reply.translationDuplicatesReply ? "degraded" : reply.translationChars ? "ok" : "empty",
        detail: reply.translationDuplicatesReply
          ? "正文与翻译是同一句（语义退化）"
          : reply.translationChars
            ? `正文 ${reply.replyChars} 字 · 翻译 ${reply.translationChars} 字`
            : `正文 ${reply.replyChars} 字 · 没有翻译`,
        items: [],
      }
      : absent("双语回包"),
    memory
      ? {
        capability: "记忆抽取",
        outcome: memory.failed ? "failed" : memory.candidates ? "ok" : "empty",
        detail: memory.failed
          ? "抽取失败"
          : memory.candidates
            ? `抽出 ${memory.candidates} 条候选`
            : "跑了，但一条候选都没有",
        items: [],
      }
      : absent("记忆抽取"),
    tts
      ? {
        capability: "语音播放",
        outcome: tts.errorCount ? "degraded" : tts.played ? "ok" : "failed",
        detail: `${tts.sentences} 句 · ${tts.played ? "播过" : "没播出来"}${tts.errorCount ? ` · 失败 ${tts.errorCount} 句` : ""}`,
        items: [],
      }
      : absent("语音播放"),
  ];
}

/** 没有对应事件：这一轮没走到这项能力，与「走了但结果为空」是两件事。 */
function absent(capability: string): CapabilityCall {
  return { capability, outcome: "absent", detail: "这一轮没有发生", items: [] };
}

export const OUTCOME_LABELS: Record<CapabilityOutcome, string> = {
  ok: "正常",
  empty: "空结果",
  degraded: "降级",
  failed: "失败",
  absent: "未发生",
};
