/**
 * 受控意图协议 `companion.intent.v1`（FE-31）。
 *
 * 它原本是「pet 薄窗口 → Rust 校验窗口 label → 主窗」的上行通道。MVP-03 删掉
 * 自研桌宠窗口之后，这条通道只在**主窗内部**使用（例如设置页的「看屏幕聊聊」），
 * 于是只剩一层：形状白名单 + 会话代数、epoch、长度与 requestId 去重，全部在
 * `companionSessionController` 里。Rust 侧的窗口校验随窗口一起删除，这里不再
 * 声称存在第二层。
 *
 * 协议本身保留，是因为它穷尽了「主窗能委托给会话控制器」的全部动作：
 *
 * - `talk`：普通文本输入（走主窗既有用户发送路径）
 * - `screen_talk`：看屏幕聊聊（一次性刷新屏幕上下文后发一轮）
 * - `pause_reading` / `end_session` / `open_main`：会话控制
 *
 * 调用方**不能**提供 system prompt、source、Provider、路径或工具调用参数——
 * 多一个字段都不行，校验失败直接丢弃。
 */

export const COMPANION_INTENT_SCHEMA = "companion.intent.v1" as const;

/** 文本上限：与展示协议的 2000 字符对齐。 */
export const COMPANION_INTENT_TEXT_LIMIT = 2000;
/** requestId 去重窗口与容量（SPEC 冻结）。 */
export const COMPANION_INTENT_DEDUPE_MS = 120_000;
export const COMPANION_INTENT_DEDUPE_LIMIT = 256;

export type CompanionIntentKind = "talk" | "screen_talk" | "pause_reading" | "end_session" | "open_main";

const KINDS: readonly CompanionIntentKind[] = ["talk", "screen_talk", "pause_reading", "end_session", "open_main"];

export interface CompanionIntentV1 {
  readonly schemaVersion: typeof COMPANION_INTENT_SCHEMA;
  readonly requestId: string;
  /** pet 窗口这一次打开的代数；主窗前移后旧 epoch 的意图一律丢弃。 */
  readonly sessionEpoch: string;
  readonly kind: CompanionIntentKind;
  /** 只有 talk 带文本；其余 kind 必须没有文本。 */
  readonly text: string | null;
}

/**
 * 生产校验：形状不符返回 null（丢弃，不抛、不报错给 pet）。
 *
 * 多余字段会被丢掉而不是被转发——「pet 塞一个 systemPrompt 进来」的结果是
 * 那个字段根本不存在于返回值里。
 */
export function validateCompanionIntent(raw: unknown): CompanionIntentV1 | null {
  if (raw === null || typeof raw !== "object") return null;
  const intent = raw as Record<string, unknown>;
  if (intent.schemaVersion !== COMPANION_INTENT_SCHEMA) return null;
  if (typeof intent.requestId !== "string" || intent.requestId.length === 0 || intent.requestId.length > 128) return null;
  if (typeof intent.sessionEpoch !== "string" || intent.sessionEpoch.length === 0 || intent.sessionEpoch.length > 128) return null;
  if (typeof intent.kind !== "string" || !KINDS.includes(intent.kind as CompanionIntentKind)) return null;

  const kind = intent.kind as CompanionIntentKind;
  if (kind === "talk") {
    if (typeof intent.text !== "string") return null;
    const text = intent.text.trim();
    if (text.length === 0 || text.length > COMPANION_INTENT_TEXT_LIMIT) return null;
    return { schemaVersion: COMPANION_INTENT_SCHEMA, requestId: intent.requestId, sessionEpoch: intent.sessionEpoch, kind, text };
  }
  // 非 talk 带文本 = 形状不对，丢弃（不是「忽略多余字段」——那会让越权更难看见）。
  if (intent.text !== undefined && intent.text !== null) return null;
  return { schemaVersion: COMPANION_INTENT_SCHEMA, requestId: intent.requestId, sessionEpoch: intent.sessionEpoch, kind, text: null };
}

/**
 * requestId 去重：120 秒窗口内至多记 256 个。
 *
 * 防的是重放与「双击发两轮」：同一个 requestId 第二次到达直接算重复。
 * 单调时钟输入，不用墙钟（休眠/改系统时间不该让去重失效）。
 */
export function createIntentDedupe(options?: { windowMs?: number; limit?: number }) {
  const windowMs = options?.windowMs ?? COMPANION_INTENT_DEDUPE_MS;
  const limit = options?.limit ?? COMPANION_INTENT_DEDUPE_LIMIT;
  const seen = new Map<string, number>();

  function prune(now: number): void {
    for (const [id, at] of seen) {
      if (now - at >= windowMs) seen.delete(id);
    }
    while (seen.size > limit) {
      const oldest = seen.keys().next();
      if (oldest.done) break;
      seen.delete(oldest.value);
    }
  }

  return {
    /** true = 这是重复请求，调用方应丢弃。 */
    isDuplicate(requestId: string, now: number): boolean {
      prune(now);
      return seen.has(requestId);
    },
    remember(requestId: string, now: number): void {
      seen.set(requestId, now);
      prune(now);
    },
    size(): number {
      return seen.size;
    },
    clear(): void {
      seen.clear();
    },
  };
}
