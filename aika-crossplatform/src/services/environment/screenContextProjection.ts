import type { ContextSnippet } from "../../domain/context";

/**
 * 屏幕文本上下文的投影与纯函数口径（FE-32）。
 *
 * 这里是**唯一**把 OCR 文本变成「可以送给 Provider 的东西」的地方：截图与完整
 * OCR 原文只在内存里走到这一步，投影出去的只有受限摘录。投影结果仍然是
 * **带来源与时间的不可信上下文**——它进 `AgentContext.environment`，由既有
 * `formatRetrievedSections` 放进「参考资料」区块，不做 system/user 指令，
 * 不写 UserSoul。
 *
 * 口径（SPEC 冻结）：最多 20 段、总计 2000 字符，保留阅读顺序与段置信度；
 * 超出部分截断并标记 truncated。单段再受 240 字符限制——与既有
 * `sanitizeRetrievedText` 的出口上限对齐，避免「投影说 2000，实际进提示词被砍到
 * 240」这种账面与事实不符。
 *
 * 不承诺的事：模型可能复述摘录，这里不宣称脱敏能消除全部敏感信息；
 * 识别不到文字只说明没读到，不等于画面没有内容。
 */

export const SCREEN_CONTEXT_SCHEMA_VERSION = "screen-context.v1" as const;
export const SCREEN_CONTEXT_SOURCE_ID = "screen-context";

/** 摘录上限（SPEC 冻结）。 */
export const MAX_EXCERPTS = 20;
export const MAX_EXCERPT_TOTAL_CHARS = 2000;
/** 单段上限：与 domain/context.ts `sanitizeRetrievedText` 的默认 limit 对齐。 */
export const EXCERPT_SEGMENT_CHARS = 240;

/** 上下文有效期，从采集时刻计时。 */
export const SCREEN_CONTEXT_TTL_MS = 60_000;
/** 自动候选的置信度门槛；低于此值只能用于手动读屏并标注「不确定」。 */
export const AUTO_CANDIDATE_MIN_CONFIDENCE = 0.8;
/** 主动路径要求的「与上次已处理文本」规范化差异下限。 */
export const AUTO_MIN_DIFF_RATIO = 0.2;
/** 主动路径要求的前台内容稳定时长。 */
export const AUTO_STABLE_MS = 3000;
/** 单次 OCR 超时与热读屏预算（扩展文本区域）。 */
export const SCREEN_CONTEXT_OCR_TIMEOUT_MS = 5000;
export const SCREEN_CONTEXT_HOT_BUDGET_MS = 3000;

export type ScreenReadStatus =
  /** 读到有效文本。 */
  | "ok"
  /** 采集成功但没有可用文字（**不等于画面没有内容**）。 */
  | "empty"
  /** 只读到低置信度文字：手动路径可用但要标不确定，自动路径不用。 */
  | "low_confidence"
  | "timeout"
  /** 不可捕获：无前台窗口 / 最小化 / 受保护内容 / 黑帧。 */
  | "unavailable"
  /** 无法可靠排除 pet/主窗覆盖区域——拒绝该区域，提示调整窗口。 */
  | "self_obscured"
  /** 采集或摘录授权未开启。 */
  | "unauthorized"
  /** 达到滚动额度。 */
  | "rate_limited"
  /** 被后到候选顶掉。 */
  | "superseded"
  /** 会话撤销 / 暂停 / 锁屏 / 旧 generation。 */
  | "cancelled";

export type ScreenTextLanguage = "zh" | "en" | "mixed" | "unknown";

/** 窗口身份：进程名 + 不透明窗口 ID + 显示器 ID。**没有标题**。 */
export interface ScreenWindowIdentity {
  readonly processName: string;
  readonly windowId: string;
  readonly monitorId: string;
}

export interface ScreenRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ScreenExcerpt {
  /** 阅读顺序，从 0 开始。 */
  readonly order: number;
  readonly text: string;
  readonly confidence: number;
  /** 本段被单段上限截断。 */
  readonly truncated: boolean;
}

export interface ScreenContextResult {
  readonly schemaVersion: typeof SCREEN_CONTEXT_SCHEMA_VERSION;
  readonly id: string;
  readonly sourceId: typeof SCREEN_CONTEXT_SOURCE_ID;
  readonly sourceTrust: "environment";
  /** 采集代数：每次 readOnce 递增，用于丢弃迟到结果。 */
  readonly captureGeneration: number;
  /** 请求方（陪伴会话）的代数；会话撤销后旧结果一律无效。 */
  readonly sessionGeneration: number;
  readonly reason: "manual" | "change";
  readonly window: ScreenWindowIdentity | null;
  readonly region: ScreenRegion | null;
  /** 单调时钟的采集时刻。 */
  readonly capturedMonotonicMs: number;
  readonly expiresAtMonotonicMs: number;
  readonly language: ScreenTextLanguage;
  /** 段置信度的中位数；无有效段为 0。 */
  readonly confidence: number;
  readonly readStatus: ScreenReadStatus;
  readonly excerpts: readonly ScreenExcerpt[];
  /** 段数/总字符/单段任一超限。 */
  readonly truncated: boolean;
  /** readStatus=rate_limited 时的下一次可用时刻。 */
  readonly retryAtMonotonicMs: number | null;
}

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_LETTER = /[A-Za-z]/;
/** 控制字符与双向覆盖符：投影前统一剥掉（不靠模型自己识别）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** 一行 OCR 文本的原始形态（引擎给的行/段）。 */
export interface ScreenTextLine {
  readonly text: string;
  readonly confidence: number;
}

/** 汉字之间的单个空格：chi_sim 会逐字断词，投影前收掉，否则摘录读起来是散的。 */
const CJK_GAP = /([\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]) (?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/g;

function cleanLine(text: string): string {
  return text
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    // 只收「汉字 空格 汉字」；汉字与拉丁/数字之间的空格保留（那是真的分词）。
    .replace(CJK_GAP, "$1");
}

/**
 * 行 → 摘录：清洗、按阅读顺序保留、段数/总字符/单段三重截断。
 *
 * 不做语义挑选（那是模型的事），也不按关键词过滤——FE-21 的词表模式是另一条轨。
 */
export function projectExcerpts(
  lines: readonly ScreenTextLine[],
  options?: { maxExcerpts?: number; maxTotalChars?: number; segmentChars?: number },
): { excerpts: readonly ScreenExcerpt[]; truncated: boolean } {
  const maxExcerpts = options?.maxExcerpts ?? MAX_EXCERPTS;
  const maxTotalChars = options?.maxTotalChars ?? MAX_EXCERPT_TOTAL_CHARS;
  const segmentChars = options?.segmentChars ?? EXCERPT_SEGMENT_CHARS;

  const excerpts: ScreenExcerpt[] = [];
  let used = 0;
  let truncated = false;

  for (const line of lines) {
    const text = cleanLine(line.text ?? "");
    if (!text) continue;
    if (excerpts.length >= maxExcerpts) {
      truncated = true;
      break;
    }
    if (used >= maxTotalChars) {
      truncated = true;
      break;
    }
    const budget = Math.min(segmentChars, maxTotalChars - used);
    const cut = text.length > budget;
    const kept = cut ? text.slice(0, budget) : text;
    if (!kept) {
      truncated = true;
      break;
    }
    const confidence = Number.isFinite(line.confidence)
      ? Math.max(0, Math.min(1, line.confidence))
      : 0;
    excerpts.push({ order: excerpts.length, text: kept, confidence, truncated: cut });
    used += kept.length;
    if (cut) truncated = true;
  }

  return { excerpts, truncated };
}

/** 语言判定只看字符构成，不声称理解内容。 */
export function detectLanguage(text: string): ScreenTextLanguage {
  const hasCjk = CJK.test(text);
  const hasLatin = LATIN_LETTER.test(text);
  if (hasCjk && hasLatin) return "mixed";
  if (hasCjk) return "zh";
  if (hasLatin) return "en";
  return "unknown";
}

/** 段置信度中位数；空集为 0（不拿 1 冒充「很确定」）。 */
export function medianConfidence(excerpts: readonly ScreenExcerpt[]): number {
  if (excerpts.length === 0) return 0;
  const sorted = [...excerpts.map((item) => item.confidence)].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** 规范化：去空白、去标点、统一小写，供「是不是同一屏内容」比较。 */
export function normalizeForDiff(text: string): string {
  return cleanLine(text)
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, "")
    .replace(/\s+/g, "");
}

/**
 * 规范化差异比例：0 = 完全相同，1 = 完全不同。
 * 用字符多重集差异（不是编辑距离）——够判「这屏还是上一屏吗」，且线性开销。
 */
export function diffRatio(previous: string, next: string): number {
  const a = normalizeForDiff(previous);
  const b = normalizeForDiff(next);
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0 || b.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const char of a) counts.set(char, (counts.get(char) ?? 0) + 1);
  let shared = 0;
  for (const char of b) {
    const left = counts.get(char) ?? 0;
    if (left > 0) {
      counts.set(char, left - 1);
      shared += 1;
    }
  }
  const union = Math.max(a.length, b.length);
  return 1 - shared / union;
}

/** 有界内存指纹（只在内存、不入日志）：判断这段文本刚刚处理过没有。 */
export function createTextFingerprintMemory(limit = 8) {
  const ring: string[] = [];
  const fingerprint = (text: string): string => {
    const normalized = normalizeForDiff(text);
    // 不做加密散列：这是易失的去重键，不是可追溯标识。
    let hash = 0;
    for (let index = 0; index < normalized.length; index += 1) {
      hash = (hash * 31 + normalized.charCodeAt(index)) | 0;
    }
    return `${normalized.length}:${hash}`;
  };
  return {
    fingerprint,
    seen(text: string): boolean {
      return ring.includes(fingerprint(text));
    },
    remember(text: string): void {
      const value = fingerprint(text);
      if (ring.includes(value)) return;
      ring.push(value);
      while (ring.length > limit) ring.shift();
    },
    clear(): void {
      ring.length = 0;
    },
    size(): number {
      return ring.length;
    },
  };
}

/** 摘录合成的整屏文本（内存内使用：diff / 指纹 / 语言判定）。 */
export function excerptText(result: Pick<ScreenContextResult, "excerpts">): string {
  return result.excerpts.map((item) => item.text).join("\n");
}

export function isExpired(result: ScreenContextResult, now: number): boolean {
  return now >= result.expiresAtMonotonicMs;
}

/** 自动（主动）候选：只用置信度达标的段；不足则没有候选，不降格凑数。 */
export function autoCandidates(result: ScreenContextResult): readonly ScreenExcerpt[] {
  if (result.readStatus !== "ok") return [];
  return result.excerpts.filter((item) => item.confidence >= AUTO_CANDIDATE_MIN_CONFIDENCE);
}

function ageLabel(ageMs: number): string {
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分钟前`;
}

/**
 * 出口投影：摘录 → `ContextSnippet[]`。
 *
 * 每段一条 snippet，带来源（进程名，不含标题）、采集时间与不确定标记。
 * `precision: "proxy"` 让既有提示词渲染打上「（未确认）」；`category` 只用于
 * 界面与 trace 分类，不进模型正文。
 *
 * **未授权返回空数组**——调用方拿不到任何可外发内容，这是零摘录外发的落点。
 */
export function buildScreenContextSnippets(
  result: ScreenContextResult,
  input: { now: number; authorized: boolean },
): readonly ContextSnippet[] {
  if (!input.authorized) return [];
  if (result.readStatus !== "ok" && result.readStatus !== "low_confidence") return [];
  if (isExpired(result, input.now)) return [];
  const age = ageLabel(input.now - result.capturedMonotonicMs);
  const process = result.window?.processName ?? "未知应用";
  return result.excerpts.map((item) => ({
    id: `${result.id}-${item.order}`,
    category: "screen-text",
    content: `屏幕上可见的文字（${process}，${age}读取${item.confidence < AUTO_CANDIDATE_MIN_CONFIDENCE ? "，识别不确定" : ""}）：${item.text}`,
    source: SCREEN_CONTEXT_SOURCE_ID,
    precision: "proxy" as const,
    temporal: "current" as const,
  }));
}
