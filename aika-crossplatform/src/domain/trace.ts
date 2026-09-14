/**
 * Trace 事件协议（LLM-06）。
 *
 * 为什么要版本化事件流而不是继续用那个 5 字段的 `TurnTrace`：后者发一次就没了，
 * 没有时序、不落盘、查不了，于是「协议合法但语义退化」的回复（比如 replyText 与
 * translation 返回同一句）永远不会被看见、被统计。
 *
 * 这个文件只有类型与纯函数——谁来发、往哪儿写，分别是下一份 SPEC 与 services/trace/。
 */

import type { ContextSection, ContextDropReason } from "./context";
import type { MessageSource } from "./conversation";

export const TRACE_SCHEMA_VERSION = 1;

export type TraceEventKind =
  | "turn_start"
  | "context_assemble"
  | "context_snapshot"
  | "provider_request"
  | "provider_stream_meta"
  | "reply"
  | "memory_extract"
  | "tts"
  | "turn_end"
  | "pet_command";

export type TraceTurnStatus = "completed" | "failed" | "cancelled";

export interface TraceDroppedSource {
  source: string;
  section: ContextSection | "history" | "summary";
  reason: ContextDropReason;
}

// ---------------------------------------------------------------------------
// context_snapshot（LLM-11）：装配期观察到的裁剪诊断。
//
// 在装配时采集，**不是**从最终 context 反推被裁内容；正文开关关闭时 content
// 由唯一脱敏点置 null。ordinal 只是本轮诊断序号，不冒充 Memory ID。
// ---------------------------------------------------------------------------

export interface TraceContextSnippetDiagnostic {
  /** 受控来源名（来源 id 或 section 名），不是自由路径。 */
  source: string;
  /** 可空：来源内部 id（如 memory id）。 */
  id: string | null;
  category: string | null;
  precision: "confirmed" | "proxy" | "unknown" | null;
  temporal: "current" | "past" | null;
  /** 本轮诊断序号，从 0 起。 */
  ordinal: number;
  estimatedTokens: number;
  kept: boolean;
  /** kept=false 时的裁剪原因。 */
  reason: ContextDropReason | null;
  /** 正文。脱敏关掉时是 null；缺失（null）和空串必须分得开。 */
  content: string | null;
}

export interface TraceContextSectionDiagnostic {
  name: ContextSection;
  snippets: TraceContextSnippetDiagnostic[];
  estimatedTokens: number;
}

export interface TraceContextBudgetDiagnostic {
  inputLimit: number;
  outputReserve: number;
  safetyReserve: number;
  /** max(0, inputLimit - outputReserve - safetyReserve)。估算口径，不是平台真实预算。 */
  available: number;
  estimatedUsed: number;
}

export interface TraceContextHistoryDiagnostic {
  inputCount: number;
  normalizedCount: number;
  recentLimitDropped: number;
  budgetDropped: number;
  kept: number;
}

export interface TraceContextSummaryDiagnostic {
  state: "none" | "used" | "skipped";
  estimatedTokens: number;
}

export interface TraceContextSnapshotFields {
  budget: TraceContextBudgetDiagnostic;
  requiredBlocks: { name: string; estimatedTokens: number }[];
  history: TraceContextHistoryDiagnostic;
  summary: TraceContextSummaryDiagnostic;
  sections: TraceContextSectionDiagnostic[];
  /** 截断时明确记录：这不是全量清单。 */
  counts: { snippetsTotal: number; snippetsKept: number; truncated: boolean };
}

interface TraceEventBase {
  schemaVersion: typeof TRACE_SCHEMA_VERSION;
  turnId: string;
  /** 会话 scope（RT-02，可选增量字段）：旧事件没有它，读取方按 legacy 本地处理。 */
  conversationId?: string;
  /** 同一轮内从 1 起单调递增；跨轮各自计数。落盘顺序与发生顺序脱钩时靠它还原时序。 */
  seq: number;
  at: number;
}

export type TraceEventV1 =
  | (TraceEventBase & {
    kind: "turn_start";
    source: MessageSource;
    mode: string;
    /** 用户这轮说了什么。脱敏关掉正文时是 null——缺失和空串必须分得开。 */
    text: string | null;
  })
  | (TraceEventBase & {
    kind: "context_assemble";
    estimatedTokens: number;
    droppedSources: TraceDroppedSource[];
    historyDropped: number;
    historyRepaired: number;
    /** 真进了上下文的来源名。空数组表示这一轮没注入任何检索结果。 */
    retrievedSources: string[];
  })
  | (TraceEventBase & ({ kind: "context_snapshot" } & TraceContextSnapshotFields))
  | (TraceEventBase & {
    kind: "provider_request";
    protocol: string;
    model: string;
    /** 去掉 query string 的 endpoint。Gemini 把 key 放在 ?key= 里，不砍就等于把 key 写进日志。 */
    endpoint: string;
    requestChars: number;
    instructionsChars: number;
    /**
     * 最终 instructions 的摘要。脱敏关掉正文时是 null。
     *
     * 挂在这里而不是 context_assemble：instructions 是 provider 适配器用装配结果
     * 拼出来的，装配阶段还不存在这个字符串。放在拿不到它的事件上只能拿别的字段凑。
     */
    instructionsDigest: string | null;
  })
  | (TraceEventBase & {
    kind: "provider_stream_meta";
    /** 首个 token 到达耗时。没收到过任何 chunk 时是 null，不写 0。 */
    firstTokenMs: number | null;
    chunks: number;
  })
  | (TraceEventBase & {
    kind: "reply";
    mood: string;
    replyChars: number;
    translationChars: number;
    /**
     * 正文与翻译是同一句。
     *
     * 协议上合法（两个字段都是非空 string），语义上退化——同一句话被显示两遍。
     * 记成布尔而不是记正文：这样它不受正文开关影响，在任何脱敏设置下都能统计，
     * 而它恰恰是最需要长期盯的一项（规划文档 §0.1 的「长效手段」）。
     */
    translationDuplicatesReply: boolean;
    /** 她挑的表情包。没挑时是 null，不是空串。 */
    sticker: string | null;
    /** 动作种类，不含载荷。当前只有 sticker 一种。 */
    actions: string[];
  })
  | (TraceEventBase & {
    kind: "memory_extract";
    candidates: number;
    /** 抽取本身失败了吗。失败不影响对话，但要能被统计到。 */
    failed: boolean;
  })
  | (TraceEventBase & {
    kind: "tts";
    sentences: number;
    played: boolean;
    errorCount: number;
  })
  | (TraceEventBase & {
    kind: "turn_end";
    status: TraceTurnStatus;
    durationMs: number;
    errorCode?: string;
    tokens: TraceTokens;
  })
  | (TraceEventBase & {
    // 桌宠命令诊断（MVP-04 真机排障）：只记结果与代码，**永不记正文**——
    // 回复文本属于对话记录，trace 里出现它就破坏了「旁路不留内容」的边界。
    kind: "pet_command";
    command: string;
    outcome: string;
    code: string | null;
  });

/**
 * 两种 token 分开放，不合成一个「tokens」数字。
 *
 * `reportedTotal` 目前一律 null：provider 侧还没把 usage 透出来。写 0 会让成本页
 * 把「不知道」画成「不花钱」。
 */
export interface TraceTokens {
  estimatedPrompt: number | null;
  reportedTotal: number | null;
}

export interface TraceQuery {
  turnId?: string;
  kind?: TraceEventKind;
  /** 只要这个时刻（含）之后的。 */
  since?: number;
  limit?: number;
}

export interface TraceRedactionPolicy {
  /** false 时正文类字段一律写 null。默认 false——正文进不进盘是用户的选择。 */
  includeText: boolean;
}

export const DEFAULT_TRACE_REDACTION: TraceRedactionPolicy = { includeText: false };

/**
 * 去掉 endpoint 的 query string 与凭据部分。
 *
 * 不是「把 key 参数挑出来删掉」——那要求我们提前知道每家把 key 放在哪个参数名下。
 * 整段 query 都不要，才是不需要维护清单的做法。解析失败时退回到 `?` 之前那一截。
 */
export function redactEndpoint(endpoint: string): string {
  const raw = (endpoint ?? "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return raw.split("?")[0].split("#")[0];
  }
}

/** 正文摘要：留个开头看得出是哪一轮，不留全文。 */
export function digestText(text: string, limit = 80): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}…`;
}

/**
 * 按脱敏策略处理一个事件。
 *
 * apiKey 不在这里被过滤——它压根没有字段可放，这是类型层面的保证，比运行时过滤可靠。
 * 这里管的是「正文要不要进盘」和「endpoint 的 query 一律砍掉」。
 */
export function redactTraceEvent(
  event: TraceEventV1,
  policy: TraceRedactionPolicy = DEFAULT_TRACE_REDACTION,
): TraceEventV1 {
  if (event.kind === "provider_request") {
    // endpoint 的 query 无论开关都砍掉；instructions 摘要才受开关控制。
    const endpoint = redactEndpoint(event.endpoint);
    return policy.includeText
      ? { ...event, endpoint }
      : { ...event, endpoint, instructionsDigest: null };
  }
  if (event.kind === "context_snapshot") {
    if (policy.includeText) return event;
    // 正文开关关闭：content 一律置 null；source 是受控来源名，保留可统计。
    return {
      ...event,
      sections: event.sections.map((section) => ({
        ...section,
        snippets: section.snippets.map((snippet) => ({ ...snippet, content: null })),
      })),
    };
  }
  if (policy.includeText) return event;
  if (event.kind === "turn_start") return { ...event, text: null };
  return event;
}

/** 还原时序：按轮次分组内按 seq 升序，轮次之间按各自第一个事件的时刻。 */
export function sortTraceEvents(events: readonly TraceEventV1[]): TraceEventV1[] {
  return [...events].sort((left, right) => (
    left.turnId === right.turnId ? left.seq - right.seq : left.at - right.at || left.seq - right.seq
  ));
}
