/**
 * pet 受控意图协议 `pet.intent.v1`（FE-31）。
 *
 * 方向与 `pet.presentation.v1` 相反：pet → Rust → 主窗。pet 只是一个**受控的
 * 用户交互入口**，它能表达的东西被这里的 5 种 kind 完全穷尽：
 *
 * - `talk`：普通文本输入（走主窗既有用户发送路径）
 * - `screen_talk`：看屏幕聊聊（一次性刷新屏幕上下文后发一轮）
 * - `pause_reading` / `end_session` / `open_main`：会话控制
 *
 * pet **不能**提供 system prompt、source、Provider、路径或工具调用参数——
 * 多一个字段都不行，校验失败直接丢弃。真实窗口 label 校验在 Rust 侧
 * （只有 label=pet 的窗口能提交），主窗这一层再校验会话代数、epoch、长度与
 * requestId 去重：两层都过才算数。
 */

export const PET_INTENT_SCHEMA = "pet.intent.v1" as const;
export const PET_INTENT_EVENT = "pet://intent";
export const PET_INTENT_COMMAND = "pet_intent_submit";

/** 文本上限：与展示协议的 2000 字符对齐。 */
export const PET_INTENT_TEXT_LIMIT = 2000;
/** requestId 去重窗口与容量（SPEC 冻结）。 */
export const PET_INTENT_DEDUPE_MS = 120_000;
export const PET_INTENT_DEDUPE_LIMIT = 256;

export type PetIntentKind = "talk" | "screen_talk" | "pause_reading" | "end_session" | "open_main";

const KINDS: readonly PetIntentKind[] = ["talk", "screen_talk", "pause_reading", "end_session", "open_main"];

export interface PetIntentV1 {
  readonly schemaVersion: typeof PET_INTENT_SCHEMA;
  readonly requestId: string;
  /** pet 窗口这一次打开的代数；主窗前移后旧 epoch 的意图一律丢弃。 */
  readonly petEpoch: string;
  readonly kind: PetIntentKind;
  /** 只有 talk 带文本；其余 kind 必须没有文本。 */
  readonly text: string | null;
}

/**
 * 生产校验：形状不符返回 null（丢弃，不抛、不报错给 pet）。
 *
 * 多余字段会被丢掉而不是被转发——「pet 塞一个 systemPrompt 进来」的结果是
 * 那个字段根本不存在于返回值里。
 */
export function validatePetIntent(raw: unknown): PetIntentV1 | null {
  if (raw === null || typeof raw !== "object") return null;
  const intent = raw as Record<string, unknown>;
  if (intent.schemaVersion !== PET_INTENT_SCHEMA) return null;
  if (typeof intent.requestId !== "string" || intent.requestId.length === 0 || intent.requestId.length > 128) return null;
  if (typeof intent.petEpoch !== "string" || intent.petEpoch.length === 0 || intent.petEpoch.length > 128) return null;
  if (typeof intent.kind !== "string" || !KINDS.includes(intent.kind as PetIntentKind)) return null;

  const kind = intent.kind as PetIntentKind;
  if (kind === "talk") {
    if (typeof intent.text !== "string") return null;
    const text = intent.text.trim();
    if (text.length === 0 || text.length > PET_INTENT_TEXT_LIMIT) return null;
    return { schemaVersion: PET_INTENT_SCHEMA, requestId: intent.requestId, petEpoch: intent.petEpoch, kind, text };
  }
  // 非 talk 带文本 = 形状不对，丢弃（不是「忽略多余字段」——那会让越权更难看见）。
  if (intent.text !== undefined && intent.text !== null) return null;
  return { schemaVersion: PET_INTENT_SCHEMA, requestId: intent.requestId, petEpoch: intent.petEpoch, kind, text: null };
}

/**
 * requestId 去重：120 秒窗口内至多记 256 个。
 *
 * 防的是重放与「双击发两轮」：同一个 requestId 第二次到达直接算重复。
 * 单调时钟输入，不用墙钟（休眠/改系统时间不该让去重失效）。
 */
export function createIntentDedupe(options?: { windowMs?: number; limit?: number }) {
  const windowMs = options?.windowMs ?? PET_INTENT_DEDUPE_MS;
  const limit = options?.limit ?? PET_INTENT_DEDUPE_LIMIT;
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
